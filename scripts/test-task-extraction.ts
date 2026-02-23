import dotenv from 'dotenv';
dotenv.config({ override: true });
import { parseEmail } from '../src/services/email-parser.js';
import { extractTasks, type ExtractionResult } from '../src/services/task-extractor.js';
import { getDb } from '../src/db/database.js';
import { storeEmail, markEmailProcessed } from '../src/db/emails.js';
import { createTask, getAllTasks, type CreateTaskInput } from '../src/db/tasks.js';
import { logAction, getRecentAuditLog } from '../src/db/audit-log.js';
import type { GmailMessage } from '../src/services/gmail.js';

/**
 * Test the Phase 2 pipeline without needing Gmail API credentials.
 *
 * Simulates a forwarded email from Tim about Smyth Tavern tasks,
 * parses it, extracts tasks via Claude, and stores in SQLite.
 *
 * Usage:
 *   npx tsx scripts/test-task-extraction.ts
 *
 * Requires: ANTHROPIC_API_KEY in .env
 */

// Simulate a forwarded email — the kind Tim would forward to the agent
const MOCK_EMAIL: GmailMessage = {
  id: 'test-msg-001',
  threadId: 'test-thread-001',
  from: 'Tim Cox <tim@example.com>',
  fromName: 'Tim Cox',
  subject: 'Fwd: Updated menus and specials changes',
  date: new Date().toISOString(),
  bodyText: `---------- Forwarded message ----------
From: Dawn Smith <dawn@smythtavern.com>
Date: Wed, Feb 12, 2026
Subject: Updated menus and specials changes
To: Tim Cox <tim@example.com>

Hi Tim,

A few things for the Smyth Tavern website:

1. Can you take down the happy hour specials from the Specials page? We're not doing happy hour anymore.

2. Also, we need to remove the Restaurant Week menus from ALL the MSH restaurant websites. Restaurant Week is over.

3. I'm attaching the new Power Lunch menu PDF. Can you upload it to the Menus page and add a link for guests to download?

Thanks!
Dawn
`,
  bodyHtml: '',
  attachments: [
    {
      filename: 'Power_Lunch_Menu_Feb2026.pdf',
      mimeType: 'application/pdf',
      size: 245760,
      attachmentId: 'test-att-001',
      messageId: 'test-msg-001',
    },
  ],
};

