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
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/database.js';
import { logger } from '../utils/logger.js';

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
let accountSitesFetched = false;

// ── Config Loading ──────────────────────────────────────────────────────────

function loadSitesConfig(): SitesConfig {
  if (sitesConfig) return sitesConfig;

  const configPath = process.env.SITES_CONFIG || join(process.cwd(), 'config', 'sites.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    sitesConfig = JSON.parse(raw) as SitesConfig;
  } catch {
    // No static config — will rely on discovered sites
    sitesConfig = { clients: [] };
  }
  return sitesConfig;
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
 * Fetch all sites from the Squarespace account API and upsert into discovered_sites.
 * Uses GET /api/account/1/website-briefs with account-level session cookies.
 * Called once per session — results are cached via the accountSitesFetched flag.
 */
export function fetchAccountSites(): void {
  if (accountSitesFetched) return;
  accountSitesFetched = true;

  try {
    if (!existsSync(SESSION_PATH)) return;

    const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
    const cookies: Array<{ name: string; value: string; domain: string }> = session.cookies ?? [];

    // Build cookie header for account.squarespace.com
    const accountCookies = cookies.filter(c => {
      const d = c.domain.replace(/^\./, '');
      return d === 'squarespace.com' || d === 'account.squarespace.com';
    });
    if (accountCookies.length === 0) return;

    const cookieHeader = accountCookies.map(c => `${c.name}=${c.value}`).join('; ');
    const crumb = accountCookies.find(c => c.name === 'crumb')?.value;

    // Fire-and-forget async fetch — don't block listSites()
    fetch('https://account.squarespace.com/api/account/1/website-briefs', {
      headers: {
        Cookie: cookieHeader,
        ...(crumb ? { 'X-CSRF-Token': crumb } : {}),
      },
    }).then(async res => {
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

      let count = 0;
      for (const brief of briefs) {
        if (!brief.active || !brief.identifier) continue;
        const customDomain = brief.canonicalUrl !== brief.internalUrl
          ? brief.canonicalUrl
          : undefined;
        try {
          saveSite(brief.identifier, brief.title, customDomain);
          count++;
        } catch { /* best-effort */ }
      }

      if (count > 0) {
        logger.info({ count, total: briefs.length }, 'Discovered sites from account API');
      }
    }).catch(() => {
      // Silently fail — fall back to DB-only discovery
    });
  } catch {
    // Session file parse error etc — silently ignore
  }
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
export function listSites(): Array<{
  id: string;
  name: string;
  subdomain: string;
  aliases: string[];
  adminUrl: string;
  customDomain?: string;
}> {
  // Trigger account API discovery on first call (async, non-blocking)
  fetchAccountSites();
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
  if (cached) return cached;

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
