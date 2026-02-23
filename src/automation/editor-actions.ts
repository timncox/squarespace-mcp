import { Page, Locator, FrameLocator } from 'playwright';
import { takeScreenshot } from '../utils/screenshot.js';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

/**
 * Get the Squarespace site frame (iframe) that contains the page content.
 * In the Squarespace admin, the page content is rendered inside an iframe
 * with id="sqs-site-frame". When in edit mode, all page content (text blocks,
 * menu blocks, images, etc.) lives inside this iframe.
 *
 * Returns a FrameLocator if the iframe exists, or null if we're not in the
 * admin panel (e.g., viewing the page directly).
 */
export function getSiteFrame(page: Page): FrameLocator | null {
  return page.frameLocator('#sqs-site-frame');
}

/**
 * Find all text content on the page matching a search string.
 * Searches both the main frame and the site iframe (sqs-site-frame)
 * since content may be in either location depending on the context.
 *
 * Returns locators for matching elements.
 */
export async function findTextOnPage(
  page: Page,
  searchText: string,
): Promise<Locator[]> {
  const matches: Locator[] = [];

  // Strategy 1: Search in the site iframe (most common in admin/edit mode)
  const siteFrame = getSiteFrame(page);
  if (siteFrame) {
    try {
      const iframeLocator = siteFrame.locator(`text=${searchText}`);
      const iframeCount = await iframeLocator.count();
      logger.info({ searchText, iframeCount }, 'Found text matches in site iframe');
      for (let i = 0; i < iframeCount; i++) {
        matches.push(iframeLocator.nth(i));
      }
    } catch {
      logger.debug('Could not search site iframe');
    }
  }

  // Strategy 2: Search in the main frame (fallback)
  if (matches.length === 0) {
    const mainLocator = page.locator(`text=${searchText}`);
    const mainCount = await mainLocator.count();
    logger.info({ searchText, mainCount }, 'Found text matches in main frame');
    for (let i = 0; i < mainCount; i++) {
      matches.push(mainLocator.nth(i));
    }
  }

  logger.info({ searchText, totalMatches: matches.length }, 'Total text matches found');
  return matches;
}

/**
 * Click on a block element to select it in the Fluid Engine editor.
 * The block toolbar should appear after clicking.
 */
export async function selectBlock(page: Page, element: Locator): Promise<void> {
  await element.click();
  await page.waitForTimeout(500); // Wait for selection UI to appear
  logger.info('Block selected');
}

/**
 * Delete the currently selected section using the section toolbar's Remove button.
 *
 * In the Squarespace Fluid Engine editor, clicking on page content selects
 * the containing SECTION (not individual blocks). A section toolbar appears
 * on the right side with: Edit Section, View Layouts, Duplicate, Save,
 * Move Up/Down, and REMOVE.
 *
 * We click the "Remove" button (aria-label="Remove Section") and then
 * confirm the deletion if a confirmation dialog appears.
 */
