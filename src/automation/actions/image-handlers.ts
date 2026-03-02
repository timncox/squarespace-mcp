import { Page } from 'playwright';
import { logger } from '../../utils/logger.js';
import { clickThroughOverlay, findTextOnPage, getSiteFrame } from '../editor-actions.js';
import { errMsg } from '../../utils/errors.js';
import { validateFileExists, isFluidEngineActive, clickEditorButton, tryMediaApiUpload, tryImageBlockUpdateApi, tryReplaceImageApi, tryAddImageBlockApi, extractSubdomain } from './handler-utils.js';
import type { ActionResult } from './types.js';

// ─── Shared Helper: select image from library picker ─────────────────────

/**
 * After an API upload, try to select the newly uploaded image from the
 * Squarespace media library picker inside the image editor panel.
 *
 * Flow:
 * 1. If the image editor Content tab is showing "Add an Image" / "+" area,
 *    click it to open the upload/library picker dialog.
 * 2. Look for a "Browse" or "Library" tab/button to switch to the media
 *    library view (away from the direct upload view).
 * 3. In the library grid, click the first (most recent) image thumbnail.
 *
 * Searches both the main frame and the #sqs-site-frame iframe, since the
 * library picker can render in either depending on context.
 *
 * Returns true if an image was clicked from the library grid.
 */
async function selectFromLibrary(page: Page): Promise<boolean> {
  const siteFrame = page.frame({ name: 'sqs-site-frame' });

  // Helper: try a locator across main frame, then iframe
  const tryClick = async (
    mainSel: string,
    timeout = 2000,
  ): Promise<boolean> => {
    // Main frame
    const mainBtn = page.locator(mainSel).first();
    if (await mainBtn.isVisible({ timeout }).catch(() => false)) {
      await mainBtn.click();
      return true;
    }
    // Iframe fallback
    if (siteFrame) {
      const iframeBtn = siteFrame.locator(mainSel).first();
      if (await iframeBtn.isVisible({ timeout: Math.min(timeout, 1500) }).catch(() => false)) {
        // Use boundingBox + page.mouse.click to click through the overlay
        const box = await iframeBtn.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          return true;
        }
      }
    }
    return false;
  };

  // ── Step 0: Open the upload/library picker ──────────────────────────
  // When the image editor panel is open on the Content tab, the empty state
  // shows "Add an Image" with a "+" icon and "20 MB max" text. Clicking
  // this area opens the upload/library picker dialog.
  const uploadTriggerSelectors = [
    'button:has-text("Add an Image")',   // Button-wrapped upload trigger
    'text="Add an Image"',               // Plain text element acting as trigger
    '[class*="upload-area"]',            // Upload drop zone container
    '[class*="image-uploader"]',         // Uploader component root
    '[class*="ImageUploader"]',          // CamelCase variant (CSS modules)
    '[class*="add-image"]',              // Hyphenated variant
    '[class*="AddImage"]',               // CamelCase variant
  ];

  let uploadAreaClicked = false;
  for (const sel of uploadTriggerSelectors) {
    if (await tryClick(sel, 2000)) {
      uploadAreaClicked = true;
      logger.info({ selector: sel }, 'selectFromLibrary: clicked upload trigger area');
      await page.waitForTimeout(1500);
      break;
    }
  }

  if (!uploadAreaClicked) {
    logger.debug('selectFromLibrary: no upload trigger found — library picker may already be open');
  }

  // ── Step 1: Switch to the Library / Browse tab ──────────────────────
  // The upload/library picker may have tabs to switch between "Upload" and
  // "Browse"/"Library" views. We need the library view to pick the image
  // that was just uploaded via the media API.

  // Role-based selectors (most resilient to class name changes)
  const roleTab = page.getByRole('tab', { name: /library|browse|media/i }).first();
  const roleBtn = page.getByRole('button', { name: /library|browse/i }).first();

  let libraryOpened = false;

  // Try role-based first
  if (await roleTab.isVisible({ timeout: 2000 }).catch(() => false)) {
    await roleTab.click();
    libraryOpened = true;
    logger.info('selectFromLibrary: clicked library tab via getByRole("tab")');
  } else if (await roleBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await roleBtn.click();
    libraryOpened = true;
    logger.info('selectFromLibrary: clicked library button via getByRole("button")');
  }

  // Fallback: CSS/text-based selectors across both frames
  if (!libraryOpened) {
    const librarySelectors = [
      // Text-based tab/button labels
      'button:has-text("Browse")',
      'button:has-text("Library")',
      '[role="tab"]:has-text("Library")',
      '[role="tab"]:has-text("Browse")',
      // Data-test and aria attributes (Squarespace automation hooks)
      '[data-test="media-library"]',
      '[aria-label*="library" i]',
      '[aria-label*="browse" i]',
      '[aria-label*="media" i]',
      // Class-based (CSS modules with hashed suffixes)
      '[class*="library-tab"]',
      '[class*="LibraryTab"]',
      '[class*="browse-tab"]',
      '[class*="BrowseTab"]',
    ];

    for (const sel of librarySelectors) {
      if (await tryClick(sel, 1500)) {
        libraryOpened = true;
        logger.info({ selector: sel }, 'selectFromLibrary: clicked library/browse tab');
        break;
      }
    }
  }

  if (!libraryOpened) {
    logger.debug('selectFromLibrary: no library tab found — images may already be visible');
  }

  await page.waitForTimeout(2000);

  // ── Step 2: Click the first / most recent image in the library grid ─
  // Squarespace uses CSS modules with hashed class suffixes (e.g., "asset_abc123"),
  // so we use wildcard [class*="..."] matching. Also check role-based and
  // data-attribute selectors for resilience.
  const imageSelectors = [
    // Wildcard class matching for Squarespace's CSS module class names
    '[class*="library"] img',           // Library container images
    '[class*="asset"] img',             // Asset/media item images
    '[class*="media-grid"] img',        // Media grid layout images
    '[class*="MediaLibrary"] img',      // CamelCase variant
    '[class*="thumbnail"] img',         // Thumbnail previews
    '[class*="Thumbnail"] img',         // CamelCase variant
    // Data-test attributes (Squarespace automation hooks — most reliable)
    '[data-test="media-library-item"]',
    '[data-test="media-library-item"] img',
    // Role-based (accessible grid/list patterns)
    '[role="option"] img',              // Listbox option with image
    '[role="listbox"] img',             // Listbox container images
    '[role="grid"] img',                // Grid container images
    '[role="gridcell"] img',            // Grid cell images
    // Squarespace CDN images in a picker context (last resort — broad match)
    'img[src*="squarespace-cdn"]',
    'img[src*="images.squarespace"]',
  ];

  // Try each selector across main frame and iframe
  for (const imgSel of imageSelectors) {
    // Main frame
    const mainImg = page.locator(imgSel).first();
    if (await mainImg.isVisible({ timeout: 2000 }).catch(() => false)) {
      await mainImg.click();
      logger.info({ selector: imgSel, frame: 'main' }, 'selectFromLibrary: clicked image from library');
      await page.waitForTimeout(1000);
      return true;
    }
    // Iframe fallback
    if (siteFrame) {
      const iframeImg = siteFrame.locator(imgSel).first();
      if (await iframeImg.isVisible({ timeout: 1500 }).catch(() => false)) {
        const box = await iframeImg.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          logger.info({ selector: imgSel, frame: 'iframe' }, 'selectFromLibrary: clicked image from library');
          await page.waitForTimeout(1000);
          return true;
        }
      }
    }
  }

  logger.warn('selectFromLibrary: could not find any images in the library grid');
  return false;
}

