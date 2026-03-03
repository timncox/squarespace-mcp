/**
 * MCP Server Session Management
 *
 * Manages shared ContentSaveClient and MediaUploadClient instances per site.
 * Maps siteId (e.g., "smyth-tavern") to subdomain (e.g., "grey-yellow-hbxc")
 * using config/sites.json.
 */

import { createContentSaveClient } from '../services/content-save.js';
import { ContentSaveClient } from '../services/content-save.js';
import { MediaUploadClient } from '../services/media-upload.js';
import { resolvePageIds as resolvePageIdsImpl } from '../services/page-id-resolver.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// ── Types ───────────────────────────────────────────────────────────────────

interface SiteConfig {
  id: string;
  site: {
    adminUrl: string;
  };
}

interface SitesConfig {
  clients: SiteConfig[];
}

// ── State ───────────────────────────────────────────────────────────────────

const clientCache = new Map<string, ContentSaveClient>();
const mediaClientCache = new Map<string, MediaUploadClient>();
let sitesConfig: SitesConfig | null = null;

// ── Config Loading ──────────────────────────────────────────────────────────

function loadSitesConfig(): SitesConfig {
  if (sitesConfig) return sitesConfig;

  const configPath = join(process.cwd(), 'config', 'sites.json');
  const raw = readFileSync(configPath, 'utf-8');
  sitesConfig = JSON.parse(raw) as SitesConfig;
  return sitesConfig;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract the Squarespace subdomain from a siteId.
 * e.g., "smyth-tavern" → "grey-yellow-hbxc"
 */
export function getSubdomain(siteId: string): string {
  const config = loadSitesConfig();
  const site = config.clients.find((c) => c.id === siteId);
  if (!site) {
    throw new Error(`Unknown siteId: "${siteId}". Available: ${config.clients.map((c) => c.id).join(', ')}`);
  }
  return new URL(site.site.adminUrl).hostname.split('.')[0];
}

/**
 * Get or create a ContentSaveClient for the given site.
 * Clients are cached per siteId — session cookies loaded on first use.
 */
export function getClient(siteId: string): ContentSaveClient {
  const cached = clientCache.get(siteId);
  if (cached) return cached;

  const subdomain = getSubdomain(siteId);
  const client = createContentSaveClient(subdomain);
  clientCache.set(siteId, client);
  return client;
}

/**
 * Get or create a MediaUploadClient for the given site.
 * Clients are cached per siteId — session cookies loaded on first use.
 */
export function getMediaClient(siteId: string): MediaUploadClient {
  const cached = mediaClientCache.get(siteId);
  if (cached) return cached;

  const subdomain = getSubdomain(siteId);
  const client = new MediaUploadClient(subdomain);
  client.loadSessionCookies();
  mediaClientCache.set(siteId, client);
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
}