export async function deleteSelectedBlock(page: Page): Promise<void> {
  let clicked = false;

  // Primary: getByRole with exact name "Remove Section" (not generic "Remove")
  const removeSection = page.getByRole('button', { name: /remove section/i });
  if (await removeSection.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await removeSection.first().click();
    logger.info('Clicked Remove Section via getByRole');
    clicked = true;
  }

  // Fallback: CSS aria-label selector
  if (!clicked) {
    const ariaBtn = page.locator('button[aria-label="Remove Section"]');
    const count = await ariaBtn.count();
    // Try each one — only one should be for the selected section
    for (let i = 0; i < count; i++) {
      const btn = ariaBtn.nth(i);
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click();
        logger.info('Clicked Remove Section via aria-label');
        clicked = true;
        break;
      }
    }
  }

  // Fallback: force-click hidden button via JS (they're all visibility:hidden)
  if (!clicked) {
    const forceClicked = await page.evaluate(() => {
      const btns = document.querySelectorAll('button[aria-label="Remove Section"]');
      // Find the one associated with the selected section
      // The selected section has a visible parent container
      for (const btn of btns) {
        const parent = btn.closest('[class*="section"]') || btn.parentElement;
        if (parent) {
          (btn as HTMLElement).style.setProperty('visibility', 'visible', 'important');
          (btn as HTMLElement).click();
          return true;
        }
      }
      // Last resort: click the first one
      if (btns.length > 0) {
        (btns[0] as HTMLElement).style.setProperty('visibility', 'visible', 'important');
        (btns[0] as HTMLElement).click();
        return true;
      }
      return false;
    });
    if (forceClicked) {
      logger.info('Clicked Remove Section via force-reveal JS');
      clicked = true;
    }
  }

  if (!clicked) {
    logger.warn('Remove Section button not found — trying keyboard Delete');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(500);
    await page.keyboard.press('Delete');
  }

  await page.waitForTimeout(1500);

  // Handle confirmation dialog ("Are you sure you want to remove this section?")
  let confirmed = false;
  const dialogLocator = page.locator('text=Are you sure you want to remove this section');
  if (await dialogLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
    logger.info('Confirmation dialog detected');

    // Strategy A: Scope to a dialog found via getByRole('dialog')
    if (!confirmed) {
      const roleDialog = page.getByRole('dialog');
      if (await roleDialog.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        for (const name of ['Remove', 'REMOVE', 'Confirm', 'Yes', 'OK']) {
          const btn = roleDialog.first().getByRole('button', { name });
          if (await btn.first().isVisible({ timeout: 500 }).catch(() => false)) {
            await btn.first().click();
            logger.info({ name }, 'Confirmed removal via dialog role-scoped button');
            confirmed = true;
            break;
          }
        }
      }
    }

    // Strategy B: Find the dialog container by role/class that contains "Are you sure" text,
    // then look for buttons within it — avoids matching toolbar buttons outside the dialog
    if (!confirmed) {
      const dialogContainer = page
        .locator('[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="dialog"], [class*="confirmation"], [class*="overlay"][class*="confirm"]')
        .filter({ hasText: 'Are you sure' });
      if (await dialogContainer.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        for (const text of ['Remove', 'REMOVE', 'Confirm', 'Yes', 'OK']) {
          const btn = dialogContainer.first().locator(`button:has-text("${text}")`).first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            await btn.click();
            logger.info({ text }, 'Confirmed removal via dialog container button');
            confirmed = true;
            break;
          }
        }
      }
    }

    // Strategy C: Global search but check whether the button is inside a dialog/modal
    // (not the toolbar). This is a fallback for unusual DOM structures.
    if (!confirmed) {
      const dialogBtns = page.locator('button:has-text("REMOVE"), button:has-text("Remove")');
      const count = await dialogBtns.count();
      for (let i = count - 1; i >= 0; i--) {
        const btn = dialogBtns.nth(i);
        if (!(await btn.isVisible().catch(() => false))) continue;
        // Check if this button lives inside a dialog/modal container (not the section toolbar)
        const isInDialog = await btn.evaluate(
          el => !!el.closest('[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="dialog"], [class*="confirmation"]'),
        ).catch(() => false);
        if (isInDialog) {
          await btn.click();
          logger.info('Confirmed removal via global Remove button inside dialog');
          confirmed = true;
          break;
        }
      }
    }
  }

  // Final fallback: look for generic confirm buttons anywhere (Confirm / Yes / OK)
  if (!confirmed) {
    for (const sel of ['button:has-text("Confirm")', 'button:has-text("Yes")', 'button:has-text("OK")']) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click();
        logger.info({ selector: sel }, 'Confirmed removal via fallback');
        confirmed = true;
        break;
      }
    }
  }

  await page.waitForTimeout(1000);
  logger.info({ confirmed }, 'Section removal complete');
}

/**
 * Find a block containing specific text content, select it, and delete it.
 * Returns true if the content was found and deleted.
 *
 * In the Fluid Engine editor, the page content is rendered inside an iframe
 * (sqs-site-frame) with an overlay div (sqs-editing-overlay) that intercepts
 * all pointer events. To click on blocks, we need to:
 * 1. Find the element's bounding box inside the iframe
 * 2. Calculate coordinates relative to the main page
 * 3. Click at those coordinates on the main page (which the overlay receives)
 * This simulates how a user would click on blocks in the editor.
 */
