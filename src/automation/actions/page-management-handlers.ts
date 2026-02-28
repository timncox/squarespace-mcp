import { Page } from 'playwright';
import { logger } from '../../utils/logger.js';
import { navigateToPage, enterEditMode } from '../site-navigator.js';
import { getSiteFrame } from '../editor-actions.js';
import { errMsg } from '../../utils/errors.js';
import { tryCustomCssApi } from './handler-utils.js';
import { ContentSaveClient, createContentSaveClient } from '../../services/content-save.js';
import type { ActionResult } from './types.js';

// ─── Compound Action: createPage ─────────────────────────────────────────

/**
 * Compound action: create a new page in the Squarespace site.
 *
 * Squarespace page creation flow (discovered via live diagnostic):
 * 1. Navigate to the Pages panel
 * 2. Click the "+" / "Add Page" button → opens "Add a Page" dialog
 * 3. Click "Add Blank" → opens sub-menu with Page/Blog options
 * 4. Click "Page" (data-test="blank-page-option") → creates page with
 *    an inline title <input> already focused and pre-filled with "New Page"
 * 5. Type the desired title (Cmd+A to select all first) → press Enter
 *    to confirm — the page is now created in "Main Navigation" with
 *    the correct title. Optionally set slug via Page Settings afterward.
 *
 * IMPORTANT: After clicking "Page" in step 4, the title input is
 * immediately focused. Navigating away CANCELS the creation — the title
 * must be typed inline and confirmed with Enter BEFORE any navigation.
 */
