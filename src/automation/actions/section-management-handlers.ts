import { Page } from 'playwright';
import { logger } from '../../utils/logger.js';
import {
  clickThroughOverlay,
  dblclickThroughOverlay,
  findTextOnPage,
  getSiteFrame,
  hoverBetweenSectionsInIframe,
  cdpHoverAtSectionBoundary,
  forceClickHiddenAddSection,
  saveChanges,
} from '../editor-actions.js';
import { errMsg } from '../../utils/errors.js';
import { isFluidEngineActive, clickEditorButton, trySectionMoveApi, trySectionStyleApi, trySelectorsInFrame, tryAddBlankSectionApi } from './handler-utils.js';
import type { ActionResult } from './types.js';
// Cross-module handler imports for handleAddSectionFromTemplate
import { handleEditTextBlock, handleEditButtonBlock } from './text-editing-handlers.js';
import { handleReplaceImage } from './image-handlers.js';
import { handleRemoveBlock } from './block-management-handlers.js';

// ─── Compound Action: addSection ─────────────────────────────────────────

/**
 * Compound action: add a new section to the page.
 *
 * Steps:
 * 1. Find and click the "ADD SECTION" button
 * 2. If a category is specified, click the category tab
 * 3. If a template is specified, search/click the template
 * 4. Wait for the new section to load
 * 5. Save editor state so Content Save API can see the new section
 */
