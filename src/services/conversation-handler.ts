/**
 * Conversation handler — slim router for incoming messages.
 *
 * Supports multiple concurrent conversations. Routes messages to the
 * correct conversation using:
 * 1. Explicit conversationId (dashboard messages)
 * 2. Encoded conversationId in button IDs (WhatsApp button replies)
 * 3. Single-interactive-conversation fast path
 * 4. Disambiguation when multiple conversations await input
 *
 * Delegates to focused sub-modules:
 * - message-handlers: WhatsApp message interpretation and conversation state handlers
 * - planning: content planning pipeline and plan formatting
 * - execution: task execution (single, batched, multi-site)
 * - helpers: formatting, diagnostics, and utilities
 */

import { logger } from '../utils/logger.js';
import { logAction } from '../db/audit-log.js';
import {
  getConversation,
  getActiveConversations,
  getInteractiveConversations,
  createConversation,
  addTasksToConversation,
} from '../db/conversations.js';
import { getTask } from '../db/tasks.js';
import { storeWhatsAppMessage } from '../db/whatsapp-messages.js';
import {
  sendToTim,
  sendButtonsToTim,
  bufferImageMessage,
  onImageGroupComplete,
  type IncomingWhatsAppMessage,
} from './whatsapp.js';
import {
  handleDirectRequest,
  handleConfirmation,
  handleClarification,
  handlePlanApproval,
} from './conversation/message-handlers.js';
import { formatTaskList, describeTask } from './conversation/helpers.js';
import { errMsg } from '../utils/errors.js';
import type { Task } from '../models/task.js';
import type { Conversation } from '../models/conversation.js';

// ─── Button ID Encoding ──────────────────────────────────────────────────────

/** Extract conversationId from an encoded button ID like "confirm_yes::uuid". */
function extractConversationIdFromButton(buttonId: string): { action: string; conversationId?: string } {
  const separatorIndex = buttonId.indexOf('::');
  if (separatorIndex === -1) {
    return { action: buttonId };
  }
  return {
    action: buttonId.substring(0, separatorIndex),
    conversationId: buttonId.substring(separatorIndex + 2),
  };
}

// ─── Message Routing ─────────────────────────────────────────────────────────

/**
 * Route a WhatsApp message to the correct conversation.
 * Returns undefined if the message should be treated as a new direct request.
 */
function routeWhatsAppMessage(msg: IncomingWhatsAppMessage): Conversation | undefined {
  // 1. Check for encoded conversationId in button payload
  if (msg.type === 'button' && msg.buttonId) {
    const { conversationId } = extractConversationIdFromButton(msg.buttonId);
    if (conversationId) {
      const conv = getConversation(conversationId);
      if (conv) {
        logger.info({ conversationId, action: msg.buttonId }, 'Routed via encoded button ID');
        return conv;
      }
      logger.warn({ conversationId }, 'Encoded conversationId not found, falling back');
    }
  }

  // 2. Check for route_to:: disambiguation buttons
  if (msg.type === 'button' && msg.buttonId?.startsWith('route_to::')) {
    const conversationId = msg.buttonId.substring('route_to::'.length);
    const conv = getConversation(conversationId);
    if (conv) {
      logger.info({ conversationId }, 'Routed via disambiguation button');
      return conv;
    }
  }

  // 3. Find interactive conversations (awaiting user input)
  const interactive = getInteractiveConversations();

  if (interactive.length === 1) {
    return interactive[0];
  }

  if (interactive.length > 1) {
    // Ambiguous — trigger disambiguation (async, fire-and-forget)
    sendDisambiguationMessage(interactive).catch((err) => {
      logger.warn({ error: err }, 'Failed to send disambiguation message');
    });
    return undefined;
  }

  // 4. No interactive conversations — check if any are busy (executing, planning, etc.)
  const active = getActiveConversations();
  if (active.length > 0) {
    // All conversations are busy — treat as new request
    return undefined;
  }

  // 5. No active conversations at all
  return undefined;
}

