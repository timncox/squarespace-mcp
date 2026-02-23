import { fetchNewMessages, downloadAttachment, markAsRead, type GmailMessage } from './gmail.js';
import { parseEmail, type ParsedEmail } from './email-parser.js';
import { extractTasks, type ExtractionResult } from './task-extractor.js';
import { storeEmail, getEmailByGmailId, markEmailProcessed } from '../db/emails.js';
import { createTask, type CreateTaskInput } from '../db/tasks.js';
import { recordAttachment } from './file-manager.js';
import { logAction } from '../db/audit-log.js';
import { logger } from '../utils/logger.js';
import { errContext } from '../utils/errors.js';
import type { Task } from '../models/task.js';

export interface ProcessingResult {
  emailId: string;
  subject: string;
  from: string;
  tasks: Task[];
  reasoning: string;
}

/**
 * Process a single Gmail message end-to-end:
 * 1. Parse the email (extract sender, body, attachments)
 * 2. Store in database
 * 3. Download attachments
 * 4. Extract tasks via Claude API
 * 5. Create task records in database
 */
export async function processEmail(message: GmailMessage): Promise<ProcessingResult> {
  // Check if already processed
  const existing = getEmailByGmailId(message.id);
  if (existing) {
    logger.info({ gmailId: message.id }, 'Email already processed, skipping');
    return {
      emailId: existing.id,
      subject: existing.subject ?? '',
      from: existing.fromAddress,
      tasks: [],
      reasoning: 'Already processed',
    };
  }

  // 1. Parse the email
  const parsed = parseEmail(message);
  logger.info(
    {
      subject: parsed.subject,
      originalSender: parsed.originalSenderEmail,
      attachments: parsed.attachments.length,
    },
    'Email parsed',
  );

  // Emit agent activity — Task Extractor started
  const { dashboardEvents } = await import('./dashboard-events.js');
  dashboardEvents.emit('dashboard', {
    type: 'agent_activity' as const,
    data: {
      agent: 'task_extractor',
      status: 'started',
      message: `Parsing email: "${parsed.subject}"`,
      detail: { from: parsed.originalSenderEmail || parsed.forwarderEmail, attachments: parsed.attachments.length },
    },
    timestamp: new Date().toISOString(),
  });

  // 2. Store in database
  const storedEmail = storeEmail({
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    fromAddress: parsed.forwarderEmail,
    fromName: parsed.forwarderName,
    subject: parsed.subject,
    bodyText: parsed.rawBodyText,
    bodyHtml: parsed.rawBodyHtml,
    originalSenderEmail: parsed.originalSenderEmail,
    originalSenderName: parsed.originalSenderName,
    receivedAt: parsed.receivedAt,
  });

  logAction(null, 'email_received', `Subject: ${parsed.subject}, From: ${parsed.originalSenderEmail || parsed.forwarderEmail}`);

  // 3. Download attachments
  for (const attachment of parsed.attachments) {
    try {
      const filePath = await downloadAttachment(
        attachment.messageId,
        attachment.attachmentId,
        attachment.filename,
      );
      recordAttachment(storedEmail.id, attachment.filename, filePath, attachment.mimeType);
    } catch (err) {
      logger.error({ filename: attachment.filename, ...errContext(err) }, 'Failed to download attachment');
    }
  }

  // 4. Extract tasks via Claude (with 1 retry on failure)
  let extraction: ExtractionResult | undefined;
  let extractionFailed = false;

  dashboardEvents.emit('dashboard', {
    type: 'agent_activity' as const,
    data: { agent: 'task_extractor', status: 'progress', message: `Extracting tasks from "${parsed.subject}" via Claude...` },
    timestamp: new Date().toISOString(),
  });

  for (let extractAttempt = 1; extractAttempt <= 2; extractAttempt++) {
    try {
      extraction = await extractTasks(parsed);
      break; // Success
    } catch (err) {
      logger.error({ attempt: extractAttempt, ...errContext(err) }, 'Task extraction failed');
      if (extractAttempt < 2) {
        logger.info('Retrying task extraction in 3 seconds...');
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        extractionFailed = true;
      }
    }
  }

  // If extraction completely failed, DON'T mark as processed — next poll will skip
  // the stored record (getEmailByGmailId check) but we preserve the email for manual review.
  if (extractionFailed || !extraction) {
    dashboardEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: { agent: 'task_extractor', status: 'failed', message: `Failed to extract tasks from "${parsed.subject}" after 2 attempts` },
      timestamp: new Date().toISOString(),
    });
    logAction(null, 'email_extraction_failed', `Subject: ${parsed.subject}, Email DB ID: ${storedEmail.id}`);
    logger.error(
      { emailId: storedEmail.id, subject: parsed.subject },
      'Task extraction failed after retries — email stored but NOT marked processed (needs manual review)',
    );
    return {
      emailId: storedEmail.id,
      subject: parsed.subject,
      from: parsed.originalSenderEmail || parsed.forwarderEmail,
      tasks: [],
      reasoning: 'Extraction failed after 2 attempts — email needs manual review',
    };
  }

  // 5. Create task records
  const createdTasks: Task[] = [];
  for (const extractedTask of extraction.tasks) {
    const taskInput: CreateTaskInput = {
      emailId: storedEmail.id,
      taskType: extractedTask.taskType,
      clientName: extractedTask.clientName,
      siteId: extractedTask.siteIdentifier,
      targetPage: extractedTask.targetPage,
      contentToFind: extractedTask.contentToFind,
      contentToAdd: extractedTask.contentToAdd,
      attachmentFilename: extractedTask.attachmentFilename,
      applyToAllSites: extractedTask.applyToAllSites,
      groupId: extractedTask.groupId,
      needsClarification: extractedTask.needsClarification,
      clarificationQuestion: extractedTask.clarificationQuestion,
    };

    const task = createTask(taskInput);
    createdTasks.push(task);

    logAction(task.id, 'task_created', extractedTask.summary);
  }

  // Only mark email as processed if extraction succeeded
  markEmailProcessed(storedEmail.id);

  dashboardEvents.emit('dashboard', {
    type: 'agent_activity' as const,
    data: {
      agent: 'task_extractor',
      status: 'completed',
      message: `Extracted ${createdTasks.length} task(s) from "${parsed.subject}"`,
      detail: { taskCount: createdTasks.length, reasoning: extraction.reasoning },
    },
    timestamp: new Date().toISOString(),
  });

  logger.info(
    {
      emailId: storedEmail.id,
      taskCount: createdTasks.length,
      reasoning: extraction.reasoning,
    },
    'Email processing complete',
  );

  return {
    emailId: storedEmail.id,
    subject: parsed.subject,
    from: parsed.originalSenderEmail || parsed.forwarderEmail,
    tasks: createdTasks,
    reasoning: extraction.reasoning,
  };
}

/**
 * Poll Gmail for new messages and process them.
 */
export async function pollAndProcess(): Promise<ProcessingResult[]> {
  logger.info('Polling Gmail for new messages...');

  const messages = await fetchNewMessages();
  if (messages.length === 0) {
    logger.info('No new messages');
    return [];
  }

  const results: ProcessingResult[] = [];
  for (const message of messages) {
    try {
      const result = await processEmail(message);
      results.push(result);

      // Mark as read after successful processing
      await markAsRead(message.id);
    } catch (err) {
      logger.error({ messageId: message.id, ...errContext(err) }, 'Failed to process message');
    }
  }

  return results;
}

/**
 * Process a single email by Gmail message ID (for manual/CLI use).
 */
export async function processEmailById(gmailMessageId: string): Promise<ProcessingResult> {
  const { fetchMessage } = await import('./gmail.js');
  const message = await fetchMessage(gmailMessageId);
  if (!message) {
    throw new Error(`Message ${gmailMessageId} not found`);
  }
  return processEmail(message);
}