export async function handleAddSection(
  page: Page,
  action: { action: 'addSection'; template?: string; category?: string; templateIndex?: number },
): Promise<ActionResult> {
  const { template, category, templateIndex } = action;

  // ── API Fast Path: blank sections only (no template/category) ─────
  // The Content Save API adds a blank section in ~200ms vs 5-25s UI automation.
  // After adding via API, we reload the page so the editor's in-memory state
  // syncs with the server (prevents the "editor save overwrites API section" issue).
  if (!template && !category && templateIndex === undefined) {
    logger.info('addSection[0]: trying API fast path for blank section');
    const apiResult = await tryAddBlankSectionApi(page);
    if (apiResult) {
      logger.info({ sectionId: apiResult.sectionId }, 'addSection[0]: API succeeded — reloading page to sync editor state');

      // Reload so the editor picks up the server-side section
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);

      // Re-enter edit mode (reload exits it)
      try {
        const { enterEditMode } = await import('../site-navigator.js');
        await enterEditMode(page);
        await page.waitForTimeout(1500);
      } catch (err) {
        logger.warn({ error: errMsg(err) }, 'addSection[0]: failed to re-enter edit mode after reload');
      }

      // Find the new section in the DOM by matching the API-returned sectionId
      const siteFrame = getSiteFrame(page);
      let newSectionInfo = '';
      if (siteFrame) {
        const sectionData = await siteFrame.locator('.page-section').evaluateAll(
          (els, targetId) => {
            for (let i = 0; i < els.length; i++) {
              if (els[i].getAttribute('data-section-id') === targetId) {
                return { index: i, total: els.length };
              }
            }
            return { index: -1, total: els.length };
          },
          apiResult.sectionId,
        ).catch(() => ({ index: -1, total: 0 }));

        if (sectionData.index >= 0) {
          // Store for enterSectionEditMode to use
          await page.evaluate((info: { index: number; id: string }) => {
            (window as any).__lastAddedSectionIndex = info.index;
            (window as any).__lastAddedSectionId = info.id;
          }, { index: sectionData.index, id: apiResult.sectionId });
          newSectionInfo = ` New section at index ${sectionData.index} (data-section-id: ${apiResult.sectionId}). Total sections: ${sectionData.total}.`;
        } else {
          newSectionInfo = ` Section ID: ${apiResult.sectionId}. Total sections: ${sectionData.total}.`;
        }
      }

      const inEditMode = await isFluidEngineActive(page, 2000);
      const editModeHint = inEditMode
        ? ' You are already in section edit mode — you can immediately use addImageBlock or addBlockToSection.'
        : ' You are NOT in section edit mode. Use enterSectionEditMode with sectionIndex:"last" to enter edit mode for the new section.';

      return {
        success: true,
        message: `addSection: Added blank section via API fast path.${editModeHint}${newSectionInfo}`,
      };
    }
    logger.info('addSection[0]: API fast path unavailable — falling through to UI automation');
  }

  // Capture section IDs before adding so we can find the new one after
  const siteFramePre = getSiteFrame(page);
  let sectionIdsBefore: string[] = [];
  if (siteFramePre) {
    sectionIdsBefore = await siteFramePre.locator('.page-section').evaluateAll(
      els => els.map(el => el.getAttribute('data-section-id') || ''),
    ).catch(() => []);
    logger.info({ count: sectionIdsBefore.length }, 'addSection: captured section IDs before add');
  }

  // ── Step 1: Click "ADD SECTION" ─────────────────────────────────────
  // In Squarespace, the ADD SECTION button only appears on hover between
  // sections. We need to: scroll to the bottom, hover the gaps between
  // sections to reveal the button, then click it.
  logger.info('addSection[1/5]: clicking ADD SECTION');

  const addSectionSelectors = [
    'button:has-text("ADD SECTION")',
    'button:has-text("Add Section")',
    '[aria-label="Add Section"]',
    '[data-test="add-section"]',
    'button[aria-label="Add section"]',
    '[class*="add-section"]',
    '[class*="AddSection"]',
  ];

  let addSectionClicked = false;

  // Helper to check if ADD SECTION is visible and click it
  const tryClickAddSection = async (): Promise<boolean> => {
    for (const selector of addSectionSelectors) {
      try {
        const btn = page.locator(selector).first();
        const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          await btn.click({ timeout: 3000 });
          logger.info({ selector }, 'addSection[1/5]: clicked ADD SECTION');
          return true;
        }
      } catch { /* Try next */ }
    }
    return false;
  };

  // Determine if this is an empty page (no content sections, or only a footer).
  // On empty pages, hover-between-sections strategies (B, C) have no content
  // sections to hover between — they land near the footer boundary, which either
  // enters the footer editor or adds a section at the wrong place.
  const isEmptyPage = sectionIdsBefore.length <= 1;
  logger.info({ sectionCount: sectionIdsBefore.length, isEmptyPage }, 'addSection: page section count');

  // Strategy A0: Empty page — ADD SECTION button is prominently visible inside the iframe.
  // Use locator.click() directly (more reliable than boundingBox + page.mouse.click).
  const siteFrameCheck = getSiteFrame(page);
  if (siteFrameCheck && !addSectionClicked) {
    const iframeBtn = siteFrameCheck.locator(
      'button:has-text("ADD SECTION"), button:has-text("Add Section"), [data-test="add-section"]',
    ).first();
    const visible = await iframeBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await iframeBtn.click({ timeout: 3000 });
      logger.info('addSection[1/5]: clicked ADD SECTION inside iframe (empty page)');
      addSectionClicked = true;
    }
  }

  // Strategy A: Check if already visible in main frame
  if (!addSectionClicked) addSectionClicked = await tryClickAddSection();

  // Strategy B: CDP realistic mouse trajectory across section boundary.
  // Only run when the page has content sections to hover between — on empty
  // pages this hovers near the footer and causes footer edits or wrong placement.
  if (!addSectionClicked && !isEmptyPage) {
    logger.info('addSection[1/5]: CDP realistic mouse trajectory at section boundary');
    const cdpResult = await cdpHoverAtSectionBoundary(page);
    if (cdpResult.success) {
      await page.waitForTimeout(500);
      addSectionClicked = await tryClickAddSection();
    }
  }

  // Strategy C: iframe-aware hover at section boundaries.
  // Same restriction as B — skip on empty pages to avoid footer interaction.
  if (!addSectionClicked && !isEmptyPage) {
    logger.info('addSection[1/5]: iframe-aware hover at section boundaries');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    const hoverResult = await hoverBetweenSectionsInIframe(page);
    if (hoverResult.success) {
      addSectionClicked = await tryClickAddSection();
    }
  }

  // Strategy D: Force-reveal hidden ADD SECTION button in DOM
  // Squarespace keeps the button in the DOM but hides it with CSS.
  // This finds it, forces it visible, and clicks it.
  if (!addSectionClicked) {
    logger.info('addSection[1/5]: force-reveal hidden ADD SECTION button');
    const forceResult = await forceClickHiddenAddSection(page);
    if (forceResult.success) {
      addSectionClicked = true;
    }
  }

  if (!addSectionClicked) {
    return {
      success: false,
      message: 'addSection step 1: ADD SECTION button not found. The button appears on hover between sections. Try hovering at the bottom of the last section or between two sections.',
    };
  }
  await page.waitForTimeout(1500);

  // ── Step 1b: Click "Add Blank" if section picker panel appeared ────
  // When no template/category is specified, Squarespace shows a picker.
  // We need to click "Add Blank" or "+ Add Blank" to add a blank section.
  if (!template && !category) {
    logger.info('addSection[1b]: looking for "Add Blank" in section picker');

    // Capture picker state for diagnostics — helps identify the correct selector
    // when "Add Blank" can't be found. Screenshot saved to storage/screenshots/.
    try {
      const pickerTs = new Date().toISOString().replace(/[:.]/g, '-');
      await page.screenshot({ path: `storage/screenshots/add-section-picker-${pickerTs}.png` });
      logger.info({ file: `add-section-picker-${pickerTs}.png` }, 'addSection[1b]: captured picker state screenshot');
    } catch { /* non-fatal */ }
    // In the section picker panel, "Add Blank" appears as "+ Add Blank" (a link, not a button).
    // IMPORTANT: Do NOT use bare ':has-text("...")' selectors here — they match ancestor
    // container elements (including <body>), and clicking a large container clicks its center,
    // which lands on the first template card in the picker.
    // IMPORTANT: Do NOT use bare ':has-text("Blank")' without the "Add" prefix.
    // Squarespace's section picker shows template cards that may be named "Blank"
    // (e.g. the hero template). Clicking one of those cards inserts a template
    // section with placeholder content rather than a truly blank section.
    const addBlankSelectors = [
      // Scoped within picker panel — use FULL TEXT "Add Blank" only
      '[class*="sectionPicker"] a:has-text("Add Blank")',
      '[class*="section-picker"] a:has-text("Add Blank")',
      '[class*="layoutPicker"] a:has-text("Add Blank")',
      '[class*="layout-picker"] a:has-text("Add Blank")',
      // data-test attribute — reliable when present
      '[data-test="add-blank-section"]',
      // Element-typed selectors — safe (typed elements won't match ancestor containers)
      'a:has-text("Add Blank")',
      'a:has-text("+ Add Blank")',
      'button:has-text("Add Blank")',
      'button:has-text("+ Add Blank")',
      'button:has-text("Blank Section")',
    ];

    // Search main frame first, then site iframe (picker may appear inside iframe
    // when ADD SECTION was clicked via Strategy A0 on empty pages).
    const siteFrameForBlank = getSiteFrame(page);
    const blankClicked =
      await trySelectorsInFrame(page, addBlankSelectors, 'addSection[1b] main frame') ||
      (siteFrameForBlank
        ? await trySelectorsInFrame(siteFrameForBlank, addBlankSelectors, 'addSection[1b] iframe')
        : false);

    if (!blankClicked) {
      // "Add Blank" not found in either frame. Press Escape to dismiss any open picker.
      //
      // CRITICAL: Without this early return, saveChanges() in step 5 finds the
      // picker's "Done" confirm button and clicks it, inserting the highlighted template.
      logger.warn('addSection[1b]: "Add Blank" not found in main frame or iframe — pressing Escape');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      return {
        success: false,
        message: 'addSection: "Add Blank" not found in section picker (searched main frame + iframe). Pressed Escape to dismiss. Try clicking ADD SECTION again.',
      };
    }
    await page.waitForTimeout(1500);
  }

  // ── Step 2: Click category tab (if specified) ───────────────────────
  if (category) {
    logger.info({ category }, 'addSection[2/5]: clicking category');
    const categorySelectors = [
      `button:has-text("${category}")`,
      `[role="tab"]:has-text("${category}")`,
      `a:has-text("${category}")`,
    ];

    for (const selector of categorySelectors) {
      try {
        const el = page.locator(selector).first();
        const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
        if (visible) {
          await el.click({ timeout: 3000 });
          logger.info({ selector, category }, 'addSection[2/5]: clicked category');
          break;
        }
      } catch { /* Try next */ }
    }
    await page.waitForTimeout(800);
  }

  // ── Step 3: Click template (if specified) ───────────────────────────
  if (template || templateIndex !== undefined) {
    logger.info({ template, templateIndex }, 'addSection[3/5]: selecting template');

    let templateClicked = false;

    // Strategy A: Index-based selection (most reliable)
    // Squarespace renders templates as clickable cards/thumbnails inside the
    // section picker panel. Clicking by index avoids all text-matching issues.
    if (templateIndex !== undefined && templateIndex >= 0) {
      logger.info({ templateIndex }, 'addSection[3/5]: Strategy A — clicking template by index');
      await page.waitForTimeout(800); // Let templates render after category click

      // Squarespace template cards are typically buttons or clickable divs
      // inside the section picker panel. They sit in a grid/list layout.
      const templateCardSelectors = [
        '[class*="sectionPicker"] button[class*="template"]',
        '[class*="section-picker"] button[class*="template"]',
        '[class*="sectionPicker"] [role="button"]',
        '[class*="layoutPicker"] button',
        '[class*="layout-picker"] button',
        // Generic: clickable cards inside panel that aren't nav/utility buttons
        '[class*="sectionPicker"] [class*="card"]',
        '[class*="sectionPicker"] [class*="thumbnail"]',
      ];

      for (const selector of templateCardSelectors) {
        try {
          const cards = page.locator(selector);
          const count = await cards.count().catch(() => 0);
          if (count > templateIndex) {
            const targetCard = cards.nth(templateIndex);
            const visible = await targetCard.isVisible({ timeout: 2000 }).catch(() => false);
            if (visible) {
              await targetCard.click({ timeout: 3000 });
              templateClicked = true;
              logger.info({ selector, templateIndex, totalCards: count }, 'addSection[3/5]: clicked template card by index');
              break;
            }
          }
        } catch { /* Try next selector */ }
      }

      // Fallback for index-based: if specific selectors didn't work,
      // try finding ALL clickable thumbnails/images in the picker panel
      if (!templateClicked) {
        try {
          // Look for the section picker panel and find clickable items within it
          const panelSelectors = [
            '[class*="sectionPicker"]',
            '[class*="section-picker"]',
            '[class*="layoutPicker"]',
            '[class*="layout-picker"]',
            '[class*="panel"]',
          ];
          for (const panelSel of panelSelectors) {
            const panel = page.locator(panelSel).first();
            const panelVisible = await panel.isVisible({ timeout: 1500 }).catch(() => false);
            if (panelVisible) {
              // Find all image thumbnails inside the panel — each represents a template
              const thumbs = panel.locator('img, [class*="thumb"], [class*="preview"]');
              const thumbCount = await thumbs.count().catch(() => 0);
              if (thumbCount > templateIndex) {
                const target = thumbs.nth(templateIndex);
                await target.click({ timeout: 3000 });
                templateClicked = true;
                logger.info({ panelSel, templateIndex, thumbCount }, 'addSection[3/5]: clicked template thumbnail by index');
                break;
              }
            }
          }
        } catch { /* Continue to text-based fallback */ }
      }

      if (!templateClicked) {
        logger.warn({ templateIndex }, 'addSection[3/5]: index-based selection failed — falling back to text search');
      }
    }

    // Strategy B: Text-based search (fallback or when no index provided)
    if (!templateClicked && template) {
      logger.info({ template }, 'addSection[3/5]: Strategy B — text-based template search');

      // Try searching for the template
      const searchSelectors = [
        'input[placeholder*="Search"]',
        'input[placeholder*="search"]',
        'input[type="search"]',
      ];

      let searched = false;
      for (const selector of searchSelectors) {
        const el = page.locator(selector).first();
        const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await el.fill(template);
          await page.waitForTimeout(800);
          searched = true;
          break;
        }
      }

      // Click the template — use tighter selectors to avoid mismatches
      // Prefer exact role-based matches over loose has-text
      const templateSelectors = [
        `button:has-text("${template}")`,
        `[class*="template"]:has-text("${template}")`,
        `[class*="layout"]:has-text("${template}")`,
        `div:has-text("${template}")`,
      ];

      for (const selector of templateSelectors) {
        try {
          const el = page.locator(selector).first();
          const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
          if (visible) {
            await el.click({ timeout: 3000 });
            templateClicked = true;
            logger.info({ selector, template }, 'addSection[3/5]: clicked template by text');
            break;
          }
        } catch { /* Try next */ }
      }

      if (!templateClicked && !searched) {
        logger.warn({ template }, 'addSection[3/5]: template not found — a blank section may have been added');
      }
    }
    await page.waitForTimeout(1500);
  }

  // ── Step 4: Wait for section to load and check edit mode ────────────
  logger.info('addSection[4/5]: waiting for section to load');
  await page.waitForTimeout(3000);

  // Check if we're already in section edit mode (Squarespace sometimes auto-enters)
  const inEditMode = await isFluidEngineActive(page, 3000);

  const editModeHint = inEditMode
    ? ' You are already in section edit mode — you can immediately use addImageBlock or addBlockToSection.'
    : ' You are NOT in section edit mode. Use enterSectionEditMode with sectionIndex:"last" to enter edit mode for the new section.';

  // Find the newly added section by comparing section IDs before and after
  const siteFrame = getSiteFrame(page);
  let newSectionInfo = '';
  if (siteFrame) {
    const sectionIdsAfter = await siteFrame.locator('.page-section').evaluateAll(
      els => els.map((el, i) => ({
        id: el.getAttribute('data-section-id') || '',
        index: i,
        // Detect footer sections by class, id, aria-label, or content role
        isFooter: el.classList.contains('footer-section')
          || el.id.toLowerCase().includes('footer')
          || el.getAttribute('aria-label')?.toLowerCase().includes('footer') === true
          || el.querySelector('footer') !== null
          || el.querySelector('[data-test="footer"]') !== null
          || el.className.toLowerCase().includes('footer'),
      })),
    ).catch(() => []);
    const totalSections = sectionIdsAfter.length;

    // Find the new section (ID that wasn't in the before list)
    const newSection = sectionIdsAfter.find(s => !sectionIdsBefore.includes(s.id));
    if (newSection) {
      // FOOTER SAFETY CHECK: Warn if the new section appears to be a footer.
      // The footer shows on every page — adding content there affects the whole site.
      if (newSection.isFooter) {
        logger.warn({ newIndex: newSection.index, newId: newSection.id },
          'addSection: WARNING — new section appears to be a FOOTER section (shows on every page)');
      }

      // Also warn if the new section is the very last one (often the footer)
      const isLast = newSection.index === totalSections - 1;
      const footerWarning = newSection.isFooter
        ? ' ⚠️ WARNING: This appears to be a FOOTER section that shows on every page. Verify this is the correct section before adding content.'
        : '';

      // Store the new section's data-section-id for enterSectionEditMode to use
      await page.evaluate((info: { index: number; id: string }) => {
        (window as any).__lastAddedSectionIndex = info.index;
        (window as any).__lastAddedSectionId = info.id;
      }, { index: newSection.index, id: newSection.id });
      newSectionInfo = ` New section at index ${newSection.index} (data-section-id: ${newSection.id}). Total sections: ${totalSections}.${footerWarning}`;
      logger.info({ newIndex: newSection.index, newId: newSection.id, totalSections, isFooter: newSection.isFooter, isLast }, 'addSection: identified new section');
    } else {
      newSectionInfo = ` Total sections: ${totalSections}.`;
    }
  }

  // ── Step 5: Save editor state so Content Save API can see the new section
  logger.info('addSection[5/5]: saving editor state');
  const saveResult = await saveChanges(page);
  logger.info({ saveResult }, 'addSection[5/5]: editor state saved');

  // saveChanges may exit edit mode (returns message containing "Done")
  const saveExitedEditMode = saveResult.message.includes('Done');
  if (saveExitedEditMode) {
    logger.info('addSection[5/5]: save exited edit mode — subsequent actions may need to re-enter');
  }

  return {
    success: true,
    message: `addSection: Added new section${category ? ` (category: "${category}")` : ''}${template ? ` (template: "${template}")` : ''}.${saveExitedEditMode ? ' Note: save exited edit mode — use enterSectionEditMode to re-enter.' : ''}${editModeHint}${newSectionInfo}`,
  };
}

