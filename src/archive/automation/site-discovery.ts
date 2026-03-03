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

// Selectors that indicate site tiles have rendered on the dashboard.
// Tried in order; the first one that matches is used.
const SITE_TILE_WAIT_SELECTORS = [
  'a[href*=".squarespace.com/config"]',          // WEBSITE button links
  'a[href*=".squarespace.com"]',                  // any squarespace link
  '[data-test*="site"]',                           // data-test attributes (React test IDs)
  '[class*="SiteCard"]',                           // React component class names
  '[class*="site-card"]',                          // kebab-case variant
  '[class*="SiteList"]',                           // site list container
];

/**
 * Wait for the Squarespace dashboard to finish rendering site tiles.
 * Tries a sequence of selectors, falling back to a fixed timeout if none match.
 * Returns the selector that matched (for diagnostics) or null if none matched.
 */
async function waitForDashboardContent(page: Page): Promise<string | null> {
  // Try each selector with a short timeout — first match wins
  for (const selector of SITE_TILE_WAIT_SELECTORS) {
    try {
      await page.waitForSelector(selector, { timeout: 3000 });
      logger.info({ selector }, 'Dashboard content detected via selector');
      return selector;
    } catch {
      // Selector not found within timeout — try next
    }
  }

  // None of the known selectors matched — fall back to a generous fixed wait
  // to allow for unknown React rendering patterns
  logger.warn('No known site tile selectors matched — falling back to 8s fixed wait');
  await page.waitForTimeout(8000);
  return null;
}

/**
 * Detect if the page redirected to a login page instead of the account dashboard.
 * Returns a diagnostic object describing what was detected.
 */
