/**
 * MCP Server Session Management
 *
 * Manages shared ContentSaveClient and MediaUploadClient instances per site.
 * Maps siteId (e.g., "smyth-tavern") to subdomain (e.g., "grey-yellow-hbxc")
 * using config/sites.json (optional) merged with auto-discovered sites from SQLite.
 *
 * Flexible matching: accepts site ID, name, alias, or subdomain.
 */

import { createContentSaveClient } from '../services/content-save.js';
import { ContentSaveClient, SESSION_PATH } from '../services/content-save.js';
import { MediaUploadClient } from '../services/media-upload.js';
import { resolvePageIds as resolvePageIdsImpl } from '../services/page-id-resolver.js';
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/database.js';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

// ── Types ───────────────────────────────────────────────────────────────────

interface SiteConfig {
  id: string;
  name?: string;
  aliases?: string[];
  site: {
    adminUrl: string;
    customDomain?: string;
  };
}

interface SitesConfig {
  clients: SiteConfig[];
}

// ── State ───────────────────────────────────────────────────────────────────

const clientCache = new Map<string, ContentSaveClient>();
const mediaClientCache = new Map<string, MediaUploadClient>();
let sitesConfig: SitesConfig | null = null;
let sitesConfigMtime: number = 0;
let accountSitesFetched = false;
let discoveryPromise: Promise<void> | null = null;

// ── Config Loading ──────────────────────────────────────────────────────────

/**
 * Load sites config from a specific path with mtime-based caching.
 * Exported for testing — production code uses loadSitesConfig().
 */
export function _loadSitesConfigFromPath(configPath: string): SitesConfig {
  try {
    const mtime = statSync(configPath).mtimeMs;
    if (sitesConfig && mtime === sitesConfigMtime) return sitesConfig;

    const raw = readFileSync(configPath, 'utf-8');
    sitesConfig = JSON.parse(raw) as SitesConfig;
    sitesConfigMtime = mtime;
    logger.info({ configPath, clients: sitesConfig.clients.length }, 'Sites config loaded');
  } catch {
    if (!sitesConfig) sitesConfig = { clients: [] };
  }
  return sitesConfig;
}

function loadSitesConfig(): SitesConfig {
  const configPath = process.env.SITES_CONFIG || join(process.cwd(), 'config', 'sites.json');
  return _loadSitesConfigFromPath(configPath);
}

/**
 * Load auto-discovered sites from the SQLite database.
 * Converts rows to SiteConfig format for seamless merging.
 */
export function loadDiscoveredSites(): SiteConfig[] {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM discovered_sites').all() as any[];
    return rows.map(row => ({
      id: row.subdomain,
      name: row.site_title || row.subdomain,
      site: {
        adminUrl: row.admin_url,
        customDomain: row.custom_domain || undefined,
      },
    }));
  } catch {
    return [];
  }
}

/**
 * Save a discovered site to the SQLite database.
 * Upserts: updates title/domain/last_verified if the subdomain already exists.
 */
export function saveSite(subdomain: string, siteTitle?: string, customDomain?: string): void {
  const db = getDb();
  const adminUrl = `https://${subdomain}.squarespace.com`;
  db.prepare(`
    INSERT INTO discovered_sites (subdomain, site_title, admin_url, custom_domain, discovered_at, last_verified_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(subdomain) DO UPDATE SET
      site_title = COALESCE(excluded.site_title, site_title),
      custom_domain = COALESCE(excluded.custom_domain, custom_domain),
      last_verified_at = datetime('now')
  `).run(subdomain, siteTitle || null, adminUrl, customDomain || null);
}

/**
 * Capture site-specific cookies (member-session + crumb) for a newly discovered site.
 * Fetches a site-scoped API endpoint using account-level cookies, which triggers
 * Squarespace to return site-specific Set-Cookie headers. Best-effort — failures
 * are logged but never block discovery.
 */
