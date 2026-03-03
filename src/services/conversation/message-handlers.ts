/**
 * WhatsApp message handlers — direct requests, confirmations,
 * clarifications, and plan approval.
 *
 * All task execution routes through the MCP orchestrator pipeline.
 */

import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';
import { logAction } from '../../db/audit-log.js';
import {
  updateConversationStatus,
  updateConversationFeedback,
} from '../../db/conversations.js';
import { createConversation } from '../../db/conversations.js';
import { createTask, getTask, updateTaskStatus, updateTaskSiteInfo } from '../../db/tasks.js';
import {
  sendToTim,
  sendButtonsToTim,
  type IncomingWhatsAppMessage,
} from '../whatsapp.js';
import { interpretWhatsAppRequest } from '../whatsapp-request-interpreter.js';
import { executeTasks } from './execution.js';
import { executionQueue } from '../execution-queue.js';
import { formatDirectRequestTaskList } from './helpers.js';
import type { Task } from '../../models/task.js';
import type { Conversation } from '../../models/conversation.js';

// ─── Gallery Detection ─────────────────────────────────────────────────────

const GALLERY_PATTERNS = [
  'gallery',
  'photo gallery',
  'image gallery',
  'portfolio',
  'add photos',
  'add images',
  'upload photos',
  'upload images',
  'create gallery',
  'new gallery',
];

export function hasGalleryIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return GALLERY_PATTERNS.some((p) => lower.includes(p));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSiteIdForQueue(conversation: Conversation): string {
  for (const taskId of conversation.taskIds) {
    const task = getTask(taskId);
    if (task?.siteId) return task.siteId;
  }
  return 'unknown';
}

// ─── Direct WhatsApp Request Handler ────────────────────────────────────────