export async function findAndDeleteContent(
  page: Page,
  searchText: string,
): Promise<{ found: boolean; screenshotPath?: string }> {
  const matches = await findTextOnPage(page, searchText);

  if (matches.length === 0) {
    logger.warn({ searchText }, 'Content not found on page');
    const screenshotPath = await takeScreenshot(page, 'content-not-found');
    return { found: false, screenshotPath };
  }

  // Scroll element into view and get viewport-relative coordinates
  const target = matches[0];
  await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  const targetBox = await target.boundingBox();
  if (!targetBox) {
    logger.warn({ searchText }, 'Could not get bounding box for matched element');
    const screenshotPath = await takeScreenshot(page, 'no-bounding-box');
    return { found: false, screenshotPath };
  }

  // boundingBox() returns viewport-relative coords after scrollIntoView
  const clickX = targetBox.x + targetBox.width / 2;
  const clickY = targetBox.y + targetBox.height / 2;

  logger.info(
    { searchText, clickX, clickY, targetBox },
    'Clicking through editing overlay at calculated coordinates',
  );

  // In the Fluid Engine editor:
  // - Clicking on content selects the SECTION containing that content
  // - A section toolbar appears on the right with a "Remove" button
  // - We click "Remove" to delete the entire section
  // - If the content is in a section with other blocks, this removes
  //   the whole section — which is acceptable for the remove-content use case

  // Click to select the section containing the target content
  await page.mouse.click(clickX, clickY);
  await page.waitForTimeout(1200);
  logger.info({ searchText }, 'Section selected');

  const beforeScreenshot = await takeScreenshot(page, 'section-selected');
  logger.info({ searchText, screenshotPath: beforeScreenshot }, 'Section selected — ready to remove');

  // Now try to delete the selected block
  await deleteSelectedBlock(page);

  const afterScreenshot = await takeScreenshot(page, 'after-delete');
  return { found: true, screenshotPath: afterScreenshot };
}

/**
 * Double-click a block to open its inline editor.
 */
export async function openBlockEditor(
  page: Page,
  element: Locator,
): Promise<void> {
  await element.dblclick();
  await page.waitForTimeout(1000); // Wait for editor panel to appear
  logger.info('Block editor opened');
}

/**
 * Get the text content of a contenteditable element or textarea.
 */
export async function getBlockTextContent(
  page: Page,
  element: Locator,
): Promise<string> {
  // Try to get innerText first (works for contenteditable)
  const text = await element.innerText().catch(() => '');
  if (text) return text;

  // Fall back to inputValue (works for textarea/input)
  return element.inputValue().catch(() => '');
}

/**
 * Replace the content of a contenteditable element or textarea.
 */
export async function replaceBlockContent(
  page: Page,
  element: Locator,
  newContent: string,
): Promise<void> {
  // Select all existing content
  await element.click();
  await page.keyboard.press('Meta+a'); // Cmd+A on Mac
  await page.waitForTimeout(200);

  // Type the new content
  await element.fill(newContent);
  logger.info('Block content replaced');
}

// ─── Reusable Overlay Utilities ────────────────────────────────────────────

/**
 * Click an element inside the #sqs-site-frame iframe by calculating
 * viewport-relative coordinates through the editing overlay.
 *
 * In the Squarespace Fluid Engine editor, an overlay div intercepts all
 * pointer events. To interact with iframe content, we:
 * 1. Scroll the element into view (so boundingBox returns viewport coords)
 * 2. Get its viewport-relative bounding box
 * 3. Click at the center of the element on the main page
 */