export async function handleCreatePage(
  page: Page,
  action: { action: 'createPage'; title: string; slug?: string; template?: string },
): Promise<ActionResult> {
  const { title, slug, template } = action;

  // ── Step 1: Navigate to Pages panel ───────────────────────────────────
  logger.info({ title }, 'createPage[1/5]: navigating to pages panel');

  const currentUrl = page.url();
  const sqspMatch = currentUrl.match(/(https?:\/\/[^/]+\.squarespace\.com)/);
  if (!sqspMatch) {
    return {
      success: false,
      message: 'createPage step 1: Cannot determine site URL. Make sure you are on a Squarespace admin page.',
    };
  }
  const siteBaseUrl = sqspMatch[1];
  const pagesUrl = `${siteBaseUrl}/config/pages`;

  await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.locator('[data-test="pages-panel-item"]').first().waitFor({
      state: 'visible',
      timeout: 15000,
    });
    logger.info('createPage[1/5]: pages panel loaded');
  } catch {
    logger.warn('createPage[1/5]: pages panel items not detected — continuing with fixed wait');
    await page.waitForTimeout(5000);
  }

  // Count pages before creation for verification
  const pagesBefore = await page.locator('[data-test="pages-panel-item"]').count().catch(() => 0);

  // ── Step 2: Click the "+" / "Add Page" button ─────────────────────────
  logger.info('createPage[2/5]: clicking add page button');

  const addPageSelectors = [
    '[data-test="add-page"]',
    '[data-test="pages-add-page"]',
    'button[aria-label="Add page"]',
    'button[aria-label="Add Page"]',
    'button[aria-label="add page"]',
    'button:has-text("Add Page")',
    '[class*="pages"] button[aria-label="Add"]',
    '[class*="Pages"] button:has-text("+")',
  ];

  let addClicked = false;
  for (const selector of addPageSelectors) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        addClicked = true;
        logger.info({ selector }, 'createPage[2/5]: clicked add page button');
        break;
      }
    } catch { /* Try next */ }
  }

  // Fallback: hover over the main pages section header to reveal the + button
  if (!addClicked) {
    const pagesHeader = page.locator('text=Main Navigation, text=Pages, text=MAIN NAVIGATION').first();
    const headerVisible = await pagesHeader.isVisible({ timeout: 2000 }).catch(() => false);
    if (headerVisible) {
      await pagesHeader.hover();
      await page.waitForTimeout(800);

      for (const selector of addPageSelectors) {
        try {
          const btn = page.locator(selector).first();
          const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
          if (visible) {
            await btn.click({ timeout: 3000 });
            addClicked = true;
            logger.info({ selector }, 'createPage[2/5]: clicked add page button after hover');
            break;
          }
        } catch { /* Try next */ }
      }
    }
  }

  if (!addClicked) {
    return {
      success: false,
      message: 'createPage step 2: Add page button not found in pages panel. Try hovering over the pages section header.',
    };
  }
  await page.waitForTimeout(1500);

  // ── Step 3: Click "Add Blank" in the "Add a Page" dialog ──────────────
  logger.info({ template: template || 'Blank' }, 'createPage[3/5]: selecting page template');

  if (template && template.toLowerCase() !== 'blank') {
    // Try to find and click the specified template
    const templateSelectors = [
      `a:has-text("${template}")`,
      `button:has-text("${template}")`,
      `[data-test*="${template.toLowerCase()}"]`,
      `text="${template}"`,
    ];

    let templateClicked = false;
    for (const selector of templateSelectors) {
      try {
        const btn = page.locator(selector).first();
        const visible = await btn.isVisible({ timeout: 3000 }).catch(() => false);
        if (visible) {
          await btn.click({ timeout: 3000 });
          templateClicked = true;
          logger.info({ selector, template }, 'createPage[3/5]: selected template');
          break;
        }
      } catch { /* Try next */ }
    }
    if (!templateClicked) {
      logger.warn({ template }, 'createPage[3/5]: template not found, falling back to Add Blank');
    }
  }

  // Click "Add Blank" — this is an <a> tag, not a <button>
  const addBlankSelectors = [
    '[data-test="add-blank-options-button"]',
    'a:has-text("Add Blank")',
    'button:has-text("Add Blank")',
    ':has-text("Add Blank")',
    // Legacy selectors in case UI changes
    'button:has-text("Blank")',
    '[data-test="blank-page"]',
  ];

  let addBlankClicked = false;
  for (const selector of addBlankSelectors) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 3000 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        addBlankClicked = true;
        logger.info({ selector }, 'createPage[3/5]: clicked Add Blank');
        break;
      }
    } catch { /* Try next */ }
  }

  if (!addBlankClicked) {
    return {
      success: false,
      message: 'createPage step 3: "Add Blank" button not found in the Add a Page dialog.',
    };
  }
  await page.waitForTimeout(1500);

  // ── Step 4: Click "Page" in the sub-menu → inline title input appears ─
  // After clicking "Add Blank", a sub-menu shows "Page" and "Blog" as <LI>
  // elements. Clicking "Page" creates the page and auto-focuses an inline
  // <input type="text"> with value "New Page" for immediate renaming.
  logger.info('createPage[4/5]: clicking "Page" in Add Blank sub-menu');

  // Prefer the data-test selector which is an <LI> element
  const pageTypeSelectors = [
    '[data-test="blank-page-option"]',
    'li:has-text("Page")',
    'a:has-text("Page")',
    'button:has-text("Page")',
    'text="Page"',
  ];

  let pageTypeClicked = false;
  for (const selector of pageTypeSelectors) {
    try {
      const candidates = page.locator(selector);
      const count = await candidates.count();
      for (let i = 0; i < count; i++) {
        const candidate = candidates.nth(i);
        const visible = await candidate.isVisible({ timeout: 2000 }).catch(() => false);
        if (!visible) continue;
        const text = await candidate.innerText().catch(() => '');
        // Exact match for "Page" (not "Add Page", "Blog Page", etc.)
        if (text.trim() === 'Page') {
          await candidate.click({ timeout: 3000 });
          pageTypeClicked = true;
          logger.info({ selector, index: i }, 'createPage[4/5]: clicked "Page" in sub-menu');
          break;
        }
      }
      if (pageTypeClicked) break;
    } catch { /* Try next */ }
  }

  if (!pageTypeClicked) {
    return {
      success: false,
      message: 'createPage step 4: "Page" option not found in the Add Blank sub-menu. The sub-menu should show "Page" and "Blog" options.',
    };
  }

  // Wait for page to be created and the inline title input to be focused
  await page.waitForTimeout(2000);

  // ── Step 5: Type title inline and confirm ─────────────────────────────
  // After step 4, an <input type="text"> is auto-focused with value "New Page".
  // We select all (Cmd+A) and type the desired title, then press Enter.
  logger.info({ title }, 'createPage[5/5]: typing title inline and confirming');

  // Verify the focused element is an input
  const focusedTag = await page.evaluate(() => document.activeElement?.tagName || '').catch(() => '');
  if (focusedTag !== 'INPUT') {
    // Try to find the title input manually
    logger.warn({ focusedTag }, 'createPage[5/5]: expected INPUT to be focused, trying to find it');

    const titleInput = page.locator('input[type="text"][placeholder="New Page"], input[type="text"][value="New Page"]').first();
    const inputVisible = await titleInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (inputVisible) {
      await titleInput.click();
      await page.waitForTimeout(200);
      logger.info('createPage[5/5]: manually focused title input');
    } else {
      // Last resort: look for any visible text input near the top of the page panel
      const allInputs = page.locator('input[type="text"]');
      const inputCount = await allInputs.count();
      let found = false;
      for (let i = 0; i < inputCount; i++) {
        const inp = allInputs.nth(i);
        const visible = await inp.isVisible().catch(() => false);
        if (!visible) continue;
        const val = await inp.inputValue().catch(() => '');
        if (val === 'New Page' || val === '') {
          await inp.click();
          found = true;
          logger.info({ index: i, value: val }, 'createPage[5/5]: found title input by scanning');
          break;
        }
      }
      if (!found) {
        return {
          success: false,
          message: 'createPage step 5: Title input not found after page creation. The page may have been created but could not be renamed.',
        };
      }
    }
  }

  // Select all text and type the new title
  await page.keyboard.press('Meta+a');
  await page.waitForTimeout(100);
  await page.keyboard.type(title, { delay: 30 });
  await page.waitForTimeout(300);

  // Press Enter to confirm the title
  await page.keyboard.press('Enter');
  logger.info({ title }, 'createPage[5/5]: typed title and pressed Enter');
  await page.waitForTimeout(2000);

  // Optionally set URL slug via Page Settings
  if (slug) {
    logger.info({ slug }, 'createPage[5/5]: setting slug via Page Settings');

    // Find the page we just created and open its settings via gear icon
    const items = page.locator('[data-test="pages-panel-item"]');
    const itemCount = await items.count();
    let targetIndex = -1;

    for (let i = 0; i < itemCount; i++) {
      const text = await items.nth(i).innerText().catch(() => '');
      if (text.trim() === title) {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex >= 0) {
      const targetItem = items.nth(targetIndex);
      await targetItem.scrollIntoViewIfNeeded();
      const targetBox = await targetItem.boundingBox();
      if (targetBox) {
        // Hover to reveal gear icon
        await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
        await page.waitForTimeout(1000);

        // Click gear icon using Y-proximity
        const gearBtns = page.locator('button[data-testid="settings-icon"]');
        const gearCount = await gearBtns.count();
        for (let g = 0; g < gearCount; g++) {
          const box = await gearBtns.nth(g).boundingBox().catch(() => null);
          if (!box) continue;
          const yDist = Math.abs((box.y + box.height / 2) - (targetBox.y + targetBox.height / 2));
          if (yDist < 30) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            logger.info('createPage[5/5]: opened page settings for slug');
            await page.waitForTimeout(2000);

            // Set slug
            const slugInput = page.locator('input[aria-label="URL Slug"]').first();
            if (await slugInput.isVisible({ timeout: 3000 }).catch(() => false)) {
              await slugInput.click({ clickCount: 3 });
              await page.waitForTimeout(100);
              await slugInput.fill(slug);
              logger.info({ slug }, 'createPage[5/5]: set URL slug');
            }

            // Close settings panel
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);
            break;
          }
        }
      }
    }
  }

  // Verify the page was created with the correct title
  // Re-navigate to pages panel for a clean read
  await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const pageCreated = await page.evaluate((pageTitle: string) => {
    const lowerTitle = pageTitle.toLowerCase();
    const items = document.querySelectorAll('[data-test="pages-panel-item"]');
    for (const item of items) {
      if (item.textContent?.toLowerCase().includes(lowerTitle)) {
        return true;
      }
    }
    return false;
  }, title).catch(() => false);

  if (pageCreated) {
    return {
      success: true,
      message: `createPage: Created new page "${title}"${slug ? ` with slug "/${slug}"` : ''}. The page now appears in the pages list.`,
    };
  }

  // Check if count increased even if title doesn't match
  const pagesAfter = await page.locator('[data-test="pages-panel-item"]').count().catch(() => 0);
  if (pagesAfter > pagesBefore) {
    return {
      success: true,
      message: `createPage: Page created (count ${pagesBefore} → ${pagesAfter}) but title may not have been set to "${title}". Check the pages panel.`,
    };
  }

  return {
    success: false,
    message: `createPage: Could not verify page creation. Page count unchanged (${pagesBefore}).`,
  };
}

