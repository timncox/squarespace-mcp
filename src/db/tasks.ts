import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import type { Task, TaskStatus, TaskType } from '../models/task.js';
import { logger } from '../utils/logger.js';

export interface CreateTaskInput {
  emailId?: string;
  taskType: TaskType;
  clientName: string;
  siteId: string;
  targetPage?: string;
  contentToFind?: string;
  contentToAdd?: string;
  attachmentFilename?: string;
  attachmentPath?: string;
  /** Free-text description of what to do — fed to the browser agent */
  description?: string;
  /** Path to a reference image (e.g., WhatsApp screenshot) showing what to change */
  referenceImagePath?: string;
  /** Paths to multiple reference images (JSON-serialized array) */
  imagePaths?: string[];
  applyToAllSites: boolean;
  groupId?: string;
  needsClarification: boolean;
  clarificationQuestion?: string;
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO tasks (
      id, email_id, task_type, client_name, site_id, target_page,
      content_to_find, content_to_add, attachment_filename, attachment_path,
      description, reference_image_path, image_paths, apply_to_all_sites, group_id,
      needs_clarification, clarification_question,
      status, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
    )
  `).run(
    id,
    input.emailId ?? null,
    input.taskType,
    input.clientName,
    input.siteId,
    input.targetPage ?? null,
    input.contentToFind ?? null,
    input.contentToAdd ?? null,
    input.attachmentFilename ?? null,
    input.attachmentPath ?? null,
    input.description ?? null,
    input.referenceImagePath ?? null,
    input.imagePaths ? JSON.stringify(input.imagePaths) : null,
    input.applyToAllSites ? 1 : 0,
    input.groupId ?? null,
    input.needsClarification ? 1 : 0,
    input.clarificationQuestion ?? null,
    now,
    now,
  );

  logger.info({ taskId: id, taskType: input.taskType, siteId: input.siteId }, 'Task created');
  return getTask(id)!;
}

export function getTask(id: string): Task | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToTask(row);
}

export function getTasksByStatus(status: TaskStatus): Task[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC').all(status) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getTasksByEmailId(emailId: string): Task[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM tasks WHERE email_id = ? ORDER BY created_at ASC').all(emailId) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getAllTasks(limit = 50): Task[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function updateTaskStatus(id: string, status: TaskStatus, errorMessage?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?
  `).run(status, errorMessage ?? null, now, id);

  logger.info({ taskId: id, status, errorMessage }, 'Task status updated');

  // Emit to dashboard SSE (fire-and-forget)
  import('../services/dashboard-events.js').then(({ dashboardEvents }) => {
    dashboardEvents.emit('dashboard', {
      type: 'task_update',
      data: { taskId: id, status, errorMessage },
      timestamp: now,
    });
  }).catch((err) => { import('../utils/logger.js').then(({ logger }) => logger.warn({ error: err }, 'Failed to emit task_update SSE')); });
}

export function updateTaskScreenshot(id: string, screenshotPath: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET screenshot_path = ?, updated_at = ? WHERE id = ?
  `).run(screenshotPath, now, id);
}

/**
 * Update a task's site info after clarification resolves the target site.
 * Clears needsClarification and updates siteId, clientName, and optionally targetPage/description.
 */
export function updateTaskSiteInfo(
  id: string,
  updates: {
    siteId: string;
    clientName: string;
    targetPage?: string;
    description?: string;
  },
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks
    SET site_id = ?, client_name = ?, target_page = COALESCE(?, target_page),
        description = COALESCE(?, description),
        needs_clarification = 0, clarification_question = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(
    updates.siteId,
    updates.clientName,
    updates.targetPage ?? null,
    updates.description ?? null,
    now,
    id,
  );

  logger.info({ taskId: id, siteId: updates.siteId, clientName: updates.clientName }, 'Task site info updated after clarification');
}

/**
 * Increment the attempt count and store the last error for retry tracking.
 * Returns the new attempt count.
 */
export function incrementTaskAttempt(id: string, lastError: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ? WHERE id = ?
  `).run(lastError, now, id);

  const task = getTask(id);
  const newCount = task?.attemptCount ?? 1;
  logger.info({ taskId: id, attemptCount: newCount, lastError }, 'Task attempt incremented');
  return newCount;
}

/**
 * Update a task's image paths (e.g., when gallery images are provided after initial request).
 */
export function updateTaskImagePaths(id: string, imagePaths: string[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET image_paths = ?, updated_at = ? WHERE id = ?
  `).run(JSON.stringify(imagePaths), now, id);

  logger.info({ taskId: id, imageCount: imagePaths.length }, 'Task image paths updated');
}

export function updateTaskOriginalContent(id: string, originalContent: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET original_content = ?, updated_at = ? WHERE id = ?
  `).run(originalContent, now, id);
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    taskType: row.task_type as TaskType,
    clientName: row.client_name as string,
    siteId: row.site_id as string,
    targetPage: row.target_page as string | undefined,
    contentToFind: row.content_to_find as string | undefined,
    contentToAdd: row.content_to_add as string | undefined,
    attachmentFilename: row.attachment_filename as string | undefined,
    attachmentPath: row.attachment_path as string | undefined,
    description: row.description as string | undefined,
    applyToAllSites: (row.apply_to_all_sites as number) === 1,
    groupId: row.group_id as string | undefined,
    needsClarification: (row.needs_clarification as number) === 1,
    clarificationQuestion: row.clarification_question as string | undefined,
    status: row.status as TaskStatus,
    errorMessage: row.error_message as string | undefined,
    screenshotPath: row.screenshot_path as string | undefined,
    referenceImagePath: row.reference_image_path as string | undefined,
    imagePaths: row.image_paths ? JSON.parse(row.image_paths as string) as string[] : undefined,
    originalContent: row.original_content as string | undefined,
    attemptCount: (row.attempt_count as number) ?? 0,
    lastError: row.last_error as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
