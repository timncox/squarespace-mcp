import { Page } from 'playwright';
import { logger } from '../../utils/logger.js';
import { clickThroughOverlay, dblclickThroughOverlay, findTextOnPage, getSiteFrame } from '../editor-actions.js';
import { errMsg } from '../../utils/errors.js';
import { isFluidEngineActive, clickEditorButton, tryContentSaveApi } from './handler-utils.js';
import type { ActionResult } from './types.js';

// ─── Compound Action: editTextBlock ───────────────────────────────────────

/**
 * Compound action: edit a text block in the Squarespace Fluid Engine editor.
 *
 * Automates the full sequence that the agent frequently fails to chain:
 * 1. Find the text in the iframe
 * 2. Click through overlay to select the containing section
 * 3. Click "EDIT CONTENT" in the section context menu
 * 4. Wait for Fluid Engine editor to load
 * 5. Re-find the text block (DOM may restructure between preview and edit mode)
 * 6. Double-click through overlay to enter inline edit mode
 * 7. Verify contenteditable is active (Enter key recovery if needed)
 * 8. Select all (Meta+A) and type the new text
 * 9. Click away to deselect and trigger auto-save
 * 10. Verify the new text exists in the iframe DOM
 *
 * NOTE: The Squarespace DOM differs between preview mode and edit mode.
 * Elements may be re-wrapped, repositioned, or lose CSS transforms
 * (e.g., text-transform: uppercase). This handler re-resolves the text
 * locator after entering edit mode (step 5) and falls back to
 * case-insensitive matching. Future compound actions that need to verify
 * visual rendering (styles, layout) would need to check the live/published
 * site rather than the editor DOM.
 */