export async function clickThroughOverlay(
  page: Page,
  iframeSelector: string,
): Promise<{ success: boolean; message: string }> {
  const siteFrame = getSiteFrame(page);
  if (!siteFrame) return { success: false, message: 'Site iframe not found' };

  try {
    const element = siteFrame.locator(iframeSelector).first();

    // Scroll the element into view (handles both iframe scroll and outer page scroll)
    await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);

    // boundingBox() on a FrameLocator element returns coordinates relative to
    // the main frame viewport (already includes iframe offset), so we do NOT
    // need to add iframeBox offset separately.
    const box = await element.boundingBox();
    if (!box) return { success: false, message: `Element "${iframeSelector}" not found or not visible in iframe` };

    const clickX = box.x + box.width / 2;
    const clickY = box.y + box.height / 2;

    // Sanity check: coordinates should be within viewport
    const viewport = page.viewportSize() || { width: 1440, height: 900 };
    if (clickY < 0 || clickY > viewport.height * 2) {
      logger.warn({ clickX, clickY, boxY: box.y, boxH: box.height }, 'clickThroughOverlay: coordinates out of viewport, re-scrolling');
      await element.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      const box2 = await element.boundingBox();
      if (box2) {
        const clickX2 = box2.x + box2.width / 2;
        const clickY2 = box2.y + box2.height / 2;
        await page.mouse.click(clickX2, clickY2);
        await page.waitForTimeout(800);
        logger.info({ iframeSelector, clickX: clickX2, clickY: clickY2 }, 'Clicked through overlay (after re-scroll)');
        return { success: true, message: `Clicked "${iframeSelector}" at (${Math.round(clickX2)}, ${Math.round(clickY2)})` };
      }
    }

    await page.mouse.click(clickX, clickY);
    await page.waitForTimeout(800);

    logger.info({ iframeSelector, clickX, clickY }, 'Clicked through overlay');
    return { success: true, message: `Clicked "${iframeSelector}" at (${Math.round(clickX)}, ${Math.round(clickY)})` };
  } catch (err) {
    const msg = errMsg(err);
    logger.warn({ iframeSelector, error: msg }, 'clickThroughOverlay failed');
    return { success: false, message: msg };
  }
}

/**
 * Double-click an element inside the #sqs-site-frame iframe.
 * Uses the same overlay coordinate calculation as clickThroughOverlay.
 */
export async function dblclickThroughOverlay(
  page: Page,
  iframeSelector: string,
): Promise<{ success: boolean; message: string }> {
  const siteFrame = getSiteFrame(page);
  if (!siteFrame) return { success: false, message: 'Site iframe not found' };

  try {
    const element = siteFrame.locator(iframeSelector).first();
    await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);

    // boundingBox() returns viewport-relative coords after scrollIntoView
    const box = await element.boundingBox();
    if (!box) return { success: false, message: `Element "${iframeSelector}" not found or not visible in iframe` };

    const clickX = box.x + box.width / 2;
    const clickY = box.y + box.height / 2;

    await page.mouse.dblclick(clickX, clickY);
    await page.waitForTimeout(800);

    logger.info({ iframeSelector, clickX, clickY }, 'Double-clicked through overlay');
    return { success: true, message: `Double-clicked "${iframeSelector}" at (${Math.round(clickX)}, ${Math.round(clickY)})` };
  } catch (err) {
    const msg = errMsg(err);
    return { success: false, message: msg };
  }
}

/**
 * Click at absolute coordinates on the main page.
 * Useful when the agent already knows coordinates (e.g., from a screenshot).
 */
export async function clickThroughOverlayAtCoords(
  page: Page,
  x: number,
  y: number,
): Promise<{ success: boolean; message: string }> {
  try {
    await page.mouse.click(x, y);
    await page.waitForTimeout(500);
    logger.info({ x, y }, 'Clicked at coordinates');
    return { success: true, message: `Clicked at (${Math.round(x)}, ${Math.round(y)})` };
  } catch (err) {
    const msg = errMsg(err);
    return { success: false, message: msg };
  }
}

/**
 * Hover over an element inside the #sqs-site-frame iframe by calculating
 * absolute coordinates through the editing overlay.
 * Same coordinate math as clickThroughOverlay but uses mouse.move instead of click.
 */
