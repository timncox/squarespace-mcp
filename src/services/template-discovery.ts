/**
 * Dynamic Template Discovery — probes Squarespace's template picker UI
 * to discover available templates and their grid positions, then caches
 * results in SQLite for 7 days.
 *
 * This replaces reliance on the static section-templates.json catalog,
 * which can drift when Squarespace updates their template picker.
 * The static catalog is kept as a fallback when discovery is unavailable
 * (e.g., no browser session, timeout, picker UI changes).
 */

import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import { getDb } from '../db/database.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DiscoveredTemplate {
  /** Template name extracted from the UI card text */
  name: string;
  /** 0-based index within the category grid (left-to-right, top-to-bottom) */
  index: number;
}

export interface DiscoveredCategory {
  /** Category tab name (e.g., "Intro", "About", "Team") */
  name: string;
  /** Templates available in this category, ordered by grid position */
  templates: DiscoveredTemplate[];
}

export interface TemplateDiscoveryResult {
  /** Discovered categories with their templates */
  categories: DiscoveredCategory[];
  /** When discovery was performed */
  discoveredAt: Date;
}

// ─── Cache TTL ───────────────────────────────────────────────────────────────

/** Cache TTL in days — Squarespace rarely updates templates */
const CACHE_TTL_DAYS = 7;

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Discover templates by probing the Squarespace section picker UI.
 *
 * Opens the "Add Section" panel, iterates through each category tab,
 * extracts template card names and their positions, then closes the picker.
 *
 * @param page - Playwright page in edit mode on a Squarespace site
 * @param siteId - Site identifier for caching
 * @returns Discovery result with categories and templates
 */
export async function discoverTemplates(
  page: Page,
  siteId: string,
): Promise<TemplateDiscoveryResult> {
  const startTime = Date.now();
  logger.info({ siteId }, 'Template discovery: starting');

  const categories: DiscoveredCategory[] = [];

  try {
    // ── Step 1: Open the section picker ──────────────────────────────────
    const pickerOpened = await openSectionPicker(page);
    if (!pickerOpened) {
      throw new Error('Could not open section picker — ADD SECTION button not found');
    }
    await page.waitForTimeout(1500);

    // ── Step 2: Discover category tabs ──────────────────────────────────
    const categoryNames = await discoverCategoryTabs(page);
    if (categoryNames.length === 0) {
      throw new Error('No category tabs found in section picker');
    }
    logger.info({ categoryCount: categoryNames.length, categories: categoryNames }, 'Template discovery: found category tabs');

    // ── Step 3: Iterate through each category and extract templates ─────
    for (const categoryName of categoryNames) {
      try {
        const templates = await discoverCategoryTemplates(page, categoryName);
        categories.push({ name: categoryName, templates });
        logger.info(
          { category: categoryName, templateCount: templates.length },
          'Template discovery: extracted templates for category',
        );
      } catch (err) {
        logger.warn(
          { category: categoryName, error: errMsg(err) },
          'Template discovery: failed to extract templates for category, skipping',
        );
      }
    }

    // ── Step 4: Close the section picker ─────────────────────────────────
    await closeSectionPicker(page);

    const result: TemplateDiscoveryResult = {
      categories,
      discoveredAt: new Date(),
    };

    const totalTemplates = categories.reduce((sum, c) => sum + c.templates.length, 0);
    const durationMs = Date.now() - startTime;
    logger.info(
      { siteId, categoryCount: categories.length, totalTemplates, durationMs },
      'Template discovery: completed',
    );

    // Cache the result
    cacheDiscoveryResult(siteId, result);

    return result;
  } catch (err) {
    // Attempt to close the picker even on error
    await closeSectionPicker(page).catch(() => {});

    const errorMsg = errMsg(err);
    logger.error({ siteId, error: errorMsg, durationMs: Date.now() - startTime }, 'Template discovery: failed');
    throw new Error(`Template discovery failed: ${errorMsg}`);
  }
}

/**
 * Get cached templates or discover them fresh if cache is stale/missing.
 *
 * @param page - Playwright page in edit mode (only used if discovery is needed)
 * @param siteId - Site identifier for cache lookup
 * @returns Discovery result from cache or fresh discovery
 */
export async function getOrDiscoverTemplates(
  page: Page,
  siteId: string,
): Promise<TemplateDiscoveryResult> {
  // Check cache first
  const cached = getCachedDiscovery(siteId);
  if (cached) {
    logger.info({ siteId, discoveredAt: cached.discoveredAt }, 'Template discovery: using cached result');
    return cached;
  }

  // Cache miss or stale — discover fresh
  logger.info({ siteId }, 'Template discovery: cache miss, discovering fresh');
  return await discoverTemplates(page, siteId);
}