// ─── Compound Action: deletePage ─────────────────────────────────────────

/**
 * Delete a page by its title via the Squarespace Pages panel.
 *
 * Squarespace pages panel shows a delete icon (data-test="delete-item")
 * when hovering over a page row — no need to open the settings panel.
 *
 * Steps:
 * 1. Navigate to /config/pages
 * 2. Find the page by title in the pages list
 * 3. Hover the page item to reveal action icons
 * 4. Click the delete icon (data-test="delete-item") using Y-proximity
 * 5. Confirm deletion in the confirmation dialog
 * 6. Verify the page is removed from the pages list
 */
export async function handleDeletePage(
  page: Page,
  action: { action: 'deletePage'; title: string },
): Promise<ActionResult> {
  const { title } = action;

  // ── Step 1: Navigate to pages panel ───────────────────────────────────
  logger.info({ title }, 'deletePage[1/6]: navigating to pages panel');

  const currentUrl = page.url();
  const sqspMatch = currentUrl.match(/(https?:\/\/[^/]+\.squarespace\.com)/);
  if (!sqspMatch) {
    return {
      success: false,
      message: 'deletePage step 1: Cannot determine site URL. Make sure you are on a Squarespace admin page.',
    };
  }
  const siteBaseUrl = sqspMatch[1];
  const pagesUrl = `${siteBaseUrl}/config/pages`;

  await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.locator('[data-test="pages-panel-item"]').first().waitFor({
      state: 'visible',
      timeout: 15000,
    });
    logger.info('deletePage[1/6]: pages panel loaded');
  } catch {
    logger.warn('deletePage[1/6]: pages panel items not detected — continuing with fixed wait');
    await page.waitForTimeout(5000);
  }

  // ── Step 2: Find the page by title ────────────────────────────────────
  logger.info({ title }, 'deletePage[2/6]: finding page by title');

  // Search from bottom up (new pages tend to be at the end)
  const allItems = page.locator('[data-test="pages-panel-item"]');
  const itemCount = await allItems.count();
  let targetIndex = -1;

  for (let i = itemCount - 1; i >= 0; i--) {
    const text = await allItems.nth(i).innerText().catch(() => '');
    if (text.trim() === title) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) {
    // Try case-insensitive partial match as fallback
    const lowerTitle = title.toLowerCase();
    for (let i = itemCount - 1; i >= 0; i--) {
      const text = await allItems.nth(i).innerText().catch(() => '');
      if (text.trim().toLowerCase().includes(lowerTitle)) {
        targetIndex = i;
        break;
      }
    }
  }

  if (targetIndex === -1) {
    return {
      success: false,
      message: `deletePage step 2: Page "${title}" not found in pages panel. Check the exact page title.`,
    };
  }
  logger.info({ index: targetIndex }, 'deletePage[2/6]: found page item');

  // ── Step 3: Hover the page item to reveal action icons ────────────────
  logger.info({ title }, 'deletePage[3/6]: hovering page item to reveal delete icon');

  const pageItem = allItems.nth(targetIndex);
  await pageItem.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  const itemBox = await pageItem.boundingBox();
  if (!itemBox) {
    return {
      success: false,
      message: 'deletePage step 3: Could not get bounding box of the page item.',
    };
  }

  const itemCenterX = itemBox.x + itemBox.width / 2;
  const itemCenterY = itemBox.y + itemBox.height / 2;
  await page.mouse.move(itemCenterX, itemCenterY);
  await page.waitForTimeout(800);
  logger.info({ x: Math.round(itemCenterX), y: Math.round(itemCenterY) }, 'deletePage[3/6]: hovered page item');

  // ── Step 4: Click the delete icon ─────────────────────────────────────
  logger.info({ title }, 'deletePage[4/6]: clicking delete icon');

  let deleteClicked = false;

  // The delete icon has data-test="delete-item" and appears on hover.
  // Use Y-proximity matching to click the one on the correct row.
  const deleteIconSelectors = [
    '[data-test="delete-item"]',
    'button[aria-label="Delete"]',
    'button[aria-label="Delete Page"]',
  ];

  for (const selector of deleteIconSelectors) {
    try {
      const buttons = page.locator(selector);
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const btn = buttons.nth(i);
        const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
        if (!visible) continue;

        const btnBox = await btn.boundingBox();
        if (!btnBox) continue;

        const yDiff = Math.abs((btnBox.y + btnBox.height / 2) - itemCenterY);
        if (yDiff < 30) {
          await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
          deleteClicked = true;
          logger.info({ selector, yDiff: Math.round(yDiff) }, 'deletePage[4/6]: clicked delete icon via proximity');
          break;
        }
      }
      if (deleteClicked) break;
    } catch { /* Try next selector */ }
  }

  // Fallback: click the first visible delete-item button
  if (!deleteClicked) {
    for (const selector of deleteIconSelectors) {
      try {
        const btn = page.locator(selector).first();
        const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await btn.click({ timeout: 3000 });
          deleteClicked = true;
          logger.info({ selector }, 'deletePage[4/6]: clicked first visible delete icon (fallback)');
          break;
        }
      } catch { /* Try next */ }
    }
  }

  // DOM fallback: find delete button near the page item in the DOM tree
  if (!deleteClicked) {
    const evalClicked = await page.evaluate((itemIndex: number) => {
      const items = document.querySelectorAll('[data-test="pages-panel-item"]');
      const item = items[itemIndex];
      if (!item) return false;

      // Walk up the DOM to find a sibling delete button
      let parent = item.parentElement;
      for (let depth = 0; depth < 5 && parent; depth++) {
        const deleteBtn = parent.querySelector('[data-test="delete-item"]');
        if (deleteBtn) {
          (deleteBtn as HTMLElement).click();
          return true;
        }
        parent = parent.parentElement;
      }
      return false;
    }, targetIndex);

    if (evalClicked) {
      deleteClicked = true;
      logger.info('deletePage[4/6]: clicked delete icon via DOM traversal fallback');
    }
  }

  if (!deleteClicked) {
    return {
      success: false,
      message: `deletePage step 4: Could not find delete icon for page "${title}". Try hovering the page row to reveal the delete icon.`,
    };
  }
  await page.waitForTimeout(1500);

  // ── Step 5: Confirm deletion in the confirmation dialog ───────────────
  logger.info({ title }, 'deletePage[5/6]: confirming deletion in dialog');

  let confirmed = false;

  // Wait a moment for the confirmation dialog to appear
  await page.waitForTimeout(1000);

  // Click the confirmation button (Confirm / Delete / Yes / OK)
  const confirmSelectors = [
    'button:has-text("Confirm")',
    'button:has-text("CONFIRM")',
    'button:has-text("Delete")',
    'button:has-text("DELETE")',
    'button:has-text("Yes")',
    'button:has-text("YES")',
    'button:has-text("OK")',
    '[data-test="confirm-delete"]',
    '[data-test="confirm"]',
  ];

  // Try dialog-scoped first (most reliable)
  try {
    const dialog = page.locator('[role="dialog"], [class*="modal"], [class*="Modal"]').first();
    const dialogVisible = await dialog.isVisible({ timeout: 3000 }).catch(() => false);
    if (dialogVisible) {
      for (const sel of confirmSelectors) {
        try {
          const btn = dialog.locator(sel).first();
          const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
          if (visible) {
            await btn.click({ timeout: 3000 });
            confirmed = true;
            logger.info({ selector: sel }, 'deletePage[5/6]: clicked confirmation button in dialog');
            break;
          }
        } catch { /* Try next */ }
      }
    }
  } catch { /* No dialog found */ }

  // Fallback: try global button search
  if (!confirmed) {
    for (const sel of confirmSelectors) {
      try {
        const buttons = page.locator(sel);
        const count = await buttons.count();
        // Click the LAST visible match (dialog buttons render after trigger buttons)
        for (let i = count - 1; i >= 0; i--) {
          const btn = buttons.nth(i);
          const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
          if (visible) {
            await btn.click({ timeout: 3000 });
            confirmed = true;
            logger.info({ selector: sel, index: i }, 'deletePage[5/6]: clicked confirmation button (global fallback)');
            break;
          }
        }
        if (confirmed) break;
      } catch { /* Try next */ }
    }
  }

  if (!confirmed) {
    logger.warn('deletePage[5/6]: could not confirm deletion dialog — proceeding to verification');
  }
  await page.waitForTimeout(2000);

  // ── Step 6: Verify the page is gone from the pages list ───────────────
  logger.info({ title }, 'deletePage[6/6]: verifying page was deleted');

  // Re-navigate to pages panel to refresh the list
  await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.locator('[data-test="pages-panel-item"]').first().waitFor({
      state: 'visible',
      timeout: 10000,
    });
  } catch {
    await page.waitForTimeout(3000);
  }

  // Check if the page still exists (exact match)
  const pageStillExists = await page.evaluate((searchTitle: string) => {
    const items = document.querySelectorAll('[data-test="pages-panel-item"]');
    for (const item of items) {
      if (item.textContent?.trim() === searchTitle) {
        return true;
      }
    }
    return false;
  }, title);

  if (pageStillExists) {
    return {
      success: false,
      message: `deletePage step 6: Page "${title}" still appears in the pages list after deletion attempt. The deletion may have failed or the confirmation dialog was not properly handled.`,
    };
  }

  logger.info({ title }, 'deletePage[6/6]: page confirmed deleted');
  return {
    success: true,
    message: `deletePage: Successfully deleted page "${title}". The page no longer appears in the pages list.`,
  };
}

