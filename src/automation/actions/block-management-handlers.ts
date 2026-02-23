import { Page } from 'playwright';
import { logger } from '../../utils/logger.js';
import { clickThroughOverlay, findTextOnPage, getSiteFrame } from '../editor-actions.js';
import { errMsg } from '../../utils/errors.js';
import { isFluidEngineActive, clickEditorButton, tryBlockMoveApi, tryBlockResizeApi, tryBlockRemoveApi } from './handler-utils.js';
import type { ActionResult } from './types.js';

// ─── Compound Action: addBlockToSection ──────────────────────────────────

/**
 * Compound action: add a new block to the currently active section.
 *
 * Prerequisites: The section must already be in edit mode (Fluid Engine editor active).
 * If not, the agent should first use enterSectionEditMode.
 *
 * Steps:
 * 1. Click the "ADD BLOCK" button (main frame)
 * 2. Search for the block type in the block picker search bar
 * 3. Click the matching result in the block picker (inside iframe)
 * 4. Wait for the new block to appear
 * 5. If content is provided and it's a text-like block, type it
 */
export async function handleAddBlockToSection(
  page: Page,
  action: { action: 'addBlockToSection'; blockType: string; content?: string },
): Promise<ActionResult> {
  const { blockType, content } = action;

  // ── Step 1: Click "ADD BLOCK" ───────────────────────────────────────
  logger.info({ blockType }, 'addBlockToSection[1/5]: clicking ADD BLOCK');

  // First check if we're in section edit mode (ADD BLOCK visible via getByRole)
  const addBlockRole = page.getByRole('button', { name: /add block/i });
  const addBlockVisible = await addBlockRole.first().isVisible({ timeout: 2000 }).catch(() => false);

  if (!addBlockVisible) {
    return {
      success: false,
      message: 'addBlockToSection step 1: Not in section edit mode. Use enterSectionEditMode first, then retry.',
    };
  }

  // Click ADD BLOCK using getByRole (reliable for Squarespace's visibility:hidden spans)
  let addBlockClicked = false;
  try {
    await addBlockRole.first().click({ timeout: 3000 });
    addBlockClicked = true;
    logger.info('addBlockToSection[1/5]: clicked ADD BLOCK via getByRole');
  } catch { /* fallback below */ }

  if (!addBlockClicked) {
    // Fallback: try CSS selectors
    const addBlockSelectors = [
      'button:has-text("ADD BLOCK")',
      'button:has-text("Add Block")',
      '[aria-label="Add Block"]',
      '[data-test="add-block"]',
    ];
    for (const selector of addBlockSelectors) {
      try {
        const btn = page.locator(selector).first();
        const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          await btn.click({ timeout: 3000 });
          addBlockClicked = true;
          logger.info({ selector }, 'addBlockToSection[1/5]: clicked ADD BLOCK (CSS fallback)');
          break;
        }
      } catch { /* Try next */ }
    }
  }

  if (!addBlockClicked) {
    return {
      success: false,
      message: 'addBlockToSection step 1: ADD BLOCK button not found. Make sure you are in section edit mode.',
    };
  }
  await page.waitForTimeout(1000);

  // ── Step 2: Search for the block type in the picker ─────────────────
  // The block picker overlay has a Search input at the top and block tiles
  // arranged in a grid (Essentials: Text, Image, Button, Video, etc.).
  // The picker may be in the main frame or iframe depending on the editor.
  logger.info({ blockType }, 'addBlockToSection[2/5]: searching for block type');

  const searchSelectors = [
    'input[placeholder*="Search"]',
    'input[placeholder*="search"]',
    'input[type="search"]',
    '[data-test="block-search"] input',
  ];

  let searchInput = null;
  let searchFrame: 'main' | 'iframe' = 'main';

  // Try main frame first
  for (const selector of searchSelectors) {
    const el = page.locator(selector).first();
    const visible = await el.isVisible({ timeout: 1500 }).catch(() => false);
    if (visible) {
      searchInput = el;
      searchFrame = 'main';
      logger.info({ selector, frame: 'main' }, 'addBlockToSection[2/5]: found search input');
      break;
    }
  }

  // Try iframe if not found in main frame
  if (!searchInput) {
    const siteFrame = getSiteFrame(page);
    if (siteFrame) {
      for (const selector of searchSelectors) {
        const el = siteFrame.locator(selector).first();
        const visible = await el.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          searchInput = el;
          searchFrame = 'iframe';
          logger.info({ selector, frame: 'iframe' }, 'addBlockToSection[2/5]: found search input in iframe');
          break;
        }
      }
    }
  }

  if (searchInput) {
    await searchInput.click();
    await page.waitForTimeout(200);
    await searchInput.fill(blockType);
    await page.waitForTimeout(800);
  } else {
    logger.warn('addBlockToSection[2/5]: search input not found — will try clicking block type directly');
  }

  // ── Step 3: Click the matching block type tile ────────────────────────
  // The block picker tiles render INSIDE the iframe. boundingBox() may return
  // off-screen coordinates when the iframe is scrolled, so we check viewport
  // bounds and fall back to JS click (same pattern as addImageBlock Step 3).
  logger.info({ blockType }, 'addBlockToSection[3/5]: clicking block type result');

  let blockClicked = false;
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  const siteFrameForPicker = getSiteFrame(page);

  // Count relevant blocks before clicking so we can verify one was added
  const blockSelectorForType = (() => {
    const bt = blockType.toLowerCase();
    switch (bt) {
      case 'button': return '.sqs-block-button';
      case 'image': return '.sqs-block-image';
      case 'quote': return '.sqs-block-quote';
      case 'code':
      case 'embed': return '.sqs-block-code, .sqs-block-embed';
      case 'video': return '.sqs-block-video';
      case 'form': return '.sqs-block-form';
      case 'line':
      case 'divider': return '.sqs-block-horizontalrule';
      case 'gallery': return '.sqs-block-gallery';
      default: return '.sqs-block-html, .sqs-block-markdown';
    }
  })();
  const blockCountBefore = siteFrameForPicker
    ? await siteFrameForPicker.locator(blockSelectorForType).count().catch(() => 0)
    : 0;

  // Strategy A: boundingBox click (through overlay) — only if coordinates are on-screen
  if (!blockClicked && siteFrameForPicker) {
    const tileText = siteFrameForPicker.getByText(blockType, { exact: true }).first();
    const tileBox = await tileText.boundingBox().catch(() => null);
    if (tileBox && tileBox.y >= 0 && tileBox.y < viewport.height && tileBox.x >= 0 && tileBox.x < viewport.width) {
      await page.mouse.click(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
      blockClicked = true;
      logger.info({ x: Math.round(tileBox.x), y: Math.round(tileBox.y) }, 'addBlockToSection[3/5]: clicked tile via boundingBox');
    } else if (tileBox) {
      logger.info({ x: Math.round(tileBox.x), y: Math.round(tileBox.y), vpH: viewport.height }, 'addBlockToSection[3/5]: tile boundingBox off-screen, skipping to JS click');
    }
  }

  // Strategy B: JavaScript click in iframe (reliable even when page is scrolled)
  if (!blockClicked) {
    const frame = page.frame({ name: 'sqs-site-frame' });
    if (frame) {
      const clicked = await frame.evaluate((typeName: string) => {
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const htmlEl = el as HTMLElement;
          const text = htmlEl.innerText?.trim();
          if (text === typeName && el.children.length <= 3) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              htmlEl.click();
              return `clicked ${el.tagName}.${el.className?.toString().substring(0, 30)} at ${Math.round(rect.x)},${Math.round(rect.y)}`;
            }
          }
        }
        // Case-insensitive fallback
        for (const el of allElements) {
          const htmlEl = el as HTMLElement;
          const text = htmlEl.innerText?.trim();
          if (text && text.toLowerCase() === typeName.toLowerCase() && el.children.length <= 3) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              htmlEl.click();
              return `clicked ${el.tagName} (case-insensitive)`;
            }
          }
        }
        return false;
      }, blockType).catch(() => false);
      if (clicked) {
        blockClicked = true;
        logger.info({ detail: clicked }, 'addBlockToSection[3/5]: clicked tile via iframe JS');
      }
    }
  }

  // Strategy C: Try Playwright locators in main frame
  if (!blockClicked) {
    const exactSelectors = [
      `text="${blockType}"`,
      `button:has-text("${blockType}")`,
      `[role="button"]:has-text("${blockType}")`,
    ];
    for (const selector of exactSelectors) {
      try {
        const el = page.locator(selector).first();
        const visible = await el.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          await el.click({ timeout: 3000 });
          blockClicked = true;
          logger.info({ selector, frame: 'main' }, 'addBlockToSection[3/5]: clicked block type');
          break;
        }
      } catch { /* Try next */ }
    }
  }

  if (!blockClicked) {
    return {
      success: false,
      message: `addBlockToSection step 3: Could not find block type "${blockType}" in block picker. Check the block type name.`,
    };
  }
  await page.waitForTimeout(2000);

  // Verify that a new block was actually created
  const blockCountAfter = siteFrameForPicker
    ? await siteFrameForPicker.locator(blockSelectorForType).count().catch(() => 0)
    : 0;
  if (blockCountAfter <= blockCountBefore) {
    logger.warn({ before: blockCountBefore, after: blockCountAfter }, 'addBlockToSection[3/5]: no new block created — retrying JS click');
    const frame = page.frame({ name: 'sqs-site-frame' });
    if (frame) {
      await frame.evaluate((typeName: string) => {
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const htmlEl = el as HTMLElement;
          const text = htmlEl.innerText?.trim();
          if (text === typeName && el.children.length <= 3) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) { htmlEl.click(); return true; }
          }
        }
        return false;
      }, blockType).catch(() => false);
      await page.waitForTimeout(2000);
    }
  }

  // ── Step 4: Wait for the block to appear ────────────────────────────
  logger.info('addBlockToSection[4/5]: waiting for new block');
  await page.waitForTimeout(1000);

  // ── Step 5: Type content if provided ────────────────────────────────
  // Key insight: Squarespace's text editor only activates via real mouse events
  // through the overlay (page.mouse.dblclick), NOT via iframe JS click/focus.
  if (content) {
    logger.info({ content: content.substring(0, 50), blockType }, 'addBlockToSection[5/5]: typing content');
    await page.waitForTimeout(500);

    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    const siteFrameLocator = getSiteFrame(page);
    let contentTyped = false;

    // ── Button blocks: double-click to open editor, set label in TEXT input ──
    if (blockType.toLowerCase() === 'button') {
      logger.info('addBlockToSection[5/5]: Button block — opening editor panel');

      // Find the last button block and double-click it to open the editor
      if (siteFrameLocator) {
        const buttonBlocks = siteFrameLocator.locator('.sqs-block-button');
        const btnCount = await buttonBlocks.count().catch(() => 0);
        if (btnCount > 0) {
          const lastBtn = buttonBlocks.nth(btnCount - 1);
          await lastBtn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(300);
          const btnBox = await lastBtn.boundingBox().catch(() => null);
          if (btnBox) {
            // Single click to select, then double-click to open editor
            await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
            await page.waitForTimeout(500);
            await page.mouse.dblclick(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
            await page.waitForTimeout(1500);

            // Look for the button TEXT input in the editor panel
            const textInputSelectors = [
              'input[data-test="button-text-input"]',
              'input[placeholder*="Button"]',
              'input[value="Button"]',
              '.sqs-button-text-input',
            ];
            for (const sel of textInputSelectors) {
              const input = page.locator(sel).first();
              const visible = await input.isVisible({ timeout: 1000 }).catch(() => false);
              if (visible) {
                await input.click();
                await input.fill(content);
                contentTyped = true;
                logger.info({ sel }, 'addBlockToSection[5/5]: set button label via input');
                break;
              }
            }

            // Fallback: scan all visible text inputs for one that says "Button"
            if (!contentTyped) {
              const allInputs = page.locator('input[type="text"], input:not([type])');
              const inputCount = await allInputs.count().catch(() => 0);
              for (let i = 0; i < inputCount; i++) {
                const inp = allInputs.nth(i);
                const val = await inp.inputValue().catch(() => '');
                const visible = await inp.isVisible().catch(() => false);
                if (visible && (val === 'Button' || val === '')) {
                  await inp.click();
                  await inp.fill(content);
                  contentTyped = true;
                  logger.info({ index: i, prevVal: val }, 'addBlockToSection[5/5]: set button label via scan');
                  break;
                }
              }
            }

            if (!contentTyped) {
              logger.info('addBlockToSection[5/5]: button editor panel not found — label not set');
            }
          }
        }
      }
    } else if (blockType.toLowerCase() === 'quote') {
      // ── Quote blocks: double-click to open contenteditable, type quote text ──
      logger.info('addBlockToSection[5/5]: Quote block — typing quote content');

      if (siteFrameLocator) {
        const quoteBlocks = siteFrameLocator.locator('.sqs-block-quote');
        const qCount = await quoteBlocks.count().catch(() => 0);
        if (qCount > 0) {
          const lastQuote = quoteBlocks.nth(qCount - 1);
          await lastQuote.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(300);
          const qBox = await lastQuote.boundingBox().catch(() => null);
          if (qBox) {
            await page.mouse.click(qBox.x + qBox.width / 2, qBox.y + qBox.height / 2);
            await page.waitForTimeout(500);
            await page.mouse.dblclick(qBox.x + qBox.width / 2, qBox.y + qBox.height / 2);
            await page.waitForTimeout(800);

            // Check for active editor
            if (siteFrame) {
              const hasEditor = await siteFrame.evaluate(() => {
                const active = document.activeElement;
                return active != null && (active as HTMLElement).isContentEditable;
              }).catch(() => false);
              if (hasEditor) {
                await page.keyboard.press('Meta+a');
                await page.waitForTimeout(100);
                await page.keyboard.type(content, { delay: 20 });
                contentTyped = true;
                logger.info('addBlockToSection[5/5]: typed quote content');
              }
            }
          }
        }
      }
    } else if (blockType.toLowerCase() === 'code' || blockType.toLowerCase() === 'embed') {
      // ── Code/Embed blocks: editor may auto-open, find textarea and fill ──
      logger.info('addBlockToSection[5/5]: Code/Embed block — filling code content');

      await page.waitForTimeout(1500); // Wait for code editor to open

      // Try textarea first
      const textareaSelectors = [
        'textarea.code-editor',
        'textarea[data-test="code-input"]',
        '.code-editor textarea',
        'textarea',
      ];
      for (const sel of textareaSelectors) {
        const textarea = page.locator(sel).first();
        const visible = await textarea.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          await textarea.click();
          await textarea.fill(content);
          contentTyped = true;
          logger.info({ sel }, 'addBlockToSection[5/5]: typed code via textarea');
          break;
        }
      }

      // Try CodeMirror
      if (!contentTyped) {
        const codeMirror = page.locator('.CodeMirror');
        const cmVisible = await codeMirror.first().isVisible({ timeout: 1500 }).catch(() => false);
        if (cmVisible) {
          await codeMirror.first().click();
          await page.waitForTimeout(300);
          await page.keyboard.press('Meta+a');
          await page.waitForTimeout(100);
          await page.keyboard.type(content, { delay: 10 });
          contentTyped = true;
          logger.info('addBlockToSection[5/5]: typed code via CodeMirror');
        }
      }

      // Click Apply/Save if found
      if (contentTyped) {
        for (const sel of ['button:has-text("Apply")', 'button:has-text("Save")']) {
          const btn = page.locator(sel).first();
          const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
          if (visible) {
            await btn.click({ timeout: 3000 });
            logger.info({ sel }, 'addBlockToSection[5/5]: clicked save/apply for code block');
            break;
          }
        }
      }
    } else if (blockType.toLowerCase() === 'video') {
      // ── Video blocks: editor opens with URL input ──
      logger.info('addBlockToSection[5/5]: Video block — filling video URL');

      await page.waitForTimeout(1500); // Wait for video editor to open

      // Find URL input in the video editor
      const urlInputSelectors = [
        'input[placeholder*="URL"]',
        'input[placeholder*="url"]',
        'input[placeholder*="Paste"]',
        'input[placeholder*="paste"]',
        'input[placeholder*="video"]',
        'input[placeholder*="Video"]',
        'input[data-test="video-url"]',
        'input[type="url"]',
      ];
      for (const sel of urlInputSelectors) {
        const input = page.locator(sel).first();
        const visible = await input.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          await input.click();
          await input.fill(content);
          contentTyped = true;
          logger.info({ sel }, 'addBlockToSection[5/5]: filled video URL');
          break;
        }
      }

      // Fallback: scan all visible inputs
      if (!contentTyped) {
        const allInputs = page.locator('input[type="text"], input[type="url"], input:not([type])');
        const inputCount = await allInputs.count().catch(() => 0);
        for (let i = 0; i < inputCount; i++) {
          const inp = allInputs.nth(i);
          const visible = await inp.isVisible().catch(() => false);
          const placeholder = await inp.getAttribute('placeholder').catch(() => '');
          if (visible && (!placeholder || placeholder.toLowerCase().includes('url') || placeholder.toLowerCase().includes('paste') || placeholder.toLowerCase().includes('video'))) {
            await inp.click();
            await inp.fill(content);
            contentTyped = true;
            logger.info({ index: i, placeholder }, 'addBlockToSection[5/5]: filled video URL via scan');
            break;
          }
        }
      }

      // Press Enter or click Save to confirm the URL
      if (contentTyped) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
      }
    } else if (['form', 'line', 'divider', 'gallery'].includes(blockType.toLowerCase())) {
      // ── Form/Divider/Gallery: no auto-content — these have complex editors or no content ──
      logger.info({ blockType }, 'addBlockToSection[5/5]: block type does not support auto-content population');
      return {
        success: true,
        message: `addBlockToSection: Added "${blockType}" block. Note: ${blockType} blocks ${blockType.toLowerCase() === 'line' || blockType.toLowerCase() === 'divider' ? 'are visual elements with no editable content' : 'have complex editors that must be configured manually'}.`,
      };
    } else {
      // ── Text/other blocks: double-click to activate contenteditable editor ──

      // First check if editor is already active (e.g., auto-focused after adding)
      let hasActiveEditor = false;
      if (siteFrame) {
        hasActiveEditor = await siteFrame.evaluate(() => {
          const active = document.activeElement;
          return active != null && (active as HTMLElement).isContentEditable;
        }).catch(() => false);
      }

      if (hasActiveEditor) {
        await page.keyboard.type(content, { delay: 20 });
        contentTyped = true;
        logger.info('addBlockToSection[5/5]: typed content in auto-focused editor');
      }

      // Not auto-focused — find the empty block and double-click it via page.mouse
      if (!contentTyped && siteFrameLocator) {
        logger.info('addBlockToSection[5/5]: no active editor — finding empty block to double-click');

        // Find the last empty text block (the one we just created)
        const textBlocks = siteFrameLocator.locator('.sqs-block-html .sqs-block-content, .sqs-block-markdown .sqs-block-content');
        const textBlockCount = await textBlocks.count().catch(() => 0);

        let emptyBlockIdx = -1;
        for (let i = textBlockCount - 1; i >= 0; i--) {
          const block = textBlocks.nth(i);
          const text = await block.innerText().catch(() => 'non-empty');
          if (!text || text.trim().length === 0) {
            emptyBlockIdx = i;
            break;
          }
        }

        if (emptyBlockIdx >= 0) {
          const emptyBlock = textBlocks.nth(emptyBlockIdx);
          await emptyBlock.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(300);
          const emptyBox = await emptyBlock.boundingBox().catch(() => null);

          if (emptyBox && emptyBox.y >= 0 && emptyBox.y < viewport.height) {
            const cx = emptyBox.x + emptyBox.width / 2;
            const cy = emptyBox.y + emptyBox.height / 2;

            // Single click first to select, then double-click to edit
            await page.mouse.click(cx, cy);
            await page.waitForTimeout(500);
            await page.mouse.dblclick(cx, cy);
            await page.waitForTimeout(800);

            // Check if editor is now active
            if (siteFrame) {
              hasActiveEditor = await siteFrame.evaluate(() => {
                const active = document.activeElement;
                return active != null && (active as HTMLElement).isContentEditable;
              }).catch(() => false);
            }

            if (hasActiveEditor) {
              // Select all first (in case there's placeholder text), then type
              await page.keyboard.press('Meta+a');
              await page.waitForTimeout(100);
              await page.keyboard.type(content, { delay: 20 });
              contentTyped = true;
              logger.info('addBlockToSection[5/5]: typed content after double-click activation');
            } else {
              // Try pressing Enter to force edit mode (pattern from editTextBlock)
              logger.info('addBlockToSection[5/5]: double-click did not activate editor — pressing Enter');
              await page.keyboard.press('Enter');
              await page.waitForTimeout(500);

              if (siteFrame) {
                hasActiveEditor = await siteFrame.evaluate(() => {
                  const active = document.activeElement;
                  return active != null && (active as HTMLElement).isContentEditable;
                }).catch(() => false);
              }

              if (hasActiveEditor) {
                await page.keyboard.type(content, { delay: 20 });
                contentTyped = true;
                logger.info('addBlockToSection[5/5]: typed content after Enter activation');
              }
            }
          } else {
            logger.info({ emptyBox, vpH: viewport.height }, 'addBlockToSection[5/5]: empty block not on screen or no boundingBox');
          }
        } else {
          logger.info({ textBlockCount }, 'addBlockToSection[5/5]: no empty text block found');

          // Fallback: try to find ANY empty .sqs-block-content
          const allBlockContents = siteFrameLocator.locator('.sqs-block-content');
          const allCount = await allBlockContents.count().catch(() => 0);
          for (let i = allCount - 1; i >= 0; i--) {
            const block = allBlockContents.nth(i);
            const text = await block.innerText().catch(() => 'non-empty');
            if (!text || text.trim().length === 0) {
              await block.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
              await page.waitForTimeout(300);
              const box = await block.boundingBox().catch(() => null);
              if (box && box.y >= 0 && box.y < viewport.height) {
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                await page.waitForTimeout(300);
                await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
                await page.waitForTimeout(800);

                if (siteFrame) {
                  hasActiveEditor = await siteFrame.evaluate(() => {
                    const active = document.activeElement;
                    return active != null && (active as HTMLElement).isContentEditable;
                  }).catch(() => false);
                }

                if (hasActiveEditor) {
                  await page.keyboard.press('Meta+a');
                  await page.waitForTimeout(100);
                  await page.keyboard.type(content, { delay: 20 });
                  contentTyped = true;
                  logger.info({ blockIdx: i }, 'addBlockToSection[5/5]: typed content in fallback empty block');
                }
                break;
              }
            }
          }
        }
      }

      if (!contentTyped) {
        logger.info('addBlockToSection[5/5]: could not activate editor — content not typed');
        return {
          success: true,
          message: `addBlockToSection: Added "${blockType}" block but could not activate text editor. Use editTextBlock to type content into the empty block.`,
        };
      }
    }
  }

  return {
    success: true,
    message: `addBlockToSection: Added "${blockType}" block${content ? ` with content "${content.substring(0, 40)}..."` : ''}`,
  };
}