// ─── Compound Action: enterSectionEditMode ───────────────────────────────

/**
 * Compound action: enter section edit mode (Fluid Engine) for a section
 * containing specific text.
 *
 * Steps:
 * 1. Find the text in the iframe
 * 2. Click through overlay to select the section
 * 3. Click "EDIT CONTENT" in the section context menu
 * 4. Wait for the Fluid Engine editor to activate
 */
export async function handleEnterSectionEditMode(
  page: Page,
  action: { action: 'enterSectionEditMode'; searchText?: string; sectionIndex?: 'last' | number },
): Promise<ActionResult> {
  const { searchText, sectionIndex } = action;
  let clickedSectionSelector: string | undefined; // Track for double-click fallback in step 3

  // ── Pre-check: if we just added a section, it may already be in edit mode ──
  const addBlockByRole = page.getByRole('button', { name: /add block/i });
  const preCheckVisible = await addBlockByRole.first().isVisible({ timeout: 1500 }).catch(() => false);
  if (preCheckVisible) {
    const label = searchText ? `containing "${searchText}"` : `at index ${sectionIndex ?? 'last'}`;
    logger.info('enterSectionEditMode: ADD BLOCK already visible — section is already in edit mode');
    return {
      success: true,
      message: `enterSectionEditMode: Already in section edit mode for section ${label}. You can add/edit/remove blocks.`,
    };
  }

  // ── Step 1 & 2: Find and click the target section ──────────────────
  if (searchText) {
    // Original approach: find by text content
    logger.info({ searchText }, 'enterSectionEditMode[1/4]: finding text');
    const matches = await findTextOnPage(page, searchText);
    if (matches.length === 0) {
      return {
        success: false,
        message: `enterSectionEditMode step 1: Text "${searchText}" not found on page`,
      };
    }

    logger.info({ searchText }, 'enterSectionEditMode[2/4]: clicking section');
    const textSelector = `text=${searchText}`;
    clickedSectionSelector = textSelector;
    const clickResult = await clickThroughOverlay(page, textSelector);
    if (!clickResult.success) {
      return {
        success: false,
        message: `enterSectionEditMode step 2: Failed to click section — ${clickResult.message}`,
      };
    }
  } else {
    // Index-based approach: click a section by position (useful for blank sections)
    const targetIndex = sectionIndex === 'last' || sectionIndex === undefined ? 'last' : sectionIndex;
    logger.info({ sectionIndex: targetIndex }, 'enterSectionEditMode[1/4]: finding section by index');

    const siteFrame = getSiteFrame(page);
    if (!siteFrame) return { success: false, message: 'enterSectionEditMode: Site iframe not found' };

    const totalSections = await siteFrame.locator('.page-section').count();
    logger.info({ totalSections }, 'enterSectionEditMode: found sections in iframe');

    // For "last": use the stored data-section-id from addSection if available,
    // otherwise fall back to second-to-last (the footer is always last).
    let sectionSelector: string;
    let resolvedIndex: number | string;

    if (targetIndex === 'last') {
      const stored = await page.evaluate(() => ({
        id: (window as any).__lastAddedSectionId as string | undefined,
        index: (window as any).__lastAddedSectionIndex as number | undefined,
      })).catch(() => ({ id: undefined, index: undefined }));

      if (stored.id) {
        // Use data-section-id (most reliable — unique attribute, doesn't depend on DOM ordering)
        sectionSelector = `.page-section[data-section-id="${stored.id}"]`;
        resolvedIndex = `id:${stored.id}`;
        logger.info({ sectionId: stored.id }, 'enterSectionEditMode: using stored section ID from addSection');
      } else {
        // Fallback: use .nth() locator on the second-to-last section
        const fallbackIndex = Math.max(0, totalSections - 2);
        sectionSelector = `.page-section[data-section-id]`; // will use .nth() below
        resolvedIndex = fallbackIndex;
        logger.info({ resolvedIndex }, 'enterSectionEditMode: no stored ID, using second-to-last');
      }
    } else {
      resolvedIndex = targetIndex;
      sectionSelector = `.page-section[data-section-id]`; // will use .nth() below
    }

    // Scroll the target section into view
    const targetSection = typeof resolvedIndex === 'number'
      ? siteFrame.locator('.page-section').nth(resolvedIndex)
      : siteFrame.locator(sectionSelector).first();
    await targetSection.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);

    clickedSectionSelector = sectionSelector;
    logger.info({ sectionSelector, resolvedIndex }, 'enterSectionEditMode[2/4]: clicking section through overlay');
    const clickResult = await clickThroughOverlay(page, sectionSelector);
    if (!clickResult.success) {
      return {
        success: false,
        message: `enterSectionEditMode step 2: Failed to click section (${resolvedIndex}) — ${clickResult.message}`,
      };
    }
  }
  await page.waitForTimeout(800);

  // ── Step 3: Check if Fluid Engine is already active ─────────────────
  // Squarespace renders "Add Block" / "Edit Section" buttons with
  // visibility:hidden on non-selected sections. getByRole sees through
  // this and only matches the actually-visible button for the selected section.
  logger.info('enterSectionEditMode[3/4]: checking if Fluid Engine is already active');
  await page.waitForTimeout(500);

  const editSectionByRole = page.getByRole('button', { name: /edit section/i });
  const addBlockVisible = await addBlockByRole.first().isVisible({ timeout: 3000 }).catch(() => false);
  const editSectionVisible = await editSectionByRole.first().isVisible({ timeout: 1000 }).catch(() => false);
  logger.info({ addBlockVisible, editSectionVisible }, 'enterSectionEditMode[3/4]: edit mode indicators (getByRole)');

  let editContentClicked = false;
  if (addBlockVisible) {
    logger.info('enterSectionEditMode[3/4]: ADD BLOCK visible — Fluid Engine is active');
    editContentClicked = true;
  } else if (editSectionVisible) {
    // Section is selected but we may need EDIT SECTION to enter block-editing mode
    logger.info('enterSectionEditMode[3/4]: clicking EDIT SECTION to enter block edit mode');
    await editSectionByRole.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1500);
    editContentClicked = await addBlockByRole.first().isVisible({ timeout: 3000 }).catch(() => false);
    if (!editContentClicked) editContentClicked = true; // Proceed anyway — we clicked something
  } else {
    // Try EDIT CONTENT via getByRole, then aria-label fallbacks
    const editContentByRole = page.getByRole('button', { name: /edit content/i });
    const editContentVis = await editContentByRole.first().isVisible({ timeout: 1500 }).catch(() => false);
    if (editContentVis) {
      await editContentByRole.first().click({ timeout: 3000 });
      editContentClicked = true;
      logger.info('enterSectionEditMode[3/4]: clicked EDIT CONTENT');
    }

    if (!editContentClicked) {
      // Fallback: double-click section to enter edit mode
      if (clickedSectionSelector) {
        logger.info('enterSectionEditMode[3/4]: trying double-click to enter edit mode');
        const dblResult = await dblclickThroughOverlay(page, clickedSectionSelector);
        if (dblResult.success) {
          await page.waitForTimeout(1000);
          editContentClicked = await addBlockByRole.first().isVisible({ timeout: 2000 }).catch(() => false);
        }
      }
    }

    if (!editContentClicked) {
      return {
        success: false,
        message: 'enterSectionEditMode step 3: Fluid Engine not active and no edit buttons found. The section may not be properly selected.',
      };
    }
  }

  // ── Step 4: Verify edit mode ──────────────────────────────────────
  logger.info('enterSectionEditMode[4/4]: verifying Fluid Engine active');
  await page.waitForTimeout(1000);

  const addBlockFinal = await addBlockByRole.first().isVisible({ timeout: 2000 }).catch(() => false);
  const sectionLabel = searchText ? `containing "${searchText}"` : `at index ${sectionIndex ?? 'last'}`;
  if (addBlockFinal || editContentClicked) {
    return {
      success: true,
      message: `enterSectionEditMode: Now in section edit mode for section ${sectionLabel}. You can add/edit/remove blocks.`,
    };
  }

  return {
    success: true,
    message: `enterSectionEditMode: Clicked edit button for section ${sectionLabel}. Verify visually that the Fluid Engine editor is active.`,
  };
}