// ─── switchPage Handler ──────────────────────────────────────────────────

/**
 * Navigate to a different page within the current site and enter edit mode.
 * Enables multi-page workflows within a single task.
 */
export async function handleSwitchPage(
  page: Page,
  action: { action: 'switchPage'; pageSlug: string },
): Promise<ActionResult> {
  const { pageSlug } = action;

  // Extract siteBaseUrl from the current URL
  const currentUrl = page.url();
  const siteBaseMatch = currentUrl.match(/^(https?:\/\/[^/]+)/);
  if (!siteBaseMatch) {
    return { success: false, message: `switchPage: could not determine site base URL from "${currentUrl}"` };
  }
  const siteBaseUrl = siteBaseMatch[1];

  // Build a minimal ClientConfig for navigateToPage
  const slugToTitle = (slug: string): string =>
    slug.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

  const client = {
    id: 'dynamic',
    name: 'dynamic',
    aliases: [] as string[],
    contactEmails: [] as string[],
    site: {
      adminUrl: `${siteBaseUrl}/config/website`,
      pages: [{ slug: pageSlug, title: slugToTitle(pageSlug), types: ['general'] }],
    },
  };

  try {
    await navigateToPage(page, client, pageSlug);
    await enterEditMode(page);
    return {
      success: true,
      message: `switchPage: navigated to "/${pageSlug}" and entered edit mode`,
    };
  } catch (err) {
    return {
      success: false,
      message: `switchPage: failed to navigate to "/${pageSlug}" — ${errMsg(err)}`,
    };
  }
}