// ─── Compound Action: replaceImage ───────────────────────────────────────

/**
 * Compound action: replace an image in an image block.
 *
 * Steps:
 * 1. Find the image block by alt text, filename, or nearby text
 * 2. Click through overlay to select the section
 * 3. Enter section edit mode if needed
 * 4. Click the image block to open the image editor
 * 5. Upload the new image via file input
 * 6. Optionally set alt text
 * 7. Close panel and verify
 */
export async function handleReplaceImage(
  page: Page,
  action: { action: 'replaceImage'; searchText: string; imagePath: string; altText?: string },
): Promise<ActionResult> {
  const { searchText, imagePath, altText } = action;

  // Validate file exists before starting multi-step process
  const fileError = validateFileExists(imagePath, 'replaceImage');
  if (fileError) return fileError;

  // API fast path — try upload + API update before 7-step UI
  const apiResult = await tryReplaceImageApi(page, searchText, imagePath, altText);
  if (apiResult) return apiResult;

  // ── Step 1: Find the image block ──────────────────────────────────────
  logger.info({ searchText }, 'replaceImage[1/7]: finding image block');

  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  if (!siteFrame) {
    return {
      success: false,
      message: 'replaceImage step 1: Site iframe not found. Make sure you are in the editor.',
    };
  }

  // Search for image by alt text, src filename, or nearby text
  const imageInfo = await siteFrame.evaluate((text: string) => {
    const lower = text.toLowerCase();
    const images = document.querySelectorAll('img');

    for (const img of images) {
      const alt = (img.alt || '').toLowerCase();
      const src = (img.src || '').toLowerCase();
      const parentText = (img.closest('.sqs-block') as HTMLElement)?.innerText?.toLowerCase() || '';

      if (alt.includes(lower) || src.includes(lower) || parentText.includes(lower)) {
        const rect = img.getBoundingClientRect();
        return {
          found: true,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          alt: img.alt,
          src: img.src.substring(0, 80),
        };
      }
    }
    return { found: false, x: 0, y: 0, alt: '', src: '' };
  }, searchText).catch(() => ({ found: false, x: 0, y: 0, alt: '', src: '' }));

  if (!imageInfo.found) {
    // Also try text near the image
    const textMatches = await findTextOnPage(page, searchText);
    if (textMatches.length === 0) {
      return {
        success: false,
        message: `replaceImage step 1: Image with text/alt "${searchText}" not found on page`,
      };
    }
  }

  // ── Step 2: Click through overlay to select the section ───────────────
  logger.info('replaceImage[2/7]: clicking section');

  // If we found the image by coordinates, click those coordinates
  if (imageInfo.found) {
    // Get iframe offset to translate coordinates
    const iframeHandle = await page.$('#sqs-site-frame');
    if (iframeHandle) {
      const iframeRect = await iframeHandle.boundingBox();
      if (iframeRect) {
        const pageX = iframeRect.x + imageInfo.x;
        const pageY = iframeRect.y + imageInfo.y;
        await page.mouse.click(pageX, pageY);
        logger.info({ pageX, pageY }, 'replaceImage[2/7]: clicked image via coordinates');
      }
    }
  } else {
    const clickResult = await clickThroughOverlay(page, `text=${searchText}`);
    if (!clickResult.success) {
      return {
        success: false,
        message: `replaceImage step 2: Failed to click section — ${clickResult.message}`,
      };
    }
  }
  await page.waitForTimeout(1000);

  // ── Step 3: Enter section edit mode if needed ─────────────────────────
  logger.info('replaceImage[3/7]: checking edit mode');
  const fluidActive = await isFluidEngineActive(page, 2000);

  if (!fluidActive) {
    const clicked = await clickEditorButton(page, /edit content/i, ['[aria-label="Edit Content"]']);
    if (clicked) logger.info('replaceImage[3/7]: clicked EDIT CONTENT');
    await page.waitForTimeout(1000);
  }

  // ── Step 4: Click the image block to open editor ──────────────────────
  logger.info('replaceImage[4/7]: clicking image block');

  // Re-find image in edit mode and click it
  if (imageInfo.found) {
    const iframeHandle = await page.$('#sqs-site-frame');
    if (iframeHandle) {
      const iframeRect = await iframeHandle.boundingBox();
      if (iframeRect) {
        const pageX = iframeRect.x + imageInfo.x;
        const pageY = iframeRect.y + imageInfo.y;
        // Single click to select block
        await page.mouse.click(pageX, pageY);
        await page.waitForTimeout(800);
        // Double click to open editor
        await page.mouse.dblclick(pageX, pageY);
        logger.info('replaceImage[4/7]: double-clicked image block');
      }
    }
  } else {
    // Click near the text to find the image
    const textSelector = `text=${searchText}`;
    await clickThroughOverlay(page, textSelector);
    await page.waitForTimeout(500);
    await clickThroughOverlay(page, textSelector);
  }
  await page.waitForTimeout(1500);

  // ── Step 5: Upload the new image ──────────────────────────────────────
  logger.info({ imagePath }, 'replaceImage[5/7]: uploading new image');

  // Look for file input (Squarespace adds hidden file inputs for image uploads)
  let uploaded = false;

  // Strategy A: Find any visible file input
  const fileInputs = page.locator('input[type="file"]');
  const fileInputCount = await fileInputs.count();

  for (let i = 0; i < fileInputCount; i++) {
    try {
      await fileInputs.nth(i).setInputFiles(imagePath);
      uploaded = true;
      logger.info(`replaceImage[5/7]: uploaded via file input #${i}`);
      break;
    } catch (err) {
      logger.debug({ error: errMsg(err), index: i }, 'replaceImage[5/7]: file input failed');
    }
  }

  // Strategy B: Look for "Replace" button or image upload trigger
  if (!uploaded) {
    const replaceSelectors = [
      'button:has-text("Replace")',
      'button:has-text("REPLACE")',
      'button:has-text("Upload")',
      'button:has-text("UPLOAD")',
      '[aria-label="Replace image"]',
      '[aria-label="Upload image"]',
      '[data-test="replace-image"]',
    ];

    for (const selector of replaceSelectors) {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        logger.info({ selector }, 'replaceImage[5/7]: clicked replace/upload button');
        await page.waitForTimeout(1000);

        // Now look for file input again
        const newFileInputs = page.locator('input[type="file"]');
        const newCount = await newFileInputs.count();
        for (let i = 0; i < newCount; i++) {
          try {
            await newFileInputs.nth(i).setInputFiles(imagePath);
            uploaded = true;
            logger.info(`replaceImage[5/7]: uploaded after clicking replace button`);
            break;
          } catch { /* try next */ }
        }
        if (uploaded) break;
      }
    }
  }

  // Strategy C: Upload via media API, then select from library
  if (!uploaded) {
    logger.info('replaceImage[5/7]: trying media API upload as fallback');
    const apiResult = await tryMediaApiUpload(page, imagePath);
    if (apiResult) {
      uploaded = await selectFromLibrary(page);
      if (uploaded) {
        logger.info('replaceImage[5/7]: selected image from library after API upload');
      } else {
        logger.warn('replaceImage[5/7]: API upload succeeded but could not select from library — image is in the asset library for manual selection');
      }
    }
  }

  if (!uploaded) {
    return {
      success: false,
      message: `replaceImage step 5: Could not find file upload input. The image editor panel may not have opened. Try clicking the image block manually first.`,
    };
  }

  // Wait for upload to complete
  await page.waitForTimeout(3000);

  // ── Step 6: Set alt text if provided ──────────────────────────────────
  let altTextSet = false;
  if (altText) {
    logger.info({ altText }, 'replaceImage[6/7]: setting alt text');
    const altSelectors = [
      'input[placeholder*="alt"]',
      'input[placeholder*="Alt"]',
      'input[name*="alt"]',
      'textarea[placeholder*="alt"]',
      'input[aria-label*="alt"]',
      'input[aria-label*="Alt"]',
      'input[data-test="alt-text"]',
    ];

    for (const selector of altSelectors) {
      const input = page.locator(selector).first();
      const visible = await input.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await input.fill(altText);
        altTextSet = true;
        logger.info({ selector }, 'replaceImage[6/7]: filled alt text');
        break;
      }
    }

    if (!altTextSet) {
      // Fallback: try setting alt text via Content Save API
      const apiResult = await tryImageBlockUpdateApi(page, searchText, { altText });
      if (apiResult?.success) {
        altTextSet = true;
        logger.info('replaceImage[6/7]: set alt text via Content Save API');
      } else {
        logger.warn({ altText }, 'replaceImage[6/7]: could not find alt text input — alt text was NOT set');
      }
    }
  }

  // ── Step 7: Close panel and verify ────────────────────────────────────
  logger.info('replaceImage[7/7]: closing panel and verifying');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.mouse.click(600, 500);
  await page.waitForTimeout(1500);

  // Check if the image src changed compared to the original
  const originalSrc = imageInfo.src;
  const newImageSrc = siteFrame ? await siteFrame.evaluate((text: string) => {
    const lower = text.toLowerCase();
    const images = document.querySelectorAll('img');
    for (const img of images) {
      const alt = (img.alt || '').toLowerCase();
      const parentText = (img.closest('.sqs-block') as HTMLElement)?.innerText?.toLowerCase() || '';
      if (alt.includes(lower) || parentText.includes(lower)) {
        return img.src;
      }
    }
    return null;
  }, altText || searchText).catch(() => null) : null;

  const srcChanged = newImageSrc && newImageSrc !== originalSrc;
  const warnings: string[] = [];
  if (altText && !altTextSet) warnings.push('WARNING: Alt text input not found — alt text was not set.');
  if (!srcChanged) warnings.push('WARNING: Could not confirm the image src changed — upload may have failed.');

  return {
    success: true,
    message: `replaceImage: Image upload completed for "${searchText}".${altText && altTextSet ? ` Alt text set to "${altText}".` : ''}${newImageSrc ? ` New src: ${newImageSrc.substring(0, 60)}...` : ''}${warnings.length > 0 ? ' ' + warnings.join(' ') : ''}`,
  };
}

