import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from './automation/browser-manager.js';
import { removeContent } from './automation/actions/remove-content.js';
import { ensureLoggedIn } from './automation/squarespace-auth.js';
import { resolveSite, navigateToSite, navigateToPage, enterEditMode } from './automation/site-navigator.js';
import { saveChanges } from './automation/editor-actions.js';
import { executeBrowserTask } from './automation/browser-agent.js';
import { pollAndProcess, processEmailById } from './services/email-processor.js';
import { getAllTasks, getTasksByStatus } from './db/tasks.js';
import { getRecentAuditLog } from './db/audit-log.js';
import { getUnprocessedEmails } from './db/emails.js';
import { getRecentConversations } from './db/conversations.js';
import { logger } from './utils/logger.js';
import { MODEL_SONNET } from './config/models.js';

/**
 * CLI entry point for Squarespace Helper.
 *
 * Usage:
 *   npx tsx src/cli.ts remove --site smyth-tavern --page specials --content "happy hour"
 *   npx tsx src/cli.ts poll-emails
 *   npx tsx src/cli.ts process-email --id <gmail-message-id>
 *   npx tsx src/cli.ts list-tasks [--status pending]
 *   npx tsx src/cli.ts audit-log [--limit 20]
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    printUsage();
    process.exit(0);
  }

  const action = args[0];
  const flags = parseFlags(args.slice(1));

  try {
    switch (action) {
      case 'remove':
        await handleRemove(flags);
        break;

      case 'poll-emails':
        await handlePollEmails();
        break;

      case 'process-email':
        await handleProcessEmail(flags);
        break;

      case 'list-tasks':
        handleListTasks(flags);
        break;

      case 'unprocessed-emails':
        handleUnprocessedEmails();
        break;

      case 'audit-log':
        handleAuditLog(flags);
        break;

      case 'start':
        await handleStart();
        break;

      case 'send-test':
        await handleSendTest(flags);
        break;

      case 'conversations':
        handleConversations(flags);
        break;

      case 'agent':
        await handleAgent(flags);
        break;

      default:
        console.error(`Unknown action: ${action}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    logger.error({ error: err }, 'CLI error');
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// ─── Action Handlers ────────────────────────────────────────────────────────

async function handleRemove(flags: Record<string, string>): Promise<void> {
  const site = flags.site;
  const page = flags.page;
  const content = flags.content;

  if (!site || !page || !content) {
    console.error('Error: --site, --page, and --content are required for remove action');
    printUsage();
    process.exit(1);
  }

  const browserManager = getBrowserManager({ headless: flags.headless === 'true' });
  await browserManager.initialize();

  console.log(`\nRemoving content from ${site} / ${page}...`);
  console.log(`  Looking for: "${content}"\n`);

  const result = await removeContent(browserManager, {
    siteIdentifier: site,
    pageSlug: page,
    contentToFind: content,
  });

  if (result.success) {
    console.log('Content removed successfully.');
    console.log(`Screenshot: ${result.screenshotPath}`);
    console.log('\nThe page is in edit mode with unsaved changes.');
    console.log('Review the changes in the browser and save manually.');
  } else {
    console.error(`Failed: ${result.error}`);
    if (result.screenshotPath) {
      console.log(`Screenshot: ${result.screenshotPath}`);
    }
  }

  // Keep the browser open so Tim can review and save
  console.log('\nBrowser is still open. Press Ctrl+C to close.');
  await new Promise(() => {}); // Wait indefinitely
}

async function handlePollEmails(): Promise<void> {
  console.log('\n📧 Polling Gmail for new messages...\n');

  const results = await pollAndProcess();

  if (results.length === 0) {
    console.log('No new messages found.');
    return;
  }

  console.log(`\nProcessed ${results.length} email(s):\n`);

  for (const result of results) {
    console.log(`  Email: ${result.subject}`);
    console.log(`  From:  ${result.from}`);
    console.log(`  Tasks: ${result.tasks.length}`);

    if (result.tasks.length > 0) {
      for (const task of result.tasks) {
        const clarify = task.needsClarification ? ' [NEEDS CLARIFICATION]' : '';
        console.log(`    - [${task.taskType}] ${task.clientName}: ${task.siteId}/${task.targetPage || '?'}${clarify}`);
        if (task.contentToFind) console.log(`      Find: "${task.contentToFind}"`);
        if (task.contentToAdd) console.log(`      Add:  "${task.contentToAdd.substring(0, 80)}..."`);
        if (task.attachmentFilename) console.log(`      File: ${task.attachmentFilename}`);
        if (task.clarificationQuestion) console.log(`      Q:    ${task.clarificationQuestion}`);
      }
    }

    console.log(`  Reasoning: ${result.reasoning.substring(0, 150)}${result.reasoning.length > 150 ? '...' : ''}`);
    console.log('');
  }
}

async function handleProcessEmail(flags: Record<string, string>): Promise<void> {
  const gmailId = flags.id;
  if (!gmailId) {
    console.error('Error: --id <gmail-message-id> is required for process-email action');
    process.exit(1);
  }

  console.log(`\n📧 Processing email ${gmailId}...\n`);

  const result = await processEmailById(gmailId);

  console.log(`  Email: ${result.subject}`);
  console.log(`  From:  ${result.from}`);
  console.log(`  Tasks: ${result.tasks.length}`);
  console.log(`  Reasoning: ${result.reasoning}`);

  if (result.tasks.length > 0) {
    console.log('\n  Extracted tasks:');
    for (const task of result.tasks) {
      console.log(`    [${task.id.substring(0, 8)}] ${task.taskType} → ${task.siteId}/${task.targetPage || '?'}`);
      if (task.contentToFind) console.log(`      Find: "${task.contentToFind}"`);
      if (task.needsClarification) console.log(`      ⚠️  ${task.clarificationQuestion}`);
    }
  }
}

function handleListTasks(flags: Record<string, string>): void {
  const status = flags.status;
  const limit = parseInt(flags.limit || '50', 10);

  const tasks = status ? getTasksByStatus(status as 'pending' | 'confirmed' | 'executing' | 'done' | 'failed') : getAllTasks(limit);

  if (tasks.length === 0) {
    console.log(status ? `No tasks with status "${status}".` : 'No tasks found.');
    return;
  }

  console.log(`\n📋 Tasks${status ? ` (${status})` : ''} — ${tasks.length} total:\n`);

  for (const task of tasks) {
    const clarify = task.needsClarification ? ' [NEEDS CLARIFICATION]' : '';
    const statusIcon =
      task.status === 'done'
        ? '✅'
        : task.status === 'failed'
          ? '❌'
          : task.status === 'executing'
            ? '🔄'
            : task.status === 'confirmed'
              ? '👍'
              : '⏳';

    console.log(`  ${statusIcon} [${task.id.substring(0, 8)}] ${task.taskType} — ${task.clientName}`);
    console.log(`     Site: ${task.siteId}/${task.targetPage || '?'}  Status: ${task.status}${clarify}`);
    if (task.contentToFind) console.log(`     Find: "${task.contentToFind}"`);
    if (task.contentToAdd) console.log(`     Add: "${task.contentToAdd.substring(0, 60)}${task.contentToAdd.length > 60 ? '...' : ''}"`);
    if (task.errorMessage) console.log(`     Error: ${task.errorMessage}`);
    if (task.clarificationQuestion) console.log(`     Q: ${task.clarificationQuestion}`);
    console.log(`     Created: ${task.createdAt}`);
    console.log('');
  }
}

function handleUnprocessedEmails(): void {
  const emails = getUnprocessedEmails();

  if (emails.length === 0) {
    console.log('No unprocessed emails.');
    return;
  }

  console.log(`\n📬 Unprocessed emails — ${emails.length}:\n`);

  for (const email of emails) {
    console.log(`  [${email.id.substring(0, 8)}] ${email.subject || '(no subject)'}`);
    console.log(`    From: ${email.originalSenderEmail || email.fromAddress}`);
    console.log(`    Received: ${email.receivedAt}`);
    console.log('');
  }
}

function handleAuditLog(flags: Record<string, string>): void {
  const limit = parseInt(flags.limit || '20', 10);
  const entries = getRecentAuditLog(limit);

  if (entries.length === 0) {
    console.log('No audit log entries.');
    return;
  }

  console.log(`\n📝 Recent audit log (${entries.length} entries):\n`);

  for (const entry of entries) {
    const taskStr = entry.taskId ? `[${entry.taskId.substring(0, 8)}]` : '[      ]';
    console.log(`  ${entry.createdAt} ${taskStr} ${entry.action}`);
    if (entry.details) console.log(`    ${entry.details}`);
    console.log('');
  }
}

async function handleAgent(flags: Record<string, string>): Promise<void> {
  const site = flags.site;
  const page = flags.page;
  const task = flags.task;

  if (!site || !task) {
    console.error('Error: --site and --task are required for agent action');
    console.error('Usage: npx tsx src/cli.ts agent --site <id> [--page <slug>] --task "<description>"');
    process.exit(1);
  }

  const headless = flags.headless === 'true';
  const maxSteps = parseInt(flags.steps || '20', 10);

  const browserManager = getBrowserManager({ headless });
  await browserManager.initialize();

  console.log(`\n🤖 Browser Agent — ${site}${page ? `/${page}` : ''}`);
  console.log(`   Task: "${task}"`);
  console.log(`   Max steps: ${maxSteps} | Headless: ${headless}\n`);

  try {
    // Ensure logged in
    await ensureLoggedIn(browserManager);
    const browserPage = await browserManager.getPage();

    // Discover sites from dashboard (populates cache for resolveSite)
    const { discoverSites } = await import('./automation/site-discovery.js');
    await discoverSites(browserPage);

    // Resolve site config (tries static config first, then dashboard discovery)
    const client = await resolveSite(site, browserPage);
    console.log(`   Site: ${client.name} (${client.site.adminUrl})\n`);

    // Navigate to site
    console.log('  Navigating to site...');
    await navigateToSite(browserPage, client);

    // Navigate to page if specified
    if (page) {
      console.log(`  Navigating to page: ${page}...`);
      await navigateToPage(browserPage, client, page);
      console.log('  Entering edit mode...');
      await enterEditMode(browserPage);
    }

    // Build site context
    const siteContext = {
      pages: client.site.pages,
      siteName: client.name,
    };

    // Run the browser agent
    console.log('  Starting browser agent loop...\n');

    const result = await executeBrowserTask(browserPage, task, {
      maxSteps,
      model: MODEL_SONNET,
      verbose: true,
    }, siteContext);

    // Safety-net save if agent succeeded
    if (result.success) {
      const saveResult = await saveChanges(browserPage);
      if (saveResult.success) {
        console.log('\n  💾 Safety-net save completed');
      }
    }

    // Print result summary
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${result.success ? '✅ Success' : '❌ Failed'}: ${result.summary}`);
    console.log(`  Steps: ${result.steps.length} | Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Tokens: ${result.tokenUsage.inputTokens.toLocaleString()} input / ${result.tokenUsage.outputTokens.toLocaleString()} output`);

    // Estimate cost (Sonnet: $3/MTok input, $15/MTok output)
    const inputCost = (result.tokenUsage.inputTokens / 1_000_000) * 3;
    const outputCost = (result.tokenUsage.outputTokens / 1_000_000) * 15;
    console.log(`  Est. cost: $${(inputCost + outputCost).toFixed(4)}`);

    if (result.screenshotPath) {
      console.log(`  Screenshot: ${result.screenshotPath}`);
    }

    // Print step details
    if (result.steps.length > 0) {
      console.log(`\n  Steps:`);
      for (const step of result.steps) {
        const icon = step.result.success ? '✅' : '❌';
        console.log(`    ${step.stepNumber}. ${icon} ${step.action.action} — ${step.result.message.substring(0, 80)}`);
        if (step.reasoning) {
          console.log(`       Reasoning: ${step.reasoning.substring(0, 100)}${step.reasoning.length > 100 ? '...' : ''}`);
        }
      }
    }

    console.log('');

    // Keep browser open for review in non-headless mode
    if (!headless) {
      console.log('Browser is still open. Press Ctrl+C to close.');
      await new Promise(() => {}); // Wait indefinitely
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Agent error: ${errMsg}\n`);

    // Keep browser open for debugging
    if (!headless) {
      console.log('Browser is still open for debugging. Press Ctrl+C to close.');
      await new Promise(() => {});
    } else {
      await browserManager.close();
    }
  }
}

async function handleStart(): Promise<void> {
  console.log('\n🚀 Starting Squarespace Helper server...\n');

  // Dynamic import to avoid loading server code for other CLI commands
  const { startServer } = await import('./server.js');
  const { getDb } = await import('./db/database.js');
  const { pollAndProcess } = await import('./services/email-processor.js');
  const { notifyNewTasks } = await import('./services/conversation-handler.js');

  // Initialize database
  getDb();

  // Start the HTTP server
  await startServer();

  // Start email polling
  let polling = false;
  const POLL_INTERVAL_MS = 60_000;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const results = await pollAndProcess();
      for (const result of results) {
        if (result.tasks.length > 0) {
          await notifyNewTasks(result.emailId, result.tasks);
        }
      }
    } catch (err) {
      logger.error({ error: err }, 'Email polling error');
    } finally {
      polling = false;
    }
  };

  setTimeout(poll, 5000);
  setInterval(poll, POLL_INTERVAL_MS);

  console.log('📧 Email polling started (every 60s)');
  console.log('💬 WhatsApp webhook ready');
  console.log('\nPress Ctrl+C to stop.\n');

  // Keep running
  await new Promise(() => {});
}

async function handleSendTest(flags: Record<string, string>): Promise<void> {
  const message = flags.message || 'Hello from Squarespace Helper! 🤖';

  console.log('\n📱 Sending test WhatsApp message...\n');

  const { sendToTim } = await import('./services/whatsapp.js');
  const waMessageId = await sendToTim(message);

  console.log(`  ✅ Message sent!`);
  console.log(`  WhatsApp message ID: ${waMessageId}`);
  console.log(`  Message: "${message}"\n`);
}

function handleConversations(flags: Record<string, string>): void {
  const limit = parseInt(flags.limit || '10', 10);
  const conversations = getRecentConversations(limit);

  if (conversations.length === 0) {
    console.log('No conversations found.');
    return;
  }

  console.log(`\n💬 Recent conversations — ${conversations.length}:\n`);

  for (const conv of conversations) {
    const statusIcon =
      conv.status === 'completed'
        ? '✅'
        : conv.status === 'rejected'
          ? '❌'
          : conv.status === 'executing'
            ? '🔄'
            : conv.status === 'clarifying'
              ? '❓'
              : '⏳';

    console.log(`  ${statusIcon} [${conv.id.substring(0, 8)}] ${conv.status} — ${conv.taskIds.length} task(s) [${conv.source}]`);
    console.log(`     ${conv.emailId ? `Email: ${conv.emailId.substring(0, 8)}` : 'Source: WhatsApp'}`);
    console.log(`     Created: ${conv.createdAt}`);
    console.log(`     Summary: ${conv.summaryText.substring(0, 100)}${conv.summaryText.length > 100 ? '...' : ''}`);
    console.log('');
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      flags[key] = value;
      if (value !== 'true') i++;
    }
  }
  return flags;
}

function printUsage(): void {
  console.log(`
Squarespace Helper CLI

Usage:
  npx tsx src/cli.ts <action> [options]

Actions:
  start               Start the server (webhook + email polling)
  agent               Run the AI browser agent on a site
  send-test           Send a test WhatsApp message to Tim
  remove              Remove content from a page (legacy)
  poll-emails         Poll Gmail for new emails and process them
  process-email       Process a single email by Gmail message ID
  list-tasks          List tasks in the database
  conversations       List recent WhatsApp conversations
  unprocessed-emails  List unprocessed emails
  audit-log           Show recent audit log entries

Options for 'start':
  (no options — uses PORT and HOST from .env)

Options for 'send-test':
  --message <text>   Message to send (default: "Hello from Squarespace Helper!")

Options for 'agent':
  --site <id>        Site identifier (name, alias, or ID from sites.json)
  --page <slug>      Page slug to edit (optional — agent navigates if needed)
  --task <text>      Natural language description of what to do
  --steps <n>        Maximum agent steps (default: 20)
  --headless         Run browser in headless mode (default: false)

Options for 'remove':
  --site <id>        Site identifier (name, alias, or ID from sites.json)
  --page <slug>      Page slug to edit
  --content <text>   Text content to find and remove
  --headless         Run browser in headless mode (default: false)

Options for 'process-email':
  --id <gmail-id>    Gmail message ID to process

Options for 'list-tasks':
  --status <status>  Filter by status (pending, confirmed, executing, done, failed)
  --limit <n>        Maximum number of tasks to show (default: 50)

Options for 'conversations':
  --limit <n>        Maximum conversations to show (default: 10)

Options for 'audit-log':
  --limit <n>        Maximum entries to show (default: 20)

Examples:
  npx tsx src/cli.ts start
  npx tsx src/cli.ts agent --site smyth-tavern --page menus --task "Remove the happy hour section"
  npx tsx src/cli.ts agent --site smyth-tavern --task "Add a new page called Winter Specials"
  npx tsx src/cli.ts send-test --message "Testing 1-2-3"
  npx tsx src/cli.ts remove --site smyth-tavern --page specials --content "happy hour"
  npx tsx src/cli.ts poll-emails
  npx tsx src/cli.ts process-email --id 18dcb1234abc
  npx tsx src/cli.ts list-tasks --status pending
  npx tsx src/cli.ts conversations
  npx tsx src/cli.ts audit-log --limit 10
`);
}

main();
