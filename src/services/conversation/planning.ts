/**
 * Content planning pipeline — research, analysis, and plan formatting.
 */

import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';
import { logAction } from '../../db/audit-log.js';
import {
  updateConversationStatus,
  updateConversationPlan,
  updateConversationFeedback,
} from '../../db/conversations.js';
import { getTask } from '../../db/tasks.js';
import { sendToTim, sendButtonsToTim } from '../whatsapp.js';
import { runContentPipeline, reviseContentPlan } from '../../agents/coordinator.js';
import type { ContentPlan } from '../../agents/types.js';
import type { Task } from '../../models/task.js';
import type { Conversation } from '../../models/conversation.js';

// ─── Content Planning Detection ─────────────────────────────────────────────

/**
 * Determine whether a task needs the multi-agent content planning pipeline.
 * Returns true for creative/vague tasks where the agent would have to invent content.
 * Returns false for specific tasks like remove_content, replace_file, or tasks
 * with explicit content already provided.
 *
 * @param originalMessage - The original user message before LLM rewriting.
 *   The WhatsApp request interpreter strips creative keywords like "suggest",
 *   "come up with", "recommend" from the description, so checking the original
 *   message catches planning triggers that would otherwise be missed.
 */
export function taskNeedsContentPlanning(task: Task, originalMessage?: string): boolean {
  // Specific task types that never need planning
  if (task.taskType === 'remove_content') return false;
  if (task.taskType === 'replace_file') return false;
  if (task.taskType === 'upload_file_and_link') return false;

  // If the task has explicit content to add, no planning needed
  if (task.contentToAdd && task.contentToAdd.length > 20) return false;

  // PDF content is already extracted inline — skip planning, the content IS the plan
  if (task.description && task.description.includes('--- PDF Content from')) return false;

  // For add_content without specific content — needs planning
  if (task.taskType === 'add_content' && !task.contentToAdd) return true;

  // For general_edit, check description AND original message for vague/creative intent
  const creativePatterns = [
    'add something',
    'put something',
    'create a',
    'promote',
    'promotion',
    'announce',
    'announcement',
    'advertise',
    'highlight',
    'feature',
    'showcase',
    'add a section',
    'add a new section',
    'add a blank section',
    'add content',
    'write',
    'draft',
    'come up with',
    'suggest',
    'recommend',
    'restaurant week',
    'special event',
    'holiday',
    'seasonal',
    'new section about',
    'new section for',
    'add info about',
    'add information about',
    'endorsement',
    'testimonial',
    'reference',
    'quote block',
  ];

  if (task.description) {
    const desc = task.description.toLowerCase();
    if (creativePatterns.some((p) => desc.includes(p))) return true;
  }

  // Also check the original user message — the request interpreter may have
  // stripped creative keywords like "suggest", "come up with", "recommend"
  if (originalMessage) {
    const orig = originalMessage.toLowerCase();
    if (creativePatterns.some((p) => orig.includes(p))) return true;
  }

  return false;
}

/**
 * Detect if a task involves creating a new page (rather than editing existing content).
 * Page creation tasks need to start from the Pages panel, not in edit mode.
 */
export function taskIsPageCreation(task: Task): boolean {
  const desc = (task.description ?? '').toLowerCase();
  const pageCreationPatterns = [
    'create a new page',
    'create a page',
    'add a new page',
    'add a page',
    'new page called',
    'new page named',
    'new page for',
    'new page to',
    'create page',
    'add page',
  ];
  return pageCreationPatterns.some((p) => desc.includes(p));
}

// ─── Planning Pipeline ──────────────────────────────────────────────────────

/**
 * Run the multi-agent content planning pipeline.
 * Called after Tim confirms tasks that need creative content.
 *
 * Flow:
 * 1. Research Agent → external facts
 * 2. Site Analyst → screenshot + style analysis
 * 3. Content Strategist → draft ContentPlan
 * 4. Send plan to Tim for approval
 */
export async function runPlanningPipeline(conversation: Conversation, tasks: Task[]): Promise<void> {
  try {
    const plan = await runContentPipeline(conversation, tasks);

    // Store plan in DB
    const planJson = JSON.stringify(plan);
    updateConversationPlan(conversation.id, planJson);

    // Format and send to Tim.
    // WhatsApp interactive button messages have a 1024-char body limit,
    // so send the plan as a text message first, then follow with buttons.
    const planMessage = formatContentPlanForTim(plan);

    await sendToTim(planMessage, conversation.id);
    await sendButtonsToTim('Approve this plan?', [
      { id: 'plan_approve', title: 'Looks good!' },
      { id: 'plan_reject', title: 'Skip this' },
    ], conversation.id);

    updateConversationStatus(conversation.id, 'awaiting_plan_approval');
    logAction(null, 'plan_sent', `Content plan sent for conversation ${conversation.id}`);
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error({ error: errorMessage, conversationId: conversation.id }, 'Planning pipeline failed');

    // Fall back to direct execution without a plan.
    // Store a marker so handleConfirmation skips planning next time.
    updateConversationPlan(conversation.id, JSON.stringify({ skipPlanning: true }));

    await sendToTim(`I had trouble creating a content plan (${errorMessage}). Would you like me to try executing the tasks directly instead?`, conversation.id);
    await sendButtonsToTim('Execute without a detailed plan?', [
      { id: 'confirm_yes', title: 'Yes, try it' },
      { id: 'confirm_no', title: 'No, skip' },
    ], conversation.id);

    updateConversationStatus(conversation.id, 'awaiting_confirm');
  }
}

