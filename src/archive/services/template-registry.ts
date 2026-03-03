/**
 * Template Section Registry — maps { category, templateName } to sectionId per site.
 *
 * When a template is added to a page, the resulting section gets a unique sectionId.
 * This registry caches those mappings so we can reference known template sections
 * by category+name without re-probing the picker UI.
 *
 * Storage: SQLite `template_sections` table (Phase 17 migration).
 * TTL: 7 days (same as template_discovery cache).
 * Pattern: follows template-discovery.ts caching approach.
 */

import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import { getDb } from '../db/database.js';
import type { ContentSaveClient } from './content-save.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TemplateSectionEntry {
  siteId: string;
  category: string;
  templateName: string;
  sectionId: string;
  updatedAt: Date;
}

// ─── Config ──────────────────────────────────────────────────────────────────

/** Cache TTL in days — matches template_discovery */
const CACHE_TTL_DAYS = 7;

// ─── Registry Operations ────────────────────────────────────────────────────

/**
 * Look up a cached sectionId for a specific template.
 *
 * @param siteId   Site subdomain (e.g., "grey-yellow-hbxc")
 * @param category Template category (e.g., "About", "Services")
 * @param templateName Template name within the category
 * @returns sectionId if found and not expired, undefined otherwise
 */
export function lookupTemplate(
  siteId: string,
  category: string,
  templateName: string,
): string | undefined {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const row = db.prepare(`
      SELECT section_id FROM template_sections
      WHERE site_id = ? AND category = ? AND template_name = ? AND updated_at > ?
    `).get(siteId, category, templateName, cutoff) as { section_id: string } | undefined;

    if (row) {
      logger.debug({ siteId, category, templateName, sectionId: row.section_id }, 'template-registry: cache hit');
      return row.section_id;
    }

    return undefined;
  } catch (err) {
    logger.warn({ siteId, category, templateName, error: errMsg(err) }, 'template-registry: lookup failed');
    return undefined;
  }
}

/**
 * Register a template section mapping.
 *
 * @param siteId       Site subdomain
 * @param category     Template category
 * @param templateName Template name
 * @param sectionId    The section ID assigned by Squarespace
 */
export function registerTemplate(
  siteId: string,
  category: string,
  templateName: string,
  sectionId: string,
): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO template_sections (site_id, category, template_name, section_id, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(siteId, category, templateName, sectionId);

    logger.info({ siteId, category, templateName, sectionId }, 'template-registry: registered template section');
  } catch (err) {
    logger.warn({ siteId, category, templateName, error: errMsg(err) }, 'template-registry: register failed');
  }
}

/**
 * Populate the registry by reading existing sections from a page.
 *
 * Fetches the page's sections via the Content Save API and attempts to match
 * them against known template patterns (section names, block structure).
 * This is a best-effort scan — sections that can't be identified are skipped.
 *
 * @param client   Authenticated ContentSaveClient
 * @param siteId   Site subdomain
 * @param pageSectionsId  Page sections ID to scan
 */
export async function populateRegistry(
  client: ContentSaveClient,
  siteId: string,
  pageSectionsId: string,
): Promise<{ registered: number; skipped: number }> {
  let registered = 0;
  let skipped = 0;

  try {
    const data = await client.getPageSections(pageSectionsId);
    const sections = data.sections ?? [];

    for (const section of sections) {
      const sectionId = section.id;
      const sectionName = section.sectionName ?? section.title ?? '';

      if (!sectionId || !sectionName) {
        skipped++;
        continue;
      }

      // Attempt to categorize by section name patterns
      const category = inferCategory(sectionName);
      if (category) {
        registerTemplate(siteId, category, sectionName, sectionId);
        registered++;
      } else {
        skipped++;
      }
    }

    logger.info(
      { siteId, pageSectionsId, registered, skipped, totalSections: sections.length },
      'template-registry: populated from page sections',
    );
  } catch (err) {
    logger.warn({ siteId, pageSectionsId, error: errMsg(err) }, 'template-registry: populate failed');
  }

  return { registered, skipped };
}

/**
 * Get all registered templates for a site.
 */
export function getRegisteredTemplates(siteId: string): TemplateSectionEntry[] {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const rows = db.prepare(`
      SELECT site_id, category, template_name, section_id, updated_at
      FROM template_sections
      WHERE site_id = ? AND updated_at > ?
      ORDER BY category, template_name
    `).all(siteId, cutoff) as Array<{
      site_id: string;
      category: string;
      template_name: string;
      section_id: string;
      updated_at: string;
    }>;

    return rows.map(r => ({
      siteId: r.site_id,
      category: r.category,
      templateName: r.template_name,
      sectionId: r.section_id,
      updatedAt: new Date(r.updated_at),
    }));
  } catch (err) {
    logger.warn({ siteId, error: errMsg(err) }, 'template-registry: getRegisteredTemplates failed');
    return [];
  }
}

/**
 * Invalidate all registry entries for a site.
 */
export function invalidateRegistry(siteId: string): void {
  try {
    const db = getDb();
    const result = db.prepare('DELETE FROM template_sections WHERE site_id = ?').run(siteId);
    logger.info({ siteId, deleted: result.changes }, 'template-registry: invalidated');
  } catch (err) {
    logger.warn({ siteId, error: errMsg(err) }, 'template-registry: invalidate failed');
  }
}

/**
 * Invalidate all registry entries across all sites.
 */
export function invalidateAllRegistries(): void {
  try {
    const db = getDb();
    const result = db.prepare('DELETE FROM template_sections').run();
    logger.info({ deleted: result.changes }, 'template-registry: invalidated all');
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'template-registry: invalidate all failed');
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Known template category keywords for heuristic section categorization */
const CATEGORY_PATTERNS: Array<{ category: string; patterns: RegExp[] }> = [
  { category: 'Intro', patterns: [/intro/i, /hero/i, /welcome/i, /banner/i] },
  { category: 'About', patterns: [/about/i, /bio/i, /story/i, /mission/i] },
  { category: 'Team', patterns: [/team/i, /staff/i, /people/i, /members/i] },
  { category: 'Contact', patterns: [/contact/i, /get.in.touch/i, /reach/i, /location/i] },
  { category: 'Services', patterns: [/service/i, /offering/i, /what.we.do/i] },
  { category: 'Products', patterns: [/product/i, /shop/i, /store/i, /pricing/i] },
  { category: 'FAQs', patterns: [/faq/i, /question/i, /help/i] },
  { category: 'Images', patterns: [/image/i, /gallery/i, /photo/i, /portfolio/i] },
];

/**
 * Attempt to infer a template category from a section name.
 * Returns the category string or null if no match found.
 */
function inferCategory(sectionName: string): string | null {
  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.some(p => p.test(sectionName))) {
      return category;
    }
  }
  return null;
}
