/**
 * Database helpers for the learnings table — cross-execution memory.
 *
 * Follows the same patterns as tasks.ts and conversations.ts:
 * - UUID text primary keys
 * - ISO timestamp strings
 * - JSON.stringify/parse for complex fields
 * - Defensive COALESCE updates
 */

import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type LearningCategory =
  | 'selector_discovery'
  | 'interaction_pattern'
  | 'failure_recovery'
  | 'site_specific'
  | 'editor_workflow'
  | 'workflow_sequence'
  | 'negative_pattern';

export interface Learning {
  id: string;
  category: LearningCategory;
  patternKey: string;
  description: string;
  promptTip: string;
  siteId?: string;
  pageContext?: string;
  confidence: number;
  confirmationCount: number;
  contradictionCount: number;
  sourceTaskId?: string;
  selectors?: string[];
  context?: Record<string, unknown>;
  /** Whether this is a positive ("do this") or negative ("don't do this") pattern */
  polarity: 'positive' | 'negative';
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  isActive: boolean;
}

export interface CreateLearningInput {
  category: LearningCategory;
  patternKey: string;
  description: string;
  promptTip: string;
  siteId?: string;
  pageContext?: string;
  confidence?: number;
  sourceTaskId?: string;
  selectors?: string[];
  context?: Record<string, unknown>;
  /** Defaults to 'positive' if not specified */
  polarity?: 'positive' | 'negative';
}

// ─── CRUD Operations ────────────────────────────────────────────────────────

/**
 * Create a new learning or confirm (boost) an existing one.
 * Deduplicates by (pattern_key, site_id).
 */
export function upsertLearning(input: CreateLearningInput): Learning {
  const db = getDb();
  const now = new Date().toISOString();

  // Try to find existing learning with same pattern_key + site_id
  const existing = db
    .prepare(
      `SELECT * FROM learnings
       WHERE pattern_key = ? AND (site_id IS ? OR (site_id IS NULL AND ? IS NULL))`,
    )
    .get(input.patternKey, input.siteId ?? null, input.siteId ?? null) as
    | Record<string, unknown>
    | undefined;

  if (existing) {
    // Boost confidence and increment confirmation count
    const newConfirmations = (existing.confirmation_count as number) + 1;
    const newConfidence = Math.min(1.0, (existing.confidence as number) + 0.1);

    db.prepare(
      `UPDATE learnings
       SET confidence = ?, confirmation_count = ?, updated_at = ?,
           description = COALESCE(?, description),
           prompt_tip = COALESCE(?, prompt_tip)
       WHERE id = ?`,
    ).run(newConfidence, newConfirmations, now, input.description, input.promptTip, existing.id as string);

    logger.info(
      { id: existing.id, patternKey: input.patternKey, confidence: newConfidence },
      'Learning confirmed (boosted)',
    );
    return getLearning(existing.id as string)!;
  }

  // Create new learning
  const id = randomUUID();
  db.prepare(
    `INSERT INTO learnings (
       id, category, pattern_key, description, prompt_tip,
       site_id, page_context, confidence, confirmation_count, contradiction_count,
       source_task_id, selectors, context, polarity,
       created_at, updated_at, is_active
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    id,
    input.category,
    input.patternKey,
    input.description,
    input.promptTip,
    input.siteId ?? null,
    input.pageContext ?? null,
    input.confidence ?? 0.5,
    input.sourceTaskId ?? null,
    input.selectors ? JSON.stringify(input.selectors) : null,
    input.context ? JSON.stringify(input.context) : null,
    input.polarity ?? 'positive',
    now,
    now,
  );

  logger.info({ id, category: input.category, patternKey: input.patternKey }, 'New learning created');
  return getLearning(id)!;
}

/**
 * Get a single learning by ID.
 */
export function getLearning(id: string): Learning | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return rowToLearning(row);
}

/**
 * Get active learnings relevant to a specific task context.
 * Returns universal learnings + site-specific ones, sorted by confidence descending.
 * Marks returned learnings as "used" (updates last_used_at).
 *
 * Confidence threshold: 0.5 (raised from 0.3 to filter low-quality learnings).
 * Optional category filter — pass relevant categories to reduce noise.
 */
export function getRelevantLearnings(
  siteId?: string,
  pageContext?: string,
  categories?: LearningCategory[],
): Learning[] {
  const db = getDb();

  // Build dynamic query with optional category filter
  let sql = `SELECT * FROM learnings
     WHERE is_active = 1
       AND confidence >= 0.5
       AND (site_id IS NULL OR site_id = ?)
       AND (page_context IS NULL OR page_context = ?)`;

  const params: unknown[] = [siteId ?? null, pageContext ?? null];

  if (categories && categories.length > 0) {
    const placeholders = categories.map(() => '?').join(',');
    sql += ` AND category IN (${placeholders})`;
    params.push(...categories);
  }

  sql += ` ORDER BY confidence DESC, confirmation_count DESC LIMIT 10`;

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  // Mark these learnings as "used"
  if (rows.length > 0) {
    const now = new Date().toISOString();
    const ids = rows.map((r) => r.id as string);
    const idPlaceholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE learnings SET last_used_at = ? WHERE id IN (${idPlaceholders})`).run(now, ...ids);
  }

  return rows.map(rowToLearning);
}