async function captureSiteCookies(subdomain: string): Promise<void> {
  try {
    if (!existsSync(SESSION_PATH)) return;

    const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
    const cookies: Array<{ name: string; value: string; domain: string }> = session.cookies ?? [];

    // Build cookie header from account-level + global cookies
    const accountCookies = cookies.filter(c => {
      const d = c.domain.replace(/^\./, '');
      return d === 'squarespace.com' || d === 'account.squarespace.com';
    });
    if (accountCookies.length === 0) return;

    const cookieHeader = accountCookies.map(c => `${c.name}=${c.value}`).join('; ');

    const res = await fetch(`https://${subdomain}.squarespace.com/api/commondata/GetCollections`, {
      headers: { Cookie: cookieHeader },
      redirect: 'manual',
    });

    // Parse Set-Cookie headers for member-session and crumb
    const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
    const captured: Array<{ name: string; value: string; domain: string }> = [];

    for (const header of setCookieHeaders) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      if (!match) continue;
      const [, name, value] = match;
      if (name === 'member-session' || name === 'crumb') {
        // Extract domain from Set-Cookie header, default to site subdomain
        const domainMatch = header.match(/[Dd]omain=([^;]+)/);
        const domain = domainMatch ? domainMatch[1].trim() : `.${subdomain}.squarespace.com`;
        captured.push({ name, value, domain });
      }
    }

    if (captured.length === 0) return;

    // Merge captured cookies into the session file
    const freshSession = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
    const existingCookies: Array<{ name: string; value: string; domain: string }> =
      freshSession.cookies ?? [];

    for (const newCookie of captured) {
      const idx = existingCookies.findIndex(
        c => c.name === newCookie.name && c.domain === newCookie.domain,
      );
      if (idx >= 0) {
        existingCookies[idx].value = newCookie.value;
      } else {
        existingCookies.push(newCookie);
      }
    }

    freshSession.cookies = existingCookies;
    writeFileSync(SESSION_PATH, JSON.stringify(freshSession, null, 2), 'utf-8');
    logger.info(
      { subdomain, captured: captured.map(c => c.name) },
      'Captured site-specific cookies for discovered site',
    );
  } catch (err) {
    logger.debug({ subdomain, error: errMsg(err) }, 'Failed to capture site cookies — skipping');
  }
}

/**
 * Auto-register a discovered site in the sites.json config file.
 * Only adds if the subdomain isn't already present. Best-effort — failures
 * are logged but never block discovery.
 */
function registerSiteInConfig(
  subdomain: string,
  siteTitle?: string,
  customDomain?: string,
): void {
  try {
    const configPath = process.env.SITES_CONFIG || join(process.cwd(), 'config', 'sites.json');
    if (!existsSync(configPath)) return;

    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as SitesConfig & { groups?: unknown[] };

    // Check if subdomain already exists in config
    const alreadyExists = config.clients.some(c => {
      try {
        const existing = new URL(c.site.adminUrl).hostname.split('.')[0];
        return existing === subdomain;
      } catch { return false; }
    });
    if (alreadyExists) return;

    // Build the new client entry
    const newEntry: SiteConfig = {
      id: subdomain,
      name: siteTitle || subdomain,
      aliases: [],
      site: {
        adminUrl: `https://${subdomain}.squarespace.com/config/website`,
        ...(customDomain ? { customDomain } : {}),
      },
    };

    config.clients.push(newEntry);
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    // Reset the mtime-based cache so loadSitesConfig() re-reads next time
    sitesConfig = null;
    sitesConfigMtime = 0;

    logger.info({ subdomain, name: siteTitle }, 'Auto-registered site in config');
  } catch (err) {
    logger.debug({ subdomain, error: errMsg(err) }, 'Failed to register site in config — skipping');
  }
}

/**
 * Fetch all sites from the Squarespace account API and upsert into discovered_sites.
 * Uses GET /api/account/1/website-briefs with account-level session cookies.
 * Called once per session — results are cached via the accountSitesFetched flag.
 */
