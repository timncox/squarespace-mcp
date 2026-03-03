import { Page } from 'playwright';
import { logger } from '../../utils/logger.js';
import { clickThroughOverlay, dblclickThroughOverlay, findTextOnPage, getSiteFrame } from '../editor-actions.js';
import { errMsg } from '../../utils/errors.js';
import { validateFileExists } from './handler-utils.js';
import type { ActionResult } from './types.js';

// ─── Individual Action Handlers ────────────────────────────────────────────

export async function handleClick(
  page: Page,
  action: { action: 'click'; selector?: string; x?: number; y?: number },
): Promise<ActionResult> {
  if (action.selector) {
    const el = page.locator(action.selector).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      // Element not in main frame — try clicking through iframe overlay.
      // The Squarespace editor renders some UI panels (block picker, section
      // editor controls) inside the iframe. The agent often uses "click" for
      // these since they look like admin UI, but they're actually in the iframe.
      const siteFrame = getSiteFrame(page);
      if (siteFrame) {
        logger.info(
          { selector: action.selector },
          'click: element not visible in main frame — trying iframe fallback',
        );
        const iframeResult = await clickThroughOverlay(page, action.selector);
        if (iframeResult.success) {
          return {
            success: true,
            message: `Clicked "${action.selector}" via iframe fallback (element was in iframe, not main frame)`,
          };
        }
      }
      return { success: false, message: `Element "${action.selector}" not visible` };
    }

    try {
      // Try normal click first with a short timeout (5s instead of default 30s).
      // This prevents the 30-second hang when an overlay intercepts the click.
      await el.click({ timeout: 5000 });
      await page.waitForTimeout(500);
      return { success: true, message: `Clicked "${action.selector}"` };
    } catch (clickErr) {
      const clickErrMsg = errMsg(clickErr);

      // If an overlay/iframe intercepts pointer events, fall back to
      // clickThroughOverlay which correctly calculates iframe-offset coordinates.
      // The Squarespace editor wraps site content in an iframe (#sqs-site-frame)
      // with an overlay div that intercepts all pointer events.
      if (clickErrMsg.includes('intercepts pointer events') || clickErrMsg.includes('Timeout')) {
        logger.info({ selector: action.selector }, 'Click intercepted by overlay — trying clickThroughOverlay');

        // First try clicking through the iframe overlay (most common case in Squarespace editor)
        const siteFrame = getSiteFrame(page);
        if (siteFrame) {
          const iframeResult = await clickThroughOverlay(page, action.selector!);
          if (iframeResult.success) {
            return { success: true, message: `Clicked "${action.selector}" via iframe overlay (${iframeResult.message})` };
          }
          logger.info({ selector: action.selector }, 'clickThroughOverlay failed — trying raw mouse.click at bounding box');
        }

        // Final fallback: raw mouse.click at the element's bounding box center
        try {
          const box = await el.boundingBox();
          if (box) {
            const cx = Math.round(box.x + box.width / 2);
            const cy = Math.round(box.y + box.height / 2);
            await page.mouse.click(cx, cy);
            await page.waitForTimeout(500);
            return { success: true, message: `Clicked "${action.selector}" via raw mouse at (${cx}, ${cy})` };
          }
        } catch { /* fall through to error */ }

        return { success: false, message: `Element "${action.selector}" is behind an overlay — click failed even with iframe fallback` };
      }

      // Re-throw for other unexpected errors
      throw clickErr;
    }
  }

  if (action.x !== undefined && action.y !== undefined) {
    await page.mouse.click(action.x, action.y);
    await page.waitForTimeout(500);
    return { success: true, message: `Clicked at (${action.x}, ${action.y})` };
  }

  return { success: false, message: 'Click requires either a selector or x/y coordinates' };
}