/** Send Tim a disambiguation message when multiple conversations await input. */
async function sendDisambiguationMessage(conversations: Conversation[]): Promise<void> {
  const summaries = conversations.map((conv, i) => {
    const tasks = conv.taskIds.map((id) => getTask(id)).filter(Boolean) as Task[];
    const site = tasks[0]?.clientName ?? 'Unknown';
    const desc = conv.summaryText?.substring(0, 60) ?? (tasks[0] ? describeTask(tasks[0]) : 'Unknown task');
    return `${i + 1}. ${site}: ${desc}`;
  }).join('\n');

  // WhatsApp buttons limited to 3
  if (conversations.length <= 3) {
    const buttons = conversations.map((conv, i) => {
      const tasks = conv.taskIds.map((id) => getTask(id)).filter(Boolean) as Task[];
      const site = tasks[0]?.clientName ?? 'Unknown';
      return {
        id: `route_to::${conv.id}`,
        title: `${i + 1}. ${site}`.substring(0, 20),
      };
    });

    await sendButtonsToTim(
      `I have ${conversations.length} pending requests:\n\n${summaries}\n\nWhich one are you responding to?`,
      buttons,
    );
  } else {
    await sendToTim(
      `I have ${conversations.length} pending requests:\n\n${summaries}\n\nReply with the number to select one, or send a new request.`,
    );
  }
}

// ─── Incoming Message Handler ───────────────────────────────────────────────

/**
 * Handle an incoming message (WhatsApp or dashboard).
 * Routes to the appropriate handler based on the resolved conversation's state.
 */
export async function handleIncomingMessage(msg: IncomingWhatsAppMessage): Promise<void> {
  const isDashboard = msg.from === 'dashboard';
  logger.info(
    { from: msg.from, type: msg.type, body: msg.body, buttonId: msg.buttonId, source: isDashboard ? 'dashboard' : 'whatsapp' },
    'Processing incoming message',
  );

  // ─── Route to the correct conversation ────────────────────────────────
  let conversation: Conversation | undefined;

  // Dashboard messages may carry an explicit conversationId
  const explicitConversationId = (msg as unknown as Record<string, unknown>).conversationId as string | undefined;

  if (explicitConversationId) {
    conversation = getConversation(explicitConversationId);
  } else if (isDashboard) {
    // Dashboard without conversationId: route to most recent interactive conversation
    const interactive = getInteractiveConversations();
    conversation = interactive[0];
  } else {
    // WhatsApp: smart routing
    conversation = routeWhatsAppMessage(msg);
  }

  // Decode encoded button IDs back to the original action before passing to handlers
  if (msg.type === 'button' && msg.buttonId) {
    const { action } = extractConversationIdFromButton(msg.buttonId);
    msg = { ...msg, buttonId: action };
  }

  // Store inbound message
  storeWhatsAppMessage({
    conversationId: conversation?.id,
    waMessageId: msg.waMessageId,
    direction: 'inbound',
    fromNumber: isDashboard ? 'dashboard' : msg.from,
    toNumber: isDashboard ? 'system' : (process.env.WHATSAPP_PHONE_NUMBER_ID ?? ''),
    body: msg.body,
    timestamp: msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000).toISOString() : new Date().toISOString(),
  });

  // Treat finished conversations as no conversation — start fresh
  if (conversation && (conversation.status === 'completed' || conversation.status === 'rejected')) {
    logger.info({ conversationId: conversation.id, status: conversation.status },
      'Ignoring finished conversation — treating as new request');
    conversation = undefined;
  }

  if (!conversation) {
    // Try to buffer image messages for multi-image grouping
    if (!isDashboard && msg.type === 'image' && bufferImageMessage(msg)) {
      logger.info({ waMessageId: msg.waMessageId }, 'Image buffered for grouping');
      return;
    }

    // No matching conversation — interpret as a direct editing request
    await handleDirectRequest(msg);
    return;
  }

  switch (conversation.status) {
    case 'awaiting_confirm':
      await handleConfirmation(conversation, msg);
      break;

    case 'clarifying':
      await handleClarification(conversation, msg);
      break;

    case 'planning':
      await sendToTim('I\'m still researching and drafting a content plan. Hang tight — I\'ll send it to you shortly.', conversation.id);
      break;

    case 'awaiting_plan_approval':
      await handlePlanApproval(conversation, msg);
      break;

    case 'revising':
      await sendToTim('I\'m revising the plan based on your feedback. I\'ll send the updated version shortly.', conversation.id);
      break;

    case 'executing':
      await sendToTim('I\'m currently working on your tasks. I\'ll let you know when I\'m done.', conversation.id);
      break;

    default:
      await sendToTim('I received your message but I\'m not sure what to do with it. Send me a request or forward an email to get started.', conversation.id);
      break;
  }
}