export async function hoverThroughOverlay(
  page: Page,
  iframeSelector: string,
): Promise<{ success: boolean; message: string; x?: number; y?: number }> {
  const siteFrame = getSiteFrame(page);
  if (!siteFrame) return { success: false, message: 'Site iframe not found' };

  try {
    const element = siteFrame.locator(iframeSelector).first();
    await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);

    // boundingBox() returns viewport-relative coords after scrollIntoView
    const box = await element.boundingBox();
    if (!box) return { success: false, message: `Element "${iframeSelector}" not found or not visible in iframe` };

    const hoverX = box.x + box.width / 2;
    const hoverY = box.y + box.height; // bottom edge

    await page.mouse.move(hoverX, hoverY);
    await page.waitForTimeout(400);

    logger.info({ iframeSelector, hoverX, hoverY }, 'Hovered through overlay at bottom edge of element');
    return { success: true, message: `Hovered at (${Math.round(hoverX)}, ${Math.round(hoverY)})`, x: hoverX, y: hoverY };
  } catch (err) {
    const msg = errMsg(err);
    logger.warn({ iframeSelector, error: msg }, 'hoverThroughOverlay failed');
    return { success: false, message: msg };
  }
}

/**
 * Hover at the bottom edge of each .page-section in the iframe to trigger
 * the ADD SECTION button to appear. Returns the coordinates where the hover
 * was successful (i.e., ADD SECTION became visible), or null.
 *
 * The ADD SECTION button in Squarespace only appears when you hover between
 * two sections (at the boundary). We iterate over all sections, hover at
 * the bottom edge of each one, and check if the button appears.
 */
export async function hoverBetweenSectionsInIframe(
  page: Page,
): Promise<{ success: boolean; message: string }> {
  const siteFrame = getSiteFrame(page);
  if (!siteFrame) return { success: false, message: 'Site iframe not found' };

  try {
    // Get the count of page sections in the iframe
    const sectionCount = await siteFrame.locator('.page-section').count();
    logger.info({ sectionCount }, 'hoverBetweenSections: found sections in iframe');

    if (sectionCount === 0) {
      return { success: false, message: 'No .page-section elements found in iframe' };
    }

    const viewportHeight = page.viewportSize()?.height || 900;
    const addSectionSelectors = [
      'button:has-text("ADD SECTION")',
      'button:has-text("Add Section")',
      '[aria-label="Add Section"]',
      '[data-test="add-section"]',
      'button[aria-label="Add section"]',
    ];

    const checkAddSection = async (): Promise<boolean> => {
      for (const selector of addSectionSelectors) {
        const visible = await page.locator(selector).first().isVisible({ timeout: 800 }).catch(() => false);
        if (visible) {
          logger.info({ selector }, 'hoverBetweenSections: ADD SECTION appeared!');
          return true;
        }
      }
      return false;
    };

    // Strategy: scroll the LAST section into view, then hover at its bottom edge.
    // We want to add sections at the bottom, so we focus on the last section boundary.
    // scrollIntoViewIfNeeded() brings the element into the viewport, then we can
    // get accurate viewport-relative coordinates from boundingBox().
    const indicesToTry = [sectionCount - 1]; // Start with last section
    if (sectionCount > 1) indicesToTry.push(sectionCount - 2); // Also try second-to-last

    for (const i of indicesToTry) {
      const section = siteFrame.locator('.page-section').nth(i);

      // Scroll section into view (this scrolls within the iframe)
      await section.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);

      // Now get the bounding box — it should be in the visible viewport area
      const sectionBox = await section.boundingBox().catch(() => null);
      if (!sectionBox) continue;

      // boundingBox() from FrameLocator already returns viewport-relative coords
      // (accounting for iframe position + scroll), so use directly
      const hoverX = sectionBox.x + sectionBox.width / 2;
      const hoverY = sectionBox.y + sectionBox.height;

      // Skip if still outside viewport
      if (hoverY < 0 || hoverY > viewportHeight + 50) {
        logger.info({ sectionIndex: i, hoverY: Math.round(hoverY) }, 'hoverBetweenSections: section bottom edge outside viewport, skipping');
        continue;
      }

      // Hover at the bottom edge of the section
      logger.info({ sectionIndex: i, hoverX: Math.round(hoverX), hoverY: Math.round(hoverY) }, 'hoverBetweenSections: hovering at section bottom edge');
      await page.mouse.move(hoverX, hoverY);
      await page.waitForTimeout(700);
      if (await checkAddSection()) {
        return { success: true, message: `ADD SECTION appeared after hovering at section ${i} bottom edge` };
      }

      // Try slightly below (in the gap between sections)
      await page.mouse.move(hoverX, hoverY + 5);
      await page.waitForTimeout(500);
      if (await checkAddSection()) {
        return { success: true, message: `ADD SECTION appeared after hovering below section ${i}` };
      }

      // Try moving up slowly from the bottom edge
      for (const offset of [-10, -20, -30, 10, 20]) {
        await page.mouse.move(hoverX, hoverY + offset);
        await page.waitForTimeout(400);
        if (await checkAddSection()) {
          return { success: true, message: `ADD SECTION appeared hovering near section ${i} boundary (offset ${offset})` };
        }
      }
    }

    return { success: false, message: `Hovered at section boundaries but ADD SECTION did not appear` };
  } catch (err) {
    const msg = errMsg(err);
    logger.warn({ error: msg }, 'hoverBetweenSectionsInIframe failed');
    return { success: false, message: msg };
  }
}

