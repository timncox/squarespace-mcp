import dotenv from 'dotenv';
dotenv.config({ override: true });

// Safety net: if shell exports ANTHROPIC_API_KEY="" (empty), delete it so
// dotenv's value from .env takes precedence (override:true handles non-empty).
if (process.env.ANTHROPIC_API_KEY !== undefined && !process.env.ANTHROPIC_API_KEY) {
  delete process.env.ANTHROPIC_API_KEY;
}
import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from './utils/logger.js';
import { getDb, closeDb } from './db/database.js';
import { startServer } from './server.js';
import { pollAndProcess } from './services/email-processor.js';
import { notifyNewTasks } from './services/conversation-handler.js';
import { shutdownBrowser } from './automation/browser-manager.js';
import { ensureProxy, stopProxy } from './utils/proxy-manager.js';

const POLL_INTERVAL_MS = 60_000; // Check Gmail every 60 seconds

/**
 * Main entry point for the Squarespace Helper agent.
 *
 * Starts the Fastify server (for WhatsApp webhooks) and
 * runs a Gmail polling loop that extracts tasks and notifies Tim.
 */
async function main(): Promise<void> {
  logger.info('Squarespace Helper starting');

  // Initialize database
  getDb();
  logger.info('Database initialized');

  // Recover any tasks/conversations left in 'executing' state from a previous crash
  recoverOrphanedExecutions();

  // Clean up old screenshots to prevent unbounded disk growth
  pruneOldScreenshots();

  // Ensure claude-code-proxy is running (needed for Anthropic API calls)
  await ensureProxy();

  // Start the HTTP server
  const app = await startServer();

  // Start email polling loop
  startEmailPolling();

  // Register shutdown handlers for clean browser + server + DB cleanup
  setupShutdownHandlers(app);

  logger.info('Agent is ready. Waiting for emails and WhatsApp messages.');
}

/**
 * Periodically poll Gmail for new emails, extract tasks, and notify Tim.
 */
function startEmailPolling(): void {
  let polling = false;

  const poll = async () => {
    if (polling) return; // Prevent overlapping polls
    polling = true;

    try {
      const results = await pollAndProcess();

      for (const result of results) {
        if (result.tasks.length > 0) {
          logger.info(
            { emailId: result.emailId, taskCount: result.tasks.length },
            'New tasks extracted, notifying Tim',
          );
          await notifyNewTasks(result.emailId, result.tasks);
        }
      }
    } catch (err) {
      // Don't crash the server — log and continue
      logger.error({ error: err }, 'Email polling error');
    } finally {
      polling = false;
    }
  };

  // First poll after a short delay (let server start up)
  setTimeout(poll, 5000);

  // Then poll on interval
  setInterval(poll, POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Email polling started');
}

/**
 * On startup, find any tasks or conversations stuck in 'executing' state
 * from a previous server crash and reset them so they don't block new work.
 */
function recoverOrphanedExecutions(): void {
  const db = getDb();

  // Check for orphaned executing tasks
  const orphanedTasks = db
    .prepare(`SELECT id FROM tasks WHERE status = 'executing'`)
    .all() as { id: string }[];

  if (orphanedTasks.length > 0) {
    // For each orphaned task, check if the browser agent completed successfully
    // before the server restart (i.e., the supervisor was interrupted, not the agent)
    const checkAgentCompleted = db.prepare(
      `SELECT 1 FROM agent_events
       WHERE task_id = ? AND event_type = 'agent_activity'
       AND data LIKE '%"agent":"browser_agent"%'
       AND data LIKE '%"status":"completed"%'
       LIMIT 1`,
    );

    const markDone = db.prepare(
      `UPDATE tasks SET status = 'done', error_message = 'Browser agent completed; supervisor verification interrupted by server restart'
       WHERE id = ?`,
    );
    const markFailed = db.prepare(
      `UPDATE tasks SET status = 'failed', error_message = 'Server restarted while task was executing — marked as failed for safety'
       WHERE id = ?`,
    );

    let doneCount = 0;
    let failedCount = 0;

    for (const task of orphanedTasks) {
      const agentCompleted = checkAgentCompleted.get(task.id);
      if (agentCompleted) {
        markDone.run(task.id);
        doneCount++;
        logger.info({ taskId: task.id }, 'Orphaned task recovered as done — browser agent had completed');
      } else {
        markFailed.run(task.id);
        failedCount++;
      }
    }

    if (doneCount > 0) {
      logger.warn({ count: doneCount }, 'Recovered orphaned executing tasks → done (browser agent had completed)');
    }
    if (failedCount > 0) {
      logger.warn({ count: failedCount }, 'Recovered orphaned executing tasks → failed');
    }
  }

  // Reset orphaned conversations: executing → completed
  const stuckConversations = db.prepare(
    `UPDATE conversations SET status = 'completed'
     WHERE status = 'executing'`,
  ).run();

  if (stuckConversations.changes > 0) {
    logger.warn({ count: stuckConversations.changes }, 'Recovered orphaned executing conversations → completed');
  }

  // Also reset planning → idle (planning without a browser agent running is stale)
  const stuckPlanning = db.prepare(
    `UPDATE conversations SET status = 'idle'
     WHERE status = 'planning'`,
  ).run();

  if (stuckPlanning.changes > 0) {
    logger.warn({ count: stuckPlanning.changes }, 'Recovered orphaned planning conversations → idle');
  }
}

/**
 * Delete screenshots older than 7 days from storage/screenshots/.
 * Runs on startup to prevent unbounded disk growth.
 */
function pruneOldScreenshots(): void {
  const screenshotDir = join(process.cwd(), 'storage', 'screenshots');
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const cutoff = Date.now() - MAX_AGE_MS;
  let pruned = 0;
  let errors = 0;

  try {
    const files = readdirSync(screenshotDir);

    for (const file of files) {
      try {
        const filePath = join(screenshotDir, file);
        const stat = statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
          pruned++;
        }
      } catch {
        errors++;
      }
    }

    if (pruned > 0 || errors > 0) {
      logger.info({ pruned, errors, remaining: files.length - pruned }, 'Screenshot cleanup complete');
    }
  } catch (err) {
    // Directory may not exist yet on first run — that's fine
    logger.debug({ error: err }, 'Screenshot cleanup skipped (directory may not exist)');
  }
}

// Graceful shutdown: clean up browser, server, and database on exit
function setupShutdownHandlers(app: Awaited<ReturnType<typeof startServer>>): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received — cleaning up');

    // 1. Stop accepting new HTTP requests
    try {
      await app.close();
      logger.info('Fastify server closed');
    } catch (err) {
      logger.warn({ error: err }, 'Error closing Fastify server');
    }

    // 2. Stop proxy if we spawned it
    stopProxy();

    // 3. Close browser processes
    await shutdownBrowser();

    // 4. Close SQLite database (flushes WAL)
    try {
      closeDb();
    } catch (err) {
      logger.warn({ error: err }, 'Error closing database');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('uncaughtException', (err) => {
  logger.fatal({ error: err }, 'Uncaught exception — exiting');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection — exiting');
  process.exit(1);
});

main().catch((err) => {
  logger.error({ error: err }, 'Fatal error');
  process.exit(1);
});