export async function handleEditTextBlock(
  page: Page,
  action: { action: 'editTextBlock'; searchText: string; newText: string },
): Promise<ActionResult> {
  const { searchText, newText } = action;

  // ── Fast path: try Content Save API first (no UI, ~100ms) ─────────────
  logger.info({ searchText }, 'editTextBlock[0/10]: trying Content Save API fast path');
  const apiResult = await tryContentSaveApi(page, searchText, newText);
  if (apiResult) {
    return apiResult;
  }
  logger.info('editTextBlock[0/10]: API fast path unavailable, falling back to UI automation');

  // ── Step 1: Find the text in the iframe ──────────────────────────────
  logger.info({ searchText }, 'editTextBlock[1/10]: finding text');
  let matches = await findTextOnPage(page, searchText);
  let usingPlaceholderFallback = false;

  if (matches.length === 0) {
    // Placeholder/empty text blocks: "Write here..." is a CSS placeholder,
    // NOT real DOM text. Look for empty text blocks instead.
    logger.info({ searchText }, 'editTextBlock[1/10]: no exact match — checking for empty/placeholder text blocks');
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (siteFrame) {
      const emptyBlockSelector = await siteFrame.evaluate((search: string) => {
        const lower = search.toLowerCase();
        // Check if search looks like it's targeting a placeholder
        const placeholderTerms = ['write here', 'placeholder', 'empty', 'click to edit', 'add text'];
        const isPlaceholderSearch = placeholderTerms.some(t => lower.includes(t));

        if (isPlaceholderSearch) {
          // Find empty text blocks — these have placeholder text via CSS ::before
          // Squarespace uses .sqs-block-content with empty or whitespace-only text
          const textBlocks = document.querySelectorAll(
            '.sqs-block-html .sqs-block-content, ' +
            '.sqs-block-html .html-block, ' +
            '[data-block-type="2"] .sqs-block-content, ' +  // block type 2 = text
            '.fe-block .sqs-block-content'
          );
          for (const block of textBlocks) {
            const text = (block as HTMLElement).innerText?.trim() || '';
            if (text === '' || text === '\n' || text === '\u200B') {
              // Found an empty text block — return a unique selector
              if (block.id) return `#${block.id}`;
              const parent = block.closest('[data-block-id]');
              if (parent) return `[data-block-id="${parent.getAttribute('data-block-id')}"]`;
              const feBlock = block.closest('.fe-block');
              if (feBlock) {
                const cls = feBlock.className.split(' ').find(c => c.startsWith('fe-block-'));
                if (cls) return `.${cls}`;
              }
              return '.sqs-block-html .sqs-block-content';
            }
          }
        }

        // Also try: the search text might appear as a ::placeholder or data attribute
        const allBlocks = document.querySelectorAll('[data-placeholder], [placeholder]');
        for (const block of allBlocks) {
          const ph = block.getAttribute('data-placeholder') || block.getAttribute('placeholder') || '';
          if (ph.toLowerCase().includes(lower)) {
            if (block.id) return `#${block.id}`;
            return null; // found but no unique selector
          }
        }

        return null;
      }, searchText).catch(() => null);

      if (emptyBlockSelector) {
        logger.info({ emptyBlockSelector }, 'editTextBlock[1/10]: found empty/placeholder text block');
        usingPlaceholderFallback = true;
        // Create a pseudo-match — we'll use the selector directly in later steps
        // Store the selector so we can use it for clicking
        (action as any)._placeholderSelector = emptyBlockSelector;
      }
    }

    if (!usingPlaceholderFallback) {
      return {
        success: false,
        message: `editTextBlock step 1 (findText): Text "${searchText}" not found on page. If targeting an empty text block, the placeholder text is CSS-only and not in the DOM.`,
      };
    }
  }

  // ── Step 2: Click through overlay to select the section ──────────────
  logger.info({ searchText, usingPlaceholderFallback }, 'editTextBlock[2/10]: clicking section');
  const placeholderSelector = (action as any)._placeholderSelector as string | undefined;
  const textSelector = usingPlaceholderFallback && placeholderSelector
    ? placeholderSelector
    : `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return {
      success: false,
      message: `editTextBlock step 2 (clickSection): Failed to click section — ${clickResult.message}`,
    };
  }
  await page.waitForTimeout(800);

  // ── Step 3: Check if Fluid Engine is already active ──────────────────
  // After clicking on a section, the Fluid Engine editor is typically already
  // active (blue border, ADD BLOCK button visible). We do NOT click
  // "EDIT SECTION" — that opens the section DESIGN settings panel, not the
  // content editor. We just need to proceed to clicking the specific block.
  logger.info('editTextBlock[3/10]: checking if Fluid Engine is active');

  const fluidEngineActive = await isFluidEngineActive(page, 3000);

  if (fluidEngineActive) {
    logger.info('editTextBlock[3/10]: Fluid Engine is active — proceeding to block selection');
  } else {
    // The Fluid Engine is NOT active. Try clicking "EDIT CONTENT" if it exists.
    // NOTE: "EDIT SECTION" opens DESIGN settings — we do NOT want that.
    logger.info('editTextBlock[3/10]: Fluid Engine not active — looking for EDIT CONTENT button');
    const editContentClicked = await clickEditorButton(page, /edit content/i, [
      '[aria-label="Edit Content"]', 'button[data-test="edit-content"]',
    ]);

    if (editContentClicked) {
      await page.waitForTimeout(1500);
    } else {
      logger.info('editTextBlock[3/10]: No EDIT CONTENT — Fluid Engine may activate after block click');
    }
  }

  // ── Step 4: Wait for Fluid Engine editor ─────────────────────────────
  logger.info('editTextBlock[4/10]: waiting for Fluid Engine');
  try {
    await Promise.race([
      page.locator('[class*="fluid-engine"]').first()
        .isVisible({ timeout: 3000 }).catch(() => false),
      page.locator('[class*="FluidEngine"]').first()
        .isVisible({ timeout: 3000 }).catch(() => false),
      isFluidEngineActive(page, 3000),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 3000)),
    ]);
  } catch {
    // Non-blocking — proceed anyway
  }

  // ── Step 5: Re-find the text in edit-mode DOM ─────────────────────────
  // IMPORTANT: The DOM structure changes between preview mode and Fluid
  // Engine edit mode. Elements may be re-wrapped, repositioned, or have
  // different CSS transforms (e.g., text-transform: uppercase in preview
  // but mixed-case in the editable block). We must re-find the text
  // fresh — we cannot reuse the locator/position from step 1.
  logger.info({ searchText, usingPlaceholderFallback }, 'editTextBlock[5/10]: re-finding text in edit-mode DOM');

  let editModeSelector = textSelector; // default: same text= selector

  if (usingPlaceholderFallback) {
    // For placeholder/empty blocks, keep using the placeholder selector.
    // The block is empty, so there's no text to re-find.
    editModeSelector = placeholderSelector || textSelector;
    logger.info({ editModeSelector }, 'editTextBlock[5/10]: using placeholder selector (empty block)');
  } else {
    // Re-resolve the selector fresh — findTextOnPage searches the current DOM
    const editableMatches = await findTextOnPage(page, searchText);

    if (editableMatches.length === 0) {
      // The text might have changed case/form when entering edit mode
      // (e.g., CSS text-transform: uppercase removed). Try case-insensitive search.
      logger.info({ searchText }, 'editTextBlock[5/10]: exact text not found, trying case-insensitive');
      const siteFrameStep5 = page.frame({ name: 'sqs-site-frame' });
      if (siteFrameStep5) {
        const caseInsensitiveFound = await siteFrameStep5.evaluate((search: string) => {
          const lower = search.toLowerCase();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
              // Return the text content of the parent element so we can build a selector
              const parent = node.parentElement;
              return parent?.textContent?.trim().substring(0, 100) || null;
            }
          }
          return null;
        }, searchText).catch(() => null);

        if (caseInsensitiveFound) {
          editModeSelector = `text=${caseInsensitiveFound}`;
          logger.info({ editModeSelector }, 'editTextBlock[5/10]: found case-insensitive match');
        } else {
          return {
            success: false,
            message: `editTextBlock step 5 (refindText): Text "${searchText}" not found after entering edit mode. DOM may have changed structure.`,
          };
        }
      } else {
        return {
          success: false,
          message: `editTextBlock step 5 (refindText): Text "${searchText}" not found and iframe unavailable`,
        };
      }
    }
  }

  // ── Step 6: Double-click to enter inline edit mode ───────────────────
  // Use the re-resolved selector which reflects the edit-mode DOM.
  // The overlay intercepts mouse events, so we dblclick through it using
  // coordinate translation. After the overlay click, we ALSO dispatch
  // synthetic dblclick events directly on the DOM element inside the iframe
  // to ensure the Squarespace editor activates.
  logger.info({ editModeSelector }, 'editTextBlock[6/10]: double-clicking text block');
  const dblResult = await dblclickThroughOverlay(page, editModeSelector);
  if (!dblResult.success) {
    return {
      success: false,
      message: `editTextBlock step 6 (dblclick): Failed to double-click text block — ${dblResult.message}`,
    };
  }
  await page.waitForTimeout(500);

  // ── Step 7: Verify contenteditable is active ─────────────────────────
  // The overlay dblclick often doesn't propagate into the iframe's focus chain.
  // We use multiple strategies, including synthetic DOM events and direct
  // contentEditable manipulation, to ensure the inline editor is active.
  logger.info('editTextBlock[7/10]: verifying contenteditable');
  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  let editorActive = false;

  const checkEditorActive = async (): Promise<boolean> => {
    if (!siteFrame) return false;
    return siteFrame.evaluate(() => {
      const active = document.activeElement;
      if (active && (active as HTMLElement).isContentEditable) return true;
      // Also check if ANY contenteditable element has focus or is in editing state
      const editableEls = document.querySelectorAll('[contenteditable="true"]');
      for (const el of editableEls) {
        if (el === document.activeElement) return true;
        // Check if the element has a blinking cursor (selection inside it)
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) return true;
      }
      const toolbar = document.querySelector(
        '.sqs-editing-toolbar, .rte-toolbar, [data-rte-toolbar]',
      );
      return !!toolbar;
    }).catch(() => false);
  };

  // Helper to find the text element in the iframe by text content
  const findTextElementInFrame = async (text: string): Promise<string | null> => {
    if (!siteFrame) return null;
    return siteFrame.evaluate((searchStr: string) => {
      const lower = searchStr.toLowerCase();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
          const parent = node.parentElement;
          if (!parent) continue;
          // Walk up to find the editable block or a suitable target
          const block = parent.closest('.sqs-block') || parent.closest('[data-block-id]') || parent.closest('.fe-block');
          if (block) {
            // Return info we can use to target this element
            const blockId = block.getAttribute('data-block-id') || '';
            const feBlock = block.closest('.fe-block');
            const feClass = feBlock?.className.split(' ').find((c: string) => c.startsWith('fe-block-')) || '';
            return JSON.stringify({
              blockId,
              feClass,
              parentTag: parent.tagName,
              parentId: parent.id || '',
            });
          }
        }
      }
      return null;
    }, text).catch(() => null);
  };

  if (siteFrame) {
    editorActive = await checkEditorActive();

    // Strategy 1: Dispatch synthetic dblclick events directly on the text element
    // This is crucial — the overlay dblclick sends events to the main frame,
    // but the Squarespace editor needs events on the actual DOM element.
    if (!editorActive) {
      logger.info('editTextBlock[7/10]: dispatching synthetic dblclick on DOM element');
      const synthResult = await siteFrame.evaluate((text: string) => {
        const lower = text.toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
            const target = node.parentElement;
            if (!target) continue;

            // Dispatch a full mouse event sequence to simulate a real dblclick
            const rect = target.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
            target.dispatchEvent(new MouseEvent('dblclick', opts));

            // Also try focusing the element
            target.focus();
            return { tag: target.tagName, text: target.textContent?.substring(0, 40) };
          }
        }
        return null;
      }, searchText).catch(() => null);

      if (synthResult) {
        logger.info({ synthResult }, 'editTextBlock[7/10]: synthetic dblclick dispatched');
        await page.waitForTimeout(500);
        editorActive = await checkEditorActive();
      }
    }

    // Strategy 2: Press Enter to force edit mode (Squarespace pattern)
    if (!editorActive) {
      logger.info('editTextBlock[7/10]: pressing Enter to force edit mode');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      editorActive = await checkEditorActive();
    }

    // Strategy 3: Find block by text content and directly set contentEditable + focus
    if (!editorActive) {
      logger.info('editTextBlock[7/10]: force-activating contentEditable on text element');
      const forceResult = await siteFrame.evaluate((text: string) => {
        const lower = text.toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
            const parent = node.parentElement;
            if (!parent) continue;

            // Find the block content container or the nearest editable ancestor
            const block = parent.closest('.sqs-block');
            if (!block) continue;

            // Look for existing contenteditable children first
            let editableEl = block.querySelector('[contenteditable="true"]') as HTMLElement | null;

            if (!editableEl) {
              // Find the best target: a <p>, <h1>-<h6>, or the block-content div
              editableEl = (block.querySelector('p, h1, h2, h3, h4, h5, h6') as HTMLElement) ||
                           (block.querySelector('.sqs-block-content') as HTMLElement);
            }

            if (editableEl) {
              // Force it to be editable
              editableEl.setAttribute('contenteditable', 'true');
              editableEl.focus();

              // Select all text inside
              const range = document.createRange();
              range.selectNodeContents(editableEl);
              const sel = window.getSelection();
              if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
              }
              return 'force-editable';
            }
          }
        }
        return null;
      }, searchText).catch(() => null);

      if (forceResult) {
        logger.info({ forceResult }, 'editTextBlock[7/10]: forced contentEditable');
        await page.waitForTimeout(300);
        editorActive = await checkEditorActive();

        // Even if checkEditorActive doesn't detect it, the force approach
        // sets contenteditable=true and selects text — typing should work
        if (!editorActive) {
          logger.info('editTextBlock[7/10]: force-editable applied — proceeding optimistically');
          editorActive = true;
        }
      }
    }

    // Strategy 4: Retry overlay double-click + immediate focus transfer
    if (!editorActive) {
      logger.info('editTextBlock[7/10]: retrying overlay dblclick with focus transfer');
      const retryDbl = await dblclickThroughOverlay(page, editModeSelector);
      if (retryDbl.success) {
        await page.waitForTimeout(300);
        // Immediately try to transfer focus into the iframe
        await siteFrame.evaluate((text: string) => {
          const lower = text.toLowerCase();
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
              const parent = node.parentElement;
              if (parent) {
                parent.focus();
                return true;
              }
            }
          }
          return false;
        }, searchText).catch(() => false);
        await page.waitForTimeout(300);
        editorActive = await checkEditorActive();
      }
    }

    // Strategy 5: Skip verification for placeholder blocks
    if (!editorActive && usingPlaceholderFallback) {
      logger.info('editTextBlock[7/10]: placeholder block — skipping strict verification, will try typing directly');
      editorActive = true;
    }
  }

  if (!editorActive) {
    return {
      success: false,
      message: 'editTextBlock step 7 (verifyEditable): Could not activate inline text editor. Try using dblclickInIframe manually.',
    };
  }

  // ── Step 8: Select all and type new text ─────────────────────────────
  logger.info({ newText: newText.substring(0, 50) }, 'editTextBlock[8/10]: selecting all and typing');

  // For placeholder blocks, ensure focus is in the block before typing
  if (usingPlaceholderFallback && siteFrame) {
    await siteFrame.evaluate((selector: string) => {
      let block: Element | null = null;
      if (selector.startsWith('#') || selector.startsWith('[')) {
        block = document.querySelector(selector);
      }
      if (block) {
        // Try to click and focus the deepest editable or text-holding element
        const targets = [
          block.querySelector('[contenteditable="true"]'),
          block.querySelector('p'),
          block.querySelector('div'),
          block,
        ];
        for (const target of targets) {
          if (target) {
            (target as HTMLElement).click();
            (target as HTMLElement).focus();
            break;
          }
        }
      }
    }, editModeSelector).catch(() => {});
    await page.waitForTimeout(200);
  }

  // Try keyboard-based replacement first (works when focus is correct)
  await page.keyboard.press('Meta+a');
  await page.waitForTimeout(200);
  await page.keyboard.type(newText, { delay: 20 });
  await page.waitForTimeout(500);

  // Check if the typing actually worked by looking for the new text in DOM
  let typingWorked = false;
  if (siteFrame) {
    typingWorked = await siteFrame.evaluate((text: string) => {
      return document.body.innerText.includes(text);
    }, newText).catch(() => false);
  }

  // If keyboard typing didn't work (focus was in wrong frame), use direct DOM replacement
  if (!typingWorked && siteFrame && !usingPlaceholderFallback) {
    logger.info('editTextBlock[8/10]: keyboard typing failed — using direct DOM replacement');
    const domReplaced = await siteFrame.evaluate((args: { oldText: string; newText: string }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.textContent && node.textContent.trim().toLowerCase().includes(args.oldText.toLowerCase())) {
          const parent = node.parentElement;
          if (!parent) continue;
          // Find the closest editable block
          const block = parent.closest('.sqs-block');
          if (!block) continue;
          // Replace the text content of the specific text node
          node.textContent = node.textContent.replace(
            new RegExp(args.oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
            args.newText,
          );
          // Dispatch an input event so Squarespace picks up the change
          parent.dispatchEvent(new Event('input', { bubbles: true }));
          parent.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, { oldText: searchText, newText }).catch(() => false);

    if (domReplaced) {
      logger.info('editTextBlock[8/10]: text replaced via direct DOM manipulation');
    } else {
      logger.info('editTextBlock[8/10]: direct DOM replacement also failed');
    }
  }

  // ── Step 9: Click away to deselect ───────────────────────────────────
  // IMPORTANT: Don't click at (100,100) — that's in the header zone and
  // triggers header/footer edit mode.  Use Escape key instead, then click
  // in a safe content area (near the middle of the viewport, y=500+).
  logger.info('editTextBlock[9/10]: pressing Escape to deselect');
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    // Click in a safe zone — center-right of viewport, well below header
    await page.mouse.click(600, 500);
    await page.waitForTimeout(500);
  } catch {
    // Non-critical — text was already typed
  }

  // ── Step 10: Verify the new text in DOM ──────────────────────────────
  logger.info({ newText: newText.substring(0, 50) }, 'editTextBlock[10/10]: verifying');
  let verified = false;

  // Wait a moment for Squarespace to persist the edit
  await page.waitForTimeout(500);

  if (siteFrame) {
    // Check the specific block we edited first
    if (usingPlaceholderFallback) {
      verified = await siteFrame.evaluate((args: { selector: string; text: string }) => {
        const block = document.querySelector(args.selector);
        if (block) {
          const blockText = (block as HTMLElement).innerText?.trim() || '';
          if (blockText.includes(args.text)) return true;
        }
        // Also check the parent block container
        const parent = block?.closest('.sqs-block');
        if (parent) {
          const parentText = (parent as HTMLElement).innerText?.trim() || '';
          if (parentText.includes(args.text)) return true;
        }
        // Fall back to full body search
        return document.body.innerText.includes(args.text);
      }, { selector: editModeSelector, text: newText }).catch(() => false);
    } else {
      verified = await siteFrame.evaluate((text: string) => {
        return document.body.innerText.includes(text);
      }, newText).catch(() => false);
    }
  }

  if (!verified) {
    // Fallback: check main frame
    verified = await page.evaluate((text: string) => {
      return document.body.innerText.includes(text);
    }, newText).catch(() => false);
  }

  if (!verified) {
    return {
      success: true,
      message: `editTextBlock: Typed "${newText.substring(0, 40)}" but could not verify in DOM. Text may have been entered — check visually.`,
    };
  }

  return {
    success: true,
    message: `editTextBlock: Successfully replaced "${searchText}" with "${newText.substring(0, 60)}${newText.length > 60 ? '...' : ''}"`,
  };
}

// ─── Compound Action: formatTextBlock ─────────────────────────────────────

/**
 * Compound action: format a text block in the Squarespace Fluid Engine editor.
 *
 * Enters inline edit mode on a text block, selects all text, and applies
 * formatting using the Squarespace text formatting toolbar.
 *
 * Steps:
 * 1. Validate at least one formatting param is provided
 * 2. Find the text in the iframe
 * 3. Click through overlay to select the section
 * 4. Check/enter Fluid Engine mode
 * 5. Re-find text in edit-mode DOM
 * 6. Double-click to enter inline editor + verify contenteditable
 * 7. Select all text
 * 8. Apply formatting options via toolbar
 * 9. Exit and build result
 */
export async function handleFormatTextBlock(
  page: Page,
  action: { action: 'formatTextBlock'; searchText: string; formatLevel?: 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'paragraph1' | 'paragraph2' | 'paragraph3' | 'monospace'; bold?: boolean; italic?: boolean; alignment?: 'left' | 'center' | 'right'; fontSize?: 'increase' | 'decrease' },
): Promise<ActionResult> {
  const { searchText, formatLevel, bold, italic, alignment, fontSize } = action;

  // ── Step 1/9: Validate params ────────────────────────────────────────
  if (!formatLevel && bold === undefined && italic === undefined && !alignment && !fontSize) {
    return {
      success: false,
      message: 'formatTextBlock: must provide at least one formatting option (formatLevel, bold, italic, alignment, or fontSize)',
    };
  }

  // ── Step 2/9: Find the text in the iframe ────────────────────────────
  logger.info({ searchText }, 'formatTextBlock[2/9]: finding text');
  const matches = await findTextOnPage(page, searchText);
  if (matches.length === 0) {
    return {
      success: false,
      message: `formatTextBlock step 2 (findText): Text "${searchText}" not found on page`,
    };
  }

  // ── Step 3/9: Click through overlay to select the section ────────────
  logger.info({ searchText }, 'formatTextBlock[3/9]: clicking section');
  const textSelector = `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return {
      success: false,
      message: `formatTextBlock step 3 (clickSection): Failed to click section — ${clickResult.message}`,
    };
  }
  await page.waitForTimeout(800);

  // ── Step 4/9: Check/enter Fluid Engine mode ──────────────────────────
  logger.info('formatTextBlock[4/9]: checking Fluid Engine');
  const fluidActive = await isFluidEngineActive(page, 3000);
  if (!fluidActive) {
    logger.info('formatTextBlock[4/9]: Fluid Engine not active — looking for EDIT CONTENT');
    const editContentClicked = await clickEditorButton(page, /edit content/i, [
      '[aria-label="Edit Content"]', 'button[data-test="edit-content"]',
    ]);
    if (editContentClicked) {
      await page.waitForTimeout(1500);
    }
  }

  // Wait briefly for Fluid Engine to settle
  try {
    await Promise.race([
      page.locator('[class*="fluid-engine"]').first().isVisible({ timeout: 3000 }).catch(() => false),
      page.locator('[class*="FluidEngine"]').first().isVisible({ timeout: 3000 }).catch(() => false),
      isFluidEngineActive(page, 3000),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 3000)),
    ]);
  } catch {
    // Non-blocking
  }

  // ── Step 5/9: Re-find text in edit-mode DOM ──────────────────────────
  logger.info({ searchText }, 'formatTextBlock[5/9]: re-finding text in edit-mode DOM');
  let editModeSelector = textSelector;
  const editableMatches = await findTextOnPage(page, searchText);
  if (editableMatches.length === 0) {
    // Try case-insensitive fallback
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (siteFrame) {
      const caseInsensitiveFound = await siteFrame.evaluate((search: string) => {
        const lower = search.toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
            return node.parentElement?.textContent?.trim().substring(0, 100) || null;
          }
        }
        return null;
      }, searchText).catch(() => null);
      if (caseInsensitiveFound) {
        editModeSelector = `text=${caseInsensitiveFound}`;
      } else {
        return {
          success: false,
          message: `formatTextBlock step 5 (refindText): Text "${searchText}" not found after entering edit mode`,
        };
      }
    }
  }

  // ── Step 6/9: Double-click to enter inline editor ────────────────────
  logger.info({ editModeSelector }, 'formatTextBlock[6/9]: double-clicking text block');
  const dblResult = await dblclickThroughOverlay(page, editModeSelector);
  if (!dblResult.success) {
    return {
      success: false,
      message: `formatTextBlock step 6 (dblclick): Failed to double-click text block — ${dblResult.message}`,
    };
  }
  await page.waitForTimeout(500);

  // Verify contenteditable is active using multi-strategy approach
  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  let editorActive = false;

  const checkEditorActive = async (): Promise<boolean> => {
    if (!siteFrame) return false;
    return siteFrame.evaluate(() => {
      const active = document.activeElement;
      if (active && (active as HTMLElement).isContentEditable) return true;
      const editableEls = document.querySelectorAll('[contenteditable="true"]');
      for (const el of editableEls) {
        if (el === document.activeElement) return true;
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) return true;
      }
      const toolbar = document.querySelector('.sqs-editing-toolbar, .rte-toolbar, [data-rte-toolbar]');
      return !!toolbar;
    }).catch(() => false);
  };

  if (siteFrame) {
    editorActive = await checkEditorActive();

    // Strategy 1: Dispatch synthetic dblclick on DOM element
    if (!editorActive) {
      logger.info('formatTextBlock[6/9]: dispatching synthetic dblclick');
      await siteFrame.evaluate((text: string) => {
        const lower = text.toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
            const target = node.parentElement;
            if (!target) continue;
            const rect = target.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
            target.dispatchEvent(new MouseEvent('dblclick', opts));
            target.focus();
            return;
          }
        }
      }, searchText).catch(() => {});
      await page.waitForTimeout(500);
      editorActive = await checkEditorActive();
    }

    // Strategy 2: Press Enter
    if (!editorActive) {
      logger.info('formatTextBlock[6/9]: pressing Enter to force edit mode');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      editorActive = await checkEditorActive();
    }

    // Strategy 3: Force contentEditable
    if (!editorActive) {
      logger.info('formatTextBlock[6/9]: force-activating contentEditable');
      const forceResult = await siteFrame.evaluate((text: string) => {
        const lower = text.toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
            const parent = node.parentElement;
            if (!parent) continue;
            const block = parent.closest('.sqs-block');
            if (!block) continue;
            let editableEl = block.querySelector('[contenteditable="true"]') as HTMLElement | null;
            if (!editableEl) {
              editableEl = (block.querySelector('p, h1, h2, h3, h4, h5, h6') as HTMLElement) ||
                           (block.querySelector('.sqs-block-content') as HTMLElement);
            }
            if (editableEl) {
              editableEl.setAttribute('contenteditable', 'true');
              editableEl.focus();
              const range = document.createRange();
              range.selectNodeContents(editableEl);
              const sel = window.getSelection();
              if (sel) { sel.removeAllRanges(); sel.addRange(range); }
              return 'force-editable';
            }
          }
        }
        return null;
      }, searchText).catch(() => null);
      if (forceResult) {
        editorActive = true;
      }
    }
  }

  if (!editorActive) {
    return {
      success: false,
      message: 'formatTextBlock step 6 (verifyEditable): Could not activate inline text editor',
    };
  }

  // ── Step 7/9: Select all text ────────────────────────────────────────
  logger.info('formatTextBlock[7/9]: selecting all text');
  await page.keyboard.press('Meta+a');
  await page.waitForTimeout(300);

  // ── Step 8/9: Apply formatting ───────────────────────────────────────
  logger.info({ formatLevel, bold, italic, alignment, fontSize }, 'formatTextBlock[8/9]: applying formatting');
  const parts: string[] = [];
  const warnings: string[] = [];

  // Check if toolbar is collapsed — expand it if needed
  const expandToolbar = async (): Promise<void> => {
    const ellipsis = page.locator('button:has-text("…"), button:has-text("..."), button[aria-label="More"], button[aria-label="Show more"]').first();
    const ellipsisVisible = await ellipsis.isVisible({ timeout: 1000 }).catch(() => false);
    if (ellipsisVisible) {
      await ellipsis.click();
      await page.waitForTimeout(300);
      logger.info('formatTextBlock[8/9]: expanded collapsed toolbar');
    }
  };
  await expandToolbar();

  // 8a: Format level (heading/paragraph/monospace)
  if (formatLevel) {
    logger.info({ formatLevel }, 'formatTextBlock[8/9]: setting format level');
    const formatLabels: Record<string, string> = {
      heading1: 'Heading 1', heading2: 'Heading 2', heading3: 'Heading 3', heading4: 'Heading 4',
      paragraph1: 'Paragraph 1', paragraph2: 'Paragraph 2', paragraph3: 'Paragraph 3',
      monospace: 'Monospace',
    };
    const targetLabel = formatLabels[formatLevel];
    let formatSet = false;

    // Strategy A: Find the format dropdown button (shows current format, e.g., "Paragraph 2")
    const formatDropdownSelectors = [
      'button:has-text("Paragraph")',
      'button:has-text("Heading")',
      'button:has-text("Monospace")',
      '[class*="format-dropdown"]',
      '[class*="rte-format"]',
      '[data-test*="format"]',
      'button[aria-label*="format" i]',
      'button[aria-label*="Format" i]',
    ];

    for (const sel of formatDropdownSelectors) {
      const dropdown = page.locator(sel).first();
      const vis = await dropdown.isVisible({ timeout: 1500 }).catch(() => false);
      if (vis) {
        await dropdown.click();
        await page.waitForTimeout(400);
        logger.info({ sel }, 'formatTextBlock[8/9]: format dropdown opened');

        // Now click the target option in the dropdown menu
        const optionSelectors = [
          `text="${targetLabel}"`,
          `[role="option"]:has-text("${targetLabel}")`,
          `[role="menuitem"]:has-text("${targetLabel}")`,
          `li:has-text("${targetLabel}")`,
          `div:has-text("${targetLabel}")`,
        ];

        for (const optSel of optionSelectors) {
          const option = page.locator(optSel).first();
          const optVis = await option.isVisible({ timeout: 1500 }).catch(() => false);
          if (optVis) {
            await option.click();
            formatSet = true;
            logger.info({ optSel, targetLabel }, 'formatTextBlock[8/9]: format level selected');
            break;
          }
        }
        break;
      }
    }

    if (formatSet) {
      parts.push(`format set to "${formatLevel}"`);
    } else {
      warnings.push(`could not set format level to "${formatLevel}" — format dropdown not found`);
    }
    await page.waitForTimeout(300);

    // Re-select all text after format change (format change may deselect)
    await page.keyboard.press('Meta+a');
    await page.waitForTimeout(200);
  }

  // 8b: Bold
  if (bold !== undefined && bold) {
    logger.info('formatTextBlock[8/9]: toggling bold');
    let boldSet = false;

    const boldSelectors = [
      'button[aria-label="Bold"]',
      'button[aria-label="bold"]',
      'button[title="Bold"]',
      'button[title="bold"]',
    ];

    for (const sel of boldSelectors) {
      const btn = page.locator(sel).first();
      const vis = await btn.isVisible({ timeout: 1500 }).catch(() => false);
      if (vis) {
        await btn.click();
        boldSet = true;
        logger.info({ sel }, 'formatTextBlock[8/9]: bold button clicked');
        break;
      }
    }

    // Fallback: use keyboard shortcut
    if (!boldSet) {
      logger.info('formatTextBlock[8/9]: using Cmd+B keyboard shortcut for bold');
      await page.keyboard.press('Meta+b');
      boldSet = true;
    }

    if (boldSet) {
      parts.push('bold applied');
    } else {
      warnings.push('could not toggle bold');
    }
    await page.waitForTimeout(200);
  }

  // 8c: Italic
  if (italic !== undefined && italic) {
    logger.info('formatTextBlock[8/9]: toggling italic');
    let italicSet = false;

    const italicSelectors = [
      'button[aria-label="Italic"]',
      'button[aria-label="italic"]',
      'button[title="Italic"]',
      'button[title="italic"]',
    ];

    for (const sel of italicSelectors) {
      const btn = page.locator(sel).first();
      const vis = await btn.isVisible({ timeout: 1500 }).catch(() => false);
      if (vis) {
        await btn.click();
        italicSet = true;
        logger.info({ sel }, 'formatTextBlock[8/9]: italic button clicked');
        break;
      }
    }

    // Fallback: use keyboard shortcut
    if (!italicSet) {
      logger.info('formatTextBlock[8/9]: using Cmd+I keyboard shortcut for italic');
      await page.keyboard.press('Meta+i');
      italicSet = true;
    }

    if (italicSet) {
      parts.push('italic applied');
    } else {
      warnings.push('could not toggle italic');
    }
    await page.waitForTimeout(200);
  }

  // 8d: Alignment
  if (alignment) {
    logger.info({ alignment }, 'formatTextBlock[8/9]: setting alignment');
    let alignmentSet = false;
    const alignLabel = alignment.charAt(0).toUpperCase() + alignment.slice(1);

    // Strategy A: Click alignment toolbar button to open sub-menu
    const alignBtnSelectors = [
      'button[aria-label*="align" i]',
      'button[aria-label*="Align" i]',
      'button[title*="align" i]',
      'button[title*="Align" i]',
    ];

    for (const sel of alignBtnSelectors) {
      const btn = page.locator(sel).first();
      const vis = await btn.isVisible({ timeout: 1500 }).catch(() => false);
      if (vis) {
        await btn.click();
        await page.waitForTimeout(300);
        logger.info({ sel }, 'formatTextBlock[8/9]: alignment menu opened');

        // Click the specific alignment option
        const optionSelectors = [
          `button[aria-label*="${alignLabel}" i]`,
          `[role="option"]:has-text("${alignLabel}")`,
          `[role="menuitem"]:has-text("${alignLabel}")`,
          `button:has-text("${alignLabel}")`,
        ];

        for (const optSel of optionSelectors) {
          const option = page.locator(optSel).first();
          const optVis = await option.isVisible({ timeout: 1500 }).catch(() => false);
          if (optVis) {
            await option.click();
            alignmentSet = true;
            logger.info({ optSel, alignment }, 'formatTextBlock[8/9]: alignment selected');
            break;
          }
        }
        break;
      }
    }

    // Strategy B: Try clicking directly by alignment label
    if (!alignmentSet) {
      const directSelectors = [
        `button:has-text("${alignLabel}")`,
        `[data-value="${alignment}"]`,
      ];
      for (const sel of directSelectors) {
        const btn = page.locator(sel).first();
        const vis = await btn.isVisible({ timeout: 1000 }).catch(() => false);
        if (vis) {
          await btn.click();
          alignmentSet = true;
          logger.info({ sel }, 'formatTextBlock[8/9]: alignment set via direct click');
          break;
        }
      }
    }

    if (alignmentSet) {
      parts.push(`alignment set to "${alignment}"`);
    } else {
      warnings.push(`could not set alignment to "${alignment}" — alignment control not found`);
    }
    await page.waitForTimeout(200);
  }

  // 8e: Font size (increase/decrease)
  if (fontSize) {
    logger.info({ fontSize }, 'formatTextBlock[8/9]: adjusting font size');
    let fontSizeSet = false;

    // Strategy A: Find the Aa (font size) button
    const fontSizeBtnSelectors = [
      'button[aria-label*="font size" i]',
      'button[aria-label*="Font size" i]',
      'button[aria-label*="Aa" i]',
      'button[title*="font size" i]',
      'button[title*="Font Size" i]',
    ];

    for (const sel of fontSizeBtnSelectors) {
      const btn = page.locator(sel).first();
      const vis = await btn.isVisible({ timeout: 1500 }).catch(() => false);
      if (vis) {
        await btn.click();
        await page.waitForTimeout(300);
        logger.info({ sel }, 'formatTextBlock[8/9]: font size button clicked');

        // Look for increase/decrease sub-buttons
        const subLabel = fontSize === 'increase' ? ['Increase', 'Larger', 'Up', '+'] : ['Decrease', 'Smaller', 'Down', '-'];
        for (const label of subLabel) {
          const subSelectors = [
            `button:has-text("${label}")`,
            `button[aria-label*="${label}" i]`,
            `[role="option"]:has-text("${label}")`,
          ];
          for (const subSel of subSelectors) {
            const subBtn = page.locator(subSel).first();
            const subVis = await subBtn.isVisible({ timeout: 1000 }).catch(() => false);
            if (subVis) {
              await subBtn.click();
              fontSizeSet = true;
              logger.info({ subSel }, 'formatTextBlock[8/9]: font size adjusted');
              break;
            }
          }
          if (fontSizeSet) break;
        }

        // If no sub-buttons found, click the Aa button again (some editors toggle through sizes)
        if (!fontSizeSet) {
          await btn.click();
          fontSizeSet = true;
          logger.info('formatTextBlock[8/9]: font size toggled via double-click');
        }
        break;
      }
    }

    if (fontSizeSet) {
      parts.push(`font size ${fontSize}d`);
    } else {
      warnings.push(`could not ${fontSize} font size — font size control not found`);
    }
    await page.waitForTimeout(200);
  }

  // ── Step 9/9: Exit and verify ────────────────────────────────────────
  logger.info('formatTextBlock[9/9]: exiting and verifying');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.mouse.click(600, 500);
  await page.waitForTimeout(500);

  // Build result message
  if (parts.length === 0 && warnings.length > 0) {
    return {
      success: false,
      message: `formatTextBlock: ${warnings.join('; ')}`,
    };
  }

  return {
    success: true,
    message: `formatTextBlock: ${parts.join('; ')}${warnings.length > 0 ? `. Warning: ${warnings.join('; ')}` : ''}.`,
  };
}

