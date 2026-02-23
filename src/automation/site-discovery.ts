import { Page } from 'playwright';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshot.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveredSite {
  /** Display name from the dashboard tile, e.g. "Smyth Tavern" */
  name: string;
  /** Subdomain extracted from URL, e.g. "smyth-tavern" */
  subdomain: string;
  /** Full admin URL, e.g. "https://smyth-tavern.squarespace.com/config/website" */
  adminUrl: string;
  /** Custom domain if shown on the dashboard tile */
  customDomain?: string;
}

// ─── In-Memory Cache ────────────────────────────────────────────────────────────

let discoveredSitesCache: DiscoveredSite[] | null = null;

export function getDiscoveredSites(): DiscoveredSite[] | null {
  return discoveredSitesCache;
}

export function clearDiscoveredSitesCache(): void {
  discoveredSitesCache = null;
}

// ─── Dashboard Scraping ─────────────────────────────────────────────────────────

const ACCOUNT_URL = 'https://account.squarespace.com/';

/**
 * Navigate to the Squarespace account dashboard and discover all accessible sites.
 *
 * Caches results in memory for the session. Returns cached results on
 * subsequent calls unless `force` is true.
 */
export async function discoverSites(
  page: Page,
  options?: { force?: boolean },
): Promise<DiscoveredSite[]> {
  if (discoveredSitesCache && !options?.force) {
    logger.info({ count: discoveredSitesCache.length }, 'Returning cached discovered sites');
    return discoveredSitesCache;
  }

  logger.info('Navigating to account dashboard to discover sites');
  await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000); // Wait for React to render site tiles

  await takeScreenshot(page, 'dashboard-discovery');

  // Scrape site tiles from the dashboard.
  // The Squarespace dashboard shows site cards with:
  // - A heading with the site name (e.g., "Smyth Tavern (Copy)")
  // - A domain text — either "xxx.squarespace.com" OR a custom domain like "timcox.co"
  // - Buttons like "WEBSITE" and "SELLING" that link to the site admin
  //
  // IMPORTANT: Sites with custom domains do NOT show their squarespace subdomain as text.
  // The subdomain is only in the WEBSITE button href. We must check links, not just text.
  const sites = await page.evaluate(() => {
    const results: Array<{ name: string; subdomain: string; customDomain?: string }> = [];

    // Primary strategy: Find all links to *.squarespace.com (covers ALL sites)
    // This catches both sites with subdomains shown as text AND sites with custom domains.
    const siteLinks = document.querySelectorAll('a[href*=".squarespace.com"]');
    const subdomainToCard = new Map<string, { link: Element; subdomain: string }>();

    for (const link of siteLinks) {
      const href = link.getAttribute('href') ?? '';
      // Skip non-site links
      if (
        href.includes('login.squarespace') ||
        href.includes('account.squarespace') ||
        href.includes('support.squarespace') ||
        href.includes('squarespace.com/pricing')
      ) {
        continue;
      }

      const match = href.match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i);
      if (!match) continue;
      const subdomain = match[1];

      if (!subdomainToCard.has(subdomain)) {
        subdomainToCard.set(subdomain, { link, subdomain });
      }
    }

    // Patterns that indicate button/navigation text, NOT site names
    const SKIP_TEXT = /^(website|selling|domains|go to website|google workspace|manage site|edit site|open site|view site|get started|settings|create website|upgrade|dismiss)$/i;
    const SKIP_CONTENT = /(trial expires|renews on|expires on|days? left|\.squarespace\.com)/i;

    for (const [subdomain, { link }] of subdomainToCard) {
      let name = '';
      let customDomain: string | undefined;

      // Walk up from the link to find the site card container.
      // Look for the site name and optional custom domain text.
      let container = link.parentElement;
      for (let depth = 0; depth < 10 && container; depth++) {
        const children = Array.from(container.children);

        // A card typically has: name div, domain text, buttons div — at least 2 children
        if (children.length < 2) {
          container = container.parentElement;
          continue;
        }

        // PRIORITY 1: Look for headings — most reliable site name source
        const heading = container.querySelector('h1, h2, h3, h4, h5, [class*="title"], [class*="name"], [class*="heading"]');
        if (heading) {
          const headingText = heading.textContent?.trim() ?? '';
          if (headingText && headingText.length > 1 && headingText.length < 80
            && headingText !== 'Dashboard'
            && !SKIP_TEXT.test(headingText)
            && !SKIP_CONTENT.test(headingText)) {
            name = headingText;
          }
        }

        // PRIORITY 2: Scan children for name-like text and custom domain
        for (const child of children) {
          const text = child.textContent?.trim() ?? '';
          if (!text || text.length > 100) continue;

          // Skip button labels, navigation text, and subscription info
          if (SKIP_TEXT.test(text)) continue;
          if (SKIP_CONTENT.test(text)) continue;

          // Skip if this child contains a link/button (likely a button container)
          if (child.querySelector('a, button') && !child.querySelector('h1, h2, h3, h4, h5')) continue;

          // Check if this looks like a custom domain (contains a dot, no spaces)
          if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text) && !text.includes('.squarespace.')) {
            customDomain = text;
            continue;
          }

          // If no heading-based name found, use first reasonable text
          if (!name && text.length > 1 && text.length < 80) {
            name = text;
          }
        }

        if (name) break;
        container = container.parentElement;
      }

      // Fallback: look for headings further up the tree
      if (!name) {
        let headingContainer = link.parentElement;
        for (let i = 0; i < 6 && headingContainer; i++) {
          const heading = headingContainer.querySelector('h1, h2, h3, h4, h5');
          const headingText = heading?.textContent?.trim();
          if (headingText && headingText !== 'Dashboard'
            && !SKIP_TEXT.test(headingText)
            && !SKIP_CONTENT.test(headingText)) {
            name = headingText;
            break;
          }
          headingContainer = headingContainer.parentElement;
        }
      }

      if (name && !results.some((r) => r.subdomain === subdomain)) {
        results.push({ name, subdomain, customDomain });
      }
    }

    return results;
  });

  // Parse into DiscoveredSite objects
  const discovered: DiscoveredSite[] = sites.map((s) => ({
    name: s.name,
    subdomain: s.subdomain,
    adminUrl: `https://${s.subdomain}.squarespace.com/config/website`,
    customDomain: s.customDomain,
  }));

  logger.info(
    { count: discovered.length, sites: discovered.map((s) => `${s.name} (${s.subdomain})`) },
    'Discovered sites from dashboard',
  );

  if (discovered.length === 0) {
    logger.warn('No sites discovered from dashboard — selectors may need updating. Check dashboard-discovery screenshot.');
  }

  discoveredSitesCache = discovered;
  return discovered;
}

