import { getDb } from './database.js';
import { logger } from '../utils/logger.js';

export interface AgentEventRow {
  id: number;
  taskId: string | null;
  eventType: string;
  data: Record<string, unknown>;
  createdAt: string;
}

interface RawRow {
  id: number;
  task_id: string | null;
  event_type: string;
  data: string;
  created_at: string;
}

export function insertAgentEvent(
  eventType: string,
  taskId: string | null,
  data: Record<string, unknown>,
): void {
  try {
    getDb()
      .prepare('INSERT INTO agent_events (task_id, event_type, data) VALUES (?, ?, ?)')
      .run(taskId ?? null, eventType, JSON.stringify(data));
  } catch (err) {
    logger.warn({ err, eventType, taskId }, 'Failed to persist agent event');
  }
}

function mapRow(row: RawRow): AgentEventRow {
  return {
    id: row.id,
    taskId: row.task_id,
    eventType: row.event_type,
    data: JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

export function getAgentEventsByTask(taskId: string): AgentEventRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_events WHERE task_id = ? ORDER BY id ASC')
    .all(taskId) as RawRow[];
  return rows.map(mapRow);
}

export function getRecentAgentEvents(limit = 200): AgentEventRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM agent_events ORDER BY id DESC LIMIT ?')
    .all(limit) as RawRow[];
  return rows.map(mapRow).reverse();
}

export function deleteOldAgentEvents(daysOld = 7): number {
  const result = getDb()
    .prepare("DELETE FROM agent_events WHERE created_at < datetime('now', ?)")
    .run(`-${daysOld} days`);
  if (result.changes > 0) {
    logger.info({ deleted: result.changes, daysOld }, 'Cleaned up old agent events');
  }
  return result.changes;
}
