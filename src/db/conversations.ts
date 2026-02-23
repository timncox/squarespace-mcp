import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import type { Conversation, ConversationStatus, ConversationSource } from '../models/conversation.js';
import { logger } from '../utils/logger.js';

export interface CreateConversationInput {
  /** Email ID — required for email-originated, optional for WhatsApp-originated */
  emailId?: string;
  /** How this conversation was initiated */
  source: ConversationSource;
  taskIds: string[];
  summaryText: string;
  /** Original user message text (before LLM rewriting) — used for planning detection */
  originalMessage?: string;
}

export function createConversation(input: CreateConversationInput): Conversation {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO conversations (id, email_id, source, status, task_ids, summary_text, original_message, created_at, updated_at)
    VALUES (?, ?, ?, 'awaiting_confirm', ?, ?, ?, ?, ?)
  `).run(
    id,
    input.emailId ?? null,
    input.source,
    JSON.stringify(input.taskIds),
    input.summaryText,
    input.originalMessage ?? null,
    now,
    now,
  );

  logger.info({ conversationId: id, source: input.source, taskCount: input.taskIds.length }, 'Conversation created');
  return getConversation(id)!;
}

export function getConversation(id: string): Conversation | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToConversation(row);
}

/**
 * Get the most recent active conversation.
 * @deprecated Use getActiveConversations() or getInteractiveConversations() for concurrent support.
 */
export function getActiveConversation(): Conversation | undefined {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM conversations
    WHERE status IN ('awaiting_confirm', 'clarifying', 'executing', 'planning', 'awaiting_plan_approval', 'revising')
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToConversation(row);
}

/** Get ALL active conversations (any non-terminal status), most recently updated first. */
export function getActiveConversations(): Conversation[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM conversations
    WHERE status IN ('awaiting_confirm', 'clarifying', 'executing', 'planning', 'awaiting_plan_approval', 'revising')
    ORDER BY updated_at DESC
  `).all() as Record<string, unknown>[];
  return rows.map(rowToConversation);
}

/** Get conversations waiting for user input (not busy executing/planning). */
export function getInteractiveConversations(): Conversation[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM conversations
    WHERE status IN ('awaiting_confirm', 'clarifying', 'awaiting_plan_approval')
    ORDER BY updated_at DESC
  `).all() as Record<string, unknown>[];
  return rows.map(rowToConversation);
}

export function getConversationByEmailId(emailId: string): Conversation | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM conversations WHERE email_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(emailId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToConversation(row);
}

export function updateConversationStatus(id: string, status: ConversationStatus): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now, id);
  logger.info({ conversationId: id, status }, 'Conversation status updated');

  // Emit to dashboard SSE (fire-and-forget)
  import('../services/dashboard-events.js').then(({ dashboardEvents }) => {
    dashboardEvents.emit('dashboard', {
      type: 'conversation_update',
      data: { conversationId: id, status },
      timestamp: now,
    });
  }).catch((err) => { import('../utils/logger.js').then(({ logger }) => logger.warn({ error: err }, 'Failed to emit conversation_update SSE')); });
}

export function addTasksToConversation(id: string, newTaskIds: string[]): void {
  const db = getDb();
  const conversation = getConversation(id);
  if (!conversation) return;

  const allTaskIds = [...conversation.taskIds, ...newTaskIds];
  const now = new Date().toISOString();

  db.prepare('UPDATE conversations SET task_ids = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(allTaskIds), now, id);
  logger.info({ conversationId: id, addedTasks: newTaskIds.length }, 'Tasks added to conversation');
}

export function updateConversationPlan(id: string, contentPlanJson: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE conversations SET content_plan = ?, updated_at = ? WHERE id = ?')
    .run(contentPlanJson, now, id);
  logger.info({ conversationId: id }, 'Conversation content plan updated');
}

export function updateConversationFeedback(id: string, feedback: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE conversations SET plan_feedback = ?, updated_at = ? WHERE id = ?')
    .run(feedback, now, id);
  logger.info({ conversationId: id }, 'Conversation plan feedback updated');
}

export function getRecentConversations(limit = 10): Conversation[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToConversation);
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    emailId: (row.email_id as string) || undefined,
    source: (row.source as ConversationSource) || 'email',
    status: row.status as ConversationStatus,
    taskIds: JSON.parse(row.task_ids as string) as string[],
    summaryText: row.summary_text as string,
    contentPlan: (row.content_plan as string) || undefined,
    planFeedback: (row.plan_feedback as string) || undefined,
    originalMessage: (row.original_message as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