// ─── Matching ───────────────────────────────────────────────────────────────────

/**
 * Normalize a string for fuzzy matching: lowercase, replace hyphens/underscores
 * with spaces, collapse whitespace, strip common suffixes like "(copy)".
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[-_]/g, ' ')       // "smyth-tavern" → "smyth tavern"
    .replace(/\s*\(copy\)\s*/g, '') // "Smyth Tavern (Copy)" → "Smyth Tavern"
    .replace(/\s+/g, ' ')        // collapse whitespace
    .trim();
}

/**
 * Find a discovered site by flexible matching against a search term.
 * Matches against: subdomain, name (exact), name (partial), subdomain (partial).
 * Normalizes hyphens/underscores to spaces so "smyth-tavern" matches "Smyth Tavern".
 */
export function findDiscoveredSite(
  sites: DiscoveredSite[],
  searchTerm: string,
): DiscoveredSite | undefined {
  const lower = searchTerm.toLowerCase().trim();
  const normalized = normalize(searchTerm);

  // 1. Exact match on subdomain (most common — siteId is usually the subdomain slug)
  const bySubdomain = sites.find((s) => s.subdomain.toLowerCase() === lower);
  if (bySubdomain) return bySubdomain;

  // 2. Exact match on name (case-insensitive)
  const byName = sites.find((s) => s.name.toLowerCase() === lower);
  if (byName) return byName;

  // 3. Exact match on custom domain (e.g., "timcox.co")
  const byDomain = sites.find((s) => s.customDomain?.toLowerCase() === lower);
  if (byDomain) return byDomain;

  // 4. Normalized exact match on name (hyphens → spaces, strip "(copy)")
  const byNormalizedName = sites.find((s) => normalize(s.name) === normalized);
  if (byNormalizedName) return byNormalizedName;

  // 5. Partial match on name (e.g., "smyth" matches "Smyth Tavern")
  const byPartialName = sites.find((s) => s.name.toLowerCase().includes(lower));
  if (byPartialName) return byPartialName;

  // 6. Normalized partial match (e.g., "smyth tavern" in "smyth tavern copy edition")
  const byNormalizedPartial = sites.find((s) => normalize(s.name).includes(normalized));
  if (byNormalizedPartial) return byNormalizedPartial;

  // 7. Partial match on subdomain (e.g., "smyth" matches "smyth-tavern")
  const byPartialSubdomain = sites.find((s) => s.subdomain.toLowerCase().includes(lower));
  if (byPartialSubdomain) return byPartialSubdomain;

  // 8. Partial match on custom domain (e.g., "timcox" matches "timcox.co")
  const byPartialDomain = sites.find((s) => s.customDomain?.toLowerCase().includes(lower));
  if (byPartialDomain) return byPartialDomain;

  // 9. Search term contains subdomain (e.g., "smyth-tavern-test" contains "smyth")
  const byReverse = sites.find((s) => lower.includes(s.subdomain.toLowerCase()));
  if (byReverse) return byReverse;

  return undefined;
}