export async function handleDirectRequest(msg: IncomingWhatsAppMessage & { imageMessages?: IncomingWhatsAppMessage[] }): Promise<void> {
  let messageText = msg.body;
  let referenceImagePath: string | undefined;
  let referenceImageBase64: string | undefined;
  let imagePaths: string[] | undefined;

  // Handle multi-image group
  if (msg.imageMessages && msg.imageMessages.length > 0) {
    const { downloadMedia } = await import('../whatsapp.js');
    const { readFileSync } = await import('fs');
    const downloaded: string[] = [];

    for (const imgMsg of msg.imageMessages) {
      const localPath = (imgMsg as Record<string, unknown>)._localPath as string | undefined;
      if (localPath) {
        downloaded.push(localPath);
      } else if (imgMsg.mediaId) {
        try {
          const path = await downloadMedia(imgMsg.mediaId);
          downloaded.push(path);
        } catch (err) {
          logger.error({ error: errMsg(err), mediaId: imgMsg.mediaId }, 'Failed to download image from group');
        }
      }
    }

    if (downloaded.length > 0) {
      imagePaths = downloaded;
      referenceImagePath = downloaded[0];
      try {
        const { statSync } = await import('fs');
        const fileSize = statSync(downloaded[0]).size;
        if (fileSize <= 5 * 1024 * 1024) {
          referenceImageBase64 = readFileSync(downloaded[0]).toString('base64');
        }
      } catch { /* non-fatal */ }
      logger.info({ count: downloaded.length, imageGroupId: msg.imageGroupId }, 'Downloaded multi-image group');
    }
  }
  // Handle single image
  else if (msg.type === 'image' && msg.mediaId) {
    try {
      const { downloadMedia } = await import('../whatsapp.js');
      referenceImagePath = await downloadMedia(msg.mediaId);
      const { readFileSync, statSync } = await import('fs');
      const fileSize = statSync(referenceImagePath).size;
      if (fileSize <= 5 * 1024 * 1024) {
        referenceImageBase64 = readFileSync(referenceImagePath).toString('base64');
      }
      imagePaths = [referenceImagePath];
      logger.info({ mediaId: msg.mediaId, path: referenceImagePath }, 'Downloaded WhatsApp reference image');
    } catch (err) {
      logger.error({ error: errMsg(err) }, 'Failed to download WhatsApp image');
    }
  }

  // Handle audio/voice note
  if (msg.type === 'audio' && msg.mediaId) {
    try {
      const { downloadMedia } = await import('../whatsapp.js');
      const audioPath = await downloadMedia(msg.mediaId);
      const { transcribeAudio } = await import('../transcription.js');
      messageText = await transcribeAudio(audioPath);
      logger.info({ mediaId: msg.mediaId, charCount: messageText.length }, 'Transcribed WhatsApp voice note');
      await sendToTim(`I heard: "${messageText}"\n\nProcessing your request...`);
    } catch (err) {
      const errorMessage = errMsg(err);
      logger.error({ error: errorMessage }, 'Failed to transcribe voice note');
      await sendToTim(`Sorry, I couldn't understand that voice note. ${errorMessage.includes('not installed') || errorMessage.includes('not found') ? errorMessage : 'Try sending a text message instead.'}`);
      return;
    }
  }

  if (!referenceImagePath && (!messageText || messageText.length < 3)) {
    await sendToTim('Hey! Send me an editing request or forward me an email and I\'ll handle it.');
    return;
  }

  logger.info({ messageText: messageText?.substring(0, 100), hasImage: !!referenceImagePath }, 'Handling direct WhatsApp request');

  try {
    const interpreted = await interpretWhatsAppRequest(
      messageText || 'See the attached screenshot for what to change.',
      undefined,
      referenceImageBase64,
    );

    // Process memories
    if (interpreted.memories && interpreted.memories.length > 0) {
      const { classifyMemory } = await import('../memory-classifier.js');
      const { saveMemory } = await import('../../db/memories.js');
      const source = msg.from === 'dashboard' ? 'dashboard' : 'whatsapp';

      const savedMemories: string[] = [];
      for (const mem of interpreted.memories) {
        try {
          const classified = await classifyMemory(mem.rawText);
          const saved = saveMemory({
            content: classified.content,
            category: classified.category,
            siteId: classified.siteId,
            tags: classified.tags,
            source,
          });
          const scope = saved.siteId ? ` for ${saved.siteId}` : '';
          savedMemories.push(`Remembered: *${saved.content}* (${saved.category}${scope})`);
        } catch (err) {
          logger.error({ error: errMsg(err) }, 'Failed to classify/save memory');
        }
      }

      if (interpreted.tasks.length === 0 && savedMemories.length > 0) {
        await sendToTim(savedMemories.join('\n'));
        return;
      }
      if (savedMemories.length > 0) {
        await sendToTim(savedMemories.join('\n'));
      }
    }

    if (interpreted.tasks.length === 0) {
      await sendToTim('Hey! Send me an editing request and I\'ll take care of it. For example: "Update the menus page on Smyth — remove the lunch special"');
      return;
    }

    // Clarification needed
    const needsClarification = interpreted.tasks.some((t) => t.needsClarification);
    if (needsClarification) {
      const clarifyTask = interpreted.tasks.find((t) => t.needsClarification)!;
      const createdTasks = interpreted.tasks.map((t) =>
        createTask({
          taskType: 'general_edit',
          clientName: t.clientName,
          siteId: t.siteId,
          targetPage: t.targetPage,
          description: t.description,
          referenceImagePath,
          imagePaths,
          applyToAllSites: t.applyToAllSites,
          groupId: t.groupId,
          needsClarification: t.needsClarification,
          clarificationQuestion: t.clarificationQuestion,
        }),
      );

      const conversation = createConversation({
        source: msg.from === 'dashboard' ? 'dashboard' : 'whatsapp',
        taskIds: createdTasks.map((t) => t.id),
        summaryText: interpreted.reasoning,
        originalMessage: messageText,
      });

      logAction(null, 'conversation_created', `WhatsApp request — needs clarification: ${clarifyTask.clarificationQuestion}`);
      updateConversationStatus(conversation.id, 'clarifying');
      await sendToTim(clarifyTask.clarificationQuestion ?? 'I need a bit more detail. Which site should I update?', conversation.id);
      return;
    }

    // Create tasks and conversation
    const createdTasks = interpreted.tasks.map((t) =>
      createTask({
        taskType: 'general_edit',
        clientName: t.clientName,
        siteId: t.siteId,
        targetPage: t.targetPage,
        description: t.description,
        referenceImagePath,
        imagePaths,
        applyToAllSites: t.applyToAllSites,
        groupId: t.groupId,
        needsClarification: false,
      }),
    );

    const summaryText = formatDirectRequestTaskList(interpreted.tasks);
    const conversation = createConversation({
      source: msg.from === 'dashboard' ? 'dashboard' : 'whatsapp',
      taskIds: createdTasks.map((t) => t.id),
      summaryText,
      originalMessage: messageText,
    });

    logAction(null, 'conversation_created', `WhatsApp request: ${conversation.id}`);

    // Gallery without images: ask for images
    const galleryIntentInMessage = hasGalleryIntent(messageText || '');
    const galleryIntentInTasks = interpreted.tasks.some((t) => hasGalleryIntent(t.description));
    const hasImages = imagePaths && imagePaths.length > 0;

    if ((galleryIntentInMessage || galleryIntentInTasks) && !hasImages) {
      updateConversationStatus(conversation.id, 'clarifying');
      logAction(null, 'gallery_awaiting_images', `Gallery request without images — asking Tim for photos`);
      await sendToTim(
        `Got it — I'll set up a gallery for you! Please send me the photos you'd like to include, and I'll add them.`,
        conversation.id,
      );
      return;
    }

    // Send confirmation
    const taskSummary = interpreted.tasks
      .map((t, i) => `${i + 1}. ${t.description} (${t.clientName}${t.targetPage ? ` / ${t.targetPage}` : ''})`)
      .join('\n');

    const fullMessage = `Got it! Here's what I'll do:\n\n${taskSummary}`;

    if (fullMessage.length > 900) {
      await sendToTim(fullMessage, conversation.id);
      await sendButtonsToTim('Proceed with these tasks?', [
        { id: 'confirm_yes', title: 'Yes, proceed' },
        { id: 'confirm_no', title: 'No, skip' },
      ], conversation.id);
    } else {
      await sendButtonsToTim(`${fullMessage}\n\nProceed?`, [
        { id: 'confirm_yes', title: 'Yes, proceed' },
        { id: 'confirm_no', title: 'No, skip' },
      ], conversation.id);
    }
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error({ error: errorMessage }, 'Failed to interpret WhatsApp request');
    try {
      await sendToTim('Sorry, I had trouble understanding that request. Could you rephrase it?');
    } catch (sendErr) {
      logger.warn({ error: errMsg(sendErr) }, 'Could not send error reply via WhatsApp');
      const { dashboardEvents } = await import('../dashboard-events.js');
      dashboardEvents.emit('dashboard', {
        type: 'message',
        data: { body: 'Sorry, I had trouble understanding that request. Could you rephrase it?', direction: 'outbound' },
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// ─── Confirmation Handler ───────────────────────────────────────────────────

export async function handleConfirmation(conversation: Conversation, msg: IncomingWhatsAppMessage): Promise<void> {
  const response = interpretResponse(msg);

  if (response === 'yes') {
    logAction(null, 'conversation_confirmed', `Conversation ${conversation.id} confirmed by Tim`);
    await sendToTim(`Got it. Starting ${conversation.taskIds.length} task(s)...`, conversation.id);
    updateConversationStatus(conversation.id, 'executing');

    const siteId = getSiteIdForQueue(conversation);
    executionQueue.enqueue(conversation.id, siteId, () => executeTasks(conversation));
  } else if (response === 'no') {
    logAction(null, 'conversation_rejected', `Conversation ${conversation.id} rejected by Tim`);
    updateConversationStatus(conversation.id, 'rejected');
    for (const taskId of conversation.taskIds) {
      updateTaskStatus(taskId, 'failed', 'Rejected by Tim');
    }
    await sendToTim('Understood. Tasks skipped. Send me another request when you\'re ready.', conversation.id);
  } else {
    await sendButtonsToTim(
      `I didn't quite get that. Should I proceed with the ${conversation.taskIds.length} task(s)?`,
      [
        { id: 'confirm_yes', title: 'Yes, proceed' },
        { id: 'confirm_no', title: 'No, skip' },
      ],
      conversation.id,
    );
  }
}

// ─── Clarification Handler ──────────────────────────────────────────────────

export async function handleClarification(conversation: Conversation, msg: IncomingWhatsAppMessage & { imageMessages?: IncomingWhatsAppMessage[] }): Promise<void> {
  const reply = msg.body.trim();
  logAction(null, 'clarification_received', `Tim replied: ${reply}`);

  // Gallery image fulfillment
  const tasks = conversation.taskIds.map((id) => getTask(id)).filter(Boolean) as Task[];
  const conversationHasGalleryIntent = tasks.some((t) => hasGalleryIntent(t.description ?? ''));

  if (conversationHasGalleryIntent) {
    let newImagePaths: string[] = [];

    if (msg.imageMessages && msg.imageMessages.length > 0) {
      const { downloadMedia } = await import('../whatsapp.js');
      for (const imgMsg of msg.imageMessages) {
        const localPath = (imgMsg as Record<string, unknown>)._localPath as string | undefined;
        if (localPath) {
          newImagePaths.push(localPath);
        } else if (imgMsg.mediaId) {
          try {
            const path = await downloadMedia(imgMsg.mediaId);
            newImagePaths.push(path);
          } catch (err) {
            logger.error({ error: errMsg(err) }, 'Failed to download gallery image');
          }
        }
      }
    } else if (msg.type === 'image' && msg.mediaId) {
      try {
        const { downloadMedia } = await import('../whatsapp.js');
        const path = await downloadMedia(msg.mediaId);
        newImagePaths.push(path);
      } catch (err) {
        logger.error({ error: errMsg(err) }, 'Failed to download gallery image');
      }
    }

    if (newImagePaths.length > 0) {
      const { updateTaskImagePaths } = await import('../../db/tasks.js');
      for (const task of tasks) {
        const existingPaths = task.imagePaths ?? [];
        updateTaskImagePaths(task.id, [...existingPaths, ...newImagePaths]);
      }

      updateConversationStatus(conversation.id, 'awaiting_confirm');

      const taskSummary = tasks
        .map((t, i) => `${i + 1}. ${t.description} (${t.clientName}${t.targetPage ? ` / ${t.targetPage}` : ''})`)
        .join('\n');

      await sendButtonsToTim(
        `Got ${newImagePaths.length} photo(s)! Here's the plan:\n\n${taskSummary}\n\nProceed?`,
        [
          { id: 'confirm_yes', title: 'Yes, proceed' },
          { id: 'confirm_no', title: 'No, skip' },
        ],
        conversation.id,
      );
      return;
    }
  }

  // Re-interpret the clarification to resolve site name
  try {
    const reinterpreted = await interpretWhatsAppRequest(reply);

    if (reinterpreted.tasks.length > 0 && !reinterpreted.tasks[0].needsClarification && reinterpreted.tasks[0].siteId !== 'unknown') {
      const newTask = reinterpreted.tasks[0];
      const updatedDescriptions: string[] = [];

      for (const taskId of conversation.taskIds) {
        const task = getTask(taskId);
        if (task && (task.needsClarification || task.siteId === 'unknown')) {
          updateTaskSiteInfo(taskId, {
            siteId: newTask.siteId,
            clientName: newTask.clientName,
            targetPage: newTask.targetPage,
            description: newTask.description,
          });
          updatedDescriptions.push(`- ${newTask.description} on *${newTask.clientName}*`);
        }
      }

      logger.info({ site: newTask.clientName, siteId: newTask.siteId }, 'Resolved site from clarification');
      updateConversationStatus(conversation.id, 'awaiting_confirm');

      const summary = updatedDescriptions.length > 0
        ? updatedDescriptions.join('\n')
        : `Tasks on ${newTask.clientName}`;

      await sendButtonsToTim(
        `Got it — *${newTask.clientName}*. Here's the plan:\n\n${summary}\n\nProceed?`,
        [
          { id: 'confirm_yes', title: 'Yes, proceed' },
          { id: 'confirm_no', title: 'No, skip' },
        ],
        conversation.id,
      );
      return;
    }
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Re-interpretation of clarification failed');
  }

  logger.warn({ reply }, 'Could not resolve clarification reply to a known site');
  await sendToTim(
    `I couldn't match that to a known site. Could you tell me the exact site name?`,
    conversation.id,
  );
}

// ─── Plan Approval Handler ──────────────────────────────────────────────────

/**
 * Handle Tim's response to a content plan (used when REQUIRE_PLAN_APPROVAL=true).
 */
export async function handlePlanApproval(conversation: Conversation, msg: IncomingWhatsAppMessage): Promise<void> {
  if (msg.type === 'button' && msg.buttonId) {
    if (msg.buttonId === 'plan_approve') return await approvePlan(conversation);
    if (msg.buttonId === 'plan_reject') return await rejectPlan(conversation);
  }

  const text = msg.body.toLowerCase().trim();
  const approvePatterns = ['looks good', 'approved', 'approve', 'yes', 'go', 'do it', 'proceed', 'perfect', 'great', 'go ahead', 'love it', 'good', 'it\'s good', 'its good', 'sounds good', 'ok', 'okay', 'sure', 'yep', 'yup', 'yeah', 'cool', 'fine', 'let\'s go', 'lets go', 'ship it', 'send it', 'make it happen'];
  const rejectPatterns = ['no', 'skip', 'cancel', 'stop', 'reject', 'nope', 'don\'t'];

  const matchesApproval = approvePatterns.some((p) => text === p || text.includes(p));
  const matchesRejection = rejectPatterns.some((p) => text === p || text.startsWith(p + ' '));

  if (matchesApproval && !matchesRejection) return await approvePlan(conversation);
  if (matchesRejection && !matchesApproval) return await rejectPlan(conversation);

  // Treat as revision feedback — re-run the orchestrator
  logger.info({ feedback: msg.body.substring(0, 100), conversationId: conversation.id }, 'Treating response as plan revision feedback');
  updateConversationFeedback(conversation.id, msg.body);
  await sendToTim('Got it — I\'ll take that feedback into account. Re-running...', conversation.id);
  updateConversationStatus(conversation.id, 'executing');

  const siteId = getSiteIdForQueue(conversation);
  executionQueue.enqueue(conversation.id, siteId, () => executeTasks(conversation));
}

async function approvePlan(conversation: Conversation): Promise<void> {
  logAction(null, 'plan_approved', `Content plan approved for conversation ${conversation.id}`);
  await sendToTim('Great! Starting the edits now...', conversation.id);
  updateConversationStatus(conversation.id, 'executing');

  const siteId = getSiteIdForQueue(conversation);
  executionQueue.enqueue(conversation.id, siteId, () => executeTasks(conversation));
}

async function rejectPlan(conversation: Conversation): Promise<void> {
  logAction(null, 'plan_rejected', `Content plan rejected for conversation ${conversation.id}`);
  updateConversationStatus(conversation.id, 'rejected');
  for (const taskId of conversation.taskIds) {
    updateTaskStatus(taskId, 'failed', 'Plan rejected by Tim');
  }
  await sendToTim('Understood — plan skipped. Send me another request when you\'re ready.', conversation.id);
}

// ─── Response Interpretation ────────────────────────────────────────────────

export function interpretResponse(msg: IncomingWhatsAppMessage): 'yes' | 'no' | 'ambiguous' {
  if (msg.type === 'button' && msg.buttonId) {
    if (msg.buttonId === 'confirm_yes' || msg.buttonId === 'plan_approve') return 'yes';
    if (msg.buttonId === 'confirm_no' || msg.buttonId === 'plan_reject') return 'no';
  }

  const text = msg.body.toLowerCase().trim();
  const yesPatterns = ['yes', 'y', 'yep', 'yeah', 'go', 'proceed', 'do it', 'ok', 'sure', 'confirmed', 'approve', 'go ahead'];
  const noPatterns = ['no', 'n', 'nope', 'skip', 'cancel', 'stop', 'don\'t', 'reject'];

  if (yesPatterns.some((p) => text === p || text.startsWith(p + ' '))) return 'yes';
  if (noPatterns.some((p) => text === p || text.startsWith(p + ' '))) return 'no';

  return 'ambiguous';
}
