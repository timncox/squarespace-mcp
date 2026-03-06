import { getDb } from '../db/database.js';
import { errMsg } from '../utils/errors.js';

interface SaveSnapshotParams {
  siteId: string;
  pageSectionsId: string;
  collectionId?: string;
  sections: unknown[];
  label?: string;
  isAuto?: boolean;
}

interface SnapshotSummary {
  id: number;
  siteId: string;
  pageSectionsId: string;
  label: string | null;
  isAuto: boolean;
  sectionCount: number;
  createdAt: string;
}

interface SnapshotRecord {
  id: number;
  siteId: string;
  pageSectionsId: string;
  collectionId: string | null;
  sections: unknown[];
  label: string | null;
  isAuto: boolean;
  createdAt: string;
}

export function saveSnapshot(params: SaveSnapshotParams): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO section_snapshots (site_id, page_sections_id, collection_id, sections_json, label, is_auto)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const result = stmt.run(
    params.siteId,
    params.pageSectionsId,
    params.collectionId ?? null,
    JSON.stringify(params.sections),
    params.label ?? null,
    params.isAuto ? 1 : 0,
  );
  return result.lastInsertRowid as number;
}

export function listSnapshots(opts: {
  siteId?: string;
  pageSectionsId?: string;
  limit?: number;
  includeAuto?: boolean;
}): SnapshotSummary[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (opts.siteId) {
    conditions.push('site_id = ?');
    values.push(opts.siteId);
  }
  if (opts.pageSectionsId) {
    conditions.push('page_sections_id = ?');
    values.push(opts.pageSectionsId);
  }
  if (opts.includeAuto === false) {
    conditions.push('is_auto = 0');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;

  const rows = db.prepare(
    `SELECT id, site_id, page_sections_id, label, is_auto, sections_json, created_at
     FROM section_snapshots ${where}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(...values, limit) as Array<{
    id: number;
    site_id: string;
    page_sections_id: string;
    label: string | null;
    is_auto: number;
    sections_json: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    siteId: r.site_id,
    pageSectionsId: r.page_sections_id,
    label: r.label,
    isAuto: r.is_auto === 1,
    sectionCount: (JSON.parse(r.sections_json) as unknown[]).length,
    createdAt: r.created_at,
  }));
}

export function getSnapshot(id: number): SnapshotRecord | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, site_id, page_sections_id, collection_id, sections_json, label, is_auto, created_at
     FROM section_snapshots WHERE id = ?`,
  ).get(id) as {
    id: number;
    site_id: string;
    page_sections_id: string;
    collection_id: string | null;
    sections_json: string;
    label: string | null;
    is_auto: number;
    created_at: string;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    siteId: row.site_id,
    pageSectionsId: row.page_sections_id,
    collectionId: row.collection_id,
    sections: JSON.parse(row.sections_json) as unknown[],
    label: row.label,
    isAuto: row.is_auto === 1,
    createdAt: row.created_at,
  };
}

export function deleteSnapshot(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM section_snapshots WHERE id = ?').run(id);
  return result.changes > 0;
}

export function shouldAutoSnapshot(
  siteId: string,
  pageSectionsId: string,
  dedupMinutes = 5,
): boolean {
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM section_snapshots
     WHERE site_id = ? AND page_sections_id = ? AND is_auto = 1
       AND created_at > datetime('now', ?)
     LIMIT 1`,
  ).get(siteId, pageSectionsId, `-${dedupMinutes} minutes`) as { id: number } | undefined;

  return !row;
}

export function cleanupOldSnapshots(retentionDays = 7): number {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM section_snapshots
     WHERE is_auto = 1 AND created_at < datetime('now', ?)`,
  ).run(`-${retentionDays} days`);
  return result.changes;
}