// ─── editPageSEO Handler ─────────────────────────────────────────────────

/**
 * Edit the SEO title and/or description for a page via its settings panel.
 */
export async function handleEditPageSEO(
  page: Page,
  action: { action: 'editPageSEO'; pageSlug: string; seoTitle?: string; seoDescription?: string },
): Promise<ActionResult> {
  const { pageSlug, seoTitle, seoDescription } = action;

  if (!seoTitle && !seoDescription) {
    return { success: false, message: 'editPageSEO: must provide at least seoTitle or seoDescription' };
  }

  // Navigate to the pages panel
  const currentUrl = page.url();
  const siteBaseMatch = currentUrl.match(/^(https?:\/\/[^/]+)/);
  if (!siteBaseMatch) {
    return { success: false, message: `editPageSEO: could not determine site base URL from "${currentUrl}"` };
  }
  const siteBaseUrl = siteBaseMatch[1];
  const pagesUrl = `${siteBaseUrl}/config/pages`;

  await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Find and click the target page
  const slugToTitle = (slug: string): string =>
    slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const pageTitle = slugToTitle(pageSlug);

  const clicked = await page.evaluate((title) => {
    const lowerTitle = title.toLowerCase();
    const items = document.querySelectorAll('[data-test="pages-panel-item"]');
    for (const item of items) {
      if (item.textContent?.toLowerCase().includes(lowerTitle)) {
        (item as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, pageTitle);

  if (!clicked) {
    return { success: false, message: `editPageSEO: page "${pageTitle}" not found in pages panel` };
  }
  await page.waitForTimeout(2000);

  // Click the settings gear icon for this page
  const settingsSelectors = [
    'button[aria-label="Settings"]',
    'button[aria-label="Page Settings"]',
    '[data-test="page-settings"]',
    'button:has-text("Settings")',
    '[aria-label="settings"]',
  ];

  let settingsClicked = false;
  for (const sel of settingsSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await btn.click();
      settingsClicked = true;
      break;
    }
  }

  if (!settingsClicked) {
    return { success: false, message: 'editPageSEO: could not find page settings button' };
  }
  await page.waitForTimeout(2000);

  // Click the SEO tab
  const seoTabSelectors = [
    'button:has-text("SEO")',
    'a:has-text("SEO")',
    '[data-test="seo-tab"]',
    'button:has-text("Search Engine Optimization")',
  ];

  for (const sel of seoTabSelectors) {
    const tab = page.locator(sel).first();
    const visible = await tab.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await tab.click();
      await page.waitForTimeout(1000);
      break;
    }
  }

  const updates: string[] = [];

  // Fill SEO title
  if (seoTitle) {
    const titleSelectors = [
      'input[name="seoTitle"]',
      'input[placeholder*="SEO title"]',
      'input[placeholder*="Page title"]',
      'input[data-test="seo-title"]',
    ];

    for (const sel of titleSelectors) {
      const input = page.locator(sel).first();
      const visible = await input.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await input.click({ clickCount: 3 });
        await input.fill(seoTitle);
        updates.push(`SEO title → "${seoTitle}"`);
        break;
      }
    }
  }

  // Fill SEO description
  if (seoDescription) {
    const descSelectors = [
      'textarea[name="seoDescription"]',
      'textarea[placeholder*="SEO description"]',
      'textarea[data-test="seo-description"]',
      'textarea[placeholder*="description"]',
    ];

    for (const sel of descSelectors) {
      const input = page.locator(sel).first();
      const visible = await input.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await input.click({ clickCount: 3 });
        await input.fill(seoDescription);
        updates.push(`SEO description → "${seoDescription.substring(0, 60)}..."`);
        break;
      }
    }
  }

  // Save settings
  const saveSelectors = ['button:has-text("Save")', 'button:has-text("Done")', 'button:has-text("Apply")'];
  for (const sel of saveSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await btn.click();
      await page.waitForTimeout(1000);
      break;
    }
  }

  if (updates.length === 0) {
    return { success: false, message: 'editPageSEO: could not find SEO input fields in the settings panel' };
  }

  return {
    success: true,
    message: `editPageSEO: updated ${updates.join(', ')} for page "/${pageSlug}"`,
  };
}