// ─── Image Group Handler ────────────────────────────────────────────────────

// Register callback for when a multi-image group is ready
onImageGroupComplete(async (messages, imageGroupId) => {
  try {
    logger.info({ imageGroupId, count: messages.length }, 'Image group complete, processing');

    // The caption on the first image becomes the task description
    const firstMsg = messages[0];
    const caption = messages.find((m) => m.body)?.body ?? '';

    // Build a synthetic message that carries all the grouped images
    const syntheticMsg: IncomingWhatsAppMessage & { imageMessages?: IncomingWhatsAppMessage[] } = {
      ...firstMsg,
      body: caption,
      isPartOfImageGroup: true,
      imageGroupId,
      imageMessages: messages,
    };

    // Route through normal handler (as a new direct request)
    await handleDirectRequest(syntheticMsg);
  } catch (err) {
    logger.error({ imageGroupId, error: errMsg(err) }, 'Image group handler failed');
  }
});

// ─── New Email Handler ──────────────────────────────────────────────────────

/**
 * Called after email processing creates tasks.
 * Creates a new conversation or appends to an existing interactive one for the same site.
 */
export async function notifyNewTasks(emailId: string, tasks: Task[]): Promise<void> {
  if (tasks.length === 0) return;

  const taskIds = tasks.map((t) => t.id);
  const newSiteIds = new Set(tasks.map((t) => t.siteId));

  // Check for existing interactive conversations for the SAME site
  const interactive = getInteractiveConversations();
  const matchingConversation = interactive.find((conv) => {
    if (conv.status !== 'awaiting_confirm' && conv.status !== 'clarifying') return false;
    const convTasks = conv.taskIds.map((id) => getTask(id)).filter(Boolean) as Task[];
    return convTasks.some((t) => newSiteIds.has(t.siteId));
  });

  if (matchingConversation) {
    // Append to matching conversation
    addTasksToConversation(matchingConversation.id, taskIds);
    const total = matchingConversation.taskIds.length + taskIds.length;

    await sendToTim(
      `📧 New tasks added! Now ${total} total:\n\n${formatTaskList([...matchingConversation.taskIds.map((id) => getTask(id)!).filter(Boolean), ...tasks])}`,
      matchingConversation.id,
    );
    return;
  }

  // Create new conversation (even if other conversations are active)
  const summaryText = formatTaskList(tasks);
  const conversation = createConversation({
    emailId,
    source: 'email',
    taskIds,
    summaryText,
  });

  logAction(null, 'conversation_created', `Conversation ${conversation.id} for email ${emailId}`);

  // Build the message
  const sender = tasks[0].clientName;
  const message = `📧 New request from ${sender}:\n\n${summaryText}\n\nProceed?`;

  // Send with buttons (encoded with conversationId for routing)
  await sendButtonsToTim(message, [
    { id: 'confirm_yes', title: 'Yes, proceed' },
    { id: 'confirm_no', title: 'No, skip' },
  ], conversation.id);
}