// ─── Compound Action: addImageBlock ──────────────────────────────────────

/**
 * Compound action: add a NEW Image block to the current section and upload an image.
 *
 * Prerequisite: the section must already be in edit mode (use enterSectionEditMode first).
 *
 * Steps:
 * 1. Verify section is in edit mode
 * 2. Click ADD BLOCK
 * 3. Search for "Image" and click it
 * 4. Wait for image editor / library panel
 * 5. Upload the image via file input
 * 6. Set alt text (if provided)
 * 7. Close panel
 */
export async function handleAddImageBlock(
  page: Page,
  action: { action: 'addImageBlock'; imagePath: string; altText?: string },
): Promise<ActionResult> {
  const { imagePath, altText } = action;

  // Validate file exists before starting multi-step process
  const fileError = validateFileExists(imagePath, 'addImageBlock');
  if (fileError) return fileError;

  // API fast path — try upload + API add before 7-step UI
  const apiResult = await tryAddImageBlockApi(page, imagePath, altText);
  if (apiResult) return apiResult;

  // ── Step 1: Verify section edit mode ────────────────────────────────
  logger.info({ imagePath }, 'addImageBlock[1/7]: verifying section edit mode');

  const addBlockVisible = await isFluidEngineActive(page, 2000);

  if (!addBlockVisible) {
    return {
      success: false,
      message: 'addImageBlock step 1: Not in section edit mode. Use enterSectionEditMode first, then retry.',
    };
  }

  // ── Step 2: Click ADD BLOCK ─────────────────────────────────────────
  logger.info('addImageBlock[2/7]: clicking ADD BLOCK');

  let addBlockClicked = false;
  try {
    await page.getByRole('button', { name: /add block/i }).first().click({ timeout: 3000 });
    addBlockClicked = true;
    logger.info('addImageBlock[2/7]: clicked ADD BLOCK via getByRole');
  } catch { /* fallback */ }

  if (!addBlockClicked) {
    for (const selector of ['button:has-text("ADD BLOCK")', '[aria-label="Add Block"]']) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await btn.click({ timeout: 3000 });
          addBlockClicked = true;
          break;
        }
      } catch { /* Try next */ }
    }
  }

  if (!addBlockClicked) {
    return {
      success: false,
      message: 'addImageBlock step 2: ADD BLOCK button not found. Make sure you are in section edit mode.',
    };
  }
  await page.waitForTimeout(1000);

  // ── Step 3: Search for "Image" and click it ─────────────────────────
  // NOTE: The block picker renders INSIDE the iframe (#sqs-site-frame).
  // The search input may be in main frame, but the block tiles are in the iframe.
  logger.info('addImageBlock[3/7]: searching for Image block type');

  const siteFrameForPicker = getSiteFrame(page);

  // Try typing "Image" in search input (could be in main or iframe)
  const searchSelectors = [
    'input[placeholder*="Search"]',
    'input[placeholder*="search"]',
    'input[type="search"]',
  ];

  for (const selector of searchSelectors) {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      await el.click();
      await el.fill('Image');
      logger.info('addImageBlock[3/7]: typed "Image" in search (main)');
      await page.waitForTimeout(800);
      break;
    }
  }

  // Click the Image tile — check iframe first (where block picker lives)
  let blockClicked = false;

  // Get viewport size for off-screen detection
  const viewport = page.viewportSize() || { width: 1440, height: 900 };

  // Count image blocks before clicking so we can verify one was added
  const imgBlockCountBefore = siteFrameForPicker
    ? await siteFrameForPicker.locator('.sqs-block-image').count().catch(() => 0)
    : 0;

  // Strategy A: Click "Image" text in iframe via boundingBox (through overlay)
  // NOTE: boundingBox() may return off-screen y-coords when the iframe is scrolled
  // (the block picker is a fixed panel but coords are relative to iframe content).
  if (!blockClicked && siteFrameForPicker) {
    const imgText = siteFrameForPicker.getByText('Image', { exact: true }).first();
    const imgBox = await imgText.boundingBox().catch(() => null);
    if (imgBox && imgBox.y >= 0 && imgBox.y < viewport.height && imgBox.x >= 0 && imgBox.x < viewport.width) {
      await page.mouse.click(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
      blockClicked = true;
      logger.info({ x: Math.round(imgBox.x), y: Math.round(imgBox.y) }, 'addImageBlock[3/7]: clicked Image tile in iframe via boundingBox');
    } else if (imgBox) {
      logger.info({ x: Math.round(imgBox.x), y: Math.round(imgBox.y), vpH: viewport.height }, 'addImageBlock[3/7]: Image tile boundingBox off-screen, skipping to JS click');
    }
  }

  // Strategy B: JavaScript click in iframe (reliable even when page is scrolled)
  if (!blockClicked) {
    const frame = page.frame({ name: 'sqs-site-frame' });
    if (frame) {
      const clicked = await frame.evaluate(() => {
        // Find elements with visible "Image" text — try multiple approaches
        // 1. Look for elements where the direct textContent is "Image"
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const htmlEl = el as HTMLElement;
          const text = htmlEl.innerText?.trim();
          if (text === 'Image' && el.children.length <= 3) {
            const rect = el.getBoundingClientRect();
            // Must be visible (width/height > 0)
            if (rect.width > 0 && rect.height > 0) {
              htmlEl.click();
              return `clicked ${el.tagName}.${el.className?.toString().substring(0, 30)} at ${Math.round(rect.x)},${Math.round(rect.y)}`;
            }
          }
        }
        return false;
      }).catch(() => false);
      if (clicked) {
        blockClicked = true;
        logger.info({ detail: clicked }, 'addImageBlock[3/7]: clicked Image tile via iframe JS');
      }
    }
  }

  // Strategy C: Main frame locators (fallback)
  if (!blockClicked) {
    for (const selector of [`text="Image"`, `button:has-text("Image")`]) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click({ timeout: 3000 });
        blockClicked = true;
        logger.info({ selector }, 'addImageBlock[3/7]: clicked Image tile in main frame');
        break;
      }
    }
  }

  if (!blockClicked) {
    return {
      success: false,
      message: 'addImageBlock step 3: Could not find "Image" in block picker.',
    };
  }
  await page.waitForTimeout(2000);

  // Verify that a new image block was actually created
  const imgBlockCountAfter = siteFrameForPicker
    ? await siteFrameForPicker.locator('.sqs-block-image').count().catch(() => 0)
    : 0;

  if (imgBlockCountAfter <= imgBlockCountBefore) {
    // The click didn't create a new block — retry with JS click if we haven't tried it
    logger.warn({ before: imgBlockCountBefore, after: imgBlockCountAfter }, 'addImageBlock[3/7]: no new image block created — retrying with JS click');
    const frame = page.frame({ name: 'sqs-site-frame' });
    if (frame) {
      const retryClicked = await frame.evaluate(() => {
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const htmlEl = el as HTMLElement;
          const text = htmlEl.innerText?.trim();
          if (text === 'Image' && el.children.length <= 3) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              htmlEl.click();
              return true;
            }
          }
        }
        return false;
      }).catch(() => false);
      if (retryClicked) {
        logger.info('addImageBlock[3/7]: retry JS click completed');
        await page.waitForTimeout(2000);
      }
    }
  }

  // ── Step 4: Wait for image editor / open it by double-clicking ──────
  // After clicking Image tile, a .sqs-block-image is created in the iframe.
  // Double-clicking it opens the image editor panel with a file input.
  logger.info('addImageBlock[4/7]: waiting for image editor panel');

  const siteFrameForEditor = getSiteFrame(page);

  // Helper: count image-accepting file inputs in both frames
  const countImageFileInputs = async () => {
    let total = 0;
    const mainInputs = page.locator('input[type="file"][accept*="image"]');
    total += await mainInputs.count().catch(() => 0);
    if (siteFrameForEditor) {
      const iframeInputs = siteFrameForEditor.locator('input[type="file"][accept*="image"]');
      total += await iframeInputs.count().catch(() => 0);
    }
    return total;
  };

  let fileInputCount = await countImageFileInputs();
  if (fileInputCount > 0) {
    logger.info('addImageBlock[4/7]: image file input already available');
  } else if (siteFrameForEditor) {
    // Find the EMPTY image block (newly created, no uploaded image yet)
    // Look for .sqs-block-image blocks and find the one without an img[src*="squarespace-cdn"]
    const allImgBlocks = siteFrameForEditor.locator('.sqs-block-image');
    const blockCount = await allImgBlocks.count();
    let targetBlock = allImgBlocks.last(); // fallback to last
    let targetBox: { x: number; y: number; width: number; height: number } | null = null;

    for (let i = blockCount - 1; i >= 0; i--) {
      const block = allImgBlocks.nth(i);
      const hasCdnImg = await block.locator('img[src*="squarespace-cdn"], img[src*="images.squarespace"]').count().catch(() => 0);
      if (hasCdnImg === 0) {
        // This is an empty image block (no uploaded image)
        targetBlock = block;
        await targetBlock.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
        targetBox = await targetBlock.boundingBox().catch(() => null);
        logger.info({ index: i, blockCount }, 'addImageBlock[4/7]: found empty image block');
        break;
      }
    }

    if (!targetBox) {
      // Fallback: scroll to last block and get its box
      await targetBlock.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      targetBox = await targetBlock.boundingBox().catch(() => null);
    }

    if (targetBox) {
      // Double-click the empty image block through overlay to open editor
      // boundingBox() from FrameLocator returns viewport-relative coords
      await page.mouse.dblclick(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height / 2,
      );
      logger.info('addImageBlock[4/7]: double-clicked empty image block through overlay');
      await page.waitForTimeout(2000);
      fileInputCount = await countImageFileInputs();
    }

    // If still no file input, try single-click then check
    if (fileInputCount === 0 && targetBox) {
      await page.mouse.click(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height / 2,
      );
      await page.waitForTimeout(1500);
      fileInputCount = await countImageFileInputs();
    }
  }

  logger.info({ fileInputCount }, 'addImageBlock[4/7]: file inputs found');

  // ── Step 5: Upload the image file ───────────────────────────────────
  logger.info({ imagePath }, 'addImageBlock[5/7]: uploading image');

  let uploaded = false;

  // Strategy A: Try iframe file inputs first (Squarespace puts them there)
  if (!uploaded && siteFrameForEditor) {
    const iframeInputs = siteFrameForEditor.locator('input[type="file"]');
    const iCount = await iframeInputs.count();
    for (let i = 0; i < iCount; i++) {
      try {
        await iframeInputs.nth(i).setInputFiles(imagePath);
        uploaded = true;
        logger.info(`addImageBlock[5/7]: uploaded via iframe file input #${i}`);
        break;
      } catch (err) {
        logger.debug({ error: errMsg(err), index: i }, 'addImageBlock[5/7]: iframe file input failed');
      }
    }
  }

  // Strategy B: Try main frame file inputs
  if (!uploaded) {
    const mainInputs = page.locator('input[type="file"]');
    const mCount = await mainInputs.count();
    for (let i = 0; i < mCount; i++) {
      try {
        await mainInputs.nth(i).setInputFiles(imagePath);
        uploaded = true;
        logger.info(`addImageBlock[5/7]: uploaded via main file input #${i}`);
        break;
      } catch (err) {
        logger.debug({ error: errMsg(err), index: i }, 'addImageBlock[5/7]: main file input failed');
      }
    }
  }

  // Strategy C: Click the "+" / "Add an Image" area to trigger file input
  if (!uploaded && siteFrameForEditor) {
    // The image editor panel may have a clickable upload area
    const uploadTriggers = [
      'button:has-text("Add an Image")',
      'button:has-text("Upload")',
      '[class*="upload"]',
    ];
    for (const selector of uploadTriggers) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click({ timeout: 3000 });
        logger.info({ selector }, 'addImageBlock[5/7]: clicked upload trigger');
        await page.waitForTimeout(1500);

        // Re-check both frames
        for (const loc of [siteFrameForEditor.locator('input[type="file"]'), page.locator('input[type="file"]')]) {
          const c = await loc.count();
          for (let i = 0; i < c; i++) {
            try {
              await loc.nth(i).setInputFiles(imagePath);
              uploaded = true;
              logger.info('addImageBlock[5/7]: uploaded after clicking upload trigger');
              break;
            } catch { /* try next */ }
          }
          if (uploaded) break;
        }
        if (uploaded) break;
      }
    }
  }

  // Strategy D: Upload via media API, then select from library
  if (!uploaded) {
    logger.info('addImageBlock[5/7]: trying media API upload as fallback');
    const apiResult = await tryMediaApiUpload(page, imagePath);
    if (apiResult) {
      uploaded = await selectFromLibrary(page);
      if (uploaded) {
        logger.info('addImageBlock[5/7]: selected image from library after API upload');
      } else {
        logger.warn('addImageBlock[5/7]: API upload succeeded but could not select from library — image is in the asset library for manual selection');
      }
    }
  }

  if (!uploaded) {
    return {
      success: false,
      message: 'addImageBlock step 5: Could not find file upload input in main frame or iframe. The image editor panel may not have opened.',
    };
  }

  // Wait for upload to complete
  await page.waitForTimeout(3000);

  // ── Step 6: Set alt text if provided ────────────────────────────────
  let altTextSet = false;
  if (altText) {
    logger.info({ altText }, 'addImageBlock[6/7]: setting alt text');
    const altSelectors = [
      'input[placeholder*="alt"]',
      'input[placeholder*="Alt"]',
      'input[name*="alt"]',
      'textarea[placeholder*="alt"]',
      'input[aria-label*="alt"]',
      'input[aria-label*="Alt"]',
      'input[data-test="alt-text"]',
    ];

    for (const selector of altSelectors) {
      const input = page.locator(selector).first();
      const visible = await input.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await input.fill(altText);
        altTextSet = true;
        logger.info({ selector }, 'addImageBlock[6/7]: filled alt text');
        break;
      }
    }

    if (!altTextSet) {
      // Fallback: try setting alt text via Content Save API
      // Note: for addImageBlock the block was just created, so searchText may not match.
      // We use a broad search — the newly added image block typically has no title/text yet,
      // so this may not find it. Best-effort attempt.
      const apiResult = await tryImageBlockUpdateApi(page, altText, { altText });
      if (apiResult?.success) {
        altTextSet = true;
        logger.info('addImageBlock[6/7]: set alt text via Content Save API');
      } else {
        logger.warn({ altText }, 'addImageBlock[6/7]: could not find alt text input — alt text was NOT set');
      }
    }
  }

  // ── Step 7: Close panel and verify ────────────────────────────────────
  // ⚠️ KNOWN SIDE EFFECT: Pressing Escape + clicking outside exits
  // section edit mode (Fluid Engine). After this step, the section is
  // no longer in edit mode. If you need to add more blocks (Text, Button,
  // etc.) to the same section, you MUST call enterSectionEditMode again
  // before calling addBlockToSection or editButtonBlock.
  logger.info('addImageBlock[7/7]: closing panel and verifying — NOTE: this exits section edit mode');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.mouse.click(600, 500);
  await page.waitForTimeout(1500);

  // Verify the image block was actually added by checking for a new image in the section
  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  const imageFound = siteFrame ? await siteFrame.evaluate(() => {
    const images = document.querySelectorAll('img');
    // Check if any image was recently added (has a Squarespace CDN src)
    for (const img of images) {
      if (img.src && (img.src.includes('squarespace-cdn') || img.src.includes('images.squarespace-cdn'))) {
        return img.src;
      }
    }
    return null;
  }).catch(() => null) : null;

  const warnings: string[] = [];
  if (altText && !altTextSet) warnings.push('WARNING: Alt text input not found — alt text was not set.');
  if (!imageFound) warnings.push('WARNING: Could not confirm the image block was added — verify visually.');

  return {
    success: true,
    message: `addImageBlock: Added Image block and uploaded "${imagePath}".${altText && altTextSet ? ` Alt text set to "${altText}".` : ''}${imageFound ? ` Image src: ${imageFound.substring(0, 60)}...` : ''}${warnings.length > 0 ? ' ' + warnings.join(' ') : ''}`,
  };
}