/**
 * Use CDP (Chrome DevTools Protocol) to dispatch a realistic mouse movement
 * trajectory across a section boundary. Unlike page.mouse.move() which sends
 * a single mouseMoved event, this sends a sequence of events that simulate
 * the mouse crossing from inside a section to its bottom edge — which is
 * what triggers Squarespace to show the ADD SECTION button.
 */
export async function cdpHoverAtSectionBoundary(
  page: Page,
): Promise<{ success: boolean; message: string }> {
  const siteFrame = getSiteFrame(page);
  if (!siteFrame) return { success: false, message: 'Site iframe not found' };

  try {
    const sectionCount = await siteFrame.locator('.page-section').count();
    if (sectionCount === 0) return { success: false, message: 'No sections found' };

    const lastSection = siteFrame.locator('.page-section').nth(sectionCount - 1);
    await lastSection.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);

    const sectionBox = await lastSection.boundingBox();
    if (!sectionBox) return { success: false, message: 'Cannot get section bounding box' };

    // Target: bottom edge of last section
    const targetX = sectionBox.x + sectionBox.width / 2;
    const targetY = sectionBox.y + sectionBox.height;
    // Start: 100px above (inside the section)
    const startY = targetY - 100;

    const cdpSession = await page.context().newCDPSession(page);
    try {
      // Simulate realistic mouse movement: 20 steps from inside section to its edge
      const steps = 20;
      for (let i = 0; i <= steps; i++) {
        const y = startY + (targetY - startY) * (i / steps);
        await cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(targetX),
          y: Math.round(y),
          button: 'none',
          modifiers: 0,
        });
        await page.waitForTimeout(20);
      }

      // Dwell at the boundary with slight jitter
      for (let i = 0; i < 5; i++) {
        await cdpSession.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(targetX),
          y: Math.round(targetY + (i % 2 === 0 ? 0 : 2)),
          button: 'none',
          modifiers: 0,
        });
        await page.waitForTimeout(100);
      }

      await page.waitForTimeout(300);
      logger.info({ targetX: Math.round(targetX), targetY: Math.round(targetY) }, 'cdpHoverAtSectionBoundary: completed CDP mouse trajectory');
      return { success: true, message: `CDP hover at (${Math.round(targetX)}, ${Math.round(targetY)})` };
    } finally {
      await cdpSession.detach().catch(() => {});
    }
  } catch (err) {
    const msg = errMsg(err);
    logger.warn({ error: msg }, 'cdpHoverAtSectionBoundary failed');
    return { success: false, message: msg };
  }
}

/**
 * Force-reveal and click a hidden ADD SECTION button in the DOM.
 * Squarespace keeps the button in the DOM but hides it with CSS.
 * This finds the button, forces it visible, and clicks it.
 */