// ─── Section Picker UI Interaction ───────────────────────────────────────────

/**
 * Open the section picker by clicking "ADD SECTION".
 * Uses the same strategies as handleAddSection in section-management-handlers.ts.
 */
async function openSectionPicker(page: Page): Promise<boolean> {
  const addSectionSelectors = [
    'button:has-text("ADD SECTION")',
    'button:has-text("Add Section")',
    '[aria-label="Add Section"]',
    '[data-test="add-section"]',
    'button[aria-label="Add section"]',
    '[class*="add-section"]',
    '[class*="AddSection"]',
  ];

  // Try to find ADD SECTION button in iframe first (empty page case)
  try {
    const siteFrame = page.frameLocator('iframe[title="Site Preview"]').first();
    const iframeBtn = siteFrame.locator('button:has-text("ADD SECTION")').first();
    const iframeBtnVisible = await iframeBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (iframeBtnVisible) {
      // Get bounding box from the actual iframe element
      const iframeEl = page.locator('iframe[title="Site Preview"]').first();
      const iframeBox = await iframeEl.boundingBox().catch(() => null);
      if (iframeBox) {
        // Click through the iframe coordinate space
        const btnBox = await iframeBtn.boundingBox().catch(() => null);
        if (btnBox) {
          await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
          logger.info('Template discovery: clicked ADD SECTION inside iframe');
          return true;
        }
      }
    }
  } catch { /* Not in iframe, try main frame */ }

  // Try main frame selectors
  for (const selector of addSectionSelectors) {
    try {
      const btn = page.locator(selector).first();
      const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await btn.click({ timeout: 3000 });
        logger.info({ selector }, 'Template discovery: clicked ADD SECTION');
        return true;
      }
    } catch { /* Try next */ }
  }

  // Try CDP hover to reveal the button
  try {
    const { cdpHoverAtSectionBoundary } = await import('../automation/editor-actions.js');
    const cdpResult = await cdpHoverAtSectionBoundary(page);
    if (cdpResult.success) {
      await page.waitForTimeout(500);
      for (const selector of addSectionSelectors) {
        try {
          const btn = page.locator(selector).first();
          const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
          if (visible) {
            await btn.click({ timeout: 3000 });
            logger.info({ selector }, 'Template discovery: clicked ADD SECTION after CDP hover');
            return true;
          }
        } catch { /* Try next */ }
      }
    }
  } catch { /* CDP not available */ }

  // Force-reveal strategy
  try {
    const { forceClickHiddenAddSection } = await import('../automation/editor-actions.js');
    const forceResult = await forceClickHiddenAddSection(page);
    if (forceResult.success) {
      logger.info('Template discovery: force-revealed ADD SECTION');
      return true;
    }
  } catch { /* Force reveal not available */ }

  return false;
}

/**
 * Discover category tab names from the section picker panel.
 * Category tabs appear as buttons or tab-like elements in the picker.
 */
async function discoverCategoryTabs(page: Page): Promise<string[]> {
  // Known category tab selectors in Squarespace's section picker
  const tabSelectors = [
    '[role="tab"]',
    '[class*="sectionPicker"] button[class*="tab"]',
    '[class*="section-picker"] button[class*="tab"]',
    '[class*="sectionPicker"] [class*="category"]',
    '[class*="panel"] [role="tab"]',
  ];

  for (const selector of tabSelectors) {
    try {
      const tabs = page.locator(selector);
      const count = await tabs.count().catch(() => 0);
      if (count >= 3) {
        // Extract text from each tab
        const names: string[] = [];
        for (let i = 0; i < count; i++) {
          const text = await tabs.nth(i).textContent().catch(() => null);
          if (text && text.trim().length > 0) {
            const name = text.trim();
            // Filter out non-category tabs (e.g., "Add Blank", search, etc.)
            if (!name.toLowerCase().includes('blank') && !name.toLowerCase().includes('search') && name.length < 30) {
              names.push(name);
            }
          }
        }
        if (names.length >= 3) {
          logger.info({ selector, tabCount: names.length }, 'Template discovery: found category tabs');
          return names;
        }
      }
    } catch { /* Try next selector */ }
  }

  // Fallback: try to find any clickable elements that look like category names
  const knownCategories = ['Intro', 'About', 'Team', 'Contact', 'Services', 'Products', 'FAQs', 'Images'];
  const foundCategories: string[] = [];

  for (const cat of knownCategories) {
    try {
      const el = page.locator(`button:has-text("${cat}"), [role="tab"]:has-text("${cat}"), a:has-text("${cat}")`).first();
      const visible = await el.isVisible({ timeout: 1000 }).catch(() => false);
      if (visible) {
        foundCategories.push(cat);
      }
    } catch { /* Not found */ }
  }

  return foundCategories;
}

