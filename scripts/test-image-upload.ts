/**
 * End-to-end test: create a page, add an image block, upload an image, verify, then cleanup.
 *
 * Flow:
 * 1. Create a new blank page "Image Test" (slug: image-test)
 * 2. Navigate to it and enter edit mode
 * 3. Add a section, enter section edit mode, add an image block, upload an image
 * 4. Verify the image was uploaded (check for squarespace-cdn src)
 * 5. Save changes
 * 6. Cleanup: delete the test page
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import path from 'path';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, saveChanges } from '../src/automation/editor-actions.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const SITE_URL = 'https://tim-cox.squarespace.com';
const IMAGE_PATH = path.resolve('/Users/timcox/squarespace helper/storage/uploads/project-screenshots/menu-block-lovable-app.png');

const results: { step: string; success: boolean; detail: string }[] = [];

function log(step: string, success: boolean, detail: string) {
  results.push({ step, success, detail });
  console.log(`${success ? '[PASS]' : '[FAIL]'} ${step}: ${detail}`);
}

async function main() {
  const bm = getBrowserManager({ headless: false });
  let pageCreated = false;

  try {
    // ── Initialize and login ──
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();
    log('Login', true, 'Logged in successfully');

    // ══════════════════════════════════════════════════════════════
    // Phase 1: Create the test page
    // ══════════════════════════════════════════════════════════════
    console.log('\n=== Phase 1: Create test page ===');
    await page.goto(`${SITE_URL}/config/pages`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);
    await takeScreenshot(page, 'test-upload-pages-panel');

    // Check if "Image Test" page already exists (from a previous failed run)
    const existingPage = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-test="pages-panel-item"]');
      for (const item of items) {
        if (item.textContent?.trim().toLowerCase() === 'image test') {
          return true;
        }
      }
      return false;
    });

    if (existingPage) {
      console.log('Image Test page already exists from a previous run — will reuse it');
      pageCreated = true; // Mark for cleanup
      log('Create Page', true, 'Page already exists (reusing)');
    } else {
      // Click the "+" button next to "Not Linked" to add a page there
      // The "+" is visible in the pages panel next to the section header
      let addPageClicked = false;

      // Strategy 1: Find the "+" button via aria-label or text content using JS
      const addBtnLabel = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (ariaLabel.includes('add') && (ariaLabel.includes('page') || ariaLabel.includes('item'))) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.y < 400) {
              (btn as HTMLElement).click();
              return ariaLabel;
            }
          }
        }
        return null;
      });
      if (addBtnLabel) {
        console.log(`Clicked add button via JS: ${addBtnLabel}`);
        addPageClicked = true;
      }

      if (!addPageClicked) {
        // Strategy 2: The "+" button next to "Main Navigation" visible at ~(259, 170)
        // Click it directly by using the visible "+" icons in the panel
        // Dump all button info to understand what's available
        const btnInfo = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          return btns
            .filter(b => {
              const r = b.getBoundingClientRect();
              return r.y > 100 && r.y < 350 && r.x < 310;
            })
            .map(b => ({
              text: b.textContent?.trim().substring(0, 30),
              ariaLabel: b.getAttribute('aria-label'),
              x: Math.round(b.getBoundingClientRect().x),
              y: Math.round(b.getBoundingClientRect().y),
              w: Math.round(b.getBoundingClientRect().width),
              h: Math.round(b.getBoundingClientRect().height),
            }));
        });
        console.log('Buttons in pages panel:', JSON.stringify(btnInfo, null, 2));

        // Find the "+" button (should have "+" in text or a specific aria-label)
        // Based on the screenshot, the "+" next to "Main Navigation" is visible
        // Let's click it by finding the button whose textContent is "+" or empty and is near the header
        const clickedPlus = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          // Look for "+" icon buttons near section headers
          for (const btn of btns) {
            const rect = btn.getBoundingClientRect();
            const text = btn.textContent?.trim() || '';
            const label = btn.getAttribute('aria-label') || '';
            // The "+" button is small (around 20-30px wide) and in the top area
            if (rect.y > 140 && rect.y < 320 && rect.width < 50 && rect.width > 10) {
              // Check if it has a "+" path or icon
              const svg = btn.querySelector('svg');
              if (svg) {
                const paths = svg.querySelectorAll('path, line, use');
                // A "+" icon typically has crossing lines
                if (paths.length > 0 && !label.toLowerCase().includes('search') && !label.toLowerCase().includes('collapse') && !label.toLowerCase().includes('info')) {
                  // Skip collapse/chevron buttons (they tend to be at the far right)
                  if (rect.x < 280 && rect.x > 220) {
                    (btn as HTMLElement).click();
                    return { label, x: Math.round(rect.x), y: Math.round(rect.y) };
                  }
                }
              }
            }
          }
          return null;
        });

        if (clickedPlus) {
          console.log(`Clicked "+" button at (${clickedPlus.x}, ${clickedPlus.y}), label: "${clickedPlus.label}"`);
          addPageClicked = true;
        }
      }

      if (!addPageClicked) {
        // Strategy 3: Click at the known position of the "+" next to "Main Navigation"
        // From screenshot: "+" is at approximately (259, 170)
        console.log('Trying coordinate click at (259, 170) for Main Navigation "+"');
        await page.mouse.click(259, 170);
        await page.waitForTimeout(1500);
        // Check if a menu appeared
        const menuAppeared = await page.locator('text=Blank').first().isVisible({ timeout: 3000 }).catch(() => false)
          || await page.locator('[role="menu"], [role="dialog"], [role="listbox"]').first().isVisible({ timeout: 1000 }).catch(() => false);
        if (menuAppeared) {
          addPageClicked = true;
          console.log('Menu appeared after coordinate click');
        }
      }

      if (!addPageClicked) {
        // Strategy 4: Try the "+" next to "Not Linked" at approximately (259, 297)
        console.log('Trying coordinate click at (259, 297) for Not Linked "+"');
        await page.mouse.click(259, 297);
        await page.waitForTimeout(1500);
        addPageClicked = true; // Assume it worked, check for Blank button later
      }

      if (!addPageClicked) {
        log('Create Page', false, 'Could not find Add Page button');
        await takeScreenshot(page, 'test-upload-no-add-btn');
        throw new Error('Cannot create test page — Add Page button not found');
      }

      await page.waitForTimeout(2000);
      await takeScreenshot(page, 'test-upload-add-page-menu');

      // Click "Blank" page template
      let blankClicked = false;
      const blankBtn = page.locator('button:has-text("Blank")').first();
      if (await blankBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await blankBtn.click();
        blankClicked = true;
      }

      if (!blankClicked) {
        // Try clicking text "Blank" anywhere
        const blankText = page.locator('text=Blank').first();
        if (await blankText.isVisible({ timeout: 2000 }).catch(() => false)) {
          await blankText.click();
          blankClicked = true;
        }
      }

      if (!blankClicked) {
        // Alternative: click the first template option
        const templateBtn = page.locator('[data-test="page-type-option"]').first();
        if (await templateBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await templateBtn.click();
          blankClicked = true;
        }
      }

      if (!blankClicked) {
        log('Create Page', false, 'Could not find Blank template button');
        await takeScreenshot(page, 'test-upload-no-blank-btn');
        throw new Error('Cannot create test page — Blank template not found');
      }

      await page.waitForTimeout(2000);
      await takeScreenshot(page, 'test-upload-blank-clicked');

      // Fill the page title — the new page might auto-create with "New Page" title
      // and show a title editing field
      let titleFilled = false;
      for (const placeholder of ['Page Title', 'Title', 'Enter page title', 'Page title']) {
        const titleInput = page.locator(`input[placeholder*="${placeholder}"]`).first();
        if (await titleInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await titleInput.fill('Image Test');
          titleFilled = true;
          break;
        }
      }

      if (!titleFilled) {
        // Fallback: look for any visible text input in the page settings panel
        const inputs = page.locator('input[type="text"]');
        const inputCount = await inputs.count();
        for (let i = 0; i < inputCount; i++) {
          const inp = inputs.nth(i);
          if (await inp.isVisible({ timeout: 500 }).catch(() => false)) {
            const val = await inp.inputValue().catch(() => '');
            // If the input has "New Page" or is empty, fill our title
            if (val === '' || val.toLowerCase().includes('new page')) {
              await inp.fill('Image Test');
              titleFilled = true;
              break;
            }
          }
        }
      }

      if (titleFilled) {
        // Press Enter or click Done/Save to confirm
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
      } else {
        console.log('Could not find title input — page may have been created with default name');
        await page.waitForTimeout(2000);
      }

      pageCreated = true;
      log('Create Page', true, `Created page${titleFilled ? ' "Image Test"' : ' (default name)'}`);
      await takeScreenshot(page, 'test-upload-page-created');
    }

    // ══════════════════════════════════════════════════════════════
    // Phase 2: Navigate to the page and enter edit mode
    // ══════════════════════════════════════════════════════════════
    console.log('\n=== Phase 2: Navigate to page and enter edit mode ===');

    // Make sure we're on the pages panel
    await page.goto(`${SITE_URL}/config/pages`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Click on "Image Test" in the pages list
    const clickedPage = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-test="pages-panel-item"]');
      for (const item of items) {
        if (item.textContent?.toLowerCase().includes('image test')) {
          (item as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (!clickedPage) {
      log('Navigate to Page', false, 'Could not find "Image Test" in pages list');
      await takeScreenshot(page, 'test-upload-page-not-found');
      throw new Error('Test page not found in pages list');
    }

    log('Navigate to Page', true, 'Clicked "Image Test" in pages list');
    await page.waitForTimeout(4000);
    await takeScreenshot(page, 'test-upload-page-selected');

    // Enter edit mode
    await enterEditMode(page);
    await page.waitForTimeout(3000);
    log('Enter Edit Mode', true, 'Entered edit mode');
    await takeScreenshot(page, 'test-upload-edit-mode');

    // ══════════════════════════════════════════════════════════════
    // Phase 3: Add a section and image block
    // ══════════════════════════════════════════════════════════════
    console.log('\n=== Phase 3: Add section and image block ===');

    // Add a new section
    const addSectionResult = await executeAgentAction(page, { action: 'addSection' });
    log('Add Section', addSectionResult.success, addSectionResult.message?.substring(0, 120) ?? 'no message');
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'test-upload-section-added');

    if (!addSectionResult.success) {
      console.log('Section add failed, but continuing — blank page may already have a section');
    }

    // Enter section edit mode on the last section
    const enterSectionResult = await executeAgentAction(page, {
      action: 'enterSectionEditMode',
      sectionIndex: 'last',
    });
    log('Enter Section Edit', enterSectionResult.success, enterSectionResult.message?.substring(0, 120) ?? 'no message');
    await page.waitForTimeout(1500);
    await takeScreenshot(page, 'test-upload-section-edit');

    // Add image block with upload
    console.log('\n=== Adding image block with upload ===');
    const addImageResult = await executeAgentAction(page, {
      action: 'addImageBlock',
      imagePath: IMAGE_PATH,
      altText: 'Test upload image',
    });
    log('Add Image Block', addImageResult.success, addImageResult.message?.substring(0, 200) ?? 'no message');
    await takeScreenshot(page, 'test-upload-image-added');

    // ══════════════════════════════════════════════════════════════
    // Phase 4: Verify the image was uploaded
    // ══════════════════════════════════════════════════════════════
    console.log('\n=== Phase 4: Verify image upload ===');

    const sf = getSiteFrame(page);
    let imageVerified = false;
    if (sf) {
      // Check for uploaded image with CDN source
      const cdnImages = sf.locator('img[src*="squarespace-cdn"], img[src*="images.squarespace"]');
      const imgCount = await cdnImages.count().catch(() => 0);

      if (imgCount > 0) {
        const src = await cdnImages.first().getAttribute('src').catch(() => '');
        imageVerified = true;
        log('Verify Image', true, `Found ${imgCount} CDN image(s). src: ${src?.substring(0, 80)}...`);
      } else {
        // Also check for any images at all (might have a different src pattern during upload)
        const anyImages = sf.locator('.sqs-block-image img');
        const anyImgCount = await anyImages.count().catch(() => 0);
        if (anyImgCount > 0) {
          const src = await anyImages.first().getAttribute('src').catch(() => '');
          imageVerified = true;
          log('Verify Image', true, `Found ${anyImgCount} image(s) in block (non-CDN). src: ${src?.substring(0, 80)}...`);
        } else {
          log('Verify Image', false, 'No images found in the page content');
        }
      }
    } else {
      log('Verify Image', false, 'Site frame not found');
    }

    await takeScreenshot(page, 'test-upload-verification');

    // ══════════════════════════════════════════════════════════════
    // Phase 5: Save changes
    // ══════════════════════════════════════════════════════════════
    console.log('\n=== Phase 5: Save changes ===');

    // Press Escape to exit any editor panels first
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    const saveResult = await saveChanges(page);
    log('Save Changes', saveResult.success, saveResult.message);
    await takeScreenshot(page, 'test-upload-saved');

    // ══════════════════════════════════════════════════════════════
    // Phase 6: Cleanup — delete the test page
    // ══════════════════════════════════════════════════════════════
    console.log('\n=== Phase 6: Cleanup — delete test page ===');

    // Navigate back to pages panel
    await page.goto(`${SITE_URL}/config/pages`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Right-click or find settings for "Image Test" page to delete it
    // Strategy: click the gear/settings icon next to the page, then delete
    let deleteSuccess = false;

    // First, find and hover over the page item to reveal its settings gear
    const pageItems = page.locator('[data-test="pages-panel-item"]');
    const itemCount = await pageItems.count();
    for (let i = 0; i < itemCount; i++) {
      const item = pageItems.nth(i);
      const text = await item.textContent().catch(() => '');
      if (text?.toLowerCase().includes('image test')) {
        // Right-click to open context menu
        await item.click({ button: 'right' });
        await page.waitForTimeout(1000);

        // Look for "Delete" or "Remove" in the context menu
        const deleteBtn = page.locator('button:has-text("Delete"), [role="menuitem"]:has-text("Delete")').first();
        if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await deleteBtn.click();
          await page.waitForTimeout(1000);

          // Confirm deletion
          const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Delete"), button:has-text("Yes")').last();
          if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await confirmBtn.click();
            await page.waitForTimeout(2000);
            deleteSuccess = true;
          }
        }

        if (!deleteSuccess) {
          // Fallback: click the page, then use settings to delete
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);

          // Click the page to select it
          await item.click();
          await page.waitForTimeout(2000);

          // Look for settings gear or 3-dot menu
          const settingsBtn = page.locator('button[aria-label="Settings"], button[aria-label="Page Settings"], button:has-text("Settings")').first();
          if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await settingsBtn.click();
            await page.waitForTimeout(2000);

            // Scroll to bottom of settings panel and find Delete
            const deleteInSettings = page.locator('button:has-text("Delete Page"), button:has-text("Delete")');
            const delCount = await deleteInSettings.count();
            for (let d = 0; d < delCount; d++) {
              const btn = deleteInSettings.nth(d);
              if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await btn.click();
                await page.waitForTimeout(1500);

                // Confirm
                const confirmAgain = page.locator('button:has-text("Confirm"), button:has-text("Delete")').last();
                if (await confirmAgain.isVisible({ timeout: 2000 }).catch(() => false)) {
                  await confirmAgain.click();
                  await page.waitForTimeout(2000);
                  deleteSuccess = true;
                }
                break;
              }
            }
          }
        }

        break;
      }
    }

    if (!deleteSuccess) {
      // Last resort: navigate to page settings URL directly
      // Squarespace URL pattern: /config/pages/<page-id>/settings
      // We need to find the page ID from the URL when we clicked the page
      console.log('Direct delete strategies failed — trying URL-based approach');

      // Try the trash/disable approach
      const trashBtn = page.locator('button[aria-label="Move to Trash"], button:has-text("Move to Trash")').first();
      if (await trashBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await trashBtn.click();
        await page.waitForTimeout(1000);
        const confirmTrash = page.locator('button:has-text("Confirm"), button:has-text("Move")').last();
        if (await confirmTrash.isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirmTrash.click();
          deleteSuccess = true;
        }
      }
    }

    log('Delete Page', deleteSuccess, deleteSuccess ? 'Test page deleted' : 'Could not delete test page — manual cleanup needed');
    await takeScreenshot(page, 'test-upload-cleanup');

  } catch (err) {
    const msg = (err as Error).message;
    console.error('\nFatal error:', msg);
    log('Fatal', false, msg);
    try {
      const page = await bm.getPage();
      await takeScreenshot(page, 'test-upload-error');
    } catch { /* ignore */ }
  } finally {
    // ══════════════════════════════════════════════════════════════
    // Summary
    // ══════════════════════════════════════════════════════════════
    console.log('\n' + '═'.repeat(60));
    console.log('TEST RESULTS SUMMARY');
    console.log('═'.repeat(60));
    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    for (const r of results) {
      console.log(`  ${r.success ? 'PASS' : 'FAIL'} | ${r.step}: ${r.detail.substring(0, 100)}`);
    }
    console.log('─'.repeat(60));
    console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
    console.log('═'.repeat(60));

    await bm.close();
  }
}

main().catch(console.error);