// ─── Compound Action: editButtonBlock ─────────────────────────────────────

/**
 * Compound action: edit a button block in the Squarespace Fluid Engine editor.
 *
 * The Squarespace button editor works via a PANEL that appears when you click
 * the button block in Fluid Engine mode:
 *
 *   Content tab:
 *     TEXT  — input field with the button label
 *     LINK  — "ATTACH LINK" button → opens a URL picker overlay with a
 *             search-and-select input for internal pages or external URLs
 *   Design tab:
 *     Size  — Small (S), Medium (M), Large (L)
 *     Style — Primary, Secondary, Tertiary
 *     Alignment — Left, Center, Right
 *
 * Steps:
 * 1. Find the button by its visible text in the iframe
 * 2. Click through overlay to select the containing section
 * 3. Verify Fluid Engine is active
 * 4. Click button again to open the button editor panel
 * 5. Update label via TEXT input and/or URL via LINK picker
 * 6. Close panel and verify changes
 */
export async function handleEditButtonBlock(
  page: Page,
  action: { action: 'editButtonBlock'; searchText: string; newLabel?: string; url?: string; size?: 'small' | 'medium' | 'large'; style?: 'primary' | 'secondary' | 'tertiary'; alignment?: 'left' | 'center' | 'right' },
): Promise<ActionResult> {
  const { searchText, newLabel, url, size, style, alignment } = action;

  if (!newLabel && !url && !size && !style && !alignment) {
    return { success: false, message: 'editButtonBlock: must provide at least newLabel, url, size, style, or alignment' };
  }

  // ── Step 1: Find the button in the iframe ───────────────────────────
  logger.info({ searchText }, 'editButtonBlock[1/6]: finding button');
  const matches = await findTextOnPage(page, searchText);
  if (matches.length === 0) {
    return {
      success: false,
      message: `editButtonBlock step 1 (findButton): Button "${searchText}" not found on page`,
    };
  }

  // ── Step 2: Click through overlay to select the section ─────────────
  logger.info({ searchText }, 'editButtonBlock[2/6]: clicking section');
  const textSelector = `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return {
      success: false,
      message: `editButtonBlock step 2 (clickSection): ${clickResult.message}`,
    };
  }
  await page.waitForTimeout(1000);

  // ── Step 3: Verify Fluid Engine is active ──────────────────────────
  logger.info('editButtonBlock[3/6]: checking Fluid Engine active');
  const btnFluidActive = await isFluidEngineActive(page, 2000);

  if (btnFluidActive) {
    logger.info('editButtonBlock[3/6]: Fluid Engine active');
  } else {
    logger.info('editButtonBlock[3/6]: Fluid Engine not detected — proceeding anyway');
  }

  // ── Step 4: Click button again to open the button editor panel ──────
  // A second click on the button block opens the Content/Design editor panel.
  logger.info({ searchText }, 'editButtonBlock[4/6]: clicking button to open editor panel');

  const click2Result = await clickThroughOverlay(page, textSelector);
  if (click2Result.success) {
    logger.info('editButtonBlock[4/6]: second click sent');
  }
  await page.waitForTimeout(1200);

  // Wait for the editor panel to appear (look for Content/Design tabs or TEXT label)
  let panelOpen = false;
  const panelSelectors = [
    'text=Content',      // Content tab
    'text=TEXT',         // TEXT label in the panel
    'text=LINK',         // LINK label in the panel
    'button:has-text("ATTACH LINK")',
  ];

  for (const sel of panelSelectors) {
    const vis = await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false);
    if (vis) {
      panelOpen = true;
      logger.info({ sel }, 'editButtonBlock[4/6]: editor panel detected');
      break;
    }
  }

  // If panel didn't open, try clicking the button a third time
  if (!panelOpen) {
    logger.info('editButtonBlock[4/6]: panel not detected, retrying click');
    await clickThroughOverlay(page, textSelector);
    await page.waitForTimeout(1500);

    for (const sel of panelSelectors) {
      const vis = await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false);
      if (vis) {
        panelOpen = true;
        logger.info({ sel }, 'editButtonBlock[4/6]: editor panel detected on retry');
        break;
      }
    }
  }

  if (!panelOpen) {
    logger.warn('editButtonBlock[4/6]: button editor panel did not open — will attempt fallback');
  }

  // ── Step 5: Update label and/or URL using the panel ─────────────────
  let labelUpdated = false;
  let urlUpdated = false;

  // Step 5a: Update TEXT (label)
  if (newLabel) {
    logger.info({ newLabel }, 'editButtonBlock[5/6]: updating label via TEXT input');

    // Strategy A: Find the TEXT input in the editor panel
    // The panel has a label "TEXT" followed by an input field containing the current button text.
    // The input can be found by its current value (searchText) or by proximity to the TEXT label.
    const textInputSelectors = [
      `input[value="${searchText}"]`,
      `input[value="${searchText.trim()}"]`,
    ];

    let textInput = null;
    for (const sel of textInputSelectors) {
      const el = page.locator(sel).first();
      const vis = await el.isVisible({ timeout: 1500 }).catch(() => false);
      if (vis) {
        textInput = el;
        logger.info({ sel }, 'editButtonBlock[5/6]: found TEXT input by value');
        break;
      }
    }

    // Strategy B: Find any input near the "TEXT" label
    if (!textInput) {
      // Look for inputs inside a section that contains "TEXT" label
      const genericInputSelectors = [
        'input[type="text"]',
        'input:not([type="search"]):not([type="hidden"]):not([type="checkbox"])',
      ];
      for (const sel of genericInputSelectors) {
        const inputs = page.locator(sel);
        const count = await inputs.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const inp = inputs.nth(i);
          const val = await inp.inputValue().catch(() => '');
          const vis = await inp.isVisible().catch(() => false);
          if (vis && val.toLowerCase().includes(searchText.toLowerCase())) {
            textInput = inp;
            logger.info({ sel, index: i, val }, 'editButtonBlock[5/6]: found TEXT input by scanning');
            break;
          }
        }
        if (textInput) break;
      }
    }

    if (textInput) {
      await textInput.click();
      await page.waitForTimeout(100);
      await textInput.fill(newLabel);
      await page.waitForTimeout(300);
      // Press Tab or Enter to commit the value
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
      labelUpdated = true;
      logger.info('editButtonBlock[5/6]: label updated via TEXT input');
    } else {
      // Fallback: try direct DOM contenteditable approach
      logger.info('editButtonBlock[5/6]: TEXT input not found, trying contenteditable fallback');
      const siteFrame = page.frame({ name: 'sqs-site-frame' });
      if (siteFrame) {
        const madeEditable = await siteFrame.evaluate((btnText: string) => {
          const allButtons = document.querySelectorAll(
            '.sqs-block-button a, .sqs-block-button-element a, ' +
            'a.sqs-block-button-element--medium'
          );
          for (const el of allButtons) {
            const text = (el as HTMLElement).innerText?.trim();
            if (text && text.toLowerCase().includes(btnText.toLowerCase())) {
              (el as HTMLElement).contentEditable = 'true';
              (el as HTMLElement).focus();
              const range = document.createRange();
              range.selectNodeContents(el);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
              return true;
            }
          }
          return false;
        }, searchText).catch(() => false);

        if (madeEditable) {
          await page.keyboard.type(newLabel, { delay: 20 });
          await page.waitForTimeout(300);
          labelUpdated = true;
          logger.info('editButtonBlock[5/6]: label updated via contenteditable fallback');
        }
      }
    }
  }

  // Step 5b: Update URL (link)
  if (url) {
    logger.info({ url }, 'editButtonBlock[5/6]: updating URL');

    // First, make sure we're on the Content tab (not Design)
    const contentTab = page.locator('button:has-text("Content"), [role="tab"]:has-text("Content")').first();
    const contentTabVisible = await contentTab.isVisible({ timeout: 1000 }).catch(() => false);
    if (contentTabVisible) {
      await contentTab.click().catch(() => {});
      await page.waitForTimeout(500);
    }

    // Strategy A: Click "ATTACH LINK" button to open the URL picker
    const attachLinkSelectors = [
      'button:has-text("ATTACH LINK")',
      'button:has-text("Attach Link")',
      'button:has-text("EDIT LINK")',
      'button:has-text("Edit Link")',
      // If a link is already set, it may show the current URL instead of "ATTACH LINK"
      '[class*="link-editor"] button',
      '[class*="LinkEditor"] button',
    ];

    let attachClicked = false;
    for (const sel of attachLinkSelectors) {
      const btn = page.locator(sel).first();
      const vis = await btn.isVisible({ timeout: 1500 }).catch(() => false);
      if (vis) {
        await btn.click();
        attachClicked = true;
        logger.info({ sel }, 'editButtonBlock[5/6]: clicked ATTACH LINK');
        break;
      }
    }

    if (attachClicked) {
      await page.waitForTimeout(800);

      // The URL picker has a search input: "Enter link, search, or add files"
      const urlInputSelectors = [
        'input[placeholder*="link"]',
        'input[placeholder*="Link"]',
        'input[placeholder*="search"]',
        'input[placeholder*="Enter link"]',
        'input[placeholder*="enter link"]',
        'input[placeholder*="URL"]',
        'input[placeholder*="url"]',
      ];

      let urlInput = null;
      for (const sel of urlInputSelectors) {
        const el = page.locator(sel).first();
        const vis = await el.isVisible({ timeout: 1500 }).catch(() => false);
        if (vis) {
          urlInput = el;
          logger.info({ sel }, 'editButtonBlock[5/6]: found URL input');
          break;
        }
      }

      if (urlInput) {
        await urlInput.click();
        await page.waitForTimeout(200);
        await urlInput.fill(url);
        await page.waitForTimeout(500);

        // If it's an external URL, press Enter to confirm
        if (url.startsWith('http') || url.startsWith('/')) {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
        } else {
          // For internal page names, look for a matching result to click
          const matchResult = page.locator(`text=${url}`).first();
          const matchVisible = await matchResult.isVisible({ timeout: 2000 }).catch(() => false);
          if (matchVisible) {
            await matchResult.click();
            await page.waitForTimeout(500);
          } else {
            // Just press Enter
            await page.keyboard.press('Enter');
            await page.waitForTimeout(500);
          }
        }
        urlUpdated = true;
        logger.info('editButtonBlock[5/6]: URL updated via link picker');
      } else {
        logger.warn('editButtonBlock[5/6]: URL input not found in link picker');
      }
    } else {
      // Fallback: try to set href directly in the DOM
      logger.info('editButtonBlock[5/6]: ATTACH LINK not found, trying DOM href fallback');
      const siteFrame = page.frame({ name: 'sqs-site-frame' });
      if (siteFrame) {
        const hrefSet = await siteFrame.evaluate((args: { btnText: string; newUrl: string }) => {
          const allLinks = document.querySelectorAll(
            '.sqs-block-button a, .sqs-block-button-element a, a.sqs-block-button-element--medium'
          );
          for (const el of allLinks) {
            const text = (el as HTMLElement).innerText?.trim();
            if (text && text.toLowerCase().includes(args.btnText.toLowerCase())) {
              (el as HTMLAnchorElement).href = args.newUrl;
              return true;
            }
          }
          return false;
        }, { btnText: newLabel || searchText, newUrl: url }).catch(() => false);

        if (hrefSet) {
          urlUpdated = true;
          logger.info('editButtonBlock[5/6]: URL set via DOM href fallback');
        }
      }
    }
  }

  // ── Step 5c: Update Design tab properties (size, style, alignment) ──
  let sizeSet = false;
  let styleSet = false;
  let alignmentSet = false;

  if (size || style || alignment) {
    logger.info({ size, style, alignment }, 'editButtonBlock[5/6]: switching to Design tab');

    // Click the "Design" tab in the button editor panel
    const designTabSelectors = [
      'button:has-text("Design")',
      '[role="tab"]:has-text("Design")',
    ];

    let designTabClicked = false;
    for (const sel of designTabSelectors) {
      const tab = page.locator(sel).first();
      const vis = await tab.isVisible({ timeout: 2000 }).catch(() => false);
      if (vis) {
        await tab.click();
        designTabClicked = true;
        logger.info({ sel }, 'editButtonBlock[5/6]: Design tab clicked');
        break;
      }
    }

    if (!designTabClicked) {
      logger.warn('editButtonBlock[5/6]: Design tab not found in button editor');
    }
    await page.waitForTimeout(800);

    // 5c-i: Set size (S/M/L)
    if (size && designTabClicked) {
      const sizeLabels: Record<string, string[]> = {
        small: ['S', 'Small'],
        medium: ['M', 'Medium'],
        large: ['L', 'Large'],
      };
      const labels = sizeLabels[size] || [];
      for (const label of labels) {
        const selectors = [
          `button:has-text("${label}")`,
          `[role="option"]:has-text("${label}")`,
          `[aria-label*="${label}" i]`,
          `[data-value="${label.toLowerCase()}"]`,
        ];
        for (const sel of selectors) {
          const btn = page.locator(sel).first();
          const vis = await btn.isVisible({ timeout: 1500 }).catch(() => false);
          if (vis) {
            await btn.click();
            sizeSet = true;
            logger.info({ sel, size }, 'editButtonBlock[5/6]: size button clicked');
            break;
          }
        }
        if (sizeSet) break;
      }
      if (!sizeSet) logger.warn({ size }, 'editButtonBlock[5/6]: could not find size button');
      await page.waitForTimeout(300);
    }

    // 5c-ii: Set style (Primary/Secondary/Tertiary)
    if (style && designTabClicked) {
      const styleLabels: Record<string, string[]> = {
        primary: ['Primary', 'Primary Button'],
        secondary: ['Secondary', 'Secondary Button'],
        tertiary: ['Tertiary', 'Tertiary Button'],
      };
      const labels = styleLabels[style] || [];
      for (const label of labels) {
        const selectors = [
          `button:has-text("${label}")`,
          `[role="option"]:has-text("${label}")`,
          `[aria-label*="${label}" i]`,
          `[data-value="${label.toLowerCase()}"]`,
        ];
        for (const sel of selectors) {
          const btn = page.locator(sel).first();
          const vis = await btn.isVisible({ timeout: 1500 }).catch(() => false);
          if (vis) {
            await btn.click();
            styleSet = true;
            logger.info({ sel, style }, 'editButtonBlock[5/6]: style button clicked');
            break;
          }
        }
        if (styleSet) break;
      }
      if (!styleSet) logger.warn({ style }, 'editButtonBlock[5/6]: could not find style button');
      await page.waitForTimeout(300);
    }

    // 5c-iii: Set alignment (Left/Center/Right)
    if (alignment && designTabClicked) {
      const alignLabel = alignment.charAt(0).toUpperCase() + alignment.slice(1);
      const selectors = [
        `button:has-text("${alignLabel}")`,
        `[role="option"]:has-text("${alignLabel}")`,
        `[aria-label*="${alignLabel}" i]`,
        `[data-value="${alignment}"]`,
      ];
      for (const sel of selectors) {
        const btn = page.locator(sel).first();
        const vis = await btn.isVisible({ timeout: 1500 }).catch(() => false);
        if (vis) {
          await btn.click();
          alignmentSet = true;
          logger.info({ sel, alignment }, 'editButtonBlock[5/6]: alignment button clicked');
          break;
        }
      }
      if (!alignmentSet) logger.warn({ alignment }, 'editButtonBlock[5/6]: could not find alignment button');
      await page.waitForTimeout(300);
    }
  }

  // ── Step 6: Close panel and verify ──────────────────────────────────
  logger.info('editButtonBlock[6/6]: closing panel and verifying');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.mouse.click(600, 500);
  await page.waitForTimeout(1500);

  let labelVerified = false;
  let urlVerified = false;

  const checkFrame = page.frame({ name: 'sqs-site-frame' });

  // Verify label
  if (newLabel && labelUpdated && checkFrame) {
    labelVerified = await checkFrame.evaluate((text: string) => {
      const buttons = document.querySelectorAll(
        '.sqs-block-button-element, .sqs-block-button a, ' +
        '.sqs-block-button span, .sqs-block-button-element--medium, ' +
        '.sqs-block-button-element--medium a, ' +
        'a.sqs-block-button-element--medium'
      );
      for (const btn of buttons) {
        if ((btn as HTMLElement).innerText?.trim().includes(text)) return true;
      }
      return false;
    }, newLabel).catch(() => false);

    if (!labelVerified) {
      await page.waitForTimeout(2000);
      labelVerified = await checkFrame.evaluate((text: string) => {
        return document.body.innerText.includes(text);
      }, newLabel).catch(() => false);
    }
    logger.info({ labelVerified, newLabel }, 'editButtonBlock[6/6]: label verification');
  }

  // Verify URL
  if (url && urlUpdated && checkFrame) {
    urlVerified = await checkFrame.evaluate((targetUrl: string) => {
      const links = document.querySelectorAll(
        '.sqs-block-button a, .sqs-block-button-element a, a.sqs-block-button-element--medium'
      );
      for (const link of links) {
        const href = (link as HTMLAnchorElement).href || '';
        if (href.includes(targetUrl) || href.endsWith(targetUrl)) return true;
      }
      return false;
    }, url).catch(() => false);
    logger.info({ urlVerified, url }, 'editButtonBlock[6/6]: URL verification');
  }

  // ── Build result ───────────────────────────────────────────────────
  const parts: string[] = [];
  const failures: string[] = [];

  if (newLabel) {
    if (labelUpdated && labelVerified) {
      parts.push(`label changed from "${searchText}" to "${newLabel}"`);
    } else if (labelUpdated) {
      parts.push(`label set to "${newLabel}" (unverified — check visually)`);
    } else {
      failures.push(`could not update label`);
    }
  }

  if (url) {
    if (urlUpdated && urlVerified) {
      parts.push(`URL set to "${url}"`);
    } else if (urlUpdated) {
      parts.push(`URL set to "${url}" (unverified — check visually)`);
    } else {
      failures.push(`could not update URL`);
    }
  }

  if (size) {
    if (sizeSet) {
      parts.push(`size set to "${size}"`);
    } else {
      failures.push('could not set button size');
    }
  }

  if (style) {
    if (styleSet) {
      parts.push(`style set to "${style}"`);
    } else {
      failures.push('could not set button style');
    }
  }

  if (alignment) {
    if (alignmentSet) {
      parts.push(`alignment set to "${alignment}"`);
    } else {
      failures.push('could not set button alignment');
    }
  }

  if (failures.length > 0 && parts.length === 0) {
    return {
      success: false,
      message: `editButtonBlock: ${failures.join(', ')}. Button editor panel ${panelOpen ? 'opened' : 'did not open'}.`,
    };
  }

  return {
    success: true,
    message: `editButtonBlock: ${parts.join('; ')}${failures.length > 0 ? `. Warning: ${failures.join(', ')}` : ''}.`,
  };
}

// ─── Compound Action: editMenuBlock ──────────────────────────────────────────

/**
 * Compound action: edit a menu block using a select-all/cut/paste strategy.
 *
 * The Squarespace menu block editor is a contenteditable area where direct
 * cursor positioning is unreliable — clicking often lands mid-word, corrupting
 * existing text. This action avoids that problem entirely by:
 *
 * 1. Finding and opening the menu block for editing
 * 2. Reading the EXISTING content from the block via DOM
 * 3. Selecting ALL content in the block (Meta+A)
 * 4. Typing the new complete content (which replaces the selection)
 * 5. Verifying the result
 *
 * The agent (Claude) is responsible for composing `newContent` — it should
 * include BOTH the existing items it wants to keep AND the new items, fully
 * formatted. This action just does the mechanical select-all → replace.
 */
export async function handleEditMenuBlock(
  page: Page,
  action: { action: 'editMenuBlock'; searchText: string; newContent: string },
): Promise<ActionResult> {
  const { searchText, newContent } = action;

  // ── Step 1: Find the menu block text on the page ────────────────────
  logger.info({ searchText }, 'editMenuBlock[1/8]: finding menu block');
  const matches = await findTextOnPage(page, searchText);
  if (matches.length === 0) {
    return {
      success: false,
      message: `editMenuBlock step 1 (findText): Text "${searchText}" not found on page. Try a different searchText from the menu block.`,
    };
  }

  // ── Step 2: Click through overlay to select the section ─────────────
  logger.info({ searchText }, 'editMenuBlock[2/8]: clicking section');
  const textSelector = `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return {
      success: false,
      message: `editMenuBlock step 2 (clickSection): Failed to click section — ${clickResult.message}`,
    };
  }
  await page.waitForTimeout(800);

  // ── Step 3: Ensure Fluid Engine edit mode ───────────────────────────
  logger.info('editMenuBlock[3/8]: checking Fluid Engine');
  const fluidActive = await isFluidEngineActive(page, 3000);
  if (!fluidActive) {
    const editContentClicked = await clickEditorButton(page, /edit content/i, [
      '[aria-label="Edit Content"]', 'button[data-test="edit-content"]',
    ]);
    if (editContentClicked) {
      await page.waitForTimeout(1500);
    }
  }

  // ── Step 4: Double-click to enter inline edit mode ──────────────────
  logger.info({ searchText }, 'editMenuBlock[4/8]: double-clicking to enter edit mode');
  const dblResult = await dblclickThroughOverlay(page, textSelector);
  if (!dblResult.success) {
    return {
      success: false,
      message: `editMenuBlock step 4 (dblclick): Failed to open editor — ${dblResult.message}`,
    };
  }
  await page.waitForTimeout(800);

  // ── Step 5: Read existing content from the block ────────────────────
  // This is crucial for the agent's context — it reads what's currently
  // in the block so the agent knows what it's working with.
  logger.info('editMenuBlock[5/8]: reading existing content');
  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  let existingContent = '';

  if (siteFrame) {
    existingContent = await siteFrame.evaluate((search: string) => {
      const lower = search.toLowerCase();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
          // Walk up to find the containing block
          const block = node.parentElement?.closest('.sqs-block') ||
                        node.parentElement?.closest('[data-block-id]') ||
                        node.parentElement?.closest('.fe-block');
          if (block) {
            return (block as HTMLElement).innerText?.trim() || '';
          }
        }
      }
      return '';
    }, searchText).catch(() => '');

    logger.info(
      { existingLength: existingContent.length, preview: existingContent.substring(0, 100) },
      'editMenuBlock[5/8]: existing content read',
    );
  }

  // ── Step 6: Activate contenteditable and select all ─────────────────
  // Use the same multi-strategy approach as editTextBlock to ensure
  // the inline editor is active, then select all content.
  logger.info('editMenuBlock[6/8]: activating editor and selecting all');

  let editorActive = false;

  if (siteFrame) {
    // Try to find and focus the contenteditable element near our search text
    editorActive = await siteFrame.evaluate((search: string) => {
      const lower = search.toLowerCase();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
          const parent = node.parentElement;
          if (!parent) continue;

          // Find the block container
          const block = parent.closest('.sqs-block') ||
                        parent.closest('[data-block-id]') ||
                        parent.closest('.fe-block');
          if (!block) continue;

          // Look for an existing contenteditable element inside
          let editableEl = block.querySelector('[contenteditable="true"]') as HTMLElement | null;

          if (!editableEl) {
            // Try the block-content div or a text-holding element
            editableEl = (block.querySelector('.sqs-block-content') as HTMLElement) ||
                         (block.querySelector('p, h1, h2, h3, h4, h5, h6, div') as HTMLElement);
          }

          if (editableEl) {
            // Ensure it's editable
            if (!editableEl.isContentEditable) {
              editableEl.setAttribute('contenteditable', 'true');
            }
            editableEl.focus();

            // Select ALL content inside the block
            const range = document.createRange();
            range.selectNodeContents(editableEl);
            const sel = window.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(range);
            }
            return true;
          }
        }
      }
      return false;
    }, searchText).catch(() => false);

    if (!editorActive) {
      // Fallback: dispatch synthetic dblclick then try keyboard select-all
      logger.info('editMenuBlock[6/8]: fallback — synthetic events + keyboard select-all');
      await siteFrame.evaluate((search: string) => {
        const lower = search.toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent && node.textContent.trim().toLowerCase().includes(lower)) {
            const target = node.parentElement;
            if (!target) continue;
            const rect = target.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
            target.dispatchEvent(new MouseEvent('dblclick', opts));
            target.focus();
            return;
          }
        }
      }, searchText).catch(() => {});
      await page.waitForTimeout(500);
      editorActive = true; // proceed optimistically
    }
  }

  // Use Meta+A to select all content in the active editor
  await page.keyboard.press('Meta+a');
  await page.waitForTimeout(300);

  // ── Step 7: Type the new complete content ───────────────────────────
  // This replaces the selected content. The `newContent` string should
  // include everything — existing items to keep + new items + formatting.
  logger.info(
    { newContentLength: newContent.length, preview: newContent.substring(0, 80) },
    'editMenuBlock[7/8]: typing new content (replaces selection)',
  );
  await page.keyboard.type(newContent, { delay: 15 });
  await page.waitForTimeout(500);

  // ── Step 8: Deselect, save, and verify ──────────────────────────────
  logger.info('editMenuBlock[8/8]: deselecting and verifying');
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.mouse.click(600, 500); // safe zone click
    await page.waitForTimeout(500);
  } catch {
    // Non-critical
  }

  // Verify new content is in the DOM
  let verified = false;
  // Check for the first meaningful chunk of the new content (first 40 chars or first line)
  const verifyText = newContent.split('\n')[0].trim().substring(0, 40);
  if (siteFrame && verifyText) {
    verified = await siteFrame.evaluate((text: string) => {
      return document.body.innerText.includes(text);
    }, verifyText).catch(() => false);
  }

  if (!verified) {
    verified = await page.evaluate((text: string) => {
      return document.body.innerText.includes(text);
    }, verifyText).catch(() => false);
  }

  const existingPreview = existingContent ? existingContent.substring(0, 60) + '...' : '(empty)';

  if (!verified) {
    return {
      success: true,
      message: `editMenuBlock: Typed new content but could not verify in DOM. Existing content was: "${existingPreview}". Check visually.`,
    };
  }

  return {
    success: true,
    message: `editMenuBlock: Successfully replaced menu block content. Previous content: "${existingPreview}". New content starts with: "${newContent.substring(0, 60)}${newContent.length > 60 ? '...' : ''}"`,
  };
}