// ─── Compound Action: addGalleryBlock ─────────────────────────────────────

/**
 * Compound action: add multiple images as a gallery grid to the current section.
 *
 * API fast path (try first):
 * 1. Extract API context (subdomain, pageSectionsId, collectionId)
 * 2. Upload all images via MediaUploadClient.uploadImages()
 * 3. Calculate grid layout based on galleryStyle
 * 4. Call ContentSaveClient.addImageBlockBatch() with uploaded URLs and grid positions
 *
 * UI fallback (if API fails):
 * 1. For each image, call handleAddImageBlock() sequentially
 */
export async function handleAddGalleryBlock(
  page: Page,
  action: { action: 'addGalleryBlock'; imagePaths: string[]; altTexts?: string[]; galleryStyle?: 'grid' | 'slideshow' | 'collage' },
): Promise<ActionResult> {
  const { imagePaths, altTexts, galleryStyle = 'grid' } = action;

  if (!imagePaths || imagePaths.length === 0) {
    return {
      success: false,
      message: 'addGalleryBlock: No image paths provided. Supply at least one imagePath.',
    };
  }

  // Validate all files exist before starting
  for (const filePath of imagePaths) {
    const fileError = validateFileExists(filePath, 'addGalleryBlock');
    if (fileError) return fileError;
  }

  logger.info(
    { imageCount: imagePaths.length, galleryStyle },
    'addGalleryBlock: starting gallery creation',
  );

  // ── API Fast Path ──────────────────────────────────────────────────────
  const apiResult = await tryGalleryApi(page, imagePaths, altTexts, galleryStyle);
  if (apiResult) return apiResult;

  // ── UI Fallback ────────────────────────────────────────────────────────
  logger.info('addGalleryBlock: API fast path unavailable, falling back to sequential UI uploads');

  let successCount = 0;
  const warnings: string[] = [];

  for (let i = 0; i < imagePaths.length; i++) {
    const altText = altTexts?.[i];
    const result = await handleAddImageBlock(page, {
      action: 'addImageBlock',
      imagePath: imagePaths[i],
      altText,
    });

    if (result.success) {
      successCount++;
    } else {
      warnings.push(`Image ${i + 1} ("${imagePaths[i]}") failed: ${result.message}`);
    }

    // Re-enter section edit mode between images since handleAddImageBlock exits it
    if (i < imagePaths.length - 1) {
      const fluidActive = await isFluidEngineActive(page, 2000);
      if (!fluidActive) {
        // Try re-entering edit mode by clicking Edit Content
        const clicked = await clickEditorButton(page, /edit content/i, ['[aria-label="Edit Content"]']);
        if (clicked) {
          logger.info('addGalleryBlock: re-entered section edit mode between images');
          await page.waitForTimeout(1000);
        } else {
          warnings.push(`Could not re-enter edit mode after image ${i + 1} — remaining images may fail.`);
        }
      }
    }
  }

  if (successCount === 0) {
    return {
      success: false,
      message: `addGalleryBlock: All ${imagePaths.length} image uploads failed via UI fallback. ${warnings.join(' ')}`,
    };
  }

  return {
    success: true,
    message: `addGalleryBlock: Added ${successCount}/${imagePaths.length} images via UI fallback (${galleryStyle} layout).${warnings.length > 0 ? ' ' + warnings.join(' ') : ''}`,
  };
}

