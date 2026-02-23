import { getDb } from './database.js';
import { logger } from '../utils/logger.js';

export interface AuditEntry {
  id: number;
  taskId?: string;
  action: string;
  details?: string;
  screenshotPath?: string;
  createdAt: string;
}

export function logAction(taskId: string | null, action: string, details?: string, screenshotPath?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (task_id, action, details, screenshot_path)
    VALUES (?, ?, ?, ?)
  `).run(taskId, action, details ?? null, screenshotPath ?? null);

  logger.debug({ taskId, action }, 'Audit log entry created');
}

export function getAuditLog(taskId: string): AuditEntry[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM audit_log WHERE task_id = ? ORDER BY created_at ASC',
  ).all(taskId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as number,
    taskId: row.task_id as string | undefined,
    action: row.action as string,
    details: row.details as string | undefined,
    screenshotPath: row.screenshot_path as string | undefined,
    createdAt: row.created_at as string,
  }));
}

export function getRecentAuditLog(limit = 50): AuditEntry[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as number,
    taskId: row.task_id as string | undefined,
    action: row.action as string,
    details: row.details as string | undefined,
    screenshotPath: row.screenshot_path as string | undefined,
    createdAt: row.created_at as string,
  }));
}
