/**
 * Page ID Resolver
 *
 * Resolves a Squarespace page slug + subdomain into the pageSectionsId and
 * collectionId needed by the Content Save API.  Uses a SQLite cache (30-day
 * TTL) to avoid repeated network lookups.
 *
 * Resolution chain:
 *   1. SQLite cache hit (< 30 days) → instant
 *   2. ContentSaveClient.getPageIds(slug) → collectionId
 *   3. Public HTML fetch → pageSectionsId from data-page-sections attribute
 *   4. Headless browser fallback → pageSectionsId from DOM (expensive, last resort)
 */

import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import { getDb } from '../db/database.js';
import { createContentSaveClient } from './content-save.js';

// ── Constants ────────────────────────────────────────────────────────────────

const CACHE_MAX_DAYS = 30;
const FETCH_TIMEOUT_MS = 10_000;

// ── Slug normalization ───────────────────────────────────────────────────────

const HOME_SLUGS = ['homepage', 'home-page', 'home', 'landing', 'index', 'main', ''];

function normalizeSlug(slug: string): string {
  const lower = slug.toLowerCase().trim();
  if (HOME_SLUGS.includes(lower)) return 'home';
  return slug.replace(/^\/+/, '').toLowerCase();
}

// ── Cache layer ──────────────────────────────────────────────────────────────

interface CachedIds {
  pageSectionsId: string;
  collectionId: string;
  cachedAt: string;
}

function getCachedIds(subdomain: string, slug: string): CachedIds | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT page_sections_id, collection_id, cached_at FROM page_id_cache WHERE subdomain = ? AND slug = ?',
  ).get(subdomain, slug) as { page_sections_id: string; collection_id: string; cached_at: string } | undefined;

  if (!row) return null;

  // Check staleness
  const cachedAt = new Date(row.cached_at);
  const ageDays = (Date.now() - cachedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > CACHE_MAX_DAYS) {
    logger.debug({ subdomain, slug, ageDays: ageDays.toFixed(1) }, 'Page ID cache stale');
    return null;
  }

  return {
    pageSectionsId: row.page_sections_id,
    collectionId: row.collection_id,
    cachedAt: row.cached_at,
  };
}

/**
 * Cache page IDs for future lookups.
 * INSERT OR REPLACE so callers can update stale entries.
 */
export function cachePageIds(
  subdomain: string,
  slug: string,
  pageSectionsId: string,
  collectionId: string,
): void {
  const normalizedSlug = normalizeSlug(slug);
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO page_id_cache (subdomain, slug, page_sections_id, collection_id, cached_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(subdomain, normalizedSlug, pageSectionsId, collectionId);
  logger.debug({ subdomain, slug: normalizedSlug }, 'Cached page IDs');
}

/**
 * Invalidate cached page IDs for a given collectionId.
 * Call after deleting a page to prevent stale cache hits.
 */
export function invalidateCacheByCollectionId(collectionId: string): void {
  const db = getDb();
  const deleted = db.prepare(
    'DELETE FROM page_id_cache WHERE collection_id = ?',
  ).run(collectionId);
  if (deleted.changes > 0) {
    logger.info({ collectionId, rowsDeleted: deleted.changes }, 'Invalidated page ID cache');
  }
}

// ── Resolution chain ─────────────────────────────────────────────────────────

/**
 * Try to extract pageSectionsId from the public HTML of the page.
 * Looks for `data-page-sections="..."` in the response.
 */
async function fetchPageSectionsIdFromHtml(
  subdomain: string,
  slug: string,
): Promise<string | null> {
  const normalizedSlug = normalizeSlug(slug);
  const pageUrl = normalizedSlug === 'home'
    ? `https://${subdomain}.squarespace.com/`
    : `https://${subdomain}.squarespace.com/${normalizedSlug}`;

  try {
    const response = await fetch(pageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    if (!response.ok) return null;

    const html = await response.text();
    const match = html.match(/data-page-sections="([^"]+)"/);
    return match?.[1] ?? null;
  } catch (err) {
    logger.debug({ error: errMsg(err), subdomain, slug }, 'Failed to fetch page HTML for pageSectionsId');
    return null;
  }
}

/**
 * Browser fallback removed — no longer available.
 */
async function fetchPageSectionsIdFromBrowser(
  _subdomain: string,
  _slug: string,
): Promise<string | null> {
  return null;
}

/**
 * Resolve page slug + subdomain → { pageSectionsId, collectionId }.
 *
 * Returns null if resolution fails at every step.
 */
export async function resolvePageIds(
  subdomain: string,
  slug: string,
): Promise<{ pageSectionsId: string; collectionId: string } | null> {
  const normalizedSlug = normalizeSlug(slug);

  // Step 1: Check cache
  const cached = getCachedIds(subdomain, normalizedSlug);
  if (cached) {
    logger.debug({ subdomain, slug: normalizedSlug }, 'Page ID cache hit');
    return { pageSectionsId: cached.pageSectionsId, collectionId: cached.collectionId };
  }

  // Step 2: Get collectionId + pageSectionsId via API
  // Uses GetCollections → GetCollectionSettings (same flow as the Squarespace editor)
  let collectionId: string | null = null;
  let pageSectionsId: string | null = null;
  try {
    const client = createContentSaveClient(subdomain);
    const ids = await client.getPageIds(normalizedSlug === 'home' ? '' : normalizedSlug);
    if (ids) {
      collectionId = ids.collectionId;
      pageSectionsId = ids.pageSectionsId ?? null;
      if (pageSectionsId) {
        logger.info({ subdomain, slug: normalizedSlug }, 'Resolved pageSectionsId via GetCollectionSettings API');
      }
    }
  } catch (err) {
    logger.warn({ error: errMsg(err), subdomain, slug: normalizedSlug }, 'getPageIds failed');
  }

  if (!collectionId) {
    logger.warn({ subdomain, slug: normalizedSlug }, 'Could not resolve collectionId');
    return null;
  }

  // Step 3: Fallback — get pageSectionsId from public HTML
  if (!pageSectionsId) {
    pageSectionsId = await fetchPageSectionsIdFromHtml(subdomain, normalizedSlug);
  }

  // Step 3b: Fallback — authenticated HTML fetch (handles hidden/protected pages)
  if (!pageSectionsId) {
    try {
      const client = createContentSaveClient(subdomain);
      const html = await client.fetchAuthenticatedPageHtml(normalizedSlug);
      if (html) {
        const match = html.match(/data-page-sections="([^"]+)"/);
        pageSectionsId = match?.[1] ?? null;
        if (pageSectionsId) {
          logger.info({ subdomain, slug: normalizedSlug }, 'Resolved pageSectionsId via authenticated fetch');
        }
      }
    } catch (err) {
      logger.debug({ error: errMsg(err), subdomain, slug: normalizedSlug }, 'Authenticated HTML fetch failed');
    }
  }

  // Step 4: Last resort — headless browser
  if (!pageSectionsId) {
    logger.info({ subdomain, slug: normalizedSlug }, 'Trying browser fallback for pageSectionsId');
    pageSectionsId = await fetchPageSectionsIdFromBrowser(subdomain, normalizedSlug);
  }

  if (!pageSectionsId) {
    logger.warn({ subdomain, slug: normalizedSlug }, 'Could not resolve pageSectionsId');
    return null;
  }

  // Step 5: Cache for future use
  cachePageIds(subdomain, normalizedSlug, pageSectionsId, collectionId);

  return { pageSectionsId, collectionId };
}
