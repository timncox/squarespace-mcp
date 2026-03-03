/**
 * URL Researcher — visits user-provided URLs to extract title, description,
 * and a screenshot for each project.
 *
 * Used when Tim's request contains URLs (e.g., "add these 8 project URLs to
 * the Coding Projects page"). Instead of web-searching, we visit each URL
 * directly and gather real metadata.
 *
 * Uses its own headless Playwright browser (separate from the editing browser).
 */

import { chromium, type Browser } from 'playwright';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UrlResearchResult {
  url: string;
  title: string;
  description: string;
  screenshotPath?: string;
}

// ─── Main ───────────────────────────────────────────────────────────────────

/** How many URLs to visit concurrently */
const CONCURRENCY = 3;
/** Timeout per URL in milliseconds */
const URL_TIMEOUT_MS = 15_000;

/**
 * Visit a list of URLs and extract title, description, and a screenshot.
 *
 * @param urls — The URLs to visit
 * @param screenshotDir — Directory to save screenshots into (created if missing)
 * @returns One result per URL (always returns an entry, even on failure)
 */
export async function visitProjectUrls(
  urls: string[],
  screenshotDir: string,
): Promise<UrlResearchResult[]> {
  const start = Date.now();

  // Ensure screenshot directory exists
  mkdirSync(screenshotDir, { recursive: true });

  // Launch a separate headless browser
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });

    const results: UrlResearchResult[] = [];

    // Process URLs in batches of CONCURRENCY
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = urls.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((url, idx) => visitSingleUrl(browser!, url, screenshotDir, i + idx)),
      );
      results.push(...batchResults);
    }

    const durationMs = Date.now() - start;
    logger.info(
      { urlCount: urls.length, successCount: results.filter(r => r.title !== 'Untitled Project').length, durationMs },
      'URL researcher: done visiting project URLs',
    );

    return results;
  } catch (err) {
    logger.error({ error: errMsg(err) }, 'URL researcher: browser launch failed');
    // Return placeholder results for all URLs
    return urls.map((url) => ({
      url,
      title: extractFallbackTitle(url),
      description: `Project at ${url}`,
    }));
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

async function visitSingleUrl(
  browser: Browser,
  url: string,
  screenshotDir: string,
  index: number,
): Promise<UrlResearchResult> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  try {
    logger.info({ url, index }, 'URL researcher: visiting');

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: URL_TIMEOUT_MS,
    });

    // Wait a bit for JS-rendered content (many Lovable/Vite apps render client-side)
    await page.waitForTimeout(3000);

    // Extract metadata
    const metadata = await page.evaluate(() => {
      const title = document.title?.trim() || '';

      // Try meta description
      const metaDesc = document.querySelector('meta[name="description"]');
      const ogDesc = document.querySelector('meta[property="og:description"]');
      const description =
        (metaDesc as HTMLMetaElement)?.content?.trim() ||
        (ogDesc as HTMLMetaElement)?.content?.trim() ||
        '';

      // Fallback: first visible h1 + first p
      let fallbackTitle = '';
      let fallbackDesc = '';
      const h1 = document.querySelector('h1');
      if (h1) {
        fallbackTitle = h1.textContent?.trim() || '';
      }
      const firstP = document.querySelector('p');
      if (firstP) {
        fallbackDesc = firstP.textContent?.trim()?.substring(0, 200) || '';
      }

      return { title, description, fallbackTitle, fallbackDesc };
    });

    // Pick the best title
    let title = metadata.title;
    if (!title || title === 'Vite + React + TS' || title === 'Vite App' || title === 'React App') {
      // Generic framework titles — use the fallback h1 or URL-derived name
      title = metadata.fallbackTitle || extractFallbackTitleFromUrl(url);
    }

    // Pick the best description
    let description = metadata.description;
    if (!description) {
      description = metadata.fallbackDesc || `Web application at ${url}`;
    }

    // Take a screenshot
    const safeFilename = `url-research-${index}-${Date.now()}.jpg`;
    const screenshotPath = join(screenshotDir, safeFilename);
    await page.screenshot({
      path: screenshotPath,
      type: 'jpeg',
      quality: 70,
      fullPage: false,
    });

    logger.info({ url, title, descLength: description.length }, 'URL researcher: extracted metadata');

    return { url, title, description, screenshotPath };
  } catch (err) {
    logger.warn(
      { url, error: errMsg(err) },
      'URL researcher: failed to visit URL',
    );
    return {
      url,
      title: extractFallbackTitle(url),
      description: `Project at ${url}`,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Extract a readable project name from a URL.
 * e.g., "https://menu-block.lovable.app/" → "Menu Block"
 */
function extractFallbackTitle(url: string): string {
  return extractFallbackTitleFromUrl(url);
}

function extractFallbackTitleFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // Take the first part of the hostname (before the first dot)
    const subdomain = hostname.split('.')[0];
    // Convert kebab-case to Title Case
    return subdomain
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  } catch {
    return 'Untitled Project';
  }
}
