/**
 * Task execution — routes all tasks through the MCP orchestrator pipeline.
 */

import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';
import { updateConversationStatus } from '../../db/conversations.js';
import { createTask, getTask, updateTaskStatus } from '../../db/tasks.js';
import { decayOldLearnings } from '../../db/learnings.js';
import { sendToTim } from '../whatsapp.js';
import { loadSitesConfig } from '../task-extractor.js';
import { getClientsInGroup } from '../../models/site-config.js';
import { orchestrateTask } from '../../orchestrator/orchestrator.js';
import { dashboardEvents } from '../dashboard-events.js';
import type { Conversation } from '../../models/conversation.js';

// ─── Task Execution (main entry point) ──────────────────────────────────────

/**
 * Execute all tasks in a conversation sequentially via MCP orchestrator.
 * Sends progress updates to Tim via WhatsApp after each task.
 */
export async function executeTasks(conversation: Conversation): Promise<void> {
  // Periodic maintenance: decay stale learnings (cheap, synchronous SQLite)
  try { decayOldLearnings(); } catch { /* non-blocking */ }

  const expandedTaskIds = expandMultiSiteTasks(conversation.taskIds);
  const total = expandedTaskIds.length;
  let completed = 0;
  let failed = 0;

  for (const taskId of expandedTaskIds) {
    const task = getTask(taskId);
    if (!task) { failed++; continue; }

    updateTaskStatus(taskId, 'executing');
    dashboardEvents.emit('task_update', { taskId, status: 'executing' });

    try {
      const result = await orchestrateTask(task, conversation);
      const status = result.success ? 'done' : 'failed';
      updateTaskStatus(taskId, status, result.success ? undefined : result.verdict?.issues?.join(', '));
      dashboardEvents.emit('task_update', { taskId, status });

      if (result.success) completed++;
      else failed++;

      if (conversation.source !== 'dashboard') {
        await sendToTim(
          result.success
            ? `Done: ${task.description}`
            : `Failed: ${result.verdict?.issues?.join(', ') ?? 'Unknown error'}`,
          conversation.id,
        );
      }
    } catch (err) {
      failed++;
      updateTaskStatus(taskId, 'failed', errMsg(err));
      dashboardEvents.emit('task_update', { taskId, status: 'failed' });
      logger.error({ taskId, error: errMsg(err) }, 'Task orchestration error');
    }
  }

  updateConversationStatus(conversation.id, 'completed');
  logger.info({ total, completed, failed, conversationId: conversation.id }, 'All tasks finished');
}

/**
 * Legacy alias — plan approval now handled by orchestrator (REQUIRE_PLAN_APPROVAL env var).
 * Kept for backward compatibility with message-handlers.ts approvePlan().
 */
export const executeTasksWithPlan = executeTasks;

// ─── Multi-Site Expansion ────────────────────────────────────────────────────

function expandMultiSiteTasks(taskIds: string[]): string[] {
  const sitesConfig = loadSitesConfig();
  const expandedIds: string[] = [];

  for (const taskId of taskIds) {
    const task = getTask(taskId);
    if (!task) {
      expandedIds.push(taskId);
      continue;
    }

    if (!task.applyToAllSites || !task.groupId) {
      expandedIds.push(taskId);
      continue;
    }

    // Expand to all sites in the group
    const clients = getClientsInGroup(sitesConfig, task.groupId);

    if (clients.length === 0) {
      logger.warn({ groupId: task.groupId }, 'No clients found in group, keeping original task');
      expandedIds.push(taskId);
      continue;
    }

    logger.info({ groupId: task.groupId, siteCount: clients.length }, 'Expanding multi-site task');

    for (const client of clients) {
      // Skip creating a duplicate if the original task already targets this site
      if (client.id === task.siteId) {
        expandedIds.push(taskId);
        continue;
      }

      // Clone the task for each additional site
      const cloned = createTask({
        emailId: undefined,
        taskType: task.taskType,
        clientName: client.name,
        siteId: client.id,
        targetPage: task.targetPage,
        contentToFind: task.contentToFind,
        contentToAdd: task.contentToAdd,
        attachmentFilename: task.attachmentFilename,
        attachmentPath: task.attachmentPath,
        description: task.description,
        referenceImagePath: task.referenceImagePath,
        applyToAllSites: false,
        groupId: undefined,
        needsClarification: task.needsClarification,
        clarificationQuestion: task.clarificationQuestion,
      });

      logger.info({ originalTaskId: taskId, clonedTaskId: cloned.id, siteId: client.id }, 'Cloned task for site');
      expandedIds.push(cloned.id);
    }
  }

  return expandedIds;
}