export async function fetchAccountSites(): Promise<void> {
  if (accountSitesFetched) return;
  if (discoveryPromise) return discoveryPromise;

  discoveryPromise = (async () => {
    accountSitesFetched = true;

    try {
      if (!existsSync(SESSION_PATH)) return;

      const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
      const cookies: Array<{ name: string; value: string; domain: string }> = session.cookies ?? [];

      const accountCookies = cookies.filter(c => {
        const d = c.domain.replace(/^\./, '');
        return d === 'squarespace.com' || d === 'account.squarespace.com';
      });
      if (accountCookies.length === 0) return;

      const cookieHeader = accountCookies.map(c => `${c.name}=${c.value}`).join('; ');
      const crumb = accountCookies.find(c => c.name === 'crumb')?.value;

      const res = await fetch('https://account.squarespace.com/api/account/1/website-briefs', {
        headers: {
          Cookie: cookieHeader,
          ...(crumb ? { 'X-CSRF-Token': crumb } : {}),
        },
      });

      if (!res.ok) return;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('json')) return;

      const briefs = await res.json() as Array<{
        identifier: string;
        title: string;
        canonicalUrl: string;
        internalUrl: string;
        active: boolean;
      }>;

      // Build set of already-known subdomains (DB + config) so we only
      // run cookie capture and config registration for truly new sites.
      const knownSubdomains = new Set<string>();
      try {
        for (const d of loadDiscoveredSites()) {
          const sub = new URL(d.site.adminUrl).hostname.split('.')[0];
          knownSubdomains.add(sub);
        }
      } catch { /* best-effort */ }
      try {
        for (const c of loadSitesConfig().clients) {
          const sub = new URL(c.site.adminUrl).hostname.split('.')[0];
          knownSubdomains.add(sub);
        }
      } catch { /* best-effort */ }

      let count = 0;
      const cookiePromises: Promise<void>[] = [];
      for (const brief of briefs) {
        if (!brief.active || !brief.identifier) continue;
        const customDomain = brief.canonicalUrl !== brief.internalUrl
          ? brief.canonicalUrl
          : undefined;
        const isNew = !knownSubdomains.has(brief.identifier);
        try {
          saveSite(brief.identifier, brief.title, customDomain);
          count++;
        } catch { /* best-effort */ }

        // For newly discovered sites, auto-capture cookies and register in config
        if (isNew) {
          cookiePromises.push(captureSiteCookies(brief.identifier));
          registerSiteInConfig(brief.identifier, brief.title, customDomain);
        }
      }

      // Await cookie captures in parallel — best-effort, don't block on failures
      if (cookiePromises.length > 0) {
        await Promise.allSettled(cookiePromises);
      }

      if (count > 0) {
        logger.info({ count, total: briefs.length }, 'Discovered sites from account API');
      }
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Account sites discovery failed — falling back to DB-only');
    } finally {
      discoveryPromise = null;
    }
  })();

  return discoveryPromise;
}

/**
 * Get all sites: static config merged with discovered sites.
 * Static config takes precedence for matching subdomains.
 */
function getAllSites(): SiteConfig[] {
  const config = loadSitesConfig();
  const discovered = loadDiscoveredSites();

  // Build a set of subdomains from static config to avoid duplicates
  const staticSubdomains = new Set<string>();
  for (const c of config.clients) {
    try {
      const subdomain = new URL(c.site.adminUrl).hostname.split('.')[0];
      staticSubdomains.add(subdomain);
    } catch { /* skip invalid URLs */ }
  }

  // Merge: static first, then discovered sites not already in static
  const merged = [...config.clients];
  for (const d of discovered) {
    try {
      const subdomain = new URL(d.site.adminUrl).hostname.split('.')[0];
      if (!staticSubdomains.has(subdomain)) {
        merged.push(d);
      }
    } catch { /* skip invalid URLs */ }
  }

  return merged;
}

/**
 * Find a site by flexible matching: exact id, name (case-insensitive),
 * alias (case-insensitive), or subdomain.
 */