/**
 * Re-run the Content Strategist with Tim's feedback to revise the plan.
 */
export async function revisePlanFromFeedback(conversation: Conversation, feedback: string): Promise<void> {
  try {
    if (!conversation.contentPlan) {
      throw new Error('No existing plan to revise');
    }

    const previousPlan: ContentPlan = JSON.parse(conversation.contentPlan);
    const tasks = conversation.taskIds.map((id) => getTask(id)).filter(Boolean) as Task[];

    const revisedPlan = await reviseContentPlan(tasks, previousPlan, feedback, undefined, undefined, conversation.id);

    // Store revised plan
    const planJson = JSON.stringify(revisedPlan);
    updateConversationPlan(conversation.id, planJson);

    // Send to Tim (text first, then buttons — 1024-char button body limit)
    const planMessage = formatContentPlanForTim(revisedPlan);

    await sendToTim(planMessage, conversation.id);
    await sendButtonsToTim('Approve the revised plan?', [
      { id: 'plan_approve', title: 'Looks good!' },
      { id: 'plan_reject', title: 'Skip this' },
    ], conversation.id);

    updateConversationStatus(conversation.id, 'awaiting_plan_approval');
    logAction(null, 'plan_revised', `Revised plan sent for conversation ${conversation.id}`);
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error({ error: errorMessage, conversationId: conversation.id }, 'Plan revision failed');

    await sendToTim(`Sorry, I had trouble revising the plan: ${errorMessage}`, conversation.id);
    updateConversationStatus(conversation.id, 'awaiting_plan_approval');
  }
}

// ─── Plan Formatting ────────────────────────────────────────────────────────

/**
 * Format a ContentPlan as a readable WhatsApp message for Tim.
 *
 * Aims for a clean, human-friendly summary — not a raw data dump.
 * Groups similar operations and uses friendly labels.
 */
export function formatContentPlanForTim(plan: ContentPlan): string {
  const lines: string[] = [];

  // ─── Header ──────────────────────────────────────────────
  lines.push('📋 *Content Plan*');
  lines.push('');
  lines.push(plan.summary);
  lines.push('');

  // ─── Friendly operation type labels ──────────────────────
  const opLabel = (type: string): string => {
    const labels: Record<string, string> = {
      add_section: 'Add section',
      edit_section: 'Edit section',
      remove_section: 'Remove section',
      create_page: 'Create new page',
      add_image: 'Add image',
      add_button: 'Add button',
    };
    return labels[type] || type.replace(/_/g, ' ');
  };

  // ─── Operations ──────────────────────────────────────────
  const opCount = plan.operations.length;

  if (opCount <= 6) {
    // Show each operation individually
    for (let i = 0; i < opCount; i++) {
      const op = plan.operations[i];
      const heading = op.content.heading;
      const btn = op.content.button;

      // One-liner per operation
      let line = `${i + 1}. *${opLabel(op.operationType)}*`;
      if (heading) line += `: "${heading}"`;
      if (btn) line += ` 🔗 ${btn.label}`;
      lines.push(line);
    }
  } else {
    // For large plans: show a count + first few examples
    lines.push(`*${opCount} steps total:*`);
    lines.push('');

    // Show first 4 as examples
    for (let i = 0; i < Math.min(4, opCount); i++) {
      const op = plan.operations[i];
      const heading = op.content.heading;
      let line = `${i + 1}. *${opLabel(op.operationType)}*`;
      if (heading) line += `: "${heading}"`;
      lines.push(line);
    }
    if (opCount > 4) {
      lines.push(`    _... and ${opCount - 4} more_`);
    }
  }

  lines.push('');

  // ─── Sources ─────────────────────────────────────────────
  if (plan.sources.length > 0) {
    lines.push('📎 Sources:');
    for (const source of plan.sources.slice(0, 3)) {
      lines.push(`  • ${source}`);
    }
    lines.push('');
  }

  // ─── Footer ──────────────────────────────────────────────
  lines.push(`⏱ Estimated: ~${plan.estimatedMinutes} min`);
  lines.push('');
  lines.push('_Approve, or tell me what to change._');

  let message = lines.join('\n');

  // WhatsApp has a 4096 char limit
  if (message.length > 3900) {
    message = message.substring(0, 3900) + '\n\n... _(plan truncated)_';
  }

  return message;
}