/**
 * Click a category tab and extract all template cards in that category.
 */
async function discoverCategoryTemplates(
  page: Page,
  categoryName: string,
): Promise<DiscoveredTemplate[]> {
  // Click the category tab
  const tabSelectors = [
    `button:has-text("${categoryName}")`,
    `[role="tab"]:has-text("${categoryName}")`,
    `a:has-text("${categoryName}")`,
  ];

  let tabClicked = false;
  for (const selector of tabSelectors) {
    try {
      const el = page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await el.click({ timeout: 3000 });
        tabClicked = true;
        break;
      }
    } catch { /* Try next */ }
  }

  if (!tabClicked) {
    throw new Error(`Could not click category tab "${categoryName}"`);
  }

  // Wait for templates to render
  await page.waitForTimeout(1000);

  // Extract template names from the cards
  const templates: DiscoveredTemplate[] = [];

  // Strategy 1: Find template cards with text content
  const cardSelectors = [
    '[class*="sectionPicker"] button[class*="template"]',
    '[class*="section-picker"] button[class*="template"]',
    '[class*="sectionPicker"] [role="button"]',
    '[class*="layoutPicker"] button',
    '[class*="layout-picker"] button',
    '[class*="sectionPicker"] [class*="card"]',
    '[class*="sectionPicker"] [class*="thumbnail"]',
  ];

  for (const selector of cardSelectors) {
    try {
      const cards = page.locator(selector);
      const count = await cards.count().catch(() => 0);
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const text = await cards.nth(i).textContent().catch(() => null);
          const name = text?.trim() || `Template ${i + 1}`;
          // Skip obviously non-template elements
          if (name.toLowerCase().includes('add blank') || name.toLowerCase().includes('search')) continue;
          templates.push({ name, index: i });
        }
        if (templates.length > 0) {
          return templates;
        }
      }
    } catch { /* Try next selector */ }
  }

  // Strategy 2: Use aria-label or title attributes on images/thumbnails
  try {
    const panelSelectors = [
      '[class*="sectionPicker"]',
      '[class*="section-picker"]',
      '[class*="layoutPicker"]',
      '[class*="layout-picker"]',
      '[class*="panel"]',
    ];

    for (const panelSel of panelSelectors) {
      const panel = page.locator(panelSel).first();
      const panelVisible = await panel.isVisible({ timeout: 1500 }).catch(() => false);
      if (panelVisible) {
        const thumbs = panel.locator('img, [class*="thumb"], [class*="preview"]');
        const thumbCount = await thumbs.count().catch(() => 0);
        if (thumbCount > 0) {
          for (let i = 0; i < thumbCount; i++) {
            const alt = await thumbs.nth(i).getAttribute('alt').catch(() => null);
            const title = await thumbs.nth(i).getAttribute('title').catch(() => null);
            const ariaLabel = await thumbs.nth(i).getAttribute('aria-label').catch(() => null);
            const name = alt || title || ariaLabel || `Template ${i + 1}`;
            templates.push({ name, index: i });
          }
          if (templates.length > 0) {
            return templates;
          }
        }
      }
    }
  } catch { /* No thumbnails found */ }

  // Strategy 3: Count clickable elements and use generic names
  try {
    const clickables = page.locator('[class*="sectionPicker"] button, [class*="sectionPicker"] [role="button"]');
    const count = await clickables.count().catch(() => 0);
    // Filter out utility buttons (category tabs, search, close, etc.)
    let templateIdx = 0;
    for (let i = 0; i < count; i++) {
      const text = await clickables.nth(i).textContent().catch(() => '');
      const trimmed = text?.trim() || '';
      // Skip known non-template buttons
      if (
        trimmed.toLowerCase().includes('blank') ||
        trimmed.toLowerCase().includes('search') ||
        trimmed.toLowerCase().includes('close') ||
        trimmed.length === 0 ||
        trimmed.length > 50
      ) continue;

      // Check if this is a category tab name — skip it
      const isCategoryTab = ['Intro', 'About', 'Team', 'Contact', 'Services', 'Products', 'FAQs', 'Images']
        .some(c => trimmed === c);
      if (isCategoryTab) continue;

      templates.push({ name: trimmed || `Template ${templateIdx + 1}`, index: templateIdx });
      templateIdx++;
    }
  } catch { /* Fallback failed */ }

  return templates;
}

/**
 * Close the section picker panel (press Escape or click outside).
 */
