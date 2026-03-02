/**
 * Database helpers for the user_memories table — cross-conversation user preferences.
 */

import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MemoryCategory =
  | 'client_preference'
  | 'site_rule'
  | 'workflow_shortcut'
  | 'general';

export interface UserMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  siteId?: string;
  tags?: string[];
  source: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveMemoryInput {
  content: string;
  category: MemoryCategory;
  siteId?: string;
  tags?: string[];
  source: string;
}

// ─── CRUD Operations ────────────────────────────────────────────────────────

export function saveMemory(input: SaveMemoryInput): UserMemory {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .prepare(
      `SELECT * FROM user_memories
       WHERE content = ? AND (site_id IS ? OR (site_id IS NULL AND ? IS NULL))`,
    )
    .get(input.content, input.siteId ?? null, input.siteId ?? null) as
    | Record<string, unknown>
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE user_memories
       SET active = 1, category = ?, tags = ?, source = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.category, input.tags ? JSON.stringify(input.tags) : null, input.source, now, existing.id as string);

    logger.info({ id: existing.id, content: input.content }, 'Memory reactivated');
    return getMemory(existing.id as string)!;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO user_memories (id, content, category, site_id, tags, source, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.content,
    input.category,
    input.siteId ?? null,
    input.tags ? JSON.stringify(input.tags) : null,
    input.source,
    now,
    now,
  );

  logger.info({ id, category: input.category, siteId: input.siteId }, 'New memory created');
  return getMemory(id)!;
}

export function getMemory(id: string): UserMemory | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return rowToMemory(row);
}

export function getRelevantMemories(
  siteId?: string,
  categories?: MemoryCategory[],
): UserMemory[] {
  const db = getDb();

  let sql = `SELECT * FROM user_memories
     WHERE active = 1
       AND (site_id IS NULL OR site_id = ?)`;

  const params: unknown[] = [siteId ?? null];

  if (categories && categories.length > 0) {
    const placeholders = categories.map(() => '?').join(',');
    sql += ` AND category IN (${placeholders})`;
    params.push(...categories);
  }

  sql += ` ORDER BY updated_at DESC LIMIT 20`;

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToMemory);
}

export function forgetMemory(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE user_memories SET active = 0, updated_at = ? WHERE id = ?').run(now, id);
  logger.info({ id }, 'Memory forgotten');
}

export function listMemories(siteId?: string): UserMemory[] {
  const db = getDb();

  if (siteId) {
    const rows = db
      .prepare('SELECT * FROM user_memories WHERE active = 1 AND site_id = ? ORDER BY updated_at DESC')
      .all(siteId) as Record<string, unknown>[];
    return rows.map(rowToMemory);
  }

  const rows = db
    .prepare('SELECT * FROM user_memories WHERE active = 1 ORDER BY updated_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToMemory);
}

// ─── Row Mapper ─────────────────────────────────────────────────────────────

function rowToMemory(row: Record<string, unknown>): UserMemory {
  return {
    id: row.id as string,
    content: row.content as string,
    category: row.category as MemoryCategory,
    siteId: (row.site_id as string) || undefined,
    tags: row.tags ? (JSON.parse(row.tags as string) as string[]) : undefined,
    source: row.source as string,
    active: (row.active as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
