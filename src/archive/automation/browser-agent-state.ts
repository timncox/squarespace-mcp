import { Page } from 'playwright';
import { logger } from '../utils/logger.js';

export interface PageState {
  url: string;
  title: string;
  isEditMode: boolean;
  /** What the editor top-bar says we are editing (e.g. "Coding Projects" / "Editing Site Footer") */
  editingContext: string;
  /** True if the editor is in the global site footer (NOT page content) */
  isEditingFooter: boolean;
  /** Interactive elements visible on the main frame */
  mainElements: ElementSummary[];
  /** Text and interactive elements visible inside the site iframe */
  iframeElements: ElementSummary[];
  /** Detected open panels / dialogs */
  openPanels: string[];
}

export interface ElementSummary {
  tag: string;
  text: string;
  selector: string;
  ariaLabel?: string;
  type?: string; // input type
}

// Reduced from 50/80 to save tokens per step (~200-400 tokens saved).
// The agent primarily uses screenshots for navigation; DOM state is supplementary.
const MAX_TEXT_ITEMS = 30;
const MAX_INTERACTIVE_ITEMS = 40;

/**
 * Extract a structured summary of the current page state.
 * This is sent alongside screenshots to give the agent actionable DOM info.
 */
export async function extractPageState(page: Page): Promise<PageState> {
  const url = page.url();
  const title = await page.title().catch(() => '');

  // Detect edit mode
  const isEditMode = await detectEditMode(page);

  // Detect what the editor says we're editing (page name vs footer)
  const { editingContext, isEditingFooter } = await detectEditingContext(page);

  // Extract main frame elements
  const mainElements = await extractMainFrameElements(page);

  // Extract iframe elements
  const iframeElements = await extractIframeElements(page);

  // Detect open panels
  const openPanels = await detectOpenPanels(page);

  return { url, title, isEditMode, editingContext, isEditingFooter, mainElements, iframeElements, openPanels };
}

/**
 * Serialize page state to a readable text format for Claude.
 */
export function formatPageState(state: PageState): string {
  const parts: string[] = [];

  parts.push(`URL: ${state.url}`);
  parts.push(`Title: ${state.title}`);
  parts.push(`Edit mode: ${state.isEditMode ? 'YES' : 'no'}`);
  if (state.editingContext) {
    parts.push(`Editing: ${state.editingContext}`);
  }
  if (state.isEditingFooter) {
    parts.push(`\n** WARNING: You are editing the SITE FOOTER (Global), NOT page content! **`);
    parts.push(`** Click EXIT or press Escape, then scroll UP to work on the page content area. **\n`);
  }

  if (state.openPanels.length > 0) {
    parts.push(`Open panels: ${state.openPanels.join(', ')}`);
  }

  if (state.mainElements.length > 0) {
    parts.push('');
    parts.push(`## Main frame elements (${state.mainElements.length}):`);
    for (const el of state.mainElements.slice(0, MAX_INTERACTIVE_ITEMS)) {
      const aria = el.ariaLabel ? ` [${el.ariaLabel}]` : '';
      const typeStr = el.type ? ` (${el.type})` : '';
      parts.push(`  <${el.tag}${typeStr}${aria}> "${el.text.substring(0, 80)}" → ${el.selector}`);
    }
  }

  if (state.iframeElements.length > 0) {
    parts.push('');
    parts.push(`## Iframe content elements (${state.iframeElements.length}):`);
    for (const el of state.iframeElements.slice(0, MAX_TEXT_ITEMS)) {
      const aria = el.ariaLabel ? ` [${el.ariaLabel}]` : '';
      parts.push(`  <${el.tag}${aria}> "${el.text.substring(0, 80)}" → ${el.selector}`);
    }
  }

  return parts.join('\n');
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

/**
 * Detect what the Squarespace editor top bar says we are editing.
 * The top bar shows e.g. "Coding Projects\nPage - Published" or "Editing Site Footer\nGlobal".
 */
async function detectEditingContext(page: Page): Promise<{ editingContext: string; isEditingFooter: boolean }> {
  try {
    // The top-center area of the editor shows the editing context.
    // Look for common Squarespace editor top bar elements.
    const contextText = await page.evaluate(() => {
      // Try multiple selectors that Squarespace uses for the top bar text
      const selectors = [
        '.editor-chrome-top-center',
        '.page-name-display',
        '[class*="EditorChrome"] [class*="title"]',
        '[class*="page-status"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          return (el as HTMLElement).innerText?.trim() || '';
        }
      }
      // Fallback: look for text containing "Editing Site Footer" or "Page" anywhere in the top 60px
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        const htmlEl = el as HTMLElement;
        if (htmlEl.offsetParent === null) continue;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.top > 50) continue; // only check top bar area
        const text = htmlEl.innerText?.trim() || '';
        if (text.includes('Editing Site Footer') || text.includes('Global')) {
          return text;
        }
      }
      return '';
    }).catch(() => '');

    const isEditingFooter = contextText.toLowerCase().includes('footer') ||
      contextText.toLowerCase().includes('global');

    return { editingContext: contextText.substring(0, 100), isEditingFooter };
  } catch {
    return { editingContext: '', isEditingFooter: false };
  }
}