function findSite(input: string): SiteConfig | undefined {
  const allSites = getAllSites();
  const lower = input.toLowerCase().trim();

  // 1. Exact id match
  const byId = allSites.find((c) => c.id === lower);
  if (byId) return byId;

  // 2. Name match (case-insensitive)
  const byName = allSites.find((c) => c.name?.toLowerCase() === lower);
  if (byName) return byName;

  // 3. Alias match (case-insensitive)
  const byAlias = allSites.find((c) =>
    c.aliases?.some((a) => a.toLowerCase() === lower),
  );
  if (byAlias) return byAlias;

  // 4. Subdomain match (e.g. "grey-yellow-hbxc")
  const bySubdomain = allSites.find((c) => {
    try {
      const subdomain = new URL(c.site.adminUrl).hostname.split('.')[0];
      return subdomain === lower;
    } catch { return false; }
  });
  if (bySubdomain) return bySubdomain;

  return undefined;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the public base URL for a site.
 * Prefers customDomain (with https://), falls back to squarespace subdomain.
 * Used for resolving relative URLs during link validation.
 */
export function getSiteBaseUrl(siteId: string): string {
  const site = findSite(siteId);
  if (!site) {
    const allSites = getAllSites();
    const available = allSites.map((c) => {
      const subdomain = new URL(c.site.adminUrl).hostname.split('.')[0];
      return `"${c.id}" (${c.name ?? subdomain})`;
    }).join(', ');
    throw new Error(`Unknown site: "${siteId}". Available: ${available}`);
  }

  if (site.site.customDomain) {
    const domain = site.site.customDomain;
    return domain.startsWith('http') ? domain : `https://${domain}`;
  }

  const subdomain = new URL(site.site.adminUrl).hostname.split('.')[0];
  return `https://${subdomain}.squarespace.com`;
}

/**
 * Extract the Squarespace subdomain from a site identifier.
 * Accepts: site id, name, alias, or subdomain.
 * e.g., "smyth-tavern" | "Smyth Tavern" | "grey-yellow-hbxc" → "grey-yellow-hbxc"
 */
export function getSubdomain(siteId: string): string {
  const site = findSite(siteId);
  if (!site) {
    const allSites = getAllSites();
    const available = allSites.map((c) => {
      const subdomain = new URL(c.site.adminUrl).hostname.split('.')[0];
      return `"${c.id}" (${c.name ?? subdomain})`;
    }).join(', ');
    throw new Error(`Unknown site: "${siteId}". Available: ${available}`);
  }
  return new URL(site.site.adminUrl).hostname.split('.')[0];
}

/**
 * List all configured and discovered sites with their identifiers.
 * Used by sq_list_sites tool.
 */
export async function listSites(): Promise<Array<{
  id: string;
  name: string;
  subdomain: string;
  aliases: string[];
  adminUrl: string;
  customDomain?: string;
}>> {
  await fetchAccountSites();
  const allSites = getAllSites();
  return allSites.map((c) => {
    const subdomain = new URL(c.site.adminUrl).hostname.split('.')[0];
    return {
      id: c.id,
      name: c.name ?? c.id,
      subdomain,
      aliases: c.aliases ?? [],
      adminUrl: c.site.adminUrl,
      customDomain: c.site.customDomain,
    };
  });
}

/**
 * Get or create a ContentSaveClient for the given site.
 * Clients are cached per canonical id — session cookies loaded on first use.
 */
export function getClient(siteId: string): ContentSaveClient {
  // Resolve to canonical id for cache key
  const site = findSite(siteId);
  const cacheKey = site?.id ?? siteId;

  const cached = clientCache.get(cacheKey);
  if (cached) {
    cached.ensureFreshSession();
    return cached;
  }

  const subdomain = getSubdomain(siteId);
  const client = createContentSaveClient(subdomain);
  client._snapshotSiteId = cacheKey;
  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Get or create a MediaUploadClient for the given site.
 * Clients are cached per canonical id — session cookies loaded on first use.
 */
export function getMediaClient(siteId: string): MediaUploadClient {
  const site = findSite(siteId);
  const cacheKey = site?.id ?? siteId;

  const cached = mediaClientCache.get(cacheKey);
  if (cached) return cached;

  const subdomain = getSubdomain(siteId);
  const client = new MediaUploadClient(subdomain);
  client.loadSessionCookies();
  mediaClientCache.set(cacheKey, client);
  return client;
}

/**
 * Resolve page slug to pageSectionsId + collectionId.
 * Maps siteId → subdomain internally before calling the resolver.
 */
export async function resolvePageIds(
  siteId: string,
  pageSlug: string,
): Promise<{ pageSectionsId: string; collectionId: string } | null> {
  const subdomain = getSubdomain(siteId);
  return resolvePageIdsImpl(subdomain, pageSlug);
}

/**
 * Clear all cached clients and reload config.
 * Useful when session cookies have been refreshed on disk.
 */
export function reloadAllSessions(): void {
  clientCache.clear();
  mediaClientCache.clear();
  sitesConfig = null;
  accountSitesFetched = false;
}
