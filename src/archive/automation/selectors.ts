import { Page, Locator } from 'playwright';
import { readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshot.js';

type SelectorMap = Record<string, Record<string, string[]>>;

let selectorsCache: SelectorMap | null = null;

function loadSelectors(): SelectorMap {
  if (selectorsCache) return selectorsCache;
  const filepath = join(process.cwd(), 'config', 'squarespace-selectors.json');
  const raw = readFileSync(filepath, 'utf-8');
  selectorsCache = JSON.parse(raw) as SelectorMap;
  return selectorsCache;
}

/** Clear cached selectors (useful for testing or after config changes). */
export function clearSelectorCache(): void {
  selectorsCache = null;
}

/**
 * Get the selector strings for a given key like "login.emailInput".
 * Returns an array of fallback selectors to try in order.
 */
export function getSelectors(key: string): string[] {
  const selectors = loadSelectors();
  const [group, name] = key.split('.');
  const groupMap = selectors[group];
  if (!groupMap) {
    throw new Error(`Selector group "${group}" not found in config`);
  }
  const selectorList = groupMap[name];
  if (!selectorList) {
    throw new Error(`Selector "${name}" not found in group "${group}"`);
  }
  return selectorList;
}

/**
 * Find the first visible element matching any of the fallback selectors for the given key.
 * Tries each selector in order, returns the first visible match.
 */
export async function findElement(
  page: Page,
  selectorKey: string,
  options: { timeout?: number } = {},
): Promise<Locator> {
  const { timeout = 3000 } = options;
  const selectors = getSelectors(selectorKey);

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      const visible = await locator.isVisible({ timeout });
      if (visible) {
        logger.debug({ selectorKey, matchedSelector: selector }, 'Selector matched');
        return locator;
      }
    } catch {
      // Selector didn't match within timeout, try next
    }
  }

  // None matched — take a diagnostic screenshot
  const screenshotPath = await takeScreenshot(page, `selector-miss-${selectorKey.replace('.', '-')}`);
  const error = new Error(
    `No element found for "${selectorKey}". Tried: ${selectors.join(', ')}. Screenshot: ${screenshotPath}`,
  );
  logger.error({ selectorKey, selectors, screenshotPath }, error.message);
  throw error;
}

/**
 * Wait for an element matching the selector key to appear, then return it.
 */
export async function waitForElement(
  page: Page,
  selectorKey: string,
  options: { timeout?: number; state?: 'visible' | 'attached' } = {},
): Promise<Locator> {
  const { timeout = 10000, state = 'visible' } = options;
  const selectors = getSelectors(selectorKey);

  // Create a race: whichever selector appears first wins
  const racePromises = selectors.map(async (selector) => {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state, timeout });
    return { locator, selector };
  });

  try {
    const winner = await Promise.any(racePromises);
    logger.debug({ selectorKey, matchedSelector: winner.selector }, 'Selector appeared');
    return winner.locator;
  } catch {
    const screenshotPath = await takeScreenshot(page, `wait-miss-${selectorKey.replace('.', '-')}`);
    throw new Error(
      `Timeout waiting for "${selectorKey}". Tried: ${selectors.join(', ')}. Screenshot: ${screenshotPath}`,
    );
  }
}
