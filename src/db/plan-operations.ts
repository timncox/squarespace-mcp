import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import { logger } from '../utils/logger.js';
import type { ContentPlan, ContentOperation } from '../agents/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PlanOperationStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'skipped';

export interface PlanOperation {
  id: string;
  conversationId: string;
  taskId: string | null;
  operationIndex: number;
  operationType: string;
  targetPage: string | null;
  placement: string | null;
  contentStrategy: string | null;
  status: PlanOperationStatus;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface PlanOperationSummary {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  skipped: number;
  executing: number;
}

interface RawRow {
  id: string;
  conversation_id: string;
  task_id: string | null;
  operation_index: number;
  operation_type: string;
  target_page: string | null;
  placement: string | null;
  content_strategy: string | null;
  status: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

// ─── Row Mapper ─────────────────────────────────────────────────────────────

function rowToOperation(row: RawRow): PlanOperation {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    operationIndex: row.operation_index,
    operationType: row.operation_type,
    targetPage: row.target_page,
    placement: row.placement,
    contentStrategy: row.content_strategy,
    status: row.status as PlanOperationStatus,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

// ─── CRUD Functions ─────────────────────────────────────────────────────────

/**
 * Bulk insert all operations from a ContentPlan when it is approved.
 * Each operation gets a UUID and is linked to the conversation.
 */
export function createPlanOperations(conversationId: string, plan: ContentPlan): PlanOperation[] {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO plan_operations (
      id, conversation_id, task_id, operation_index, operation_type,
      target_page, placement, content_strategy, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
  `);

  const operations: PlanOperation[] = [];

  const insertAll = db.transaction(() => {
    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i];
      const id = randomUUID();
      insert.run(
        id,
        conversationId,
        op.taskId ?? null,
        i,
        op.operationType,
        op.targetPage ?? null,
        op.placement ?? null,
        op.content.contentStrategy ?? null,
      );

      operations.push({
        id,
        conversationId,
        taskId: op.taskId ?? null,
        operationIndex: i,
        operationType: op.operationType,
        targetPage: op.targetPage ?? null,
        placement: op.placement ?? null,
        contentStrategy: op.content.contentStrategy ?? null,
        status: 'pending',
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
      });
    }
  });

  insertAll();

  logger.info(
    { conversationId, operationCount: operations.length },
    'Plan operations persisted',
  );

  return operations;
}

/**
 * Update the status of a single operation.
 * Emits an SSE event for real-time dashboard updates.
 */
export function updateOperationStatus(
  id: string,
  status: PlanOperationStatus,
  errorMessage?: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const updates: Record<string, string | null> = {
    status,
    error_message: errorMessage ?? null,
  };

  if (status === 'executing') {
    updates.started_at = now;
  }

  if (status === 'succeeded' || status === 'failed' || status === 'skipped') {
    updates.completed_at = now;
  }

  db.prepare(`
    UPDATE plan_operations
    SET status = ?, error_message = ?,
        started_at = COALESCE(?, started_at),
        completed_at = COALESCE(?, completed_at)
    WHERE id = ?
  `).run(
    status,
    updates.error_message,
    updates.started_at ?? null,
    updates.completed_at ?? null,
    id,
  );

  logger.info({ operationId: id, status, errorMessage }, 'Plan operation status updated');

  // Emit SSE event (fire-and-forget, dynamic import to avoid circular deps)
  const op = getOperationById(id);
  import('../services/dashboard-events.js').then(({ dashboardEvents }) => {
    dashboardEvents.emit('dashboard', {
      type: 'operation_update',
      data: {
        operationId: id,
        status,
        operationType: op?.operationType ?? '',
        targetPage: op?.targetPage ?? '',
        contentStrategy: op?.contentStrategy ?? '',
        errorMessage: errorMessage ?? null,
        conversationId: op?.conversationId ?? '',
      },
      timestamp: now,
    });
  }).catch(() => {});
}

/**
 * Get a single operation by its ID.
 */
export function getOperationById(id: string): PlanOperation | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM plan_operations WHERE id = ?').get(id) as RawRow | undefined;
  if (!row) return undefined;
  return rowToOperation(row);
}

/**
 * Get all operations for a conversation, ordered by operation_index.
 */
export function getOperationsByConversation(conversationId: string): PlanOperation[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM plan_operations WHERE conversation_id = ? ORDER BY operation_index ASC',
  ).all(conversationId) as RawRow[];
  return rows.map(rowToOperation);
}

/**
 * Get all operations for a given task ID.
 */
export function getOperationsByTask(taskId: string): PlanOperation[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM plan_operations WHERE task_id = ? ORDER BY operation_index ASC',
  ).all(taskId) as RawRow[];
  return rows.map(rowToOperation);
}

/**
 * Get only failed operations for a conversation.
 */
export function getFailedOperations(conversationId: string): PlanOperation[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM plan_operations WHERE conversation_id = ? AND status = 'failed' ORDER BY operation_index ASC",
  ).all(conversationId) as RawRow[];
  return rows.map(rowToOperation);
}

/**
 * Get a summary of operation statuses for a conversation.
 */
export function getPlanOperationSummary(conversationId: string): PlanOperationSummary {
  const db = getDb();
  const rows = db.prepare(
    'SELECT status, COUNT(*) as cnt FROM plan_operations WHERE conversation_id = ? GROUP BY status',
  ).all(conversationId) as Array<{ status: string; cnt: number }>;

  const summary: PlanOperationSummary = {
    total: 0,
    succeeded: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    executing: 0,
  };

  for (const row of rows) {
    const count = row.cnt;
    summary.total += count;

    switch (row.status) {
      case 'succeeded': summary.succeeded = count; break;
      case 'failed': summary.failed = count; break;
      case 'pending': summary.pending = count; break;
      case 'skipped': summary.skipped = count; break;
      case 'executing': summary.executing = count; break;
    }
  }

  return summary;
}

/**
 * Get operations for a conversation that match specific task IDs.
 * Used when looking up operations for dashboard task detail view.
 */
export function getOperationsByConversationAndTask(
  conversationId: string,
  taskId: string,
): PlanOperation[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM plan_operations WHERE conversation_id = ? AND task_id = ? ORDER BY operation_index ASC',
  ).all(conversationId, taskId) as RawRow[];
  return rows.map(rowToOperation);
}