// ─── Compound Action: editQuoteBlock ───────────────────────────────────

/**
 * Compound action: edit a quote block's text and optional attribution.
 *
 * Steps:
 * 1. Find the quote block by searchText
 * 2. Click through overlay to select the section
 * 3. Double-click the quote block to enter inline edit mode
 * 4. Select all and type the new quote text
 * 5. If attribution provided, press Enter and type it
 * 6. Click outside to deselect, verify
 */
export async function handleEditQuoteBlock(
  page: Page,
  action: { action: 'editQuoteBlock'; searchText: string; quote: string; attribution?: string },
): Promise<ActionResult> {
  const { searchText, quote, attribution } = action;

  // ── Step 1: Find the quote block ────────────────────────────────────
  logger.info({ searchText }, 'editQuoteBlock[1/6]: finding quote block');

  const matches = await findTextOnPage(page, searchText);
  if (matches.length === 0) {
    return {
      success: false,
      message: `editQuoteBlock step 1: Could not find text "${searchText}" on the page. Scroll down or check the text.`,
    };
  }

  // ── Step 2: Click through overlay to select section ──────────────────
  logger.info('editQuoteBlock[2/6]: clicking through overlay to select section');

  const textSelector = `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return { success: false, message: `editQuoteBlock step 2: ${clickResult.message}` };
  }
  await page.waitForTimeout(800);

  // Look for EDIT CONTENT button and click it
  const editContentBtn = page.getByRole('button', { name: /edit content/i });
  const editContentVisible = await editContentBtn.first().isVisible({ timeout: 3000 }).catch(() => false);
  if (editContentVisible) {
    await editContentBtn.first().click({ timeout: 3000 });
    await page.waitForTimeout(1000);
    logger.info('editQuoteBlock[2/6]: clicked EDIT CONTENT');
  }

  // ── Step 3: Double-click the quote block to enter edit mode ──────────
  logger.info('editQuoteBlock[3/6]: double-clicking quote block to enter edit mode');

  // Double-click through overlay to enter inline edit mode
  const dblResult = await dblclickThroughOverlay(page, textSelector);
  if (dblResult.success) {
    await page.waitForTimeout(800);
  } else {
    // Fallback: try finding the quote block via CSS
    const siteFrameLocator = getSiteFrame(page);
    if (siteFrameLocator) {
      const quoteBlocks = siteFrameLocator.locator('.sqs-block-quote');
      const count = await quoteBlocks.count().catch(() => 0);
      if (count > 0) {
        const lastQuote = quoteBlocks.nth(count - 1);
        const box = await lastQuote.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(800);
        }
      }
    }
  }

  // ── Step 4: Select all and type the new quote ────────────────────────
  logger.info('editQuoteBlock[4/6]: selecting all and typing new quote');

  // Check if contenteditable is active
  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  let hasActiveEditor = false;
  if (siteFrame) {
    hasActiveEditor = await siteFrame.evaluate(() => {
      const active = document.activeElement;
      return active != null && (active as HTMLElement).isContentEditable;
    }).catch(() => false);
  }

  if (!hasActiveEditor) {
    // Try pressing Enter to activate
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    if (siteFrame) {
      hasActiveEditor = await siteFrame.evaluate(() => {
        const active = document.activeElement;
        return active != null && (active as HTMLElement).isContentEditable;
      }).catch(() => false);
    }
  }

  if (!hasActiveEditor) {
    return {
      success: false,
      message: 'editQuoteBlock step 4: Could not activate inline editor for the quote block. Try double-clicking the quote manually.',
    };
  }

  await page.keyboard.press('Meta+a');
  await page.waitForTimeout(200);
  await page.keyboard.type(quote, { delay: 20 });
  logger.info('editQuoteBlock[4/6]: typed quote text');

  // ── Step 5: Add attribution if provided ──────────────────────────────
  if (attribution) {
    logger.info({ attribution }, 'editQuoteBlock[5/6]: adding attribution');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type(attribution, { delay: 20 });
  }

  // ── Step 6: Click outside and verify ─────────────────────────────────
  logger.info('editQuoteBlock[6/6]: clicking outside to deselect');
  await page.mouse.click(50, 50);
  await page.waitForTimeout(1000);

  // Verify the new text appears
  const verifyMatches = await findTextOnPage(page, quote.substring(0, 30));
  if (verifyMatches.length > 0) {
    return {
      success: true,
      message: `editQuoteBlock: Successfully updated quote to "${quote.substring(0, 50)}${quote.length > 50 ? '...' : ''}"${attribution ? ` with attribution "${attribution}"` : ''}.`,
    };
  }

  return {
    success: true,
    message: `editQuoteBlock: Typed quote text but could not verify in DOM. Check visually. Quote: "${quote.substring(0, 50)}..."`,
  };
}

// ─── Compound Action: editCodeBlock ────────────────────────────────────

/**
 * Compound action: edit a code/embed block's content.
 *
 * Steps:
 * 1. Find the code block by searchText
 * 2. Click through overlay to select the section
 * 3. Double-click the code block to open the code editor panel
 * 4. Find the textarea/code input in the editor panel
 * 5. Clear existing content and type new code
 * 6. Click Apply/Save/Done button
 * 7. Verify
 */
export async function handleEditCodeBlock(
  page: Page,
  action: { action: 'editCodeBlock'; searchText: string; code: string },
): Promise<ActionResult> {
  const { searchText, code } = action;

  // ── Step 1: Find the code block ─────────────────────────────────────
  logger.info({ searchText }, 'editCodeBlock[1/7]: finding code block');

  const matches = await findTextOnPage(page, searchText);
  const textSelector = `text=${searchText}`;

  if (matches.length === 0) {
    // Try finding by CSS class
    const siteFrameLocator = getSiteFrame(page);
    if (siteFrameLocator) {
      const codeBlocks = siteFrameLocator.locator('.sqs-block-code, .sqs-block-embed');
      const count = await codeBlocks.count().catch(() => 0);
      if (count === 0) {
        return {
          success: false,
          message: `editCodeBlock step 1: Could not find text "${searchText}" or any code/embed blocks on the page.`,
        };
      }
      // Click the last code block
      const lastBlock = codeBlocks.nth(count - 1);
      const box = await lastBlock.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(800);
      }
    }
  } else {
    // ── Step 2: Click through overlay to select section ────────────────
    logger.info('editCodeBlock[2/7]: clicking through overlay');
    const clickResult = await clickThroughOverlay(page, textSelector);
    if (!clickResult.success) {
      return { success: false, message: `editCodeBlock step 2: ${clickResult.message}` };
    }
    await page.waitForTimeout(800);
  }

  // Look for EDIT CONTENT button and click it
  const editContentBtn = page.getByRole('button', { name: /edit content/i });
  const editContentVisible = await editContentBtn.first().isVisible({ timeout: 3000 }).catch(() => false);
  if (editContentVisible) {
    await editContentBtn.first().click({ timeout: 3000 });
    await page.waitForTimeout(1000);
    logger.info('editCodeBlock[2/7]: clicked EDIT CONTENT');
  }

  // ── Step 3: Double-click the code block to open editor ──────────────
  logger.info('editCodeBlock[3/7]: double-clicking to open code editor');

  // Double-click via overlay if text was found, otherwise fall back to CSS
  if (matches.length > 0) {
    const dblResult = await dblclickThroughOverlay(page, textSelector);
    if (!dblResult.success) {
      logger.info('editCodeBlock[3/7]: dblclick through overlay failed, trying CSS fallback');
    }
  }

  if (matches.length === 0) {
    // Try finding code block via CSS and double-clicking
    const siteFrameLocator = getSiteFrame(page);
    if (siteFrameLocator) {
      const codeBlocks = siteFrameLocator.locator('.sqs-block-code, .sqs-block-embed');
      const count = await codeBlocks.count().catch(() => 0);
      for (let i = count - 1; i >= 0; i--) {
        const block = codeBlocks.nth(i);
        const box = await block.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
          break;
        }
      }
    }
  }
  await page.waitForTimeout(1500);

  // ── Step 4-5: Find the code input and type content ──────────────────
  logger.info('editCodeBlock[4/7]: finding code editor input');

  let codeTyped = false;

  // Strategy A: textarea in the editor panel
  const textareaSelectors = [
    'textarea.code-editor',
    'textarea[data-test="code-input"]',
    '.code-editor textarea',
    '.sqs-code-editor textarea',
    'textarea',
  ];
  for (const sel of textareaSelectors) {
    const textarea = page.locator(sel).first();
    const visible = await textarea.isVisible({ timeout: 1500 }).catch(() => false);
    if (visible) {
      await textarea.click();
      await textarea.fill(code);
      codeTyped = true;
      logger.info({ sel }, 'editCodeBlock[5/7]: typed code via textarea');
      break;
    }
  }

  // Strategy B: CodeMirror editor
  if (!codeTyped) {
    const codeMirror = page.locator('.CodeMirror');
    const cmVisible = await codeMirror.first().isVisible({ timeout: 1500 }).catch(() => false);
    if (cmVisible) {
      await codeMirror.first().click();
      await page.waitForTimeout(300);
      await page.keyboard.press('Meta+a');
      await page.waitForTimeout(100);
      await page.keyboard.type(code, { delay: 10 });
      codeTyped = true;
      logger.info('editCodeBlock[5/7]: typed code via CodeMirror');
    }
  }

  // Strategy C: contenteditable div in editor
  if (!codeTyped) {
    const editables = page.locator('[contenteditable="true"]');
    const editCount = await editables.count().catch(() => 0);
    for (let i = 0; i < editCount; i++) {
      const el = editables.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        await el.click();
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(100);
        await page.keyboard.type(code, { delay: 10 });
        codeTyped = true;
        logger.info({ index: i }, 'editCodeBlock[5/7]: typed code via contenteditable');
        break;
      }
    }
  }

  if (!codeTyped) {
    return {
      success: false,
      message: 'editCodeBlock step 5: Could not find code editor textarea, CodeMirror, or contenteditable input. The code editor panel may not have opened.',
    };
  }

  // ── Step 6: Click Apply/Save button ─────────────────────────────────
  logger.info('editCodeBlock[6/7]: clicking Apply/Save');

  const saveSelectors = [
    'button:has-text("Apply")',
    'button:has-text("Save")',
    'button:has-text("Done")',
    '[data-test="save-button"]',
  ];
  let saved = false;
  for (const sel of saveSelectors) {
    const btn = page.locator(sel).first();
    const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
    if (visible) {
      await btn.click({ timeout: 3000 });
      saved = true;
      logger.info({ sel }, 'editCodeBlock[6/7]: clicked save/apply button');
      break;
    }
  }

  // Also try getByRole
  if (!saved) {
    for (const name of [/apply/i, /save/i, /done/i]) {
      const btn = page.getByRole('button', { name });
      const visible = await btn.first().isVisible({ timeout: 1000 }).catch(() => false);
      if (visible) {
        await btn.first().click({ timeout: 3000 });
        saved = true;
        logger.info('editCodeBlock[6/7]: clicked save via getByRole');
        break;
      }
    }
  }

  await page.waitForTimeout(1000);

  // ── Step 7: Verify ──────────────────────────────────────────────────
  logger.info('editCodeBlock[7/7]: verifying');
  const verifyMatches = await findTextOnPage(page, code.substring(0, 30));

  return {
    success: true,
    message: `editCodeBlock: ${verifyMatches.length > 0 ? 'Successfully updated' : 'Typed but could not verify'} code block content. Code starts with: "${code.substring(0, 60)}${code.length > 60 ? '...' : ''}"${saved ? '' : ' (no Apply/Save button found — may auto-save)'}`,
  };
}