async function detectEditMode(page: Page): Promise<boolean> {
  // Check for edit mode indicators
  const editIndicators = [
    '#sqs-site-frame',        // Site iframe present = admin panel
    '[class*="editing"]',     // Edit mode classes
    'button:has-text("Done")',
    'button:has-text("Save")',
  ];

  for (const selector of editIndicators) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return true;
  }

  return false;
}

async function extractMainFrameElements(page: Page): Promise<ElementSummary[]> {
  try {
    return await page.evaluate((maxItems: number) => {
      const elements: Array<{
        tag: string;
        text: string;
        selector: string;
        ariaLabel?: string;
        type?: string;
      }> = [];

      // Interactive elements: buttons, links, inputs, selects
      const interactiveSelector = 'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"]';
      const interactiveEls = document.querySelectorAll(interactiveSelector);

      for (const el of interactiveEls) {
        if (elements.length >= maxItems) break;

        const htmlEl = el as HTMLElement;
        // Skip hidden elements
        if (htmlEl.offsetParent === null && htmlEl.style.display !== 'fixed') continue;

        const text = (htmlEl.textContent || htmlEl.getAttribute('value') || '').trim().substring(0, 100);
        if (!text && !htmlEl.getAttribute('aria-label')) continue;

        // Build a reasonable selector
        let selector = el.tagName.toLowerCase();
        if (el.id) {
          selector = `#${el.id}`;
        } else if (el.getAttribute('data-test')) {
          selector = `[data-test="${el.getAttribute('data-test')}"]`;
        } else if (el.getAttribute('aria-label')) {
          selector = `${el.tagName.toLowerCase()}[aria-label="${el.getAttribute('aria-label')}"]`;
        } else if (text) {
          selector = `${el.tagName.toLowerCase()}:has-text("${text.substring(0, 30)}")`;
        }

        elements.push({
          tag: el.tagName.toLowerCase(),
          text,
          selector,
          ariaLabel: htmlEl.getAttribute('aria-label') || undefined,
          type: (el as HTMLInputElement).type || undefined,
        });
      }

      return elements;
    }, MAX_INTERACTIVE_ITEMS);
  } catch (err) {
    logger.debug({ error: err }, 'Failed to extract main frame elements');
    return [];
  }
}

async function extractIframeElements(page: Page): Promise<ElementSummary[]> {
  try {
    const siteFrame = page.frame({ name: 'sqs-site-frame' }) ?? page.frames().find(f => f.url().includes('/config/'));
    if (!siteFrame) return [];

    return await siteFrame.evaluate((maxItems: number) => {
      const elements: Array<{
        tag: string;
        text: string;
        selector: string;
        ariaLabel?: string;
      }> = [];

      // Get visible text blocks + interactive elements (including Squarespace button blocks)
      const contentSelector = 'h1, h2, h3, h4, p, li, a[href], button, [class*="block"], [class*="section"], img[alt], [class*="button-element"], [class*="sqs-button"], .sqs-block-button-element';
      const contentEls = document.querySelectorAll(contentSelector);

      for (const el of contentEls) {
        if (elements.length >= maxItems) break;

        const htmlEl = el as HTMLElement;
        if (htmlEl.offsetParent === null) continue;

        const text = (htmlEl.textContent || htmlEl.getAttribute('alt') || '').trim().substring(0, 100);
        if (!text) continue;

        // Build selector for iframe elements
        let selector = el.tagName.toLowerCase();
        if (el.id) {
          selector = `#${el.id}`;
        } else if (el.getAttribute('data-block-type')) {
          selector = `[data-block-type="${el.getAttribute('data-block-type')}"]`;
        } else if (el.className && typeof el.className === 'string') {
          const firstClass = el.className.split(' ')[0];
          if (firstClass) selector = `.${firstClass}`;
        }

        elements.push({
          tag: el.tagName.toLowerCase(),
          text,
          selector,
          ariaLabel: htmlEl.getAttribute('aria-label') || undefined,
        });
      }

      return elements;
    }, MAX_TEXT_ITEMS);
  } catch (err) {
    logger.debug({ error: err }, 'Failed to extract iframe elements');
    return [];
  }
}

async function detectOpenPanels(page: Page): Promise<string[]> {
  const panels: string[] = [];

  const panelChecks: Array<[string, string]> = [
    ['[data-test="pages-panel"]', 'Pages panel'],
    ['[data-test="block-editor"]', 'Block editor'],
    ['[class*="BlockEditor"]', 'Block editor'],
    ['[class*="SectionToolbar"]', 'Section toolbar'],
    ['[class*="dialog"]', 'Dialog'],
    ['[role="dialog"]', 'Dialog'],
    ['[class*="modal"]', 'Modal'],
    ['[data-test="add-block"]', 'Add block panel'],
    ['[class*="fluid-engine"]', 'Section edit mode (fluid engine)'],
    ['[class*="block-toolbar"]', 'Block toolbar'],
    ['[class*="BlockToolbar"]', 'Block toolbar'],
  ];

  for (const [selector, name] of panelChecks) {
    const visible = await page.locator(selector).first().isVisible({ timeout: 500 }).catch(() => false);
    if (visible) panels.push(name);
  }

  return panels;
}