// ─── Compound Action: removeBlock ────────────────────────────────────────

/**
 * Compound action: remove a specific block (NOT the whole section) from
 * the Squarespace Fluid Engine editor.
 *
 * IMPORTANT: This removes a BLOCK within a section, not the section itself.
 * The section and other blocks within it are preserved.
 *
 * Steps:
 * 1. Find the block by its visible text in the iframe
 * 2. Click through overlay to select the section
 * 3. Click "EDIT CONTENT" to enter section edit mode
 * 4. Click the block to select it within the Fluid Engine grid
 * 5. Press Delete/Backspace to remove just the block
 * 6. Verify the block was removed
 */
export async function handleRemoveBlock(
  page: Page,
  action: { action: 'removeBlock'; searchText: string },
): Promise<ActionResult> {
  const { searchText } = action;

  // Step 0: Try Content Save API fast path
  const apiResult = await tryBlockRemoveApi(page, searchText);
  if (apiResult) return apiResult;

  // ── Step 1: Find the block text ─────────────────────────────────────
  logger.info({ searchText }, 'removeBlock[1/6]: finding block');
  const matches = await findTextOnPage(page, searchText);
  if (matches.length === 0) {
    return {
      success: false,
      message: `removeBlock step 1: Block containing "${searchText}" not found on page`,
    };
  }

  // ── Step 2: Click through overlay to select section ─────────────────
  logger.info({ searchText }, 'removeBlock[2/6]: clicking section');
  const textSelector = `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return {
      success: false,
      message: `removeBlock step 2: Failed to click section — ${clickResult.message}`,
    };
  }
  await page.waitForTimeout(800);

  // ── Step 3: Check if Fluid Engine is already active ─────────────────
  // IMPORTANT: Do NOT click "EDIT SECTION" — that opens the section DESIGN
  // settings panel (Grid, Row Count, Height), not the content editor.
  // After clicking a section, the Fluid Engine is usually already active.
  logger.info('removeBlock[3/6]: checking if Fluid Engine is already active');
  const rmFluidActive = await isFluidEngineActive(page, 3000);

  if (rmFluidActive) {
    logger.info('removeBlock[3/6]: Fluid Engine is active — proceeding to block selection');
  } else {
    // Only try EDIT CONTENT (NOT EDIT SECTION — that opens design settings!)
    const editContentClicked = await clickEditorButton(page, /edit content/i, [
      '[aria-label="Edit Content"]', 'button[data-test="edit-content"]',
    ]);
    if (!editContentClicked) {
      logger.info('removeBlock[3/6]: EDIT CONTENT not found — may already be in edit mode');
    } else {
      logger.info('removeBlock[3/6]: clicked EDIT CONTENT');
      await page.waitForTimeout(1500);
    }
  }

  // ── Step 4: Click the block to select it ────────────────────────────
  // In Fluid Engine edit mode, clicking a block selects that specific block
  // (shown with a blue border and block toolbar)
  logger.info({ searchText }, 'removeBlock[4/6]: clicking block to select it');

  // Re-find in edit mode
  const editMatches = await findTextOnPage(page, searchText);
  const editSelector = editMatches.length > 0 ? `text=${searchText}` : textSelector;

  const blockClick = await clickThroughOverlay(page, editSelector);
  if (!blockClick.success) {
    return {
      success: false,
      message: `removeBlock step 4: Could not click block — ${blockClick.message}`,
    };
  }
  await page.waitForTimeout(800);

  // ── Step 5: Delete the selected block ───────────────────────────────
  logger.info('removeBlock[5/6]: deleting block');

  // Try the block toolbar's delete/remove button first
  const deleteSelectors = [
    'button[aria-label="Delete"]',
    'button[aria-label="Delete block"]',
    'button[aria-label="Remove"]',
    'button[aria-label="Remove block"]',
    '[data-test="block-delete"]',
    '[class*="BlockToolbar"] button[aria-label*="elete"]',
    '[class*="BlockToolbar"] button[aria-label*="emove"]',
  ];

  let deleteClicked = false;
  for (const selector of deleteSelectors) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        deleteClicked = true;
        logger.info({ selector }, 'removeBlock[5/6]: clicked delete button');
        break;
      }
    } catch { /* Try next */ }
  }

  if (!deleteClicked) {
    // Fallback: keyboard shortcuts
    logger.info('removeBlock[5/6]: delete button not found — trying keyboard');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
    await page.keyboard.press('Backspace');
  }
  await page.waitForTimeout(1000);

  // Handle confirmation dialog if one appears
  const dialogSelectors = [
    'button:has-text("Confirm")',
    'button:has-text("Yes")',
    'button:has-text("OK")',
    'button:has-text("Delete")',
  ];

  for (const selector of dialogSelectors) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        logger.info({ selector }, 'removeBlock[5/6]: confirmed deletion');
        break;
      }
    } catch { /* Try next */ }
  }
  await page.waitForTimeout(800);

  // ── Step 6: Verify the block was removed ────────────────────────────
  logger.info({ searchText }, 'removeBlock[6/6]: verifying removal');
  const afterMatches = await findTextOnPage(page, searchText);

  if (afterMatches.length === 0) {
    return {
      success: true,
      message: `removeBlock: Successfully removed block containing "${searchText}". The text is no longer on the page.`,
    };
  }

  return {
    success: true,
    message: `removeBlock: Attempted to remove block containing "${searchText}". Text still appears on page — verify visually that the correct block was removed.`,
  };
}

// ─── moveBlockInSection Handler ──────────────────────────────────────────

/**
 * Move a block within its Fluid Engine section using keyboard arrows.
 */
export async function handleMoveBlockInSection(
  page: Page,
  action: { action: 'moveBlockInSection'; searchText: string; position: 'up' | 'down' | 'left' | 'right' },
): Promise<ActionResult> {
  const { searchText, position } = action;

  // Step 0: Try Content Save API fast path (same pattern as editTextBlock)
  const apiResult = await tryBlockMoveApi(page, searchText, position);
  if (apiResult) return apiResult;

  // Step 1: Find the text on the page
  const matches = await findTextOnPage(page, searchText);
  if (matches.length === 0) {
    return { success: false, message: `moveBlockInSection: text "${searchText}" not found on page` };
  }

  // Step 2: Click through overlay to select the section
  const textSelector = `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return { success: false, message: `moveBlockInSection: could not click through overlay for "${searchText}" — ${clickResult.message}` };
  }
  await page.waitForTimeout(800);

  // Step 3: Enter section edit mode if not already active
  if (!(await isFluidEngineActive(page, 1500))) {
    await clickEditorButton(page, /edit content/i, ['[aria-label="Edit Content"]']);
    await page.waitForTimeout(1500);
  }

  // Step 4: Click the block again to select it within the section
  await clickThroughOverlay(page, textSelector).catch(() => {});
  await page.waitForTimeout(500);

  // Step 5: Get initial position via the iframe Frame (not FrameLocator)
  const iframeFrame = page.frame({ name: 'sqs-site-frame' });
  const initialBox = iframeFrame
    ? await iframeFrame.evaluate((text) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.includes(text)) {
            const el = walker.currentNode.parentElement;
            if (el) {
              const rect = el.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }
          }
        }
        return null;
      }, searchText).catch(() => null)
    : null;

  // Step 6: Move using arrow keys (repeat 3 times for meaningful movement)
  const keyMap: Record<string, string> = {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
  };
  const arrowKey = keyMap[position];

  for (let i = 0; i < 3; i++) {
    await page.keyboard.press(arrowKey);
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(500);

  // Step 7: Check if position changed
  const finalBox = iframeFrame
    ? await iframeFrame.evaluate((text) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.includes(text)) {
            const el = walker.currentNode.parentElement;
            if (el) {
              const rect = el.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }
          }
        }
        return null;
      }, searchText).catch(() => null)
    : null;

  const moved = initialBox && finalBox &&
    (Math.abs(finalBox.x - initialBox.x) > 5 || Math.abs(finalBox.y - initialBox.y) > 5);

  if (moved) {
    return {
      success: true,
      message: `moveBlockInSection: moved block "${searchText}" ${position}. Position changed from (${Math.round(initialBox!.x)},${Math.round(initialBox!.y)}) to (${Math.round(finalBox!.x)},${Math.round(finalBox!.y)}).`,
    };
  }

  // Fallback: try drag-and-drop via the move handle
  const dragOffset: Record<string, { x: number; y: number }> = {
    up: { x: 0, y: -50 },
    down: { x: 0, y: 50 },
    left: { x: -50, y: 0 },
    right: { x: 50, y: 0 },
  };

  const moveHandleSelectors = [
    '[aria-label="Move"]',
    '[data-test="block-move-handle"]',
    '.block-toolbar [class*="move"]',
    '.fe-block-toolbar button:first-child',
  ];

  for (const sel of moveHandleSelectors) {
    const handle = page.locator(sel).first();
    const visible = await handle.isVisible({ timeout: 1000 }).catch(() => false);
    if (visible) {
      const handleBox = await handle.boundingBox();
      if (handleBox) {
        const startX = handleBox.x + handleBox.width / 2;
        const startY = handleBox.y + handleBox.height / 2;
        const offset = dragOffset[position];

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + offset.x, startY + offset.y, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(500);

        return {
          success: true,
          message: `moveBlockInSection: dragged block "${searchText}" ${position} via move handle. Verify visually.`,
        };
      }
    }
  }

  return {
    success: true,
    message: `moveBlockInSection: sent arrow key commands to move "${searchText}" ${position}. Position change may be subtle — verify visually.`,
  };
}

