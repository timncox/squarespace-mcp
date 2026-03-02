/**
 * WhatsApp message handlers — direct requests, confirmations,
 * clarifications, and plan approval.
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
import { getBrowserManager } from '../../automation/browser-manager.js';
import { ensureLoggedIn } from '../../automation/squarespace-auth.js';
import { taskNeedsContentPlanning, runPlanningPipeline, revisePlanFromFeedback } from './planning.js';
import { executeTasks, executeTasksWithPlan } from './execution.js';
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

/**
 * Detect if a request has gallery intent based on the message text or task descriptions.
 * Gallery requests without attached images should prompt the user to send images.
 */
export function hasGalleryIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return GALLERY_PATTERNS.some((p) => lower.includes(p));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract the primary siteId from a conversation's tasks for queue routing. */
function getSiteIdForQueue(conversation: Conversation): string {
  for (const taskId of conversation.taskIds) {
    const task = getTask(taskId);
    if (task?.siteId) return task.siteId;
  }
  return 'unknown';
}

// ─── Direct WhatsApp Request Handler ────────────────────────────────────────

/**
 * Handle a direct WhatsApp message as an editing request.
 * Uses Claude to interpret the message and determine which site(s) and
 * page(s) to edit, then creates tasks and asks Tim for confirmation.
 */