// ─── editCustomCSS Handler ───────────────────────────────────────────────

/**
 * Add or replace site-wide custom CSS via the Design > Custom CSS panel.
 */
export async function handleEditCustomCSS(
  page: Page,
  action: { action: 'editCustomCSS'; css: string; mode: 'append' | 'replace' },
): Promise<ActionResult> {
  const { css, mode } = action;

  // Step 0: Try Content Save API first (much faster than CodeMirror UI)
  const apiResult = await tryCustomCssApi(page, css, mode);
  if (apiResult) return apiResult;
  logger.info('editCustomCSS: API fast path failed, falling back to CodeMirror UI');

  // Navigate to Custom CSS page
  const currentUrl = page.url();
  const siteBaseMatch = currentUrl.match(/^(https?:\/\/[^/]+)/);
  if (!siteBaseMatch) {
    return { success: false, message: `editCustomCSS: could not determine site base URL from "${currentUrl}"` };
  }
  const siteBaseUrl = siteBaseMatch[1];
  const cssUrl = `${siteBaseUrl}/config/design/custom-css`;

  await page.goto(cssUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Find the CSS editor — CodeMirror or textarea
  const editorSelectors = [
    '.CodeMirror',
    'textarea[data-test="custom-css"]',
    '.custom-css-editor textarea',
    'textarea.code-editor',
  ];

  let editorFound = false;
  for (const sel of editorSelectors) {
    const editor = page.locator(sel).first();
    const visible = await editor.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      editorFound = true;

      if (sel === '.CodeMirror') {
        // CodeMirror editor — click to focus, then use keyboard
        await editor.click();
        await page.waitForTimeout(300);

        if (mode === 'replace') {
          // Select all and delete
          await page.keyboard.press('Meta+a');
          await page.waitForTimeout(100);
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(100);
        } else {
          // Append: go to end
          await page.keyboard.press('Meta+End');
          await page.keyboard.press('Enter');
        }

        // Type the CSS
        await page.keyboard.type(css, { delay: 5 });
      } else {
        // Regular textarea
        if (mode === 'replace') {
          await editor.fill(css);
        } else {
          const current = await editor.inputValue().catch(() => '');
          await editor.fill(current + '\n' + css);
        }
      }

      break;
    }
  }

  if (!editorFound) {
    return { success: false, message: 'editCustomCSS: could not find the CSS editor. The Design > Custom CSS panel may have a different layout.' };
  }

  // Save via Ctrl/Cmd+S
  await page.keyboard.press('Meta+s');
  await page.waitForTimeout(1500);

  return {
    success: true,
    message: `editCustomCSS: ${mode === 'replace' ? 'replaced' : 'appended'} ${css.length} characters of CSS. Verify visually.`,
  };
}

