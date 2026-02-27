/**
 * Section Catalog Service — maps the content strategist's templateCategory/templateIndex
 * to actual catalog entry IDs for the copyTemplateSection API.
 *
 * Wraps ContentSaveClient.getSectionCatalog() with SQLite caching (7-day TTL)
 * and provides normalization/lookup helpers.
 */

import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import { getDb } from '../db/database.js';
import { createContentSaveClient, type SectionCatalogEntry, type SectionCatalogResponse } from './content-save.js';
import type { DiscoveredCategory, TemplateDiscoveryResult } from './template-discovery.js';

// ── Cache TTL ────────────────────────────────────────────────────────────────

const CACHE_TTL_DAYS = 7;
const CACHE_KEY = '__catalog__';

// ── Category Name Normalization ──────────────────────────────────────────────

/**
 * Known aliases mapping strategist category names → API catalog keys.
 * API keys are UPPERCASE. Strategist outputs are mixed-case (e.g., "Contact", "Services").
 */
const CATEGORY_ALIASES: Record<string, string> = {
  // Direct matches (strategist → API)
  'INTRO': 'INTRO',
  'ABOUT': 'ABOUT',
  'TEAM': 'TEAM',
  'CONTACT': 'CONTACT',
  'FAQS': 'FAQS',
  'FAQ': 'FAQS',
  'IMAGES': 'IMAGES',
  'MENUS': 'MENUS',
  'MENU': 'MENUS',
  // Aliases for categories where names diverge
  'SERVICES': 'SERVICES/OFFERINGS',
  'OFFERINGS': 'SERVICES/OFFERINGS',
  'SERVICES/OFFERINGS': 'SERVICES/OFFERINGS',
  'PRODUCTS': 'PRODUCTS',
  'PRODUCT': 'PRODUCTS',
};

/**
 * Normalize a strategist category name to an API catalog key.
 * Uppercase + alias resolution. Unknown categories pass through as UPPERCASE.
 */
export function normalizeCategoryName(name: string): string {
  const upper = name.trim().toUpperCase();
  return CATEGORY_ALIASES[upper] ?? upper;
}

// ── Catalog Lookup ───────────────────────────────────────────────────────────

/**
 * Look up a catalog entry by normalized category name and 0-based index.
 * Returns null if category not found or index out of range.
 */
export function lookupCatalogEntry(
  catalog: Record<string, SectionCatalogEntry[]>,
  categoryName: string,
  templateIndex: number,
): SectionCatalogEntry | null {
  const normalized = normalizeCategoryName(categoryName);
  const entries = catalog[normalized];

  if (!entries || entries.length === 0) {
    logger.warn({ categoryName, normalized, available: Object.keys(catalog) }, 'section-catalog: category not found');
    return null;
  }

  if (templateIndex < 0 || templateIndex >= entries.length) {
    logger.warn(
      { categoryName, normalized, templateIndex, available: entries.length },
      'section-catalog: template index out of range',
    );
    return null;
  }

  return entries[templateIndex];
}

// ── Catalog → TemplateDiscoveryResult Conversion ─────────────────────────────

/**
 * Convert an API section catalog into the existing TemplateDiscoveryResult shape,
 * for backward compatibility with formatDiscoveredTemplatesForPrompt().
 */
export function catalogToDiscoveryResult(
  catalog: Record<string, SectionCatalogEntry[]>,
): TemplateDiscoveryResult {
  const categories: DiscoveredCategory[] = [];

  for (const [categoryKey, entries] of Object.entries(catalog)) {
    categories.push({
      name: categoryKey,
      templates: entries.map((entry, index) => ({
        name: entry.sectionId, // Best available name from catalog
        index,
      })),
    });
  }

  return {
    categories,
    discoveredAt: new Date(),
  };
}

// ── SQLite Cache Layer ───────────────────────────────────────────────────────

/**
 * Cache catalog data in the existing template_cache table.
 * Uses site_id = CACHE_KEY to distinguish from per-site UI discovery results.
 */
function cacheCatalog(subdomain: string, catalog: Record<string, SectionCatalogEntry[]>): void {
  try {
    const db = getDb();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

    db.prepare(`
      INSERT OR REPLACE INTO template_cache (id, site_id, categories_json, discovered_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      `catalog-${subdomain}`,
      CACHE_KEY,
      JSON.stringify(catalog),
      now.toISOString(),
      expiresAt.toISOString(),
    );

    const totalEntries = Object.values(catalog).reduce((sum, arr) => sum + arr.length, 0);
    logger.info(
      { subdomain, categories: Object.keys(catalog).length, totalEntries, expiresAt: expiresAt.toISOString() },
      'section-catalog: cached catalog',
    );
  } catch (err) {
    logger.warn({ subdomain, error: errMsg(err) }, 'section-catalog: failed to cache catalog');
  }
}

/**
 * Retrieve cached catalog data if it exists and hasn't expired.
 */
function getCachedCatalog(subdomain: string): Record<string, SectionCatalogEntry[]> | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT categories_json, expires_at
      FROM template_cache
      WHERE id = ? AND site_id = ? AND expires_at > datetime('now')
    `).get(`catalog-${subdomain}`, CACHE_KEY) as { categories_json: string; expires_at: string } | undefined;

    if (!row) return null;

    const catalog = JSON.parse(row.categories_json) as Record<string, SectionCatalogEntry[]>;
    logger.info({ subdomain }, 'section-catalog: cache hit');
    return catalog;
  } catch (err) {
    logger.warn({ subdomain, error: errMsg(err) }, 'section-catalog: failed to read cache');
    return null;
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Get the section catalog, using cached data if available.
 * Falls back to live API call if cache is empty or expired.
 *
 * @param subdomain - Site subdomain (e.g., "smyth-tavern-e9yj")
 * @param forceRefresh - Skip cache and fetch fresh data
 * @returns Catalog keyed by category, or null if API fails
 */
export async function getOrFetchCatalog(
  subdomain: string,
  forceRefresh = false,
): Promise<Record<string, SectionCatalogEntry[]> | null> {
  // Check cache first (unless forced)
  if (!forceRefresh) {
    const cached = getCachedCatalog(subdomain);
    if (cached) return cached;
  }

  // Fetch from API
  try {
    const client = createContentSaveClient(subdomain);
    const response: SectionCatalogResponse = await client.getSectionCatalog();

    if (!response.success || !response.catalog) {
      logger.warn({ error: response.error }, 'section-catalog: API fetch failed');
      return null;
    }

    // Cache the result
    cacheCatalog(subdomain, response.catalog);

    return response.catalog;
  } catch (err) {
    logger.warn({ subdomain, error: errMsg(err) }, 'section-catalog: failed to fetch catalog');
    return null;
  }
}
