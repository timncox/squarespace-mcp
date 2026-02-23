import { Page } from 'playwright';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SitesConfig, ClientConfig, findClientByName } from '../models/site-config.js';
import { takeScreenshot } from '../utils/screenshot.js';
import { logger } from '../utils/logger.js';
import { discoverSites, findDiscoveredSite, getDiscoveredSites } from './site-discovery.js';

let configCache: SitesConfig | null = null;

export function loadSitesConfig(): SitesConfig {
  if (configCache) return configCache;
  const filepath = join(process.cwd(), 'config', 'sites.json');
  const raw = readFileSync(filepath, 'utf-8');
  configCache = JSON.parse(raw) as SitesConfig;
  return configCache;
}

export function clearConfigCache(): void {
  configCache = null;
}

/**
 * Navigate to a specific site's admin panel.
 * Admin URL pattern: https://<site-subdomain>.squarespace.com/config/website
 */
export async function navigateToSite(
  page: Page,
  client: ClientConfig,
): Promise<void> {
  const adminUrl = client.site.adminUrl;
  logger.info({ site: client.name, adminUrl }, 'Navigating to site admin');

  // Go directly to the site's admin panel
  await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for the admin panel to load
  await page.waitForTimeout(3000);

  // Verify we're on the right site
  const currentUrl = page.url();
  if (currentUrl.includes('login.squarespace.com')) {
    throw new Error('Session expired during navigation — need to re-login');
  }

  // Check for "No Permissions" page — means the agent account doesn't have access
  const noPermissions = await page.evaluate(() => {
    const body = document.body?.textContent ?? '';
    return body.includes('No Permissions') || body.includes('You do not have permission');
  });
  if (noPermissions) {
    throw new Error(
      `No Permissions: The agent account does not have access to "${client.name}" (${adminUrl}). ` +
      `Invite the agent account as a contributor in Squarespace Settings > Permissions.`,
    );
  }

  logger.info({ site: client.name, url: currentUrl }, 'Arrived at site admin');
  await takeScreenshot(page, `site-nav-${client.id}`);
}

/**
 * Convert a URL slug to a human-readable title.
 * e.g., "menus" → "Menus", "private-events" → "Private Events"
 */