async function detectLoginRedirect(page: Page): Promise<{ isLoginPage: boolean; url: string; title: string }> {
  const url = page.url();
  const title = await page.title();
  const isLoginPage =
    url.includes('/login') ||
    url.includes('/signin') ||
    url.includes('/authenticate') ||
    title.toLowerCase().includes('log in') ||
    title.toLowerCase().includes('sign in');
  return { isLoginPage, url, title };
}

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

  // Log the URL after navigation to detect redirects (e.g., to login page)
  const postNavUrl = page.url();
  logger.info({ url: postNavUrl }, 'Dashboard page loaded');

  // Check for login redirect before waiting for content
  const redirectCheck = await detectLoginRedirect(page);
  if (redirectCheck.isLoginPage) {
    logger.warn(
      { url: redirectCheck.url, title: redirectCheck.title },
      'Redirected to login page — not authenticated. Site discovery will return 0 sites.',
    );
    await takeScreenshot(page, 'dashboard-discovery-login-redirect');
    discoveredSitesCache = [];
    return [];
  }

  // Smart wait: try known selectors first, fall back to fixed timeout
  const matchedSelector = await waitForDashboardContent(page);

  await takeScreenshot(page, 'dashboard-discovery');

  // Scrape site tiles from the dashboard.
  // The Squarespace dashboard shows site cards with:
  // - A heading with the site name (e.g., "Smyth Tavern (Copy)")
  // - A domain text — either "xxx.squarespace.com" OR a custom domain like "timcox.co"
  // - Buttons like "WEBSITE" and "SELLING" that link to the site admin
  //
  // IMPORTANT: Sites with custom domains do NOT show their squarespace subdomain as text.
  // The subdomain is only in the WEBSITE button href. We must check links, not just text.
  // NOTE: No named functions or named const arrow functions inside page.evaluate()!
  // tsx uses esbuild with keepNames:true, which injects __name() wrappers that
  // don't exist in the browser context. All code must be anonymous/inline.
  const sites = await page.evaluate(() => {
    const results: Array<{ name: string; subdomain: string; customDomain?: string }> = [];
    const subdomainToCard = new Map<string, { link: Element; subdomain: string }>();

    // Selectors tried in order; first non-empty result wins
    const selectors = [
      'a[href*=".squarespace.com"]',
      'a[href*="/config/"]',
      '[data-test*="site"] a[href]',
      '[class*="SiteCard"] a[href]',
      '[class*="site-card"] a[href]',
      '[class*="Site"] a[href*="squarespace"]',
      '[class*="site"] a[href*="squarespace"]',
    ];

    for (let si = 0; si < selectors.length; si++) {
      // After strategy 1 succeeds, skip fallbacks
      if (si > 0 && subdomainToCard.size > 0) break;

      const links = document.querySelectorAll(selectors[si]);
      for (const link of links) {
        const href = link.getAttribute('href') ?? '';
        if (href.includes('login.squarespace') || href.includes('account.squarespace')
          || href.includes('support.squarespace') || href.includes('squarespace.com/pricing')
          || href.includes('squarespace.com/templates') || href.includes('squarespace.com/blog')
          || href.includes('help.squarespace') || href.includes('forum.squarespace')) continue;
        const m = href.match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i);
        if (m && !subdomainToCard.has(m[1])) {
          subdomainToCard.set(m[1], { link, subdomain: m[1] });
        }
      }
    }

    // ── Name extraction ────────────────────────────────────────────────────
    const SKIP_TEXT = /^(website|selling|domains|go to website|google workspace|manage site|edit site|open site|view site|get started|settings|create website|upgrade|dismiss|dashboard)$/i;
    const SKIP_CONTENT = /(trial expires|renews on|expires on|days? left|\.squarespace\.com|create website)/i;

    for (const [subdomain, { link }] of subdomainToCard) {
      let name = '';
      let customDomain: string | undefined;

      // Walk up from the link to find the site card container
      let container = link.parentElement;
      for (let depth = 0; depth < 10 && container; depth++) {
        const children = Array.from(container.children);
        if (children.length < 2) { container = container.parentElement; continue; }

        // PRIORITY 1: Headings
        const heading = container.querySelector('h1, h2, h3, h4, h5, [class*="title"], [class*="name"], [class*="heading"], [class*="Title"], [class*="Name"]');
        if (heading) {
          const ht = heading.textContent?.trim() ?? '';
          if (ht && ht.length > 1 && ht.length < 80
            && ht !== 'Dashboard' && !SKIP_TEXT.test(ht) && !SKIP_CONTENT.test(ht)) {
            name = ht;
          }
        }

        // PRIORITY 2: Scan children for name-like text and custom domain
        for (const child of children) {
          const text = child.textContent?.trim() ?? '';
          if (!text || text.length > 100) continue;
          if (SKIP_TEXT.test(text)) continue;
          if (SKIP_CONTENT.test(text)) continue;
          if (child.querySelector('a, button') && !child.querySelector('h1, h2, h3, h4, h5')) continue;
          if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text) && !text.includes('.squarespace.')) {
            customDomain = text;
            continue;
          }
          if (!name && text.length > 1 && text.length < 80) name = text;
        }

        if (name) break;
        container = container.parentElement;
      }

      // Fallback: headings further up the tree
      if (!name) {
        let hc = link.parentElement;
        for (let i = 0; i < 6 && hc; i++) {
          const h = hc.querySelector('h1, h2, h3, h4, h5');
          const ht = h?.textContent?.trim();
          if (ht && ht !== 'Dashboard' && !SKIP_TEXT.test(ht) && !SKIP_CONTENT.test(ht)) {
            name = ht; break;
          }
          hc = hc.parentElement;
        }
      }

      // Last resort: derive name from subdomain ("smyth-tavern" → "Smyth Tavern")
      if (!name) {
        name = subdomain.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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
    // ── Extensive diagnostics when no sites found ─────────────────────────
    await takeScreenshot(page, 'dashboard-discovery-zero-sites');

    const diagnostics = await page.evaluate(() => {
      const pageTitle = document.title;
      const totalAnchors = document.querySelectorAll('a').length;
      const squarespaceAnchors = document.querySelectorAll('a[href*="squarespace"]').length;
      const hasSquarespaceText = document.body?.textContent?.includes('.squarespace.com') ?? false;
      const hasConfigLinks = document.querySelectorAll('a[href*="/config/"]').length;
      const hasSiteTestAttrs = document.querySelectorAll('[data-test*="site"]').length;
      const hasSiteClassElements = document.querySelectorAll('[class*="site"], [class*="Site"]').length;

      // Sample first few anchor hrefs for debugging
      const sampleHrefs: string[] = [];
      const anchors = document.querySelectorAll('a[href]');
      for (let i = 0; i < Math.min(anchors.length, 10); i++) {
        sampleHrefs.push(anchors[i].getAttribute('href') ?? '');
      }

      // Check for common empty/error states
      const bodyText = document.body?.textContent?.substring(0, 500) ?? '';

      return {
        pageTitle,
        totalAnchors,
        squarespaceAnchors,
        hasSquarespaceText,
        hasConfigLinks,
        hasSiteTestAttrs,
        hasSiteClassElements,
        sampleHrefs,
        bodyTextPreview: bodyText.replace(/\s+/g, ' ').trim().substring(0, 300),
      };
    });

    logger.warn(
      {
        url: page.url(),
        matchedSelector,
        ...diagnostics,
      },
      'Zero sites discovered — diagnostic dump. Check dashboard-discovery-zero-sites screenshot.',
    );
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