// ─── resizeBlock Handler ─────────────────────────────────────────────────

/**
 * Resize a block in the Fluid Engine by dragging its edge handles.
 */
export async function handleResizeBlock(
  page: Page,
  action: { action: 'resizeBlock'; searchText: string; width?: 'smaller' | 'larger' | 'full'; height?: 'shorter' | 'taller' },
): Promise<ActionResult> {
  const { searchText, width, height } = action;

  if (!width && !height) {
    return { success: false, message: 'resizeBlock: must provide at least width or height' };
  }

  // Step 0: Try Content Save API fast path
  const apiResult = await tryBlockResizeApi(page, searchText, width, height);
  if (apiResult) return apiResult;

  // Step 1: Find and select the block
  const matches = await findTextOnPage(page, searchText);
  if (matches.length === 0) {
    return { success: false, message: `resizeBlock: text "${searchText}" not found on page` };
  }

  const textSelector = `text=${searchText}`;
  const clickResult = await clickThroughOverlay(page, textSelector);
  if (!clickResult.success) {
    return { success: false, message: `resizeBlock: could not click through overlay for "${searchText}" — ${clickResult.message}` };
  }
  await page.waitForTimeout(800);

  // Enter edit mode if not already
  if (!(await isFluidEngineActive(page, 1500))) {
    await clickEditorButton(page, /edit content/i, ['[aria-label="Edit Content"]']);
    await page.waitForTimeout(1500);
  }

  // Click block to select it
  await clickThroughOverlay(page, textSelector).catch(() => {});
  await page.waitForTimeout(500);

  // Get the block's bounding box via the iframe Frame
  const iframeFrame = page.frame({ name: 'sqs-site-frame' });
  const blockBox = iframeFrame
    ? await iframeFrame.evaluate((text) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.includes(text)) {
            const el = walker.currentNode.parentElement;
            if (el) {
              const rect = el.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }
          }
        }
        return null;
      }, searchText).catch(() => null)
    : null;

  if (!blockBox) {
    return { success: false, message: `resizeBlock: could not get bounding box for block "${searchText}"` };
  }

  // Get iframe offset to convert iframe coords to page coords
  const iframeEl = page.locator('#sqs-site-frame, [name="sqs-site-frame"]').first();
  const iframeBox = await iframeEl.boundingBox().catch(() => null);
  const iframeOffsetX = iframeBox?.x ?? 0;
  const iframeOffsetY = iframeBox?.y ?? 0;

  const updates: string[] = [];

  // Resize width by dragging the right edge
  if (width) {
    const rightEdgeX = iframeOffsetX + blockBox.x + blockBox.width;
    const midY = iframeOffsetY + blockBox.y + blockBox.height / 2;

    const widthDelta: Record<string, number> = {
      smaller: -80,
      larger: 80,
      full: 300, // Drag far right to fill container
    };

    const delta = widthDelta[width];
    await page.mouse.move(rightEdgeX, midY);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.move(rightEdgeX + delta, midY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    updates.push(`width → ${width}`);
  }

  // Resize height by dragging the bottom edge
  if (height) {
    const midX = iframeOffsetX + blockBox.x + blockBox.width / 2;
    const bottomEdgeY = iframeOffsetY + blockBox.y + blockBox.height;

    const heightDelta: Record<string, number> = {
      shorter: -60,
      taller: 60,
    };

    const delta = heightDelta[height];
    await page.mouse.move(midX, bottomEdgeY);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.move(midX, bottomEdgeY + delta, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    updates.push(`height → ${height}`);
  }

  return {
    success: true,
    message: `resizeBlock: resized block "${searchText}" — ${updates.join(', ')}. Verify visually.`,
  };
}
