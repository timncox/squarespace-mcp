import { getDb } from '../db/database.js';
import { logger } from '../utils/logger.js';

export interface BrowserFallback {
  intent: string;
  actions: string[];
  reason: string;
  selectors?: string[];
}

export interface BrowserFallbackRow {
  id: number;
  site_id: string;
  page_slug: string | null;
  intent: string;
  actions: string;  // JSON
  reason: string;
  selectors: string;  // JSON
  task_id: string | null;
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  resolved: number;
  resolved_tool: string | null;
}

export function parseBrowserFallbacks(executorOutput: string): BrowserFallback[] {
  const fallbacks: BrowserFallback[] = [];
  const regex = /BROWSER_FALLBACK:\s*(\{[^}]+\})/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(executorOutput)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      fallbacks.push({
        intent: parsed.intent ?? 'unknown',
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        reason: parsed.reason ?? 'unknown',
        selectors: Array.isArray(parsed.selectors) ? parsed.selectors : undefined,
      });
    } catch {
      // Couldn't parse JSON — create unstructured fallback from the raw text
      fallbacks.push({
        intent: 'unstructured',
        actions: [],
        reason: match[1].trim(),
      });
    }
  }

  return fallbacks;
}

export function logBrowserFallback(
  siteId: string,
  pageSlug: string | null,
  fallback: BrowserFallback,
  taskId?: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const actionsJson = JSON.stringify(fallback.actions);
  const selectorsJson = JSON.stringify(fallback.selectors ?? []);

  // Check for existing unresolved fallback with the same intent
  const existing = db.prepare(
    'SELECT id, occurrence_count FROM browser_fallbacks WHERE intent = ? AND site_id = ? AND resolved = 0',
  ).get(fallback.intent, siteId) as { id: number; occurrence_count: number } | undefined;

  if (existing) {
    db.prepare(
      'UPDATE browser_fallbacks SET occurrence_count = ?, last_seen = ?, actions = ?, reason = ?, selectors = ? WHERE id = ?',
    ).run(existing.occurrence_count + 1, now, actionsJson, fallback.reason, selectorsJson, existing.id);
    logger.info({ intent: fallback.intent, count: existing.occurrence_count + 1 }, 'Browser fallback count incremented');
  } else {
    db.prepare(
      `INSERT INTO browser_fallbacks (site_id, page_slug, intent, actions, reason, selectors, task_id, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(siteId, pageSlug, fallback.intent, actionsJson, fallback.reason, selectorsJson, taskId ?? null, now, now);
    logger.info({ intent: fallback.intent, siteId }, 'New browser fallback logged');
  }
}

export function getUnresolvedFallbacks(): BrowserFallbackRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM browser_fallbacks WHERE resolved = 0 ORDER BY occurrence_count DESC',
  ).all() as BrowserFallbackRow[];
}

export function resolveFallback(id: number, toolName: string): void {
  const db = getDb();
  db.prepare(
    'UPDATE browser_fallbacks SET resolved = 1, resolved_tool = ? WHERE id = ?',
  ).run(toolName, id);
  logger.info({ id, toolName }, 'Browser fallback resolved');
}