// ─── createBlogPost Handler ──────────────────────────────────────────────

/**
 * Create a new blog post in a blog collection.
 */
export async function handleCreateBlogPost(
  page: Page,
  action: { action: 'createBlogPost'; blogPageSlug: string; title: string; content?: string; draft?: boolean },
): Promise<ActionResult> {
  const { blogPageSlug, title, content, draft = true } = action;

  // API fast path — try creating the post via ContentSaveClient (~1s vs ~5-10min UI)
  const sessionHealth = ContentSaveClient.checkSessionHealth();
  if (sessionHealth.exists && sessionHealth.hasCrumb && !sessionHealth.isStale) {
    try {
      const subdomain = new URL(page.url()).hostname.replace('.squarespace.com', '');
      const client = createContentSaveClient(subdomain);
      const meta = await client.getPageMetadata(blogPageSlug);
      if (meta?.collectionId) {
        const result = await client.createBlogPost(meta.collectionId, title, {
          body: content,
          draft: draft ?? true,
        });
        if (result.success) {
          logger.info({ itemId: result.itemId }, 'handleCreateBlogPost: created via API fast path');
          return {
            success: true,
            message: `Created blog post "${title}" via API`,
          };
        }
        if (result.endpointAvailable === false) {
          logger.debug('handleCreateBlogPost: blog post API endpoint not available, falling back to UI');
        } else {
          logger.warn({ error: result.error }, 'handleCreateBlogPost: API failed, falling back to UI');
        }
      }
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'handleCreateBlogPost: API fast path error, falling back to UI');
    }
  }
  // ↓ Existing UI automation continues below

  // Navigate to pages panel
  const currentUrl = page.url();
  const siteBaseMatch = currentUrl.match(/^(https?:\/\/[^/]+)/);
  if (!siteBaseMatch) {
    return { success: false, message: `createBlogPost: could not determine site base URL from "${currentUrl}"` };
  }
  const siteBaseUrl = siteBaseMatch[1];
  const pagesUrl = `${siteBaseUrl}/config/pages`;

  await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Find and click the blog collection
  const slugToTitle = (slug: string): string =>
    slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const blogTitle = slugToTitle(blogPageSlug);

  const blogClicked = await page.evaluate((title) => {
    const lowerTitle = title.toLowerCase();
    const items = document.querySelectorAll('[data-test="pages-panel-item"]');
    for (const item of items) {
      if (item.textContent?.toLowerCase().includes(lowerTitle)) {
        (item as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, blogTitle);

  if (!blogClicked) {
    return { success: false, message: `createBlogPost: blog collection "${blogTitle}" not found in pages panel` };
  }
  await page.waitForTimeout(2000);

  // Click "+" or "Add Post" button
  const addPostSelectors = [
    'button[aria-label="Add post"]',
    'button[aria-label="Add Post"]',
    'button:has-text("+")',
    '[data-test="add-blog-post"]',
    'button:has-text("Add Post")',
    'button:has-text("Create Post")',
  ];

  let addClicked = false;
  for (const sel of addPostSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await btn.click();
      addClicked = true;
      break;
    }
  }

  if (!addClicked) {
    // Try hovering over the blog panel to reveal the + button
    const blogHeader = page.locator('[data-test="pages-panel-header"]').first();
    if (await blogHeader.isVisible({ timeout: 1000 }).catch(() => false)) {
      await blogHeader.hover();
      await page.waitForTimeout(500);

      for (const sel of addPostSelectors) {
        const btn = page.locator(sel).first();
        const visible = await btn.isVisible({ timeout: 1000 }).catch(() => false);
        if (visible) {
          await btn.click();
          addClicked = true;
          break;
        }
      }
    }
  }

  if (!addClicked) {
    return { success: false, message: 'createBlogPost: could not find "Add Post" button' };
  }
  await page.waitForTimeout(3000);

  // Fill in the title
  const titleSelectors = [
    'input[placeholder*="Title"]',
    'input[placeholder*="title"]',
    'input[data-test="post-title"]',
    'input[name="title"]',
    '.blog-post-title input',
    'h1[contenteditable="true"]',
  ];

  let titleFilled = false;
  for (const sel of titleSelectors) {
    const input = page.locator(sel).first();
    const visible = await input.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      const isContentEditable = await input.evaluate((el) => el.getAttribute('contenteditable') === 'true').catch(() => false);
      if (isContentEditable) {
        await input.click();
        await page.keyboard.type(title, { delay: 20 });
      } else {
        await input.fill(title);
      }
      titleFilled = true;
      break;
    }
  }

  if (!titleFilled) {
    return { success: false, message: 'createBlogPost: could not find the title input field' };
  }

  // Optionally add content
  if (content) {
    // Tab or click into the content area
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    await page.keyboard.type(content, { delay: 10 });
  }

  // Save as draft (default) or publish
  if (!draft) {
    const publishSelectors = [
      'button:has-text("Publish")',
      'button:has-text("PUBLISH")',
      '[data-test="publish-button"]',
    ];
    for (const sel of publishSelectors) {
      const btn = page.locator(sel).first();
      const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await btn.click();
        await page.waitForTimeout(2000);
        break;
      }
    }
  }

  // Save the post
  const saveSelectors = ['button:has-text("Save")', 'button:has-text("Done")'];
  for (const sel of saveSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await btn.click();
      await page.waitForTimeout(1000);
      break;
    }
  }

  return {
    success: true,
    message: `createBlogPost: created ${draft ? 'draft' : 'published'} post "${title}" in /${blogPageSlug}`,
  };
}