export async function handleDblclick(
  page: Page,
  action: { action: 'dblclick'; selector?: string; x?: number; y?: number },
): Promise<ActionResult> {
  if (action.selector) {
    const el = page.locator(action.selector).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      return { success: false, message: `Element "${action.selector}" not visible` };
    }

    try {
      await el.dblclick({ timeout: 5000 });
      await page.waitForTimeout(500);
      return { success: true, message: `Double-clicked "${action.selector}"` };
    } catch (clickErr) {
      const clickErrMsg = errMsg(clickErr);
      if (clickErrMsg.includes('intercepts pointer events') || clickErrMsg.includes('Timeout')) {
        logger.info({ selector: action.selector }, 'Dblclick intercepted by overlay — falling back to mouse.dblclick');
        try {
          const box = await el.boundingBox();
          if (box) {
            const cx = Math.round(box.x + box.width / 2);
            const cy = Math.round(box.y + box.height / 2);
            await page.mouse.dblclick(cx, cy);
            await page.waitForTimeout(500);
            return { success: true, message: `Double-clicked "${action.selector}" via fallback at (${cx}, ${cy})` };
          }
        } catch { /* fall through */ }
        return { success: false, message: `Element "${action.selector}" is behind an overlay — use dblclickInIframe or x/y coordinates instead` };
      }
      throw clickErr;
    }
  }

  if (action.x !== undefined && action.y !== undefined) {
    await page.mouse.dblclick(action.x, action.y);
    await page.waitForTimeout(500);
    return { success: true, message: `Double-clicked at (${action.x}, ${action.y})` };
  }

  return { success: false, message: 'Dblclick requires either a selector or x/y coordinates' };
}

export async function handleHover(
  page: Page,
  action: { action: 'hover'; selector?: string; x?: number; y?: number },
): Promise<ActionResult> {
  if (action.selector) {
    const el = page.locator(action.selector).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) {
      return { success: false, message: `Element "${action.selector}" not visible` };
    }
    await el.hover();
    await page.waitForTimeout(800); // give UI time to reveal hover elements
    return { success: true, message: `Hovered over "${action.selector}"` };
  }

  if (action.x !== undefined && action.y !== undefined) {
    await page.mouse.move(action.x, action.y);
    await page.waitForTimeout(800);
    return { success: true, message: `Hovered at (${action.x}, ${action.y})` };
  }

  return { success: false, message: 'Hover requires either a selector or x/y coordinates' };
}

/**
 * clickInIframe with main-frame fallback.
 *
 * The Squarespace editor has admin UI elements (ADD SECTION, Edit Section,
 * ADD BLOCK, toolbars) in the MAIN frame and page content in the iframe.
 * The agent sometimes uses clickInIframe for admin buttons that live in
 * the main frame. Instead of failing, we detect this and fall back to a
 * regular main-frame click using page.locator().
 */
export async function handleClickInIframe(
  page: Page,
  action: { action: 'clickInIframe'; selector: string },
): Promise<ActionResult> {
  // Try the iframe first (normal path)
  const iframeResult = await clickThroughOverlay(page, action.selector);
  if (iframeResult.success) return iframeResult;

  // Iframe failed — try the main frame as a fallback.
  // This handles admin UI buttons like "ADD SECTION", "Edit Section", "ADD BLOCK" etc.
  logger.info(
    { selector: action.selector },
    'clickInIframe failed in iframe — trying main frame fallback',
  );

  try {
    const el = page.locator(action.selector).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await el.click({ timeout: 5000 });
      await page.waitForTimeout(500);
      logger.info({ selector: action.selector }, 'clickInIframe: found element in main frame instead');
      return {
        success: true,
        message: `Clicked "${action.selector}" in main frame (element was not in iframe — this is an admin UI element, use "click" next time)`,
      };
    }
  } catch {
    // Main frame fallback also failed — return original iframe error
  }

  return iframeResult;
}

/**
 * dblclickInIframe with enhanced text-block editing support.
 *
 * After double-clicking through the overlay, checks if we actually entered
 * inline editing mode for text blocks. The Squarespace overlay sometimes
 * intercepts double-clicks and only selects the section/block rather than
 * opening the inline editor. When this happens, we press Enter to force
 * entering edit mode (Squarespace interprets Enter on a selected text block
 * as "open inline editor").
 */