export async function forceClickHiddenAddSection(
  page: Page,
): Promise<{ success: boolean; message: string }> {
  try {
    const result = await page.evaluate(() => {
      // Strategy A: Find the LAST button with ADD SECTION text (even hidden).
      // We want the last one because it adds a section at the bottom of the
      // content area (just before the footer), which is what we always want.
      const allButtons = Array.from(document.querySelectorAll('button'));
      const addSectionButtons = allButtons.filter(btn =>
        btn.textContent?.trim().toUpperCase().includes('ADD SECTION'),
      );

      if (addSectionButtons.length > 0) {
        const btn = addSectionButtons[addSectionButtons.length - 1]; // LAST one
        btn.style.setProperty('opacity', '1', 'important');
        btn.style.setProperty('visibility', 'visible', 'important');
        btn.style.setProperty('display', 'block', 'important');
        btn.style.setProperty('pointer-events', 'auto', 'important');
        let parent = btn.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          parent.style.setProperty('opacity', '1', 'important');
          parent.style.setProperty('visibility', 'visible', 'important');
          parent = parent.parentElement;
        }
        btn.click();
        return { found: true, method: 'force-reveal-click', index: addSectionButtons.length - 1, total: addSectionButtons.length };
      }

      // Strategy B: Find by class name patterns (last match)
      const classPatterns = [
        '[class*="add-section"]', '[class*="AddSection"]',
        '[class*="section-add"]', '[class*="SectionAdd"]',
      ];
      for (const selector of classPatterns) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          const el = elements[elements.length - 1] as HTMLElement;
          el.style.setProperty('opacity', '1', 'important');
          el.style.setProperty('visibility', 'visible', 'important');
          el.style.setProperty('display', 'block', 'important');
          el.style.setProperty('pointer-events', 'auto', 'important');
          el.click();
          return { found: true, method: 'class-pattern-click', selector };
        }
      }

      return { found: false };
    });

    if (!result.found) {
      return { success: false, message: 'No hidden ADD SECTION button found in DOM' };
    }
    logger.info({ method: (result as any).method }, 'forceClickHiddenAddSection: clicked hidden button');
    return { success: true, message: `Force-clicked ADD SECTION via ${(result as any).method}` };
  } catch (err) {
    const msg = errMsg(err);
    logger.warn({ error: msg }, 'forceClickHiddenAddSection failed');
    return { success: false, message: msg };
  }
}

// ─── Save Changes ──────────────────────────────────────────────────────────

/**
 * Save changes in the Squarespace editor.
 * Tries Save button first, then Done button, using selectors from config.
 *
 * Returns success: true in all cases except an actual click failure, because:
 * - If a Save/Done button is found and clicked → explicitly saved
 * - If a Save/Done button is found but disabled → changes were already auto-saved
 * - If no Save/Done button is found → the editor likely auto-saved (block editors do this)
 */
export async function saveChanges(page: Page): Promise<{ success: boolean; message: string }> {
  // Primary: getByRole (pierces Squarespace's visibility:hidden / overlay patterns)
  for (const name of [/^save$/i, /^done$/i]) {
    const btn = page.getByRole('button', { name });
    if (await btn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      const disabled = await btn.first().isDisabled().catch(() => false);
      if (disabled) {
        logger.info({ name: name.source }, 'Save/Done button disabled — already auto-saved');
        return { success: true, message: 'Changes already auto-saved (button disabled)' };
      }
      await btn.first().click();
      await page.waitForTimeout(2000);
      logger.info({ name: name.source }, 'Clicked Save/Done via getByRole');
      return { success: true, message: `Saved via ${name.source} button` };
    }
  }

  // Fallback: CSS selectors
  for (const sel of ['button:has-text("Save")', '[data-test="save"]', 'button:has-text("Done")', '[data-test="done"]']) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      const disabled = await btn.isDisabled().catch(() => false);
      if (disabled) return { success: true, message: 'Changes already auto-saved' };
      await btn.click();
      await page.waitForTimeout(2000);
      logger.info({ selector: sel }, 'Clicked Save/Done via CSS');
      return { success: true, message: `Saved via ${sel}` };
    }
  }

  logger.info('No Save/Done button visible — changes likely auto-saved');
  return { success: true, message: 'No Save/Done button found — likely auto-saved' };
}