// ─── Compound Action: moveSectionUp / moveSectionDown ─────────────────────

/**
 * Compound action: move a section up or down on the page.
 *
 * Steps:
 * 1. Find the text in the iframe to locate the section
 * 2. Click through overlay to select the section
 * 3. Find the move arrow button in the section toolbar
 * 4. Click the arrow button
 * 5. Wait and return result
 */
export async function handleMoveSection(
  page: Page,
  searchText: string,
  direction: 'up' | 'down',
): Promise<ActionResult> {
  const label = direction === 'up' ? 'moveSectionUp' : 'moveSectionDown';

  // ── Step 0: Try Content Save API fast path ──────────────────────────
  const apiResult = await trySectionMoveApi(page, searchText, direction);
  if (apiResult) return apiResult;

  // ── Step 1: Find the text ───────────────────────────────────────────
  logger.info({ searchText, direction }, `${label}[1/4]: finding text`);
  const matches = await findTextOnPage(page, searchText);
  if (matches.length === 0) {
    return {
      success: false,
      message: `${label} step 1: Text "${searchText}" not found on page`,
    };
  }

  // ── Step 2: Click through overlay to select the section ─────────────
  logger.info({ searchText }, `${label}[2/4]: clicking section`);
  // First escape any existing edit mode
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const textSelector = `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return {
      success: false,
      message: `${label} step 2: Failed to click section — ${clickResult.message}`,
    };
  }
  await page.waitForTimeout(800);

  // ── Step 3: Find and click the move arrow button ────────────────────
  logger.info({ direction }, `${label}[3/4]: looking for move ${direction} button`);

  const arrowSelectors = direction === 'up'
    ? [
        'button[aria-label="Move Section Up"]',
        'button[aria-label="Move Up"]',
        'button[aria-label="Move section up"]',
        'button[aria-label="move section up"]',
        '[data-test="move-section-up"]',
      ]
    : [
        'button[aria-label="Move Section Down"]',
        'button[aria-label="Move Down"]',
        'button[aria-label="Move section down"]',
        'button[aria-label="move section down"]',
        '[data-test="move-section-down"]',
      ];

  let arrowClicked = false;
  for (const selector of arrowSelectors) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        arrowClicked = true;
        logger.info({ selector }, `${label}[3/4]: clicked move ${direction} button`);
        break;
      }
    } catch { /* Try next */ }
  }

  // Fallback: try finding arrow buttons by their SVG icon / visual position
  if (!arrowClicked) {
    // The section toolbar has ↑ and ↓ arrow buttons. Try all arrow buttons
    // and pick the first (up) or second (down).
    const allArrows = page.locator(
      'button[aria-label*="Move"], button[aria-label*="move"]'
    );
    const arrowCount = await allArrows.count();
    if (arrowCount >= 2) {
      const idx = direction === 'up' ? 0 : 1;
      const btn = allArrows.nth(idx);
      const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        arrowClicked = true;
        logger.info(`${label}[3/4]: clicked arrow button by index (${idx})`);
      }
    }
  }

  if (!arrowClicked) {
    return {
      success: false,
      message: `${label} step 3: Move ${direction} button not found in section toolbar. The section may be at the ${direction === 'up' ? 'top' : 'bottom'} of the page already.`,
    };
  }

  // ── Step 4: Wait for animation and return ───────────────────────────
  logger.info(`${label}[4/4]: waiting for section to move`);
  await page.waitForTimeout(1500);

  return {
    success: true,
    message: `${label}: Moved section containing "${searchText}" ${direction}. Verify visually.`,
  };
}

// ─── Compound Action: editSectionStyle ───────────────────────────────────

/**
 * Compound action: edit a section's design settings (background color, image).
 *
 * IMPORTANT: This uses "EDIT SECTION" (design panel), NOT "EDIT CONTENT"
 * (Fluid Engine editor). The design panel controls background color,
 * background image, section height, etc.
 *
 * Steps:
 * 1. Find the section by text
 * 2. Click through overlay to select the section
 * 3. Click "EDIT SECTION" to open the design panel
 * 4. Set background color if provided
 * 5. Set background image if provided
 * 6. Close panel and verify
 */
export async function handleEditSectionStyle(
  page: Page,
  action: { action: 'editSectionStyle'; searchText: string; backgroundColor?: string; backgroundImage?: string; sectionTheme?: string; sectionHeight?: 'auto' | 'small' | 'medium' | 'large' | 'full'; contentWidth?: 'inset' | 'full'; verticalAlignment?: 'top' | 'middle' | 'bottom'; overlayOpacity?: number; sectionPadding?: 'none' | 'small' | 'medium' | 'large'; blockSpacing?: 'none' | 'small' | 'medium' | 'large' },
): Promise<ActionResult> {
  const { searchText, backgroundColor, backgroundImage, sectionTheme, sectionHeight, contentWidth, verticalAlignment, overlayOpacity, sectionPadding, blockSpacing } = action;

  if (!backgroundColor && !backgroundImage && !sectionTheme && !sectionHeight && !contentWidth && !verticalAlignment && overlayOpacity === undefined && !sectionPadding && !blockSpacing) {
    return {
      success: false,
      message: 'editSectionStyle: Must provide at least one style property (backgroundColor, backgroundImage, sectionTheme, sectionHeight, contentWidth, verticalAlignment, overlayOpacity, sectionPadding, or blockSpacing).',
    };
  }

  // ── API Fast Path: try Content Save API first (~200ms vs 15-20 UI steps) ──
  // Note: backgroundImage and overlayOpacity are not supported via API (need UI)
  if (!backgroundImage && overlayOpacity === undefined) {
    const apiResult = await trySectionStyleApi(page, searchText, {
      sectionTheme,
      backgroundColor,
      sectionHeight,
      contentWidth,
      verticalAlignment,
      blockSpacing: blockSpacing ?? undefined,
      paddingTop: sectionPadding ?? undefined,
      paddingBottom: sectionPadding ?? undefined,
    });
    if (apiResult) return apiResult;
    logger.info({ searchText }, 'editSectionStyle: API fast path failed, falling back to UI');
  }

  // ── Step 1: Find the section ──────────────────────────────────────────
  logger.info({ searchText }, 'editSectionStyle[1/12]: finding section');
  const matches = await findTextOnPage(page, searchText);
  if (matches.length === 0) {
    return {
      success: false,
      message: `editSectionStyle step 1/10: Text "${searchText}" not found on page`,
    };
  }

  // ── Step 2: Click through overlay to select the section ───────────────
  logger.info('editSectionStyle[2/12]: clicking section');
  // Escape any existing edit mode first
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const textSelector = `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return {
      success: false,
      message: `editSectionStyle step 2/10: Failed to click section — ${clickResult.message}`,
    };
  }
  await page.waitForTimeout(800);

  // ── Step 3: Click "EDIT SECTION" to open design panel ─────────────────
  // NOTE: This is EDIT SECTION (design), not EDIT CONTENT (Fluid Engine).
  logger.info('editSectionStyle[3/12]: clicking EDIT SECTION');

  const editSectionSelectors = [
    'button:has-text("EDIT SECTION")',
    'button:has-text("Edit Section")',
    'button:has-text("Edit section")',
    '[aria-label="Edit Section"]',
    '[aria-label="Edit section"]',
    '[data-test="edit-section"]',
    'button:has-text("EDIT DESIGN")',
    'button:has-text("Edit Design")',
  ];

  let editSectionClicked = false;
  for (const selector of editSectionSelectors) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        editSectionClicked = true;
        logger.info({ selector }, 'editSectionStyle[3/12]: clicked EDIT SECTION');
        break;
      }
    } catch { /* Try next */ }
  }

  if (!editSectionClicked) {
    return {
      success: false,
      message: 'editSectionStyle step 3/10: EDIT SECTION button not found. The section may not be properly selected.',
    };
  }
  await page.waitForTimeout(1500);

  // ── Step 4: Set section theme ──────────────────────────────────────────
  let themeSet = false;
  if (sectionTheme) {
    logger.info({ sectionTheme }, 'editSectionStyle[4/12]: setting section theme');

    // Expand the Colors/Theme section if it's collapsible
    const themeSectionSelectors = [
      'text=Colors',
      'text=COLORS',
      'text=Theme',
      'text=THEME',
      'text=Color Theme',
      '[data-test*="color-theme"]',
      '[data-test*="section-theme"]',
    ];

    for (const selector of themeSectionSelectors) {
      const el = page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }

    // Strategy A: Find theme option by text label (buttons, role=option, data-value)
    const themeOptionSelectors = [
      `button:has-text("${sectionTheme}")`,
      `[role="option"]:has-text("${sectionTheme}")`,
      `[data-value="${sectionTheme}"]`,
      `label:has-text("${sectionTheme}")`,
      `[class*="theme"]:has-text("${sectionTheme}")`,
      `[class*="color-theme"] button:has-text("${sectionTheme}")`,
    ];

    for (const selector of themeOptionSelectors) {
      try {
        const option = page.locator(selector).first();
        const visible = await option.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await option.click({ timeout: 3000 });
          themeSet = true;
          logger.info({ selector, sectionTheme }, 'editSectionStyle[4/12]: set section theme');
          break;
        }
      } catch { /* Try next */ }
    }

    // Strategy B: Try <select> dropdown
    if (!themeSet) {
      const selectSelectors = [
        'select[class*="theme"]',
        'select[class*="color"]',
        'select[data-test*="theme"]',
      ];
      for (const selector of selectSelectors) {
        try {
          const select = page.locator(selector).first();
          const visible = await select.isVisible({ timeout: 2000 }).catch(() => false);
          if (visible) {
            await select.selectOption({ label: sectionTheme }).catch(async () => {
              await select.selectOption(sectionTheme).catch(() => {});
            });
            themeSet = true;
            logger.info('editSectionStyle[4/12]: set theme via select dropdown');
            break;
          }
        } catch { /* Try next */ }
      }
    }

    if (!themeSet) {
      logger.warn('editSectionStyle[4/12]: could not find theme selector in design panel');
    }
    await page.waitForTimeout(500);
  }

  // ── Step 5: Set background color ──────────────────────────────────────
  let colorSet = false;
  if (backgroundColor) {
    logger.info({ backgroundColor }, 'editSectionStyle[5/12]: setting background color');

    // Look for color-related inputs in the design panel
    // Squarespace design panel has a "Colors" or "Background" section
    // with color pickers (swatches + hex input)

    // Strategy A: Look for the Background section and click it to expand
    const bgSectionSelectors = [
      'text=Background',
      'text=BACKGROUND',
      'text=Colors',
      'text=COLORS',
    ];

    for (const selector of bgSectionSelectors) {
      const el = page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }

    // Strategy B: Find a hex color input and fill it
    const colorInputSelectors = [
      'input[type="color"]',
      'input[placeholder*="#"]',
      'input[placeholder*="hex"]',
      'input[placeholder*="Hex"]',
      'input[aria-label*="color"]',
      'input[aria-label*="Color"]',
      'input[data-test*="color"]',
    ];

    for (const selector of colorInputSelectors) {
      try {
        const input = page.locator(selector).first();
        const visible = await input.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          const inputType = await input.getAttribute('type').catch(() => '');
          if (inputType === 'color') {
            // For type="color" inputs, we need to use evaluate
            await input.evaluate((el, color) => {
              (el as HTMLInputElement).value = color;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, backgroundColor);
          } else {
            await input.fill(backgroundColor);
          }
          colorSet = true;
          logger.info({ selector, backgroundColor }, 'editSectionStyle[5/12]: set background color');
          break;
        }
      } catch { /* Try next */ }
    }

    // Strategy C: Click a color swatch to open picker, then type hex
    if (!colorSet) {
      const swatchSelectors = [
        '[class*="color-swatch"]',
        '[class*="ColorSwatch"]',
        '[class*="color-picker"]',
        'button[class*="color"]',
      ];

      for (const selector of swatchSelectors) {
        const swatch = page.locator(selector).first();
        const visible = await swatch.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await swatch.click();
          await page.waitForTimeout(500);

          // Now look for hex input in the picker popup
          const hexInput = page.locator('input[placeholder*="#"], input[aria-label*="hex"]').first();
          const hexVisible = await hexInput.isVisible({ timeout: 2000 }).catch(() => false);
          if (hexVisible) {
            await hexInput.fill(backgroundColor);
            await page.keyboard.press('Enter');
            colorSet = true;
            logger.info('editSectionStyle[5/12]: set color via swatch picker');
          }
          break;
        }
      }
    }

    if (!colorSet) {
      logger.warn('editSectionStyle[5/12]: could not find color input in design panel');
    }
  }

  // ── Step 6: Set background image ──────────────────────────────────────
  let imageSet = false;
  if (backgroundImage) {
    logger.info({ backgroundImage }, 'editSectionStyle[6/12]: setting background image');

    // Look for background image upload in the design panel
    const bgImageSelectors = [
      'text=Background Image',
      'text=BACKGROUND IMAGE',
      'text=Section Background',
    ];

    for (const selector of bgImageSelectors) {
      const el = page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }

    // Find file input for background image upload
    const fileInputs = page.locator('input[type="file"]');
    const fileCount = await fileInputs.count();
    for (let i = 0; i < fileCount; i++) {
      try {
        await fileInputs.nth(i).setInputFiles(backgroundImage);
        imageSet = true;
        logger.info('editSectionStyle[6/12]: uploaded background image');
        break;
      } catch { /* try next */ }
    }

    // Try upload button
    if (!imageSet) {
      const uploadSelectors = [
        'button:has-text("Upload")',
        'button:has-text("UPLOAD")',
        'button:has-text("Add Image")',
        '[aria-label="Upload background image"]',
      ];

      for (const selector of uploadSelectors) {
        const btn = page.locator(selector).first();
        const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await btn.click();
          await page.waitForTimeout(1000);

          const newFileInputs = page.locator('input[type="file"]');
          const newCount = await newFileInputs.count();
          for (let i = 0; i < newCount; i++) {
            try {
              await newFileInputs.nth(i).setInputFiles(backgroundImage);
              imageSet = true;
              logger.info('editSectionStyle[6/12]: uploaded via upload button');
              break;
            } catch { /* try next */ }
          }
          if (imageSet) break;
        }
      }
    }

    if (!imageSet) {
      logger.warn('editSectionStyle[6/12]: could not upload background image');
    }
    await page.waitForTimeout(2000);
  }

  // ── Step 7: Set overlay opacity ──────────────────────────────────────
  let opacitySet = false;
  if (overlayOpacity !== undefined) {
    logger.info({ overlayOpacity }, 'editSectionStyle[7/12]: setting overlay opacity');

    // Strategy A: Find an opacity slider/range input
    const opacitySelectors = [
      'input[type="range"][class*="opacity"]',
      'input[type="range"][aria-label*="opacity" i]',
      'input[type="range"][data-test*="opacity"]',
    ];

    for (const selector of opacitySelectors) {
      try {
        const slider = page.locator(selector).first();
        const visible = await slider.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await slider.fill(String(overlayOpacity));
          opacitySet = true;
          logger.info({ selector }, 'editSectionStyle[7/12]: set opacity via range input');
          break;
        }
      } catch { /* Try next */ }
    }

    // Strategy B: Find an opacity number input
    if (!opacitySet) {
      const numberSelectors = [
        'input[type="number"][class*="opacity"]',
        'input[aria-label*="opacity" i]',
        'input[aria-label*="Opacity"]',
        'input[placeholder*="opacity" i]',
      ];

      for (const selector of numberSelectors) {
        try {
          const input = page.locator(selector).first();
          const visible = await input.isVisible({ timeout: 2000 }).catch(() => false);
          if (visible) {
            await input.fill(String(overlayOpacity));
            await page.keyboard.press('Enter');
            opacitySet = true;
            logger.info({ selector }, 'editSectionStyle[7/12]: set opacity via number input');
            break;
          }
        } catch { /* Try next */ }
      }
    }

    // Strategy C: Click "Overlay" label to expand, then find any range input
    if (!opacitySet) {
      const overlayLabels = ['text=Overlay', 'text=OVERLAY', 'text=Overlay Opacity'];
      for (const label of overlayLabels) {
        const el = page.locator(label).first();
        const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await el.click().catch(() => {});
          await page.waitForTimeout(500);
          const slider = page.locator('input[type="range"]').first();
          const sliderVisible = await slider.isVisible({ timeout: 2000 }).catch(() => false);
          if (sliderVisible) {
            await slider.fill(String(overlayOpacity));
            opacitySet = true;
            logger.info('editSectionStyle[7/12]: set opacity via overlay section');
          }
          break;
        }
      }
    }

    if (!opacitySet) {
      logger.warn('editSectionStyle[7/12]: could not find opacity control in design panel');
    }
    await page.waitForTimeout(500);
  }

  // ── Step 8: Set section height ─────────────────────────────────────────
  let heightSet = false;
  if (sectionHeight) {
    logger.info({ sectionHeight }, 'editSectionStyle[8/12]: setting section height');

    const heightLabel = sectionHeight.charAt(0).toUpperCase() + sectionHeight.slice(1); // "Auto", "Small", etc.

    // Expand the Height section if needed
    const heightSectionLabels = ['text=Height', 'text=HEIGHT', 'text=Section Height'];
    for (const label of heightSectionLabels) {
      const el = page.locator(label).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }

    // Strategy A: Find height option by text label
    const heightOptionSelectors = [
      `button:has-text("${heightLabel}")`,
      `[role="option"]:has-text("${heightLabel}")`,
      `label:has-text("${heightLabel}")`,
      `[data-value="${sectionHeight}"]`,
      `[class*="height"] button:has-text("${heightLabel}")`,
    ];

    for (const selector of heightOptionSelectors) {
      try {
        const option = page.locator(selector).first();
        const visible = await option.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await option.click({ timeout: 3000 });
          heightSet = true;
          logger.info({ selector, sectionHeight }, 'editSectionStyle[8/12]: set section height');
          break;
        }
      } catch { /* Try next */ }
    }

    // Strategy B: Try <select> dropdown
    if (!heightSet) {
      const selects = page.locator('select[class*="height"], select[data-test*="height"]');
      const count = await selects.count();
      for (let i = 0; i < count; i++) {
        try {
          await selects.nth(i).selectOption({ label: heightLabel }).catch(async () => {
            await selects.nth(i).selectOption(sectionHeight).catch(() => {});
          });
          heightSet = true;
          logger.info('editSectionStyle[8/12]: set height via select dropdown');
          break;
        } catch { /* Try next */ }
      }
    }

    if (!heightSet) {
      logger.warn('editSectionStyle[8/12]: could not find height control in design panel');
    }
    await page.waitForTimeout(500);
  }

  // ── Step 9: Set content width and vertical alignment ───────────────────
  let widthSet = false;
  if (contentWidth) {
    logger.info({ contentWidth }, 'editSectionStyle[9/12]: setting content width');

    const widthLabel = contentWidth.charAt(0).toUpperCase() + contentWidth.slice(1); // "Inset" or "Full"

    // Expand Content Width section
    const widthSectionLabels = ['text=Content Width', 'text=CONTENT WIDTH', 'text=Width'];
    for (const label of widthSectionLabels) {
      const el = page.locator(label).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }

    const widthSelectors = [
      `button:has-text("${widthLabel}")`,
      `[role="option"]:has-text("${widthLabel}")`,
      `label:has-text("${widthLabel}")`,
      `[data-value="${contentWidth}"]`,
    ];

    for (const selector of widthSelectors) {
      try {
        const option = page.locator(selector).first();
        const visible = await option.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await option.click({ timeout: 3000 });
          widthSet = true;
          logger.info({ selector }, 'editSectionStyle[9/12]: set content width');
          break;
        }
      } catch { /* Try next */ }
    }

    if (!widthSet) {
      logger.warn('editSectionStyle[9/12]: could not find content width control');
    }
  }

  let alignmentSet = false;
  if (verticalAlignment) {
    logger.info({ verticalAlignment }, 'editSectionStyle[9/12]: setting vertical alignment');

    const alignLabel = verticalAlignment.charAt(0).toUpperCase() + verticalAlignment.slice(1); // "Top", "Middle", "Bottom"

    // Expand alignment section
    const alignSectionLabels = ['text=Vertical Alignment', 'text=VERTICAL ALIGNMENT', 'text=Alignment'];
    for (const label of alignSectionLabels) {
      const el = page.locator(label).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }

    const alignSelectors = [
      `button:has-text("${alignLabel}")`,
      `[role="option"]:has-text("${alignLabel}")`,
      `[aria-label*="${alignLabel}"]`,
      `[aria-label*="${verticalAlignment}"]`,
      `[data-value="${verticalAlignment}"]`,
    ];

    for (const selector of alignSelectors) {
      try {
        const option = page.locator(selector).first();
        const visible = await option.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await option.click({ timeout: 3000 });
          alignmentSet = true;
          logger.info({ selector }, 'editSectionStyle[9/12]: set vertical alignment');
          break;
        }
      } catch { /* Try next */ }
    }

    if (!alignmentSet) {
      logger.warn('editSectionStyle[9/12]: could not find vertical alignment control');
    }
    await page.waitForTimeout(500);
  }

  // ── Step 10: Set section padding ──────────────────────────────────────
  let paddingSet = false;
  if (sectionPadding) {
    logger.info({ sectionPadding }, 'editSectionStyle[10/12]: setting section padding');

    const paddingLabel = sectionPadding.charAt(0).toUpperCase() + sectionPadding.slice(1); // "None", "Small", "Medium", "Large"

    // Expand the Padding section if needed
    const paddingSectionLabels = ['text=Padding', 'text=PADDING', 'text=Section Padding', 'text=Top/Bottom Padding'];
    for (const label of paddingSectionLabels) {
      const el = page.locator(label).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }

    // Strategy A: Find padding option by text label (button presets)
    const paddingOptionSelectors = [
      `button:has-text("${paddingLabel}")`,
      `[role="option"]:has-text("${paddingLabel}")`,
      `label:has-text("${paddingLabel}")`,
      `[data-value="${sectionPadding}"]`,
      `[class*="padding"] button:has-text("${paddingLabel}")`,
    ];

    for (const selector of paddingOptionSelectors) {
      try {
        const option = page.locator(selector).first();
        const visible = await option.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await option.click({ timeout: 3000 });
          paddingSet = true;
          logger.info({ selector, sectionPadding }, 'editSectionStyle[10/12]: set section padding');
          break;
        }
      } catch { /* Try next */ }
    }

    // Strategy B: Try slider input (range)
    if (!paddingSet) {
      const paddingValues: Record<string, number> = { none: 0, small: 25, medium: 50, large: 100 };
      const targetVal = paddingValues[sectionPadding] ?? 50;
      const sliders = page.locator('input[type="range"]');
      const sliderCount = await sliders.count().catch(() => 0);
      // Look for a slider near a "Padding" label
      for (let i = 0; i < sliderCount; i++) {
        const slider = sliders.nth(i);
        const visible = await slider.isVisible({ timeout: 1000 }).catch(() => false);
        if (visible) {
          // Check if a nearby label says "Padding"
          const parent = slider.locator('xpath=ancestor::*[position()<=3]');
          const parentText = await parent.first().innerText().catch(() => '');
          if (parentText.toLowerCase().includes('padding')) {
            await slider.fill(String(targetVal));
            paddingSet = true;
            logger.info({ targetVal }, 'editSectionStyle[10/12]: set padding via slider');
            break;
          }
        }
      }
    }

    // Strategy C: Try <select> dropdown
    if (!paddingSet) {
      const selects = page.locator('select[class*="padding"], select[data-test*="padding"]');
      const count = await selects.count();
      for (let i = 0; i < count; i++) {
        try {
          await selects.nth(i).selectOption({ label: paddingLabel }).catch(async () => {
            await selects.nth(i).selectOption(sectionPadding).catch(() => {});
          });
          paddingSet = true;
          logger.info('editSectionStyle[10/12]: set padding via select dropdown');
          break;
        } catch { /* Try next */ }
      }
    }

    if (!paddingSet) {
      logger.warn('editSectionStyle[10/12]: could not find padding control in design panel');
    }
    await page.waitForTimeout(500);
  }

  // ── Step 11: Set block spacing ────────────────────────────────────────
  let spacingSet = false;
  if (blockSpacing) {
    logger.info({ blockSpacing }, 'editSectionStyle[11/12]: setting block spacing');

    const spacingLabel = blockSpacing.charAt(0).toUpperCase() + blockSpacing.slice(1); // "None", "Small", "Medium", "Large"

    // Expand the Spacing/Gap section if needed
    const spacingSectionLabels = ['text=Spacing', 'text=SPACING', 'text=Block Spacing', 'text=Gap', 'text=GAP', 'text=Block Gap'];
    for (const label of spacingSectionLabels) {
      const el = page.locator(label).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click().catch(() => {});
        await page.waitForTimeout(500);
        break;
      }
    }

    // Strategy A: Find spacing option by text label (button presets)
    const spacingOptionSelectors = [
      `button:has-text("${spacingLabel}")`,
      `[role="option"]:has-text("${spacingLabel}")`,
      `label:has-text("${spacingLabel}")`,
      `[data-value="${blockSpacing}"]`,
      `[class*="spacing"] button:has-text("${spacingLabel}")`,
      `[class*="gap"] button:has-text("${spacingLabel}")`,
    ];

    for (const selector of spacingOptionSelectors) {
      try {
        const option = page.locator(selector).first();
        const visible = await option.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await option.click({ timeout: 3000 });
          spacingSet = true;
          logger.info({ selector, blockSpacing }, 'editSectionStyle[11/12]: set block spacing');
          break;
        }
      } catch { /* Try next */ }
    }

    // Strategy B: Try slider input (range)
    if (!spacingSet) {
      const spacingValues: Record<string, number> = { none: 0, small: 25, medium: 50, large: 100 };
      const targetVal = spacingValues[blockSpacing] ?? 50;
      const sliders = page.locator('input[type="range"]');
      const sliderCount = await sliders.count().catch(() => 0);
      for (let i = 0; i < sliderCount; i++) {
        const slider = sliders.nth(i);
        const visible = await slider.isVisible({ timeout: 1000 }).catch(() => false);
        if (visible) {
          const parent = slider.locator('xpath=ancestor::*[position()<=3]');
          const parentText = await parent.first().innerText().catch(() => '');
          if (parentText.toLowerCase().includes('spacing') || parentText.toLowerCase().includes('gap')) {
            await slider.fill(String(targetVal));
            spacingSet = true;
            logger.info({ targetVal }, 'editSectionStyle[11/12]: set spacing via slider');
            break;
          }
        }
      }
    }

    // Strategy C: Try <select> dropdown
    if (!spacingSet) {
      const selects = page.locator('select[class*="spacing"], select[class*="gap"], select[data-test*="spacing"]');
      const count = await selects.count();
      for (let i = 0; i < count; i++) {
        try {
          await selects.nth(i).selectOption({ label: spacingLabel }).catch(async () => {
            await selects.nth(i).selectOption(blockSpacing).catch(() => {});
          });
          spacingSet = true;
          logger.info('editSectionStyle[11/12]: set spacing via select dropdown');
          break;
        } catch { /* Try next */ }
      }
    }

    if (!spacingSet) {
      logger.warn('editSectionStyle[11/12]: could not find block spacing control in design panel');
    }
    await page.waitForTimeout(500);
  }

  // ── Step 12: Close panel and verify ────────────────────────────────────
  logger.info('editSectionStyle[12/12]: closing panel');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.mouse.click(600, 500);
  await page.waitForTimeout(1000);

  // Build result message
  const parts: string[] = [];
  const warnings: string[] = [];

  if (sectionTheme) {
    if (themeSet) parts.push(`section theme set to "${sectionTheme}"`);
    else warnings.push('could not set section theme — theme selector not found');
  }
  if (backgroundColor) {
    if (colorSet) parts.push(`background color set to "${backgroundColor}"`);
    else warnings.push('could not set background color — color input not found in design panel');
  }
  if (backgroundImage) {
    if (imageSet) parts.push('background image uploaded');
    else warnings.push('could not upload background image — file input not found');
  }
  if (overlayOpacity !== undefined) {
    if (opacitySet) parts.push(`overlay opacity set to ${overlayOpacity}%`);
    else warnings.push('could not set overlay opacity — opacity control not found');
  }
  if (sectionHeight) {
    if (heightSet) parts.push(`section height set to "${sectionHeight}"`);
    else warnings.push('could not set section height — height control not found');
  }
  if (contentWidth) {
    if (widthSet) parts.push(`content width set to "${contentWidth}"`);
    else warnings.push('could not set content width — width control not found');
  }
  if (verticalAlignment) {
    if (alignmentSet) parts.push(`vertical alignment set to "${verticalAlignment}"`);
    else warnings.push('could not set vertical alignment — alignment control not found');
  }
  if (sectionPadding) {
    if (paddingSet) parts.push(`section padding set to "${sectionPadding}"`);
    else warnings.push('could not set section padding — padding control not found');
  }
  if (blockSpacing) {
    if (spacingSet) parts.push(`block spacing set to "${blockSpacing}"`);
    else warnings.push('could not set block spacing — spacing control not found');
  }

  if (parts.length === 0 && warnings.length > 0) {
    return {
      success: false,
      message: `editSectionStyle: ${warnings.join('; ')}. The EDIT SECTION panel may have a different layout than expected.`,
    };
  }

  return {
    success: true,
    message: `editSectionStyle: ${parts.join('; ')} for section "${searchText}".${warnings.length > 0 ? ` Warning: ${warnings.join('; ')}.` : ''} Verify visually.`,
  };
}