export async function handleDblclickInIframe(
  page: Page,
  action: { action: 'dblclickInIframe'; selector: string },
): Promise<ActionResult> {
  const result = await dblclickThroughOverlay(page, action.selector);
  if (!result.success) return result;

  // After a successful double-click, check if we entered inline editing mode.
  // In Squarespace, inline editing activates a contenteditable element inside
  // the iframe. If it's not active, the overlay ate the dblclick and we need
  // to force-enter edit mode.
  try {
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (siteFrame) {
      // Wait a beat for the editor to potentially activate
      await page.waitForTimeout(300);

      // Check if any contenteditable element is now active in the iframe
      const hasActiveEditor = await siteFrame.evaluate(() => {
        const active = document.activeElement;
        if (active && (active as HTMLElement).isContentEditable) return true;
        // Also check if the text editing toolbar appeared
        const toolbar = document.querySelector('.sqs-editing-toolbar, .rte-toolbar, [data-rte-toolbar]');
        return !!toolbar;
      }).catch(() => false);

      if (!hasActiveEditor) {
        // Inline editing didn't activate — try pressing Enter to force it
        logger.info(
          { selector: action.selector },
          'dblclickInIframe: inline editor not active after double-click, pressing Enter to force edit mode',
        );
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
      }
    }
  } catch {
    // Non-critical — the double-click may still have worked
  }

  return result;
}

/**
 * JavaScript-based click: dispatches a full pointer/mouse event sequence
 * directly on the DOM element via evaluate(). This bypasses all overlays
 * and Playwright actionability checks. Use as a last resort when normal
 * click and clickInIframe both fail to trigger the Squarespace UI.
 *
 * Searches both the main frame and the sqs-site-frame iframe.
 */
export async function handleJsClick(
  page: Page,
  action: { action: 'jsClick'; selector: string; frame?: 'main' | 'iframe' },
): Promise<ActionResult> {
  const dispatchClick = (selector: string) => {
    // Find element with support for Playwright :has-text() pseudo-selector.
    // Standard querySelector() crashes on :has-text() — we parse it out and
    // filter by text content instead.
    function findElement(sel: string): HTMLElement | null {
      // Match patterns like: button:has-text('ADD SECTION'), div:has-text("text"), :has-text('text')
      const hasTextMatch = sel.match(/^(.*?):has-text\((['"])(.*?)\2\)(.*)$/);
      if (hasTextMatch) {
        const cssPrefix = hasTextMatch[1] || '*';
        const searchText = hasTextMatch[3];
        const suffix = hasTextMatch[4]; // e.g. :not(:has(div)) — ignored for now
        try {
          const candidates = document.querySelectorAll(cssPrefix);
          for (const el of candidates) {
            if (el.textContent?.includes(searchText)) {
              return el as HTMLElement;
            }
          }
        } catch {
          // cssPrefix itself invalid — try wildcard
          if (cssPrefix !== '*') {
            for (const el of document.querySelectorAll('*')) {
              if (el.textContent?.includes(searchText)) {
                return el as HTMLElement;
              }
            }
          }
        }
        return null;
      }

      // Standard CSS selector
      try {
        return document.querySelector(sel) as HTMLElement | null;
      } catch {
        return null; // Invalid selector — don't crash
      }
    }

    const el = findElement(selector);
    if (!el) return { found: false };

    const rect = el.getBoundingClientRect();
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };

    // Full pointer event sequence to trigger React/synthetic handlers
    el.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, button: 0 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 0 }));
    el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, button: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, button: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, button: 0 }));

    return { found: true, tag: el.tagName, text: el.textContent?.substring(0, 50), cx: Math.round(cx), cy: Math.round(cy) };
  };

  // Try the specified frame first, or both if not specified
  const tryMain = action.frame !== 'iframe';
  const tryIframe = action.frame !== 'main';

  if (tryMain) {
    const mainResult = await page.evaluate(dispatchClick, action.selector);
    if (mainResult.found) {
      await page.waitForTimeout(800);
      logger.info({ selector: action.selector, frame: 'main', ...mainResult }, 'jsClick dispatched on main frame');
      return { success: true, message: `jsClick "${action.selector}" in main frame (${mainResult.tag}: "${mainResult.text}")` };
    }
  }

  if (tryIframe) {
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (siteFrame) {
      const iframeResult = await siteFrame.evaluate(dispatchClick, action.selector);
      if (iframeResult.found) {
        await page.waitForTimeout(800);
        logger.info({ selector: action.selector, frame: 'iframe', ...iframeResult }, 'jsClick dispatched on iframe');
        return { success: true, message: `jsClick "${action.selector}" in iframe (${iframeResult.tag}: "${iframeResult.text}")` };
      }
    }
  }

  return { success: false, message: `jsClick: element "${action.selector}" not found in ${action.frame || 'any'} frame` };
}