/**
 * Record a contradiction — learning didn't hold up in practice.
 * Reduces confidence by 0.15. Deactivates if confidence hits 0.
 */
export function contradictLearning(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE learnings
     SET contradiction_count = contradiction_count + 1,
         confidence = MAX(0.0, confidence - 0.15),
         updated_at = ?
     WHERE id = ?`,
  ).run(now, id);

  // If confidence dropped to 0, deactivate
  db.prepare(
    `UPDATE learnings SET is_active = 0, updated_at = ?
     WHERE id = ? AND confidence <= 0.0`,
  ).run(now, id);

  logger.info({ id }, 'Learning contradicted');
}

/**
 * Decay old learnings that haven't been confirmed recently.
 * Learnings older than 30 days without use lose 0.02 confidence (reduced from 0.05
 * to prevent useful long-term patterns from decaying too quickly).
 * Deactivated when confidence reaches 0.
 */
export function decayOldLearnings(): number {
  const db = getDb();
  const now = new Date().toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Decay confidence for stale learnings (0.02 per 30 days)
  const result = db
    .prepare(
      `UPDATE learnings
       SET confidence = MAX(0.0, confidence - 0.02),
           updated_at = ?
       WHERE is_active = 1
         AND updated_at < ?
         AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .run(now, thirtyDaysAgo, thirtyDaysAgo);

  // Deactivate zero-confidence learnings
  db.prepare(
    `UPDATE learnings SET is_active = 0, updated_at = ?
     WHERE is_active = 1 AND confidence <= 0.0`,
  ).run(now);

  const decayed = result.changes;
  if (decayed > 0) {
    logger.info({ decayed }, 'Decayed stale learnings');
  }
  return decayed;
}

/**
 * Get all active learnings (for debugging/admin).
 */
export function getAllActiveLearnings(): Learning[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM learnings WHERE is_active = 1 ORDER BY confidence DESC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToLearning);
}

// ─── Row Mapper ─────────────────────────────────────────────────────────────

function rowToLearning(row: Record<string, unknown>): Learning {
  return {
    id: row.id as string,
    category: row.category as LearningCategory,
    patternKey: row.pattern_key as string,
    description: row.description as string,
    promptTip: row.prompt_tip as string,
    siteId: (row.site_id as string) || undefined,
    pageContext: (row.page_context as string) || undefined,
    confidence: row.confidence as number,
    confirmationCount: row.confirmation_count as number,
    contradictionCount: row.contradiction_count as number,
    sourceTaskId: (row.source_task_id as string) || undefined,
    selectors: row.selectors ? (JSON.parse(row.selectors as string) as string[]) : undefined,
    context: row.context ? (JSON.parse(row.context as string) as Record<string, unknown>) : undefined,
    polarity: (row.polarity as string) === 'negative' ? 'negative' : 'positive',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastUsedAt: (row.last_used_at as string) || undefined,
    isActive: (row.is_active as number) === 1,
  };
}