async function main(): Promise<void> {
  console.log('=== Phase 2 Pipeline Test ===\n');

  // Step 1: Initialize database
  console.log('1. Initializing database...');
  const db = getDb();
  console.log('   Database ready.\n');

  // Step 2: Parse the email
  console.log('2. Parsing email...');
  const parsed = parseEmail(MOCK_EMAIL);
  console.log(`   Subject: ${parsed.subject}`);
  console.log(`   Forwarder: ${parsed.forwarderEmail}`);
  console.log(`   Original sender: ${parsed.originalSenderEmail || '(not found)'}`);
  console.log(`   Original sender name: ${parsed.originalSenderName || '(not found)'}`);
  console.log(`   Attachments: ${parsed.attachments.length}`);
  console.log(`   Body preview: ${parsed.bodyText.substring(0, 100)}...\n`);

  // Step 3: Store email in database
  console.log('3. Storing email in database...');
  const storedEmail = storeEmail({
    gmailMessageId: MOCK_EMAIL.id,
    gmailThreadId: MOCK_EMAIL.threadId,
    fromAddress: parsed.forwarderEmail,
    fromName: parsed.forwarderName,
    subject: parsed.subject,
    bodyText: parsed.rawBodyText,
    bodyHtml: parsed.rawBodyHtml,
    originalSenderEmail: parsed.originalSenderEmail,
    originalSenderName: parsed.originalSenderName,
    receivedAt: parsed.receivedAt,
  });
  console.log(`   Stored as: ${storedEmail.id}\n`);

  logAction(null, 'email_received', `Subject: ${parsed.subject}, From: ${parsed.originalSenderEmail || parsed.forwarderEmail}`);

  // Step 4: Extract tasks via Claude
  console.log('4. Extracting tasks via Claude API...');
  console.log('   (this may take a few seconds)\n');

  let extraction: ExtractionResult;
  let usedMockData = false;
  try {
    extraction = await extractTasks(parsed);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`   ⚠️  Claude API call failed: ${errMsg.substring(0, 120)}`);
    console.warn('   Using mock task extraction to test the rest of the pipeline...\n');
    usedMockData = true;

    // Fallback: simulate what Claude would return
    extraction = {
      reasoning: 'MOCK: Simulated extraction for testing. Dawn from Smyth Tavern requests 3 changes: remove happy hour, remove RW menus from all MSH sites, upload Power Lunch PDF.',
      tasks: [
        {
          taskType: 'remove_content',
          clientName: 'Smyth Tavern',
          siteIdentifier: 'smyth-tavern',
          targetPage: 'specials',
          contentToFind: 'happy hour',
          contentToAdd: undefined,
          attachmentFilename: undefined,
          applyToAllSites: false,
          groupId: undefined,
          needsClarification: false,
          clarificationQuestion: undefined,
          summary: 'Remove happy hour specials from Smyth Tavern Specials page',
        },
        {
          taskType: 'remove_content',
          clientName: 'Mercer Street Hospitality',
          siteIdentifier: 'smyth-tavern',
          targetPage: 'menus',
          contentToFind: 'Restaurant Week',
          contentToAdd: undefined,
          attachmentFilename: undefined,
          applyToAllSites: true,
          groupId: 'msh',
          needsClarification: false,
          clarificationQuestion: undefined,
          summary: 'Remove Restaurant Week menus from ALL MSH restaurant websites',
        },
        {
          taskType: 'upload_file_and_link',
          clientName: 'Smyth Tavern',
          siteIdentifier: 'smyth-tavern',
          targetPage: 'menus',
          contentToFind: undefined,
          contentToAdd: undefined,
          attachmentFilename: 'Power_Lunch_Menu_Feb2026.pdf',
          applyToAllSites: false,
          groupId: undefined,
          needsClarification: false,
          clarificationQuestion: undefined,
          summary: 'Upload Power Lunch PDF to Smyth Tavern Menus page',
        },
      ],
    };
  }

  console.log(`   Reasoning: ${extraction.reasoning}\n`);
  console.log(`   Extracted ${extraction.tasks.length} task(s):\n`);

  for (let i = 0; i < extraction.tasks.length; i++) {
    const t = extraction.tasks[i];
    console.log(`   Task ${i + 1}: ${t.summary}`);
    console.log(`     Type: ${t.taskType}`);
    console.log(`     Client: ${t.clientName}`);
    console.log(`     Site: ${t.siteIdentifier}`);
    console.log(`     Page: ${t.targetPage || '?'}`);
    if (t.contentToFind) console.log(`     Find: "${t.contentToFind}"`);
    if (t.contentToAdd) console.log(`     Add: "${t.contentToAdd}"`);
    if (t.attachmentFilename) console.log(`     File: ${t.attachmentFilename}`);
    console.log(`     All sites: ${t.applyToAllSites}`);
    if (t.groupId) console.log(`     Group: ${t.groupId}`);
    if (t.needsClarification) console.log(`     ⚠️  Needs clarification: ${t.clarificationQuestion}`);
    console.log('');
  }

  // Step 5: Create task records in database
  console.log('5. Creating task records in database...');
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
    logAction(task.id, 'task_created', extractedTask.summary);
    console.log(`   Created: [${task.id.substring(0, 8)}] ${extractedTask.summary}`);
  }

  markEmailProcessed(storedEmail.id);

  if (usedMockData) {
    console.log('\n   Note: Used mock data because Claude API was unavailable.');
    console.log('   Top up your Anthropic credits and re-run to test with real extraction.');
  }
  console.log('');

  // Step 6: Verify database state
  console.log('6. Verifying database state...');
  const allTasks = getAllTasks();
  console.log(`   Total tasks in DB: ${allTasks.length}`);

  const auditLog = getRecentAuditLog(10);
  console.log(`   Recent audit entries: ${auditLog.length}`);

  console.log('\n=== Test Complete ===');
  console.log('\nRun "npx tsx src/cli.ts list-tasks" to see all tasks.');
  console.log('Run "npx tsx src/cli.ts audit-log" to see the audit trail.');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