// ─── Compound Action: addSectionFromTemplate ─────────────────────────────────

/**
 * Compound action: add a section from a template and replace placeholder content.
 *
 * Orchestrates the full template workflow:
 * 1. Add a section from a template category (delegates to handleAddSection)
 * 2. Wait for the template to render
 * 3. Enter section edit mode for the new section
 * 4. Replace placeholder text blocks (delegates to handleEditTextBlock)
 * 5. Replace placeholder buttons (delegates to handleEditButtonBlock)
 * 6. Replace placeholder images (delegates to handleReplaceImage)
 * 7. Remove unwanted blocks (delegates to handleRemoveBlock)
 *
 * Partial success is OK — if the template loads but some replacements fail,
 * the action still returns success with a detailed report.
 */
export async function handleAddSectionFromTemplate(
  page: Page,
  action: {
    action: 'addSectionFromTemplate';
    category: string;
    template: string;
    templateIndex?: number;
    replacements: {
      texts?: Array<{ searchText: string; newText: string }>;
      buttons?: Array<{ searchText: string; newLabel?: string; url?: string }>;
      images?: Array<{ searchText: string; imagePath: string; altText?: string }>;
      removeBlocks?: string[];
    };
  },
): Promise<ActionResult> {
  const { category, template, templateIndex, replacements } = action;

  // ── Phase 1: Add the template section ────────────────────────────────
  logger.info({ category, template, templateIndex }, 'addSectionFromTemplate[Phase1]: adding template section');

  const addResult = await handleAddSection(page, {
    action: 'addSection',
    category,
    template,
    templateIndex,
  });

  if (!addResult.success) {
    return {
      success: false,
      message: `addSectionFromTemplate Phase 1 (addSection): ${addResult.message}. Fallback: try addSection with no template, then manually add blocks.`,
    };
  }

  // Wait for template section to fully render with placeholder content
  await page.waitForTimeout(3000);

  // ── Phase 1b: Verify the template is correct ──────────────────────────
  // Detect if the wrong template type was loaded (e.g., Product/Store block
  // instead of a text section). This prevents wasting 30+ steps editing
  // the wrong thing.
  // Only check when the category is NOT Products/Store (product blocks are expected there)
  const isProductCategory = /product|store|shop|sell/i.test(category);
  if (!isProductCategory) {
    const wrongTemplateIndicators = await page.evaluate(() => {
      // Check both main frame and iframe for product/store elements
      const indicators: string[] = [];
      const iframe = document.querySelector<HTMLIFrameElement>('#sqs-site-frame');
      const doc = iframe?.contentDocument || document;
      if (doc.querySelector('.sqs-product-quick-view, .product-block, [class*="ProductItem"]')) {
        indicators.push('product-block');
      }
      if (doc.querySelector('.sqs-add-to-cart-button, [class*="add-to-cart"]')) {
        indicators.push('add-to-cart');
      }
      if (doc.querySelector('.product-price, [class*="product-price"]')) {
        indicators.push('product-price');
      }
      // Also check for text content that indicates a product template
      const bodyText = doc.body?.textContent || '';
      if (bodyText.includes('Add to cart') || bodyText.includes('Add to Cart')) {
        indicators.push('cart-text');
      }
      if (bodyText.includes('Product Name') && bodyText.includes('$')) {
        indicators.push('product-placeholder');
      }
      return indicators;
    }).catch(() => []);

    if (wrongTemplateIndicators.length > 0) {
      logger.warn(
        { indicators: wrongTemplateIndicators, category, template },
        'addSectionFromTemplate[Phase1b]: WRONG TEMPLATE DETECTED — got a Product/Store template instead of content template',
      );
      return {
        success: false,
        message: `addSectionFromTemplate Phase 1b: Wrong template selected — detected product/store elements (${wrongTemplateIndicators.join(', ')}). Expected a "${category}" content template but got a product template. Retry with a different templateIndex or use a blank section + manual blocks instead.`,
      };
    }
  }

  // ── Phase 2: Enter edit mode for the new section ─────────────────────
  logger.info('addSectionFromTemplate[Phase2]: entering edit mode for new section');

  // handleAddSection stores the new section index in window.__lastAddedSectionIndex
  const sectionIndex = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__lastAddedSectionIndex as number | undefined,
  ).catch(() => undefined);

  if (sectionIndex !== undefined) {
    const enterResult = await handleEnterSectionEditMode(page, {
      action: 'enterSectionEditMode',
      sectionIndex,
    });
    if (!enterResult.success) {
      logger.warn(
        { error: enterResult.message },
        'addSectionFromTemplate[Phase2]: could not enter section edit mode — proceeding with replacements anyway',
      );
    }
  } else {
    // Try entering edit mode for the last section on the page
    const enterResult = await handleEnterSectionEditMode(page, {
      action: 'enterSectionEditMode',
      sectionIndex: 'last',
    });
    if (!enterResult.success) {
      logger.warn('addSectionFromTemplate[Phase2]: no section index stored and last-section fallback failed');
    }
  }

  await page.waitForTimeout(1500);

  // ── Phase 3: Replace placeholder content ─────────────────────────────
  const results: string[] = [];
  let successCount = 0;
  let failCount = 0;

  // 3a. Replace text blocks
  if (replacements.texts && replacements.texts.length > 0) {
    for (const textRep of replacements.texts) {
      logger.info({ searchText: textRep.searchText }, 'addSectionFromTemplate[Phase3a]: replacing text');
      const result = await handleEditTextBlock(page, {
        action: 'editTextBlock',
        searchText: textRep.searchText,
        newText: textRep.newText,
      });
      if (result.success) {
        successCount++;
        results.push(`✓ text "${textRep.searchText.substring(0, 20)}"`);
      } else {
        failCount++;
        results.push(`✗ text "${textRep.searchText.substring(0, 20)}": ${result.message.substring(0, 60)}`);
      }
      await page.waitForTimeout(500);
    }
  }

  // 3b. Replace buttons
  if (replacements.buttons && replacements.buttons.length > 0) {
    for (const btnRep of replacements.buttons) {
      logger.info({ searchText: btnRep.searchText }, 'addSectionFromTemplate[Phase3b]: replacing button');
      const result = await handleEditButtonBlock(page, {
        action: 'editButtonBlock',
        searchText: btnRep.searchText,
        newLabel: btnRep.newLabel,
        url: btnRep.url,
      });
      if (result.success) {
        successCount++;
        results.push(`✓ button "${btnRep.searchText.substring(0, 20)}"`);
      } else {
        failCount++;
        results.push(`✗ button "${btnRep.searchText.substring(0, 20)}": ${result.message.substring(0, 60)}`);
      }
      await page.waitForTimeout(500);
    }
  }

  // 3c. Replace images
  if (replacements.images && replacements.images.length > 0) {
    for (const imgRep of replacements.images) {
      logger.info({ searchText: imgRep.searchText }, 'addSectionFromTemplate[Phase3c]: replacing image');
      const result = await handleReplaceImage(page, {
        action: 'replaceImage',
        searchText: imgRep.searchText,
        imagePath: imgRep.imagePath,
        altText: imgRep.altText,
      });
      if (result.success) {
        successCount++;
        results.push(`✓ image "${imgRep.searchText.substring(0, 20)}"`);
      } else {
        failCount++;
        results.push(`✗ image "${imgRep.searchText.substring(0, 20)}": ${result.message.substring(0, 60)}`);
      }
      await page.waitForTimeout(500);
    }
  }

  // 3d. Remove unwanted blocks
  if (replacements.removeBlocks && replacements.removeBlocks.length > 0) {
    for (const blockText of replacements.removeBlocks) {
      logger.info({ searchText: blockText }, 'addSectionFromTemplate[Phase3d]: removing unwanted block');
      const result = await handleRemoveBlock(page, {
        action: 'removeBlock',
        searchText: blockText,
      });
      if (result.success) {
        successCount++;
        results.push(`✓ removed "${blockText.substring(0, 20)}"`);
      } else {
        failCount++;
        results.push(`✗ remove "${blockText.substring(0, 20)}": ${result.message.substring(0, 60)}`);
      }
      await page.waitForTimeout(500);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────
  const totalOps = successCount + failCount;
  const summary = totalOps > 0
    ? `${successCount}/${totalOps} replacements succeeded. ${results.join('; ')}`
    : 'Template added (no replacements requested)';

  if (failCount > 0 && successCount === 0) {
    return {
      success: false,
      message: `addSectionFromTemplate: Added "${template}" from "${category}" but all ${failCount} replacement(s) failed. ${summary}. Try individual editTextBlock/editButtonBlock/replaceImage actions.`,
    };
  }

  return {
    success: true,
    message: `addSectionFromTemplate: Added "${template}" from "${category}". ${summary}`,
  };
}