export async function handleDirectRequest(msg: IncomingWhatsAppMessage & { imageMessages?: IncomingWhatsAppMessage[] }): Promise<void> {
  let messageText = msg.body;
  let referenceImagePath: string | undefined;
  let referenceImageBase64: string | undefined;
  let imagePaths: string[] | undefined;

  // Handle multi-image group: download all images
  if (msg.imageMessages && msg.imageMessages.length > 0) {
    const { downloadMedia } = await import('../whatsapp.js');
    const { readFileSync } = await import('fs');
    const downloaded: string[] = [];

    for (const imgMsg of msg.imageMessages) {
      // Dashboard images already have a local path
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
      referenceImagePath = downloaded[0]; // First image for backward compat
      try {
        const { statSync } = await import('fs');
        const fileSize = statSync(downloaded[0]).size;
        // Claude API has a 5MB limit for image inputs — skip if too large
        if (fileSize <= 5 * 1024 * 1024) {
          referenceImageBase64 = readFileSync(downloaded[0]).toString('base64');
        } else {
          logger.info({ fileSize, path: downloaded[0] }, 'Reference image exceeds 5MB — skipping base64 for interpretation');
        }
      } catch { /* non-fatal */ }
      logger.info({ count: downloaded.length, imageGroupId: msg.imageGroupId }, 'Downloaded multi-image group');
    }
  }
  // Handle single image message: download the image from WhatsApp
  else if (msg.type === 'image' && msg.mediaId) {
    try {
      const { downloadMedia } = await import('../whatsapp.js');
      referenceImagePath = await downloadMedia(msg.mediaId);

      const { readFileSync, statSync } = await import('fs');
      const fileSize = statSync(referenceImagePath).size;
      // Claude API has a 5MB limit for image inputs — skip if too large
      if (fileSize <= 5 * 1024 * 1024) {
        referenceImageBase64 = readFileSync(referenceImagePath).toString('base64');
      } else {
        logger.info({ fileSize, path: referenceImagePath }, 'Reference image exceeds 5MB — skipping base64 for interpretation');
      }

      imagePaths = [referenceImagePath];
      logger.info({ mediaId: msg.mediaId, path: referenceImagePath }, 'Downloaded WhatsApp reference image');
    } catch (err) {
      logger.error({ error: errMsg(err) }, 'Failed to download WhatsApp image');
      // Continue without the image — fall back to text-only interpretation
    }
  }

  // Handle audio/voice note messages: download and transcribe
  if (msg.type === 'audio' && msg.mediaId) {
    try {
      const { downloadMedia } = await import('../whatsapp.js');
      const audioPath = await downloadMedia(msg.mediaId);

      const { transcribeAudio } = await import('../transcription.js');
      const transcribedText = await transcribeAudio(audioPath);
      messageText = transcribedText;

      logger.info({ mediaId: msg.mediaId, charCount: transcribedText.length }, 'Transcribed WhatsApp voice note');

      // Confirm to Tim so he knows what we heard
      await sendToTim(`🎤 I heard: "${transcribedText}"\n\nProcessing your request...`);
    } catch (err) {
      const errorMessage = errMsg(err);
      logger.error({ error: errorMessage }, 'Failed to transcribe voice note');
      await sendToTim(`Sorry, I couldn't understand that voice note. ${errorMessage.includes('not installed') || errorMessage.includes('not found') ? errorMessage : 'Try sending a text message instead.'}`);
      return;
    }
  }

  // Skip conversational messages that are clearly not editing requests
  // For image messages, an empty caption is valid (the image IS the instruction)
  // For audio messages, messageText is already set from transcription above
  if (!referenceImagePath && (!messageText || messageText.length < 3)) {
    await sendToTim('Hey! Send me an editing request or forward me an email and I\'ll handle it.');
    return;
  }

  logger.info({ messageText: messageText?.substring(0, 100), hasImage: !!referenceImagePath }, 'Handling direct WhatsApp request');

  try {
    // Discover available sites from the Squarespace dashboard before interpreting.
    // This tells the LLM which sites the agent actually has access to.
    let discoveredSites: import('../../automation/site-discovery.js').DiscoveredSite[] | undefined;
    try {
      const browserManager = getBrowserManager();
      await ensureLoggedIn(browserManager);
      const page = await browserManager.getPage();
      const { discoverSites } = await import('../../automation/site-discovery.js');
      discoveredSites = await discoverSites(page);
      logger.info({ count: discoveredSites.length }, 'Discovered sites for request interpretation');
      // Save session so Content Save API has fresh cookies (crumb token etc.)
      await browserManager.saveSession();
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Could not discover sites — falling back to static config');
    }

    const interpreted = await interpretWhatsAppRequest(
      messageText || 'See the attached screenshot for what to change.',
      discoveredSites,
      referenceImageBase64,
    );

    // ─── Process memories ────────────────────────────────────────────────
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

      // If there are memories but NO tasks, respond immediately and return
      if (interpreted.tasks.length === 0 && savedMemories.length > 0) {
        await sendToTim(savedMemories.join('\n'));
        return;
      }

      // If there are both memories AND tasks, send memory confirmation alongside task flow
      if (savedMemories.length > 0) {
        await sendToTim(savedMemories.join('\n'));
      }
    }

    // No tasks extracted (conversational message like "hi", "thanks", etc.)
    if (interpreted.tasks.length === 0) {
      await sendToTim('Hey! Send me an editing request and I\'ll take care of it. For example: "Update the menus page on Smyth — remove the lunch special"');
      return;
    }

    // Check if any tasks need clarification
    const needsClarification = interpreted.tasks.some((t) => t.needsClarification);
    if (needsClarification) {
      const clarifyTask = interpreted.tasks.find((t) => t.needsClarification)!;

      // Create tasks in DB even for clarification (so we can update them later)
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

    // Create tasks in DB
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

    // Create conversation
    const summaryText = formatDirectRequestTaskList(interpreted.tasks);
    const conversation = createConversation({
      source: msg.from === 'dashboard' ? 'dashboard' : 'whatsapp',
      taskIds: createdTasks.map((t) => t.id),
      summaryText,
      originalMessage: messageText,
    });

    logAction(null, 'conversation_created', `WhatsApp request: ${conversation.id}`);

    // ─── Gallery without images: ask for images ──────────────────────────
    // Detect gallery intent from the message or task descriptions. If the user
    // hasn't provided any images, enter the 'clarifying' state and ask for them.
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

    // Send confirmation with task summary.
    // WhatsApp button messages have a 1024-char body limit.
    // For short summaries, include in the button message; otherwise split.
    const taskSummary = interpreted.tasks
      .map((t, i) => `${i + 1}. ${t.description} (${t.clientName}${t.targetPage ? ` / ${t.targetPage}` : ''})`)
      .join('\n');

    const fullMessage = `📝 Got it! Here's what I'll do:\n\n${taskSummary}`;

    if (fullMessage.length > 900) {
      // Too long for button body — split into text + buttons
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
      // If WhatsApp is down, at least push to dashboard SSE
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

// ─── Simple Edit Fast Path ──────────────────────────────────────────────────

/**
 * Attempt to classify and execute all tasks as simple edits via Content Save API.
 * Returns a summary string if ALL tasks succeed, or null to fall through to the
 * normal pipeline (planning → browser agent).
 */
export async function trySimpleEditFastPath(
  conversation: Conversation,
  tasks: Task[],
): Promise<string | null> {
  // Only attempt for conversations without existing plans
  if (conversation.contentPlan) return null;

  // No tasks → nothing to do
  if (tasks.length === 0) return null;

  // Don't attempt if tasks have images (likely need browser agent)
  if (tasks.some(t => t.referenceImagePath || (t.imagePaths && t.imagePaths.length > 0))) return null;

  try {
    const { classifySimpleEdit } = await import('../simple-edit-classifier.js');

    // Classify all tasks
    const classifications = await Promise.all(
      tasks.map(t => classifySimpleEdit(t))
    );

    // Log full classification results for debugging
    logger.info(
      { classifications: classifications.map(c => ({ isSimpleEdit: c.isSimpleEdit, editType: c.editType, confidence: c.confidence, reason: c.reason })) },
      'Simple edit fast path: classification results',
    );

    // ALL tasks must be simple edits with high confidence
    if (!classifications.every(c => c.isSimpleEdit && c.confidence === 'high')) {
      const reasons = classifications
        .filter(c => !c.isSimpleEdit || c.confidence !== 'high')
        .map(c => c.reason);
      logger.info({ reasons }, 'Simple edit fast path: not all tasks qualify');
      return null;
    }

    logger.info(
      { taskCount: tasks.length, editTypes: classifications.map(c => c.editType) },
      'Simple edit fast path: all tasks classified as simple — executing via API'
    );

    // Execute all tasks via API
    const { executeSimpleEdit } = await import('../simple-edit-executor.js');
    const results: string[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const classification = classifications[i];

      updateTaskStatus(task.id, 'executing');
      logAction(task.id, 'simple_edit_start', `Fast path: ${classification.editType} on ${task.siteId}/${task.targetPage}`);

      const result = await executeSimpleEdit(task, classification);

      if (!result.success) {
        // If any task fails, abort fast path — let normal pipeline handle everything
        logger.warn(
          { taskId: task.id, editType: result.editType, error: result.error },
          'Simple edit fast path: execution failed — falling back to normal pipeline'
        );
        // Reset task statuses back to confirmed
        for (const t of tasks) {
          updateTaskStatus(t.id, 'confirmed');
        }
        return null;
      }

      results.push(`✓ ${result.summary} (${result.durationMs}ms)`);
      logAction(task.id, 'simple_edit_done', result.summary);
    }

    return `⚡ Fast edit${tasks.length > 1 ? 's' : ''} complete:\n\n${results.join('\n')}`;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Simple edit fast path: error — falling back to normal pipeline');
    return null;
  }
}

// ─── Confirmation Handler ───────────────────────────────────────────────────

export async function handleConfirmation(conversation: Conversation, msg: IncomingWhatsAppMessage): Promise<void> {
  const response = interpretResponse(msg);

  if (response === 'yes') {
    logAction(null, 'conversation_confirmed', `Conversation ${conversation.id} confirmed by Tim`);

    // Check if planning was already attempted and failed (skipPlanning marker)
    let skipPlanning = false;
    if (conversation.contentPlan) {
      try {
        const planData = JSON.parse(conversation.contentPlan);
        if (planData.skipPlanning) skipPlanning = true;
      } catch {
        // Not JSON or no skipPlanning — proceed normally
      }
    }

    // Check if any tasks need content planning (creative/vague tasks).
    // Pass the original message — the request interpreter may have stripped creative keywords.
    const tasks = conversation.taskIds.map((id) => getTask(id)).filter(Boolean) as Task[];

    // === Simple Edit Fast Path ===
    // Try to handle simple edits directly via Content Save API (~500ms each)
    // instead of browser agent (~2-5 min each). Only for high-confidence classifications.
    logger.info({ taskCount: tasks.length, convId: conversation.id }, 'Attempting simple edit fast path');
    const simpleEditResult = await trySimpleEditFastPath(conversation, tasks);
    if (simpleEditResult) {
      // All tasks handled via API — skip browser agent entirely
      updateConversationStatus(conversation.id, 'completed');
      for (const taskId of conversation.taskIds) {
        updateTaskStatus(taskId, 'done');
      }
      await sendToTim(simpleEditResult, conversation.id);
      return;
    }
    // === End Simple Edit Fast Path ===

    const originalMsg = conversation.originalMessage;
    const needsPlanning = !skipPlanning && tasks.some((t) => taskNeedsContentPlanning(t, originalMsg));

    if (needsPlanning) {
      await sendToTim('Got it! Let me research and put together a plan for you...', conversation.id);
      updateConversationStatus(conversation.id, 'planning');

      // Run planning pipeline in background
      runPlanningPipeline(conversation, tasks).catch((err) => {
        logger.error({ error: err, conversationId: conversation.id }, 'Planning pipeline failed');
      });
    } else {
      // Clear the skipPlanning marker if it was set
      if (skipPlanning) {
        const { updateConversationPlan } = await import('../../db/conversations.js');
        updateConversationPlan(conversation.id, '');
      }

      await sendToTim(`Got it. Starting ${conversation.taskIds.length} task(s)...`, conversation.id);
      updateConversationStatus(conversation.id, 'executing');

      // Enqueue for execution (per-site queue: different sites run in parallel)
      const siteId = getSiteIdForQueue(conversation);
      executionQueue.enqueue(conversation.id, siteId, () => executeTasks(conversation));
    }
  } else if (response === 'no') {
    logAction(null, 'conversation_rejected', `Conversation ${conversation.id} rejected by Tim`);
    updateConversationStatus(conversation.id, 'rejected');

    // Mark all tasks as failed
    for (const taskId of conversation.taskIds) {
      updateTaskStatus(taskId, 'failed', 'Rejected by Tim');
    }

    await sendToTim('Understood. Tasks skipped. Send me another request when you\'re ready.', conversation.id);
  } else {
    // Ambiguous response
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

  // ─── Gallery image fulfillment ─────────────────────────────────────────
  // If the existing tasks have gallery intent and the user sends images,
  // attach the images to the tasks and move to confirmation.
  const tasks = conversation.taskIds.map((id) => getTask(id)).filter(Boolean) as Task[];
  const conversationHasGalleryIntent = tasks.some((t) => hasGalleryIntent(t.description ?? ''));

  if (conversationHasGalleryIntent) {
    // Check if this message carries images
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
      // Attach images to all gallery tasks
      const { updateTaskImagePaths } = await import('../../db/tasks.js');
      for (const task of tasks) {
        const existingPaths = task.imagePaths ?? [];
        const allPaths = [...existingPaths, ...newImagePaths];
        updateTaskImagePaths(task.id, allPaths);
      }

      logger.info(
        { imageCount: newImagePaths.length, conversationId: conversation.id },
        'Gallery images received — moving to confirmation',
      );

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

    // If no images but the reply is text, fall through to normal clarification handling
    // (e.g., the user might be providing a site name or more details)
  }

  // Try to resolve the reply as a site name using discovered sites
  let resolvedSite: import('../../automation/site-discovery.js').DiscoveredSite | undefined;

  try {
    const { getDiscoveredSites, findDiscoveredSite } = await import('../../automation/site-discovery.js');
    let sites = getDiscoveredSites();

    // If no cached sites, try discovering them now
    if (!sites) {
      try {
        const browserManager = getBrowserManager();
        await ensureLoggedIn(browserManager);
        const page = await browserManager.getPage();
        const { discoverSites } = await import('../../automation/site-discovery.js');
        sites = await discoverSites(page);
      } catch {
        logger.warn('Could not discover sites during clarification');
      }
    }

    if (sites) {
      resolvedSite = findDiscoveredSite(sites, reply);
    }
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Error resolving site from clarification');
  }

  if (resolvedSite) {
    // Update all tasks that need clarification with the resolved site info
    const updatedDescriptions: string[] = [];

    for (const taskId of conversation.taskIds) {
      const task = getTask(taskId);
      if (!task) continue;

      if (task.needsClarification || task.siteId === 'unknown') {
        updateTaskSiteInfo(taskId, {
          siteId: resolvedSite.subdomain,
          clientName: resolvedSite.name,
        });

        // Refresh the task from DB to get the updated description
        const updatedTask = getTask(taskId);
        if (updatedTask) {
          updatedDescriptions.push(
            `• ${updatedTask.description ?? 'Update'} on *${resolvedSite.name}*`,
          );
        }
      }
    }

    logger.info({ site: resolvedSite.name, subdomain: resolvedSite.subdomain, taskCount: updatedDescriptions.length }, 'Resolved site from clarification');

    updateConversationStatus(conversation.id, 'awaiting_confirm');

    const summary = updatedDescriptions.length > 0
      ? updatedDescriptions.join('\n')
      : `Tasks on ${resolvedSite.name}`;

    await sendButtonsToTim(
      `Got it — *${resolvedSite.name}*. Here's the plan:\n\n${summary}\n\nProceed?`,
      [
        { id: 'confirm_yes', title: 'Yes, proceed' },
        { id: 'confirm_no', title: 'No, skip' },
      ],
      conversation.id,
    );
  } else {
    // Couldn't match reply directly to a site name.
    // The reply might be a full sentence like "create a new page on Tim Cox to feature my vibecoding projects".
    // Re-interpret the full reply with Claude to extract the site and updated task details.
    logger.info({ reply }, 'Clarification did not match a site name directly — re-interpreting with Claude');

    try {
      const { getDiscoveredSites } = await import('../../automation/site-discovery.js');
      const sites = getDiscoveredSites() ?? [];

      const { interpretWhatsAppRequest: reinterpret } = await import('../whatsapp-request-interpreter.js');
      const reinterpreted = await reinterpret(reply, sites);

      if (reinterpreted.tasks.length > 0 && !reinterpreted.tasks[0].needsClarification && reinterpreted.tasks[0].siteId !== 'unknown') {
        // Claude successfully extracted a site and task from the clarification
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
            updatedDescriptions.push(`• ${newTask.description} on *${newTask.clientName}*`);
          }
        }

        logger.info({ site: newTask.clientName, siteId: newTask.siteId }, 'Re-interpreted clarification successfully');
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

    // Still couldn't resolve — ask Tim to be more specific
    logger.warn({ reply }, 'Could not resolve clarification reply to a known site');

    const { getDiscoveredSites: getDS } = await import('../../automation/site-discovery.js');
    const knownSites = (getDS() ?? []).map((s) => s.name).join(', ');

    await sendToTim(
      `I couldn't match that to a site on my dashboard. Available sites: ${knownSites || 'none found'}.\n\nCould you tell me the exact site name?`,
      conversation.id,
    );
  }
}

// ─── Plan Approval Handler ──────────────────────────────────────────────────

/**
 * Handle Tim's response to a content plan.
 * - Approve → execute tasks with the plan's precise instructions
 * - Reject → cancel the conversation
 * - Anything else → treat as revision feedback
 */
export async function handlePlanApproval(conversation: Conversation, msg: IncomingWhatsAppMessage): Promise<void> {
  // Check for button responses
  if (msg.type === 'button' && msg.buttonId) {
    if (msg.buttonId === 'plan_approve') {
      return await approvePlan(conversation);
    }
    if (msg.buttonId === 'plan_reject') {
      return await rejectPlan(conversation);
    }
  }

  // Check for text responses
  const text = msg.body.toLowerCase().trim();

  const approvePatterns = ['looks good', 'approved', 'approve', 'yes', 'go', 'do it', 'proceed', 'perfect', 'great', 'go ahead', 'love it', 'good', 'it\'s good', 'its good', 'sounds good', 'ok', 'okay', 'sure', 'yep', 'yup', 'yeah', 'cool', 'fine', 'let\'s go', 'lets go', 'ship it', 'send it', 'make it happen', '👍', '✅'];
  const rejectPatterns = ['no', 'skip', 'cancel', 'stop', 'reject', 'nope', 'don\'t', '👎'];

  // Match if the text equals, starts with, or contains an approval/rejection phrase
  const matchesApproval = approvePatterns.some((p) => text === p || text.includes(p));
  const matchesRejection = rejectPatterns.some((p) => text === p || text.startsWith(p + ' '));

  if (matchesApproval && !matchesRejection) {
    return await approvePlan(conversation);
  }

  if (matchesRejection && !matchesApproval) {
    return await rejectPlan(conversation);
  }

  // Treat as revision feedback
  logger.info({ feedback: msg.body.substring(0, 100), conversationId: conversation.id }, 'Treating response as plan revision feedback');

  updateConversationFeedback(conversation.id, msg.body);
  updateConversationStatus(conversation.id, 'revising');
  logAction(null, 'plan_revision_requested', `Tim's feedback: ${msg.body.substring(0, 200)}`);

  await sendToTim('Got it — revising the plan based on your feedback...', conversation.id);

  // Re-run content strategist with feedback in background
  revisePlanFromFeedback(conversation, msg.body).catch((err) => {
    logger.error({ error: err, conversationId: conversation.id }, 'Plan revision failed');
  });
}

async function approvePlan(conversation: Conversation): Promise<void> {
  logAction(null, 'plan_approved', `Content plan approved for conversation ${conversation.id}`);
  await sendToTim('Great! Starting the edits now...', conversation.id);
  updateConversationStatus(conversation.id, 'executing');

  // Enqueue for execution (per-site queue: different sites run in parallel)
  const siteId = getSiteIdForQueue(conversation);
  executionQueue.enqueue(conversation.id, siteId, () => executeTasksWithPlan(conversation));
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
  // Button replies are definitive
  if (msg.type === 'button' && msg.buttonId) {
    if (msg.buttonId === 'confirm_yes' || msg.buttonId === 'plan_approve') return 'yes';
    if (msg.buttonId === 'confirm_no' || msg.buttonId === 'plan_reject') return 'no';
  }

  // Text parsing
  const text = msg.body.toLowerCase().trim();

  const yesPatterns = ['yes', 'y', 'yep', 'yeah', 'go', 'proceed', 'do it', 'ok', 'sure', 'confirmed', 'approve', 'go ahead', '👍'];
  const noPatterns = ['no', 'n', 'nope', 'skip', 'cancel', 'stop', 'don\'t', 'reject', '👎'];

  if (yesPatterns.some((p) => text === p || text.startsWith(p + ' '))) return 'yes';
  if (noPatterns.some((p) => text === p || text.startsWith(p + ' '))) return 'no';

  return 'ambiguous';
}