export async function handleType(
  page: Page,
  action: { action: 'type'; text: string },
): Promise<ActionResult> {
  await page.keyboard.type(action.text, { delay: 30 });
  return { success: true, message: `Typed "${action.text.substring(0, 50)}${action.text.length > 50 ? '...' : ''}"` };
}

export async function handleFill(
  page: Page,
  action: { action: 'fill'; selector: string; value: string },
): Promise<ActionResult> {
  const el = page.locator(action.selector).first();
  const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
  if (!visible) {
    return { success: false, message: `Element "${action.selector}" not visible for fill` };
  }
  await el.fill(action.value);
  return { success: true, message: `Filled "${action.selector}" with "${action.value.substring(0, 50)}${action.value.length > 50 ? '...' : ''}"` };
}

export async function handlePress(
  page: Page,
  action: { action: 'press'; key: string },
): Promise<ActionResult> {
  await page.keyboard.press(action.key);
  await page.waitForTimeout(300);
  return { success: true, message: `Pressed "${action.key}"` };
}

export async function handleScroll(
  page: Page,
  action: { action: 'scroll'; direction: 'up' | 'down'; amount?: number },
): Promise<ActionResult> {
  const delta = (action.amount ?? 300) * (action.direction === 'up' ? -1 : 1);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(500);
  return { success: true, message: `Scrolled ${action.direction} by ${Math.abs(delta)}px` };
}

export async function handleWait(
  page: Page,
  action: { action: 'wait'; ms: number },
): Promise<ActionResult> {
  const ms = Math.min(action.ms, 5000); // Cap at 5 seconds
  await page.waitForTimeout(ms);
  return { success: true, message: `Waited ${ms}ms` };
}

export async function handleNavigate(
  page: Page,
  action: { action: 'navigate'; url: string },
): Promise<ActionResult> {
  await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);
  return { success: true, message: `Navigated to ${action.url}` };
}

export async function handleUploadFile(
  page: Page,
  action: { action: 'uploadFile'; selector: string; filePath: string },
): Promise<ActionResult> {
  const fileError = validateFileExists(action.filePath, 'uploadFile');
  if (fileError) return fileError;

  const fileInput = page.locator(action.selector).first();
  await fileInput.setInputFiles(action.filePath);
  await page.waitForTimeout(2000); // Wait for upload processing
  return { success: true, message: `Uploaded file "${action.filePath}" via "${action.selector}"` };
}

/**
 * Exit the footer editor and scroll up to the page content area.
 * In Squarespace, clicking on the footer enters "Editing Site Footer — Global" mode.
 * This action presses Escape to exit, then scrolls the iframe to the top of the page content.
 */
export async function handleExitFooter(page: Page): Promise<ActionResult> {
  try {
    // Try pressing Escape to exit footer edit mode
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Scroll the iframe to the very top so the page content area is visible
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (siteFrame) {
      await siteFrame.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
    }

    // Also scroll the main page viewport to the top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    return { success: true, message: 'Exited footer editor and scrolled to page content area. You should now see the page content (NOT the footer).' };
  } catch (err) {
    const msg = errMsg(err);
    return { success: false, message: `Failed to exit footer: ${msg}` };
  }
}

export async function handleFindText(
  page: Page,
  action: { action: 'findText'; text: string },
): Promise<ActionResult> {
  const matches = await findTextOnPage(page, action.text);
  if (matches.length === 0) {
    return { success: false, message: `Text "${action.text}" not found on page` };
  }
  return { success: true, message: `Found ${matches.length} match(es) for "${action.text}"` };
}