async function closeSectionPicker(page: Page): Promise<void> {
  try {
    // Press Escape to close any open panel
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // If the picker is still open, try clicking outside it
    const pickerVisible = await page
      .locator('[class*="sectionPicker"], [class*="section-picker"]')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (pickerVisible) {
      // Click on the page content area to dismiss
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  } catch {
    // Picker may already be closed
  }
}

// ─── SQLite Cache Layer ──────────────────────────────────────────────────────

/**
 * Cache a discovery result in the template_cache SQLite table.
 */
function cacheDiscoveryResult(siteId: string, result: TemplateDiscoveryResult): void {
  try {
    const db = getDb();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

    db.prepare(`
      INSERT OR REPLACE INTO template_cache (id, site_id, categories_json, discovered_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      `tc-${siteId}`,
      siteId,
      JSON.stringify(result.categories),
      now.toISOString(),
      expiresAt.toISOString(),
    );

    logger.info(
      { siteId, expiresAt: expiresAt.toISOString(), categoryCount: result.categories.length },
      'Template discovery: cached result',
    );
  } catch (err) {
    logger.warn({ siteId, error: errMsg(err) }, 'Template discovery: failed to cache result');
  }
}

/**
 * Retrieve a cached discovery result if it exists and hasn't expired.
 */
export function getCachedDiscovery(siteId: string): TemplateDiscoveryResult | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT categories_json, discovered_at, expires_at
      FROM template_cache
      WHERE site_id = ? AND expires_at > datetime('now')
    `).get(siteId) as { categories_json: string; discovered_at: string; expires_at: string } | undefined;

    if (!row) return null;

    const categories = JSON.parse(row.categories_json) as DiscoveredCategory[];
    return {
      categories,
      discoveredAt: new Date(row.discovered_at),
    };
  } catch (err) {
    logger.warn({ siteId, error: errMsg(err) }, 'Template discovery: failed to read cache');
    return null;
  }
}

/**
 * Invalidate the cache for a specific site (e.g., after a failed template operation).
 */
export function invalidateTemplateCache(siteId: string): void {
  try {
    const db = getDb();
    db.prepare('DELETE FROM template_cache WHERE site_id = ?').run(siteId);
    logger.info({ siteId }, 'Template discovery: cache invalidated');
  } catch (err) {
    logger.warn({ siteId, error: errMsg(err) }, 'Template discovery: failed to invalidate cache');
  }
}

/**
 * Invalidate all cached template data (e.g., if Squarespace UI changes globally).
 */
export function invalidateAllTemplateCache(): void {
  try {
    const db = getDb();
    db.prepare('DELETE FROM template_cache').run();
    logger.info('Template discovery: all cache entries invalidated');
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Template discovery: failed to invalidate all cache');
  }
}

// ─── Formatting for Prompt Injection ─────────────────────────────────────────

/**
 * Format discovered templates as markdown for injection into the
 * content strategist prompt. Mirrors the structure of the static
 * formatCatalogForPrompt() but uses live discovery data.
 */
export function formatDiscoveredTemplatesForPrompt(discovery: TemplateDiscoveryResult): string {
  const lines: string[] = [];

  lines.push('### Section Template Catalog (DISCOVERED from live Squarespace UI)');
  lines.push('');
  lines.push('These templates were discovered by probing the actual Squarespace template picker.');
  lines.push('Template indexes are verified and current. Use **addSectionFromTemplate** to add a template.');
  lines.push('');

  for (const category of discovery.categories) {
    lines.push(`#### ${category.name}`);
    lines.push('| Idx | Template Name |');
    lines.push('| --- | --- |');

    for (const tmpl of category.templates) {
      lines.push(`| ${tmpl.index} | ${tmpl.name} |`);
    }

    lines.push('');
  }

  lines.push(`*Discovered at: ${discovery.discoveredAt.toISOString()}*`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Validate that a template index matches expectations before execution.
 * Returns true if the index appears valid, false if it might be stale.
 */
export function validateTemplateIndex(
  discovery: TemplateDiscoveryResult,
  categoryName: string,
  templateIndex: number,
  expectedName?: string,
): { valid: boolean; reason?: string } {
  const category = discovery.categories.find(
    c => c.name.toLowerCase() === categoryName.toLowerCase(),
  );

  if (!category) {
    return { valid: false, reason: `Category "${categoryName}" not found in discovered templates` };
  }

  const template = category.templates.find(t => t.index === templateIndex);
  if (!template) {
    return {
      valid: false,
      reason: `Template index ${templateIndex} out of range for "${categoryName}" (max: ${category.templates.length - 1})`,
    };
  }

  // If an expected name was provided, check for a fuzzy match
  if (expectedName) {
    const normalizedExpected = expectedName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedActual = template.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalizedActual.includes(normalizedExpected) && !normalizedExpected.includes(normalizedActual)) {
      return {
        valid: false,
        reason: `Template at index ${templateIndex} is "${template.name}", expected "${expectedName}" — index may have shifted`,
      };
    }
  }

  return { valid: true };
}