function slugToTitle(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Navigate to a specific page within the site using the admin panel.
 *
 * Strategy: We're already on the admin panel (from navigateToSite).
 * 1. Open the Pages panel using the admin URL: /config/pages
 * 2. Find the target page item using data-test="pages-panel-item"
 * 3. Click it to open the page in the admin preview
 *
 * This works reliably because direct URL navigation to pages on the
 * Squarespace subdomain can redirect to the dashboard instead of
 * showing the page with the admin toolbar.
 */
export async function navigateToPage(
  page: Page,
  client: ClientConfig,
  pageSlug: string,
): Promise<void> {
  logger.info({ site: client.name, page: pageSlug }, 'Navigating to page via admin panel');

  // Normalize homepage variants — Squarespace labels the home page as "Home",
  // but requests often say "homepage", "home-page", "landing", etc.
  const HOME_SLUGS = ['homepage', 'home-page', 'home', 'landing', 'index', 'main'];
  const isHomePage = HOME_SLUGS.includes(pageSlug.toLowerCase());
  const normalizedSlug = isHomePage ? 'home' : pageSlug;

  // Look up the page title from the site config.
  // If no config exists (dynamically discovered site), derive from slug.
  const pageConfig = client.site.pages.find(
    (p) => p.slug === normalizedSlug || (isHomePage && p.slug === pageSlug),
  );
  const pageTitle = pageConfig?.title ?? (isHomePage ? 'Home' : slugToTitle(pageSlug));
  logger.info({ pageSlug, pageTitle }, 'Looking for page in admin');

  // Step 1: Navigate to the Pages panel directly via URL.
  // This is more reliable than clicking sidebar links which may toggle.
  const adminUrl = client.site.adminUrl;
  const configIndex = adminUrl.indexOf('/config');
  const siteBaseUrl = configIndex !== -1 ? adminUrl.substring(0, configIndex) : adminUrl;
  const pagesUrl = `${siteBaseUrl}/config/pages`;

  logger.info({ pagesUrl }, 'Navigating to pages panel');
  await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for the React page list to render.
  // The pages-panel-item elements take several seconds to appear after
  // the initial DOM load. Wait for at least one to appear, with a
  // generous timeout, falling back to a fixed wait.
  try {
    await page.locator('[data-test="pages-panel-item"]').first().waitFor({
      state: 'visible',
      timeout: 15000,
    });
    logger.info('Pages panel items loaded');
  } catch {
    logger.warn('Pages panel items not detected — continuing with fixed wait');
    await page.waitForTimeout(5000);
  }

  await takeScreenshot(page, `pages-panel-${client.id}`);

  // Step 2: Find the target page in the pages list and click it.
  // Squarespace page items have data-test="pages-panel-item" and contain
  // a <P> with the page title text.
  //
  // We use page.evaluate() to find and click the element via JavaScript
  // because Playwright's :has-text() compound selector can be unreliable
  // when the admin panel contains an iframe (sqs-site-frame) with
  // overlapping text content.
  //
  // Matching is case-insensitive to handle dynamically discovered sites
  // where the slug-to-title conversion may not match the exact casing.
  const clicked = await page.evaluate(({ title, isHome }) => {
    const lowerTitle = title.toLowerCase();
    const items = document.querySelectorAll('[data-test="pages-panel-item"]');

    // Exact match (case-insensitive)
    for (const item of items) {
      if (item.textContent?.trim().toLowerCase() === lowerTitle) {
        (item as HTMLElement).click();
        return true;
      }
    }
    // Relaxed match: contains the title (case-insensitive)
    for (const item of items) {
      if (item.textContent?.toLowerCase().includes(lowerTitle)) {
        (item as HTMLElement).click();
        return true;
      }
    }
    // Home page fallback: look for the home icon (house SVG) or any item
    // whose text is just "Home" — Squarespace often puts the home page
    // in the "Not Linked" section with a house icon.
    if (isHome) {
      for (const item of items) {
        const text = item.textContent?.trim().toLowerCase() ?? '';
        // Match "Home" in various forms (may have extra whitespace from icons)
        if (text === 'home' || text.startsWith('home') && text.length < 10) {
          (item as HTMLElement).click();
          return true;
        }
      }
      // Last resort: look for SVG home icon within page items
      for (const item of items) {
        if (item.querySelector('svg[data-icon="home"], svg.home-icon, [class*="home"]')) {
          (item as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  }, { title: pageTitle, isHome: isHomePage });

  if (clicked) {
    logger.info({ pageTitle }, 'Clicked page in pages list');
  } else {
    await takeScreenshot(page, `page-not-found-${client.id}-${pageSlug}`);
    throw new Error(
      `Could not find page "${pageTitle}" (slug: ${pageSlug}) in the pages list`,
    );
  }

  // Wait for the page preview to load
  await page.waitForTimeout(3000);
  await takeScreenshot(page, `page-nav-${client.id}-${pageSlug}`);
}

/**
 * Enter the page editor (Fluid Engine) on the current page.
 * Assumes we've already selected a page in the admin panel.
 *
 * In the Squarespace admin, after clicking a page in the Pages list,
 * you'll see a page preview or settings. We look for the Edit button
 * to enter the Fluid Engine editor. Multiple selector strategies are
 * tried since Squarespace's UI varies.
 */
export async function enterEditMode(page: Page): Promise<void> {
  logger.info('Entering edit mode');

  // Try multiple selectors for the Edit button.
  // Squarespace uses different edit buttons in different contexts:
  // - "EDIT SITE" button on the dashboard
  // - "Edit" button on individual page views
  // - Edit icon button in the admin toolbar
  const editSelectors = [
    'button:has-text("Edit")',
    'a:has-text("Edit")',
    'button:has-text("EDIT")',
    '[data-test="edit-page"]',
    '[aria-label="Edit"]',
    'button:has-text("EDIT SITE")',
    'a:has-text("EDIT SITE")',
  ];

  let clicked = false;
  for (const selector of editSelectors) {
    const btn = page.locator(selector).first();
    const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await btn.click();
      logger.info({ selector }, 'Clicked Edit button');
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    logger.warn('No Edit button found — may already be in edit mode or admin UI has changed');
    await takeScreenshot(page, 'edit-button-not-found');
  }

  // Wait for the editor to initialize
  await page.waitForTimeout(3000);
  await takeScreenshot(page, 'edit-mode');
}

/**
 * Resolve a site identifier (name, alias, or ID) to a ClientConfig.
 *
 * Resolution order:
 * 1. Dashboard discovery (preferred) — only returns sites the agent account
 *    actually has access to. This prevents navigating to production sites
 *    that are in static config but not shared with the agent account.
 * 2. Static config (sites.json) — fallback when dashboard is unavailable
 * 3. Throws if not found in either source
 *
 * When a dashboard match is found AND a matching static config entry exists
 * (by subdomain), the static config metadata (pages, aliases, contact emails)
 * is merged with the dashboard-discovered admin URL. This gives us accurate
 * URLs + rich metadata.
 */
export async function resolveSite(
  siteIdentifier: string,
  page?: Page,
): Promise<ClientConfig> {
  const config = loadSitesConfig();

  // 1. Try dashboard discovery first — these are sites the agent can actually access
  if (page) {
    const discovered = await discoverSites(page);
    const match = findDiscoveredSite(discovered, siteIdentifier);

    if (match) {
      // Look for a static config entry that enriches this discovered site.
      // Match by name/alias (not subdomain, since the test site has a different subdomain).
      const staticClient = findClientByName(config, siteIdentifier);

      if (staticClient) {
        // Merge: use the discovered admin URL (correct for the agent account)
        // but keep the rich metadata from static config (pages, aliases, etc.)
        logger.info(
          { siteId: staticClient.id, discoveredSubdomain: match.subdomain, source: 'discovery+config' },
          'Site resolved from dashboard, enriched with static config metadata',
        );
        return {
          ...staticClient,
          id: match.subdomain,
          name: match.name,
          site: {
            ...staticClient.site,
            adminUrl: match.adminUrl,
            customDomain: match.customDomain,
          },
        };
      }

      // No static config — create a minimal ClientConfig from discovered data
      logger.info(
        { name: match.name, subdomain: match.subdomain, source: 'discovery' },
        'Site resolved from dashboard discovery (no config entry)',
      );
      return {
        id: match.subdomain,
        name: match.name,
        aliases: [],
        contactEmails: [],
        site: {
          adminUrl: match.adminUrl,
          customDomain: match.customDomain,
          pages: [],
        },
      };
    }
  }

  // 2. Fallback: static config only (dashboard unavailable or site not found there)
  const staticClient = findClientByName(config, siteIdentifier);
  if (staticClient) {
    logger.warn(
      { siteId: staticClient.id, source: 'config-only' },
      'Site resolved from static config only — agent may not have access',
    );
    return staticClient;
  }

  // 3. Not found in either source
  const knownNames = config.clients.map((c) => c.name);
  const discoveredNames = getDiscoveredSites()?.map((s) => s.name) ?? [];
  const allNames = [...new Set([...knownNames, ...discoveredNames])];

  throw new Error(
    `Unknown site: "${siteIdentifier}". Known sites: ${allNames.join(', ')}`,
  );
}