/**
 * Try adding gallery images via the Content Save API + Media Upload API.
 * Returns an ActionResult on success, null on failure (caller falls back to UI).
 */
async function tryGalleryApi(
  page: Page,
  imagePaths: string[],
  altTexts: string[] | undefined,
  galleryStyle: 'grid' | 'slideshow' | 'collage',
): Promise<ActionResult | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryGalleryApi: could not extract subdomain from URL');
    return null;
  }

  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  if (!siteFrame) {
    logger.debug('tryGalleryApi: no sqs-site-frame found');
    return null;
  }

  const pageSectionsId = await siteFrame.evaluate(() => {
    const article = document.querySelector('article[data-page-sections]');
    return article?.getAttribute('data-page-sections') ?? null;
  }).catch(() => null);

  if (!pageSectionsId) {
    logger.debug('tryGalleryApi: could not find data-page-sections attribute');
    return null;
  }

  try {
    // Dynamic imports to avoid circular dependencies
    const { createContentSaveClient } = await import('../../services/content-save.js');
    const { createMediaUploadClient } = await import('../../services/media-upload.js');

    const client = createContentSaveClient(subdomain);
    const pageUrl = page.url();
    const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
    const slug = slugMatch?.[1] ?? '';
    const ids = await client.getPageIds(slug);

    if (!ids) {
      logger.debug({ slug }, 'tryGalleryApi: could not get page IDs');
      return null;
    }

    // Step 1: Upload all images via media API
    logger.info({ count: imagePaths.length }, 'tryGalleryApi: uploading images via media API');
    const mediaClient = createMediaUploadClient(subdomain);
    const uploadResults = await mediaClient.uploadImages(imagePaths, 3);

    const successfulUploads = uploadResults.filter(r => r.success && r.assetUrl);
    if (successfulUploads.length === 0) {
      logger.warn('tryGalleryApi: all image uploads failed');
      return null;
    }

    logger.info(
      { uploaded: successfulUploads.length, total: imagePaths.length },
      'tryGalleryApi: images uploaded',
    );

    // Step 2: Determine the target section (last section on the page)
    const data = await client.getPageSections(pageSectionsId);
    const sectionIndex = data.sections.length - 1;
    if (sectionIndex < 0) {
      logger.warn('tryGalleryApi: no sections found on page');
      return null;
    }

    // Step 3: Calculate grid layout based on galleryStyle
    const columns = galleryStyle === 'grid'
      ? (successfulUploads.length <= 4 ? 2 : 3)
      : 1; // slideshow and collage use full-width stacking

    const maxColumns = 24; // Squarespace Fluid Engine grid width
    const colWidth = Math.floor(maxColumns / columns);

    const imageSpecs = successfulUploads.map((upload, idx) => {
      // Find the original index to match altTexts
      const originalIndex = uploadResults.indexOf(upload);
      const altText = altTexts?.[originalIndex];

      if (galleryStyle === 'grid') {
        // Grid layout: arrange in rows of `columns` images
        const col = idx % columns;
        const startX = 1 + col * colWidth;
        const endX = col === columns - 1 ? maxColumns + 1 : startX + colWidth;

        return {
          assetUrl: upload.assetUrl!,
          altText,
          layout: {
            columns: colWidth,
            rowHeight: 8,
            gapRows: 2,
            startX,
            endX,
          },
        };
      } else {
        // Slideshow / collage: full-width stacking
        return {
          assetUrl: upload.assetUrl!,
          altText,
          layout: {
            columns: maxColumns,
            rowHeight: galleryStyle === 'slideshow' ? 10 : 8,
            gapRows: galleryStyle === 'collage' ? 1 : 2,
          },
        };
      }
    });

    // Step 4: Add all image blocks in a single batch PUT
    const batchResult = await client.addImageBlockBatch(
      pageSectionsId,
      ids.collectionId,
      sectionIndex,
      imageSpecs,
    );

    if (!batchResult.success) {
      logger.warn({ error: batchResult.error }, 'tryGalleryApi: batch add failed');
      return null;
    }

    const failedCount = imagePaths.length - successfulUploads.length;
    const failedNote = failedCount > 0 ? ` (${failedCount} upload(s) failed).` : '.';

    logger.info(
      { blocks: batchResult.blocks.length, sectionIndex, galleryStyle },
      'tryGalleryApi: gallery created successfully',
    );

    return {
      success: true,
      message: `addGalleryBlock: Added ${batchResult.blocks.length} images as ${galleryStyle} gallery via Content Save API (section index ${sectionIndex})${failedNote} Reload the page to see the change.`,
    };
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'tryGalleryApi: failed');
    return null;
  }
}
