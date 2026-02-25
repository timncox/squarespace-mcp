/**
 * Task execution — single tasks, batched plans, and multi-site expansion.
 */

import { logger } from '../../utils/logger.js';
import { MODEL_SONNET } from '../../config/models.js';
import { errMsg } from '../../utils/errors.js';
import { logAction } from '../../db/audit-log.js';
import { updateConversationStatus } from '../../db/conversations.js';
import { createTask, getTask, updateTaskStatus, updateTaskScreenshot, incrementTaskAttempt } from '../../db/tasks.js';
import { decayOldLearnings } from '../../db/learnings.js';
import {
  sendToTim,
  sendImageToTim,
} from '../whatsapp.js';
import { loadSitesConfig } from '../task-extractor.js';
import { getClientsInGroup } from '../../models/site-config.js';
import { getBrowserManager, type BrowserHandle, type BrowserSession } from '../../automation/browser-manager.js';
import { ensureLoggedIn } from '../../automation/squarespace-auth.js';
import { resolveSite, navigateToSite, navigateToPage, enterEditMode } from '../../automation/site-navigator.js';
import { saveChanges } from '../../automation/editor-actions.js';
import { executeBrowserTask } from '../../automation/browser-agent.js';
import { removeContent } from '../../automation/actions/remove-content.js';
import { superviseBrowserResult, isSupervisorEnabled, type SupervisorJsonOptions, type SupervisorApiOptions } from '../../agents/supervisor-agent.js';
import { createContentSaveClient, type PageSection } from '../../services/content-save.js';
import { extractLearnings } from '../../agents/learning-agent.js';
import { SiteReader, type SquarespacePageData } from '../../services/site-reader.js';
import { taskIsPageCreation } from './planning.js';
import { buildTaskDescription, describeTask, diagnoseFailure } from './helpers.js';
import type { ContentPlan, SupervisorVerdict } from '../../agents/types.js';
import type { Task } from '../../models/task.js';
import type { Conversation } from '../../models/conversation.js';

// ─── Batch Constants ────────────────────────────────────────────────────────

const BATCH_SIZE = 3;        // operations per batch
const STEPS_PER_BATCH = 40;  // browser agent steps per batch (~13 steps per operation)
export const BATCH_THRESHOLD = 5;   // batch when ≥6 operations (lowered from 8 to catch 8-project requests)

// ─── Task Execution (main entry point) ──────────────────────────────────────

/**
 * Execute all tasks in a conversation sequentially.
 * Sends progress updates to Tim via WhatsApp after each task.
 *
 * Phase 4 changes:
 * - Expands multi-site tasks before execution
 * - Uses browser agent for all task types (not just remove_content)
 * - Falls back to legacy remove_content action if USE_LEGACY_ACTIONS=true
 */
export async function executeTasks(conversation: Conversation, contentPlan?: ContentPlan): Promise<void> {
  // Periodic maintenance: decay stale learnings (cheap, synchronous SQLite)
  try {
    decayOldLearnings();
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Failed to decay old learnings');
  }

  // Expand multi-site tasks before execution
  const expandedTaskIds = expandMultiSiteTasks(conversation.taskIds);

  const total = expandedTaskIds.length;
  let completed = 0;
  let failed = 0;

  // Create an isolated browser session for this execution.
  // Each execution gets its own browser context sharing a single Chromium process,
  // so multiple conversations for different sites can execute in parallel.
  const browserManager = getBrowserManager({ headless: true });
  const sessionId = `exec-${conversation.id}`;
  const session = await browserManager.createSession(sessionId);

  try {
    for (let i = 0; i < expandedTaskIds.length; i++) {
      const taskId = expandedTaskIds[i];
      const task = getTask(taskId);

      if (!task) {
        logger.warn({ taskId }, 'Task not found, skipping');
        failed++;
        continue;
      }

      if (task.needsClarification) {
        await sendToTim(
          `Task ${i + 1}/${total}: ⚠️ Needs clarification — ${task.clarificationQuestion ?? 'Unknown issue'}. Skipping for now.`,
          conversation.id,
        );
        failed++;
        continue;
      }

      try {
        updateTaskStatus(taskId, 'executing');
        logAction(taskId, 'task_executing', `Starting: ${task.taskType} on ${task.siteId}/${task.targetPage ?? '?'}`);

        const result = await executeTask(session, task, contentPlan, conversation.id);

        if (result.success) {
          updateTaskStatus(taskId, 'done');
          completed++;

          if (result.screenshotPath) {
            updateTaskScreenshot(taskId, result.screenshotPath);
          }

          logAction(taskId, 'task_completed', `Completed: ${task.taskType}`, result.screenshotPath);

          // Send progress update + screenshot
          const progressMsg = `Task ${i + 1}/${total}: ✅ ${result.summary || describeTask(task)}`;

          if (result.screenshotPath) {
            try {
              await sendImageToTim(result.screenshotPath, progressMsg, conversation.id);
            } catch (imgErr) {
              logger.warn({ error: imgErr }, 'Failed to send screenshot, sending text only');
              await sendToTim(progressMsg, conversation.id);
            }
          } else {
            await sendToTim(progressMsg, conversation.id);
          }
        } else if (result.requeued) {
          // Task was re-queued for retry — add it back to the end of the list
          expandedTaskIds.push(taskId);
          const retryTask = getTask(taskId);
          const attempt = retryTask?.attemptCount ?? 1;
          await sendToTim(`Task ${i + 1}/${total}: 🔄 Attempt ${attempt} failed — retrying automatically…`, conversation.id);
        } else {
          updateTaskStatus(taskId, 'failed', result.error);
          failed++;
          logAction(taskId, 'task_failed', result.error);

          const failMsg = `Task ${i + 1}/${total}: ❌ Failed — ${result.error}`;

          // Send screenshot with failure message if available (supervisor provides verification screenshots)
          if (result.screenshotPath) {
            try {
              await sendImageToTim(result.screenshotPath, failMsg, conversation.id);
            } catch {
              await sendToTim(failMsg, conversation.id);
            }
          } else {
            await sendToTim(failMsg, conversation.id);
          }
        }
      } catch (err) {
        const errorMessage = errMsg(err);
        updateTaskStatus(taskId, 'failed', errorMessage);
        failed++;
        logAction(taskId, 'task_failed', errorMessage);

        await sendToTim(`Task ${i + 1}/${total}: ❌ Error — ${errorMessage}`, conversation.id);
      }
    }
  } finally {
    await session.close();
  }

  // Send final summary BEFORE marking completed (so dashboard source is still active)
  const summary = `All done. ${completed}/${total} task(s) completed.${failed > 0 ? ` ${failed} failed/skipped.` : ''}`;
  logAction(null, 'conversation_completed', summary);
  await sendToTim(summary, conversation.id);

  updateConversationStatus(conversation.id, 'completed');
}

// ─── Plan-Enriched Execution ────────────────────────────────────────────────

/**
 * Execute tasks using the approved ContentPlan's precise instructions.
 * Enriches each task's description with the corresponding ContentOperation's
 * editorInstruction before handing to the browser agent.
 */
export async function executeTasksWithPlan(conversation: Conversation): Promise<void> {
  // Parse the approved plan
  let plan: ContentPlan | undefined;
  if (conversation.contentPlan) {
    try {
      plan = JSON.parse(conversation.contentPlan) as ContentPlan;
    } catch {
      logger.warn({ conversationId: conversation.id }, 'Could not parse content plan, executing without plan enrichment');
    }
  }

  // ── Batching Gate (checked FIRST) ──────────────────────────────────────
  // If the plan has many operations (e.g., 8 project cards), split into
  // batches instead of sending everything to the agent at once.
  // This must be checked BEFORE building the instructionMap because when
  // all operations share the same taskId (common for single-request plans),
  // the old logic would never reach the batching gate.
  if (plan && plan.operations.length > BATCH_THRESHOLD && conversation.taskIds.length > 0) {
    const primaryTask = getTask(conversation.taskIds[0]);
    if (primaryTask) {
      logger.info(
        { operationCount: plan.operations.length, threshold: BATCH_THRESHOLD },
        'Plan exceeds batch threshold — using batched execution',
      );
      await executeBatchedPlan(conversation, plan, primaryTask);
      return; // Done — skip normal execution path
    }
  }

  // ── Blank API operations: execute directly without browser agent ──────
  // Skip if the plan includes a create_page operation — the page doesn't exist yet,
  // so blank_api ops can't navigate to it. Let everything go through the browser agent
  // in sequence (create page first, then add sections).
  if (plan) {
    const hasPageCreation = plan.operations.some(op =>
      op.operationType === 'create_page' || op.targetPage === 'new',
    );
    const blankApiOps = hasPageCreation
      ? []  // defer to browser agent — page must be created first
      : plan.operations.filter(op => op.content.contentStrategy === 'blank_api');

    if (blankApiOps.length > 0) {
      // We need a browser page to add blank sections, but text population is via API
      const blankApiBrowserManager = getBrowserManager({ headless: true });
      const blankApiSessionId = `blank-api-${conversation.id}`;
      const blankApiSession = await blankApiBrowserManager.createSession(blankApiSessionId);

      try {
        await ensureLoggedIn(blankApiSession);
        const page = await blankApiSession.getPage();

        // Discover sites and navigate
        const { discoverSites } = await import('../../automation/site-discovery.js');
        await discoverSites(page);

        const primaryTask = getTask(conversation.taskIds[0]);
        if (primaryTask) {
          const client = await resolveSite(primaryTask.siteId, page);
          await navigateToSite(page, client);

          if (primaryTask.targetPage) {
            await navigateToPage(page, client, primaryTask.targetPage);
            await enterEditMode(page);
          }

          const subdomain = page.url().match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i)?.[1];

          if (subdomain) {
            const { dashboardEvents } = await import('../../services/dashboard-events.js');

            for (let i = 0; i < blankApiOps.length; i++) {
              const op = blankApiOps[i];
              const heading = op.content.heading ?? `Section ${i + 1}`;

              dashboardEvents.emit('dashboard', {
                type: 'agent_activity' as const,
                data: {
                  agent: 'browser_agent',
                  status: 'started',
                  message: `blank_api: Adding "${heading}" (${i + 1}/${blankApiOps.length})`,
                  taskId: primaryTask.id,
                },
                timestamp: new Date().toISOString(),
              });

              const result = await executeBlankApiOperation(page, op, subdomain);

              dashboardEvents.emit('dashboard', {
                type: 'agent_activity' as const,
                data: {
                  agent: 'browser_agent',
                  status: result.success ? 'completed' : 'failed',
                  message: result.success
                    ? `blank_api: Added "${heading}" with ${result.blocksAdded} blocks`
                    : `blank_api: Failed — ${result.error}`,
                  taskId: primaryTask.id,
                },
                timestamp: new Date().toISOString(),
              });

              if (result.success) {
                logger.info({ heading, blocksAdded: result.blocksAdded }, 'blank_api operation completed');
              } else {
                logger.warn({ heading, error: result.error }, 'blank_api operation failed');
              }
            }
          }

          // Save changes
          await saveChanges(page);
        }
      } catch (err) {
        logger.error({ error: errMsg(err) }, 'Failed to execute blank_api operations');
      } finally {
        await blankApiSession.close();
      }

      // Remove blank_api ops from the plan so remaining ops go through normal execution
      plan.operations = plan.operations.filter(op => op.content.contentStrategy !== 'blank_api');

      // If no operations remain, we're done
      if (plan.operations.length === 0) {
        updateConversationStatus(conversation.id, 'completed');
        await sendToTim('All done! Content added via API.', conversation.id);
        return;
      }
    }
  }

  // ── Small plans: combine operations into task descriptions ─────────────
  // Plan operations use internal taskIds (e.g., "cv-page-creation") that don't
  // match the conversation's real DB task UUIDs. We need to map plan operations
  // back to conversation tasks. Most plans produce a single combined instruction
  // for one conversation task; multi-task conversations map ops by siteId+page.
  const instructionMap = new Map<string, string>();
  if (plan && plan.operations.length > 0 && conversation.taskIds.length > 0) {

    if (conversation.taskIds.length === 1) {
      // Single task — combine ALL plan operations into one sequenced instruction.
      const stepLines = plan.operations
        .map((op, i) => {
          const typeLabel = op.operationType?.replace(/_/g, ' ') ?? 'action';
          return `## Step ${i + 1} — ${typeLabel}\n${op.editorInstruction}`;
        })
        .join('\n\n');

      const combinedInstruction = `You are executing a content plan with ${plan.operations.length} steps.\n` +
        `Complete each step IN ORDER. After each step, take a screenshot to verify before moving to the next.\n` +
        `If you get stuck on a step, skip it and move to the next one.\n\n` +
        `## ACTION GUIDE (which click action to use)\n` +
        `- **Admin UI** (ADD SECTION, + Add Blank, Edit Section, ADD BLOCK, block picker, Save, Done, toolbars, panels): use **click** (main frame)\n` +
        `- **Page content** (text blocks, images, buttons, sections rendered on the page): use **clickInIframe** or **dblclickInIframe**\n` +
        `- If click fails on an admin button, try **jsClick** with frame: "main"\n\n` +
        `PLAN SUMMARY: ${plan.summary}\n\n` +
        stepLines;

      instructionMap.set(conversation.taskIds[0], combinedInstruction);
    } else {
      // Multiple tasks — group operations by matching siteId + targetPage to tasks.
      const tasksByKey = new Map<string, string>();
      for (const taskId of conversation.taskIds) {
        const t = getTask(taskId);
        if (t) {
          const key = `${t.siteId}|${t.targetPage ?? ''}`;
          tasksByKey.set(key, taskId);
        }
      }

      // Group plan operations by their siteId + targetPage
      const opsPerTask = new Map<string, typeof plan.operations>();
      for (const op of plan.operations) {
        const key = `${op.siteId}|${op.targetPage ?? ''}`;
        const realTaskId = tasksByKey.get(key) ?? conversation.taskIds[0];
        const existing = opsPerTask.get(realTaskId) || [];
        existing.push(op);
        opsPerTask.set(realTaskId, existing);
      }

      for (const [tid, ops] of opsPerTask) {
        const stepLines = ops
          .map((op, i) => {
            const typeLabel = op.operationType?.replace(/_/g, ' ') ?? 'action';
            return `## Step ${i + 1} — ${typeLabel}\n${op.editorInstruction}`;
          })
          .join('\n\n');

        const combinedInstruction = ops.length === 1
          ? ops[0].editorInstruction
          : `You are executing ${ops.length} steps for this task.\n` +
            `Complete each step IN ORDER.\n\n` +
            stepLines;

        instructionMap.set(tid, combinedInstruction);
      }
    }
  }

  // Temporarily enrich task descriptions with plan instructions
  const enrichedTasks = conversation.taskIds.map((taskId) => {
    const task = getTask(taskId);
    if (!task) return null;

    const planInstruction = instructionMap.get(taskId);
    if (planInstruction) {
      // REPLACE the task description with the plan instruction.
      // The original request is redundant when we have a detailed plan —
      // including both confuses the agent (e.g., typing "Menus" from the
      // original description instead of "Vibe-Coding Projects" from the plan).
      task.description = planInstruction;
    }

    return task;
  });

  // Run the normal execution pipeline (which uses task.description)
  // Pass the plan so the supervisor can verify each operation individually
  await executeTasks(conversation, plan);
}

// ─── Single Task Execution ──────────────────────────────────────────────────

/**
 * Execute a single task using the browser agent or legacy actions.
 *
 * Flow:
 * 1. Resolve the site from config
 * 2. Navigate to site admin → page → edit mode
 * 3. Run the browser agent with the task description
 * 4. Safety-net: save changes if the agent didn't
 * 5. Take final screenshot
 */
async function executeTask(
  browserManager: BrowserHandle,
  task: Task,
  contentPlan?: ContentPlan,
  conversationId?: string,
): Promise<{ success: boolean; summary?: string; screenshotPath?: string; error?: string; requeued?: boolean }> {
  // Legacy fallback: use the old remove_content action if enabled
  if (process.env.USE_LEGACY_ACTIONS === 'true' && task.taskType === 'remove_content') {
    if (!task.targetPage) {
      return { success: false, error: 'No target page specified' };
    }
    if (!task.contentToFind) {
      return { success: false, error: 'No content to find specified' };
    }

    return await removeContent(browserManager, {
      siteIdentifier: task.siteId,
      pageSlug: task.targetPage,
      contentToFind: task.contentToFind,
    });
  }

  // ─── Browser Agent Flow ─────────────────────────────────────────────

  try {
    // Ensure logged in
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    // Discover sites from dashboard (populates cache for resolveSite)
    const { discoverSites } = await import('../../automation/site-discovery.js');
    await discoverSites(page);

    // Resolve site config (tries static config first, then dashboard discovery)
    const client = await resolveSite(task.siteId, page);

    // Navigate to the site admin
    await navigateToSite(page, client);

    // Detect page-creation tasks — these need to start from the Pages panel,
    // NOT inside edit mode on an existing page.
    const isPageCreationTask = taskIsPageCreation(task);

    if (isPageCreationTask) {
      // Navigate to the Pages panel so the agent can create a new page
      const pagesUrl = `${derivePublicBaseUrl(client.site.adminUrl)}/config/pages`;
      logger.info({ pagesUrl }, 'Page creation task — navigating to Pages panel');
      await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    } else if (task.targetPage) {
      // Navigate to specific page if specified, then enter edit mode
      await navigateToPage(page, client, task.targetPage);
      await enterEditMode(page);
    } else {
      // No specific page — navigate to the first page (usually Home) so the
      // agent starts in edit mode rather than stuck on the admin dashboard.
      // The agent can navigate to other pages from within the editor.
      const defaultPage = client.site.pages[0]?.slug ?? 'home';
      logger.info({ defaultPage }, 'No target page specified — navigating to default page');
      try {
        await navigateToPage(page, client, defaultPage);
        await enterEditMode(page);
      } catch (err) {
        logger.warn({ error: errMsg(err) }, 'Could not navigate to default page — agent will start from admin panel');
      }
    }

    // Build task description for the browser agent
    const taskDescription = buildTaskDescription(task);

    // Build site context for the agent prompt
    const siteContext = {
      pages: client.site.pages,
      siteName: client.name,
    };

    // Load reference image if available (WhatsApp screenshot showing what to change)
    let referenceImageBase64: string | undefined;
    if (task.referenceImagePath) {
      try {
        const { readFileSync, existsSync } = await import('fs');
        if (existsSync(task.referenceImagePath)) {
          referenceImageBase64 = readFileSync(task.referenceImagePath).toString('base64');
          logger.info({ path: task.referenceImagePath }, 'Loaded reference image for browser agent');
        }
      } catch (err) {
        logger.warn({ error: errMsg(err) }, 'Failed to load reference image');
      }
    }

    // ── Pre-edit JSON snapshot for supervisor verification ──────────────
    let beforeSnapshot: SquarespacePageData | null = null;
    let siteBaseUrl: string | undefined;

    if (isSupervisorEnabled() && task.targetPage && !isPageCreationTask) {
      try {
        siteBaseUrl = derivePublicBaseUrl(client.site.adminUrl);
        const reader = new SiteReader(siteBaseUrl);
        beforeSnapshot = await reader.readPage(task.targetPage);
        if (beforeSnapshot) {
          logger.info(
            { siteId: task.siteId, page: task.targetPage },
            'Pre-edit JSON snapshot captured for supervisor verification',
          );
        } else {
          logger.info(
            { siteId: task.siteId, page: task.targetPage },
            'Pre-edit JSON snapshot returned null — page may be non-public',
          );
        }
      } catch (err) {
        logger.warn(
          { error: errMsg(err), siteId: task.siteId, page: task.targetPage },
          'Failed to capture pre-edit JSON snapshot — supervisor will use screenshot+DOM only',
        );
      }
    }

    // ── Pre-edit API snapshot for supervisor verification (Content Save API) ──
    let apiBeforeSections: PageSection[] | null = null;
    let apiSubdomain: string | null = null;
    let apiPageSectionsId: string | null = null;
    let apiCollectionId: string | null = null;

    if (isSupervisorEnabled() && task.targetPage && !isPageCreationTask) {
      try {
        // Extract subdomain from page URL
        apiSubdomain = page.url().match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i)?.[1] ?? null;

        if (apiSubdomain) {
          // Extract pageSectionsId from the editor DOM
          const siteFrame = page.frame({ name: 'sqs-site-frame' });
          if (siteFrame) {
            apiPageSectionsId = await siteFrame.evaluate(() => {
              const article = document.querySelector('article[data-page-sections]');
              return article?.getAttribute('data-page-sections') ?? null;
            }).catch(() => null);
          }

          if (apiPageSectionsId) {
            // Get collectionId and capture before sections
            const apiClient = createContentSaveClient(apiSubdomain);
            const ids = await apiClient.getPageIds(task.targetPage);

            if (ids) {
              apiCollectionId = ids.collectionId;
              const beforeData = await apiClient.getPageSections(apiPageSectionsId);
              apiBeforeSections = beforeData.sections ?? [];
              logger.info(
                { siteId: task.siteId, page: task.targetPage, sectionsCount: apiBeforeSections.length },
                'Pre-edit API snapshot captured for supervisor verification',
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          { error: errMsg(err), siteId: task.siteId, page: task.targetPage },
          'Failed to capture pre-edit API snapshot — supervisor will use SiteReader/screenshot only',
        );
      }
    }

    // Run the browser agent
    logger.info({ taskId: task.id, taskDescription: taskDescription.substring(0, 200) }, 'Starting browser agent');

    // Emit agent activity — Browser Agent started
    const { dashboardEvents: agentEvents } = await import('../../services/dashboard-events.js');
    agentEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: { agent: 'browser_agent', status: 'started', message: `Executing: ${taskDescription.substring(0, 100)}...`, taskId: task.id },
      timestamp: new Date().toISOString(),
    });

    // Dynamic step budget based on task complexity.
    // Content plans: ~20 steps per operation + 10 overhead, floored at 60, capped at 120.
    // Page creation: 50 (extra steps for Pages panel + title + navigation).
    // General edits: classified by task type and description length.
    const planSteps = contentPlan
      ? Math.min(120, Math.max(60, contentPlan.operations.length * 20 + 10))
      : 0;

    // Escalate budget on retries — hitting the same step limit 3x is pointless.
    // Attempt 1: base budget, Attempt 2: +50%, Attempt 3: +100% (capped at 120).
    const baseBudget = planSteps || estimateStepBudget(task, isPageCreationTask, taskDescription);
    const retryMultiplier = 1 + (task.attemptCount * 0.5);
    const maxSteps = Math.min(120, Math.round(baseBudget * retryMultiplier));

    logger.info({
      taskId: task.id,
      maxSteps,
      baseBudget,
      attemptCount: task.attemptCount,
      retryMultiplier,
      contentPlanOps: contentPlan?.operations.length,
      isPageCreation: isPageCreationTask,
      taskType: task.taskType,
    }, 'Step budget computed');

    // Live progress callback — emits agent_step SSE events + periodic chat updates
    const { dashboardEvents } = await import('../../services/dashboard-events.js');
    const { sendToTim: sendStatusToTim } = await import('../../services/whatsapp.js');
    let lastChatUpdate = Date.now();
    const CHAT_UPDATE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

    const onStepComplete = (step: import('../../automation/browser-agent.js').StepProgressEvent) => {
      // Emit to dashboard SSE
      dashboardEvents.emit('dashboard', {
        type: 'agent_step' as const,
        data: {
          taskId: task.id,
          stepNumber: step.stepNumber,
          maxSteps: step.maxSteps,
          action: step.action,
          reasoning: step.reasoning,
          success: step.success,
          screenshotFilename: step.screenshotPath?.split('/').pop() ?? '',
          done: step.done,
        },
        timestamp: new Date().toISOString(),
      });

      // Periodic chat status update (~every 3 minutes)
      const now = Date.now();
      if (now - lastChatUpdate >= CHAT_UPDATE_INTERVAL_MS && !step.done) {
        lastChatUpdate = now;
        const pct = Math.round((step.stepNumber / step.maxSteps) * 100);
        sendStatusToTim(`🔄 Still working… Step ${step.stepNumber}/${step.maxSteps} (${pct}%) — ${step.action}`, conversationId)
          .catch((err) => logger.warn({ error: err }, 'Failed to send chat status update')); // fire-and-forget
      }
    };

    const agentResult = await executeBrowserTask(page, taskDescription, {
      maxSteps,
      model: MODEL_SONNET,
      siteId: task.siteId,
      targetPage: task.targetPage,
      referenceImageBase64,
      onStepComplete,
    }, siteContext);

    // Safety-net: try to save if the agent reports success but may not have saved
    if (agentResult.success) {
      const saveResult = await saveChanges(page);
      if (saveResult.success) {
        logger.info('Safety-net save completed');
      }
    }

    logger.info({
      taskId: task.id,
      success: agentResult.success,
      steps: agentResult.steps.length,
      inputTokens: agentResult.tokenUsage.inputTokens,
      outputTokens: agentResult.tokenUsage.outputTokens,
      durationMs: agentResult.durationMs,
    }, 'Browser agent finished');

    agentEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: {
        agent: 'browser_agent',
        status: agentResult.success ? 'completed' : 'failed',
        message: agentResult.success
          ? `Completed in ${agentResult.steps.length} steps (${Math.round(agentResult.durationMs / 1000)}s)`
          : `Failed after ${agentResult.steps.length} steps`,
        taskId: task.id,
        detail: { steps: agentResult.steps.length, durationMs: agentResult.durationMs },
      },
      timestamp: new Date().toISOString(),
    });

    // ─── Supervisor Verification ────────────────────────────────────────
    let supervisorVerdict: SupervisorVerdict | undefined;

    if (isSupervisorEnabled() && agentResult.success) {
      logger.info({ taskId: task.id }, 'Supervisor: verifying browser agent result');
      agentEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: { agent: 'supervisor', status: 'started', message: 'Verifying browser agent result...', taskId: task.id },
        timestamp: new Date().toISOString(),
      });

      const retryFn = async (correctiveInstructions: string) => {
        logger.info({ taskId: task.id }, 'Supervisor: retrying with corrective instructions');

        // Re-enter edit mode if needed (agent may have left an unexpected state)
        try {
          await enterEditMode(page);
        } catch {
          // May already be in edit mode
        }

        const retryDescription = `CORRECTION: The previous attempt had issues. ${correctiveInstructions}\n\nOriginal task: ${taskDescription}`;

        const retryResult = await executeBrowserTask(page, retryDescription, {
          maxSteps: 25,
          model: MODEL_SONNET,
          siteId: task.siteId,
          targetPage: task.targetPage,
          onStepComplete,
        }, siteContext);

        // Safety-net save after retry
        if (retryResult.success) {
          await saveChanges(page);
        }

        return retryResult;
      };

      // Build JSON verification options (only when we have a before snapshot + site URL)
      const jsonOptions: SupervisorJsonOptions | undefined =
        beforeSnapshot && siteBaseUrl && task.targetPage
          ? { siteBaseUrl, pageSlug: task.targetPage, beforeSnapshot }
          : undefined;

      // Build API verification options (when we have Content Save API before-snapshot)
      const apiOptions: SupervisorApiOptions | undefined =
        apiBeforeSections && apiSubdomain && apiPageSectionsId && apiCollectionId
          ? { subdomain: apiSubdomain, pageSectionsId: apiPageSectionsId, collectionId: apiCollectionId, beforeSections: apiBeforeSections }
          : undefined;

      const supervisorResult = await superviseBrowserResult(
        page,
        taskDescription,
        agentResult,
        retryFn,
        contentPlan,
        jsonOptions,
        apiOptions,
      );

      if (supervisorResult.success && supervisorResult.data) {
        const sv = supervisorResult.data;
        supervisorVerdict = sv.verdict;

        logAction(task.id, 'supervisor_verified', `Status: ${sv.verdict.status}, Confidence: ${sv.verdict.confidence}`);

        if (sv.retryAttempted) {
          logAction(task.id, 'supervisor_retry', `Retry ${sv.retryResult?.success ? 'succeeded' : 'failed'}: ${sv.verdict.diagnosis}`);
        }

        // Fire-and-forget: extract learnings (both pass and fail paths return early below)
        extractLearnings({
          taskId: task.id,
          taskDescription,
          siteId: task.siteId,
          targetPage: task.targetPage,
          agentResult,
          supervisorVerdict: sv.verdict,
        }).catch((err) => {
          logger.warn({ error: errMsg(err) }, 'Learning extraction failed (non-blocking)');
        });

        if (sv.verdict.status === 'pass') {
          agentEvents.emit('dashboard', {
            type: 'agent_activity' as const,
            data: { agent: 'supervisor', status: 'completed', message: `Verified: PASS${sv.retryAttempted ? ' (after retry)' : ''} — confidence ${sv.verdict.confidence}`, taskId: task.id },
            timestamp: new Date().toISOString(),
          });
          // Verified correct (either first pass or after retry)
          const summary = sv.retryAttempted
            ? `[Auto-corrected] ${sv.retryResult?.summary ?? agentResult.summary}`
            : agentResult.summary;
          return {
            success: true,
            summary,
            screenshotPath: sv.verificationScreenshotPath ?? agentResult.screenshotPath,
          };
        }

        // Failed — track retry attempt and return detailed diagnosis
        const diagnosis = sv.verdict.diagnosis ?? 'The task was not completed correctly';
        agentEvents.emit('dashboard', {
          type: 'agent_activity' as const,
          data: { agent: 'supervisor', status: 'failed', message: `Verification failed: ${diagnosis.substring(0, 100)}`, taskId: task.id },
          timestamp: new Date().toISOString(),
        });
        const attemptCount = incrementTaskAttempt(task.id, diagnosis);
        const MAX_TASK_ATTEMPTS = 3;

        if (attemptCount < MAX_TASK_ATTEMPTS) {
          logger.info(
            { taskId: task.id, attemptCount, maxAttempts: MAX_TASK_ATTEMPTS },
            'Task failed supervisor verification — eligible for re-queue',
          );
          // Re-queue the task by setting status back to pending
          updateTaskStatus(task.id, 'pending', `Retry ${attemptCount}/${MAX_TASK_ATTEMPTS}: ${diagnosis}`);
          logAction(task.id, 'task_requeued', `Attempt ${attemptCount}/${MAX_TASK_ATTEMPTS}: ${diagnosis}`);
        } else {
          logger.warn(
            { taskId: task.id, attemptCount },
            'Task permanently failed — max retry attempts exhausted',
          );
          logAction(task.id, 'task_permanently_failed', `All ${MAX_TASK_ATTEMPTS} attempts exhausted: ${diagnosis}`);
        }

        return {
          success: false,
          error: diagnosis,
          screenshotPath: sv.verificationScreenshotPath ?? agentResult.screenshotPath,
        };
      }

      // Supervisor itself errored — fall back to trusting the agent result
      logger.warn({ error: supervisorResult.error }, 'Supervisor failed, falling back to agent result');
    }

    // Fire-and-forget: ALWAYS extract learnings (success, failure, supervisor pass/fail)
    extractLearnings({
      taskId: task.id,
      taskDescription,
      siteId: task.siteId,
      targetPage: task.targetPage,
      agentResult,
      supervisorVerdict,
    }).catch((err) => {
      logger.warn({ error: errMsg(err) }, 'Learning extraction failed (non-blocking)');
    });

    // ─── Retry on Agent Failure ─────────────────────────────────────────
    // If the agent itself failed (success=false) and we haven't exhausted retries,
    // re-queue the task for another attempt. This covers step-limit, stuck, and
    // crash failures that previously had ZERO retry coverage.
    if (!agentResult.success) {
      const failReason = agentResult.summary || 'Agent reported failure';
      const attemptCount = incrementTaskAttempt(task.id, failReason);
      const MAX_TASK_ATTEMPTS = 3;

      if (attemptCount < MAX_TASK_ATTEMPTS) {
        logger.info(
          { taskId: task.id, attemptCount, maxAttempts: MAX_TASK_ATTEMPTS, reason: failReason },
          'Agent failed — eligible for re-queue',
        );
        updateTaskStatus(task.id, 'pending', `Retry ${attemptCount}/${MAX_TASK_ATTEMPTS}: ${failReason}`);
        logAction(task.id, 'task_requeued', `Agent failure retry ${attemptCount}/${MAX_TASK_ATTEMPTS}: ${failReason}`);

        return {
          success: false,
          error: failReason,
          screenshotPath: agentResult.screenshotPath,
          requeued: true,
        };
      }

      logger.warn(
        { taskId: task.id, attemptCount },
        'Agent failed — max retry attempts exhausted',
      );
      logAction(task.id, 'task_permanently_failed', `All ${MAX_TASK_ATTEMPTS} attempts exhausted: ${failReason}`);

      return {
        success: false,
        error: failReason,
        screenshotPath: agentResult.screenshotPath,
      };
    }

    // No supervisor, supervisor disabled, or supervisor failed — return original result
    return {
      success: agentResult.success,
      summary: agentResult.summary,
      screenshotPath: agentResult.screenshotPath,
    };
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error({ taskId: task.id, error: errorMessage }, 'Browser agent task failed');

    // Try to take an error screenshot
    let screenshotPath: string | undefined;
    try {
      const page = await browserManager.getPage();
      const { takeScreenshot } = await import('../../utils/screenshot.js');
      screenshotPath = await takeScreenshot(page, 'agent-error');
    } catch {
      // Can't take screenshot
    }

    // Provide actionable diagnostics for common failures
    const diagnostic = diagnoseFailure(errorMessage, task);

    return {
      success: false,
      error: diagnostic,
      screenshotPath,
    };
  }
}

// ─── Blank API Operation Execution ──────────────────────────────────────────

/**
 * Execute a blank_api operation: add a blank section directly, then populate via Content Save API.
 *
 * Steps:
 * 1. Add a blank section via handleAddSection (direct call, no browser agent overhead)
 * 2. Extract pageSectionsId from iframe
 * 3. Get collectionId via getPageIds()
 * 4. Find the new section (last section)
 * 5. For each apiBlock, call client.addTextBlock()
 * 6. Reload the page to show changes
 */
async function executeBlankApiOperation(
  page: import('playwright').Page,
  operation: import('../../agents/types.js').ContentOperation,
  subdomain: string,
): Promise<{ success: boolean; blocksAdded: number; error?: string }> {
  const apiBlocks = operation.content.apiBlocks;
  if (!apiBlocks || apiBlocks.length === 0) {
    return { success: false, blocksAdded: 0, error: 'No apiBlocks provided for blank_api operation' };
  }

  try {
    // Step 1: Add a blank section via direct handler call (no browser agent overhead)
    const { handleAddSection } = await import('../../automation/actions/section-management-handlers.js');
    const addSectionResult = await handleAddSection(page, { action: 'addSection' });

    if (!addSectionResult.success) {
      return { success: false, blocksAdded: 0, error: `Failed to add blank section: ${addSectionResult.message}` };
    }

    logger.info('blank_api: blank section added successfully');

    // Step 1b: Save the editor to persist the blank section to the server.
    // Without this, the Content Save API's GET returns stale data and the PUT
    // conflicts with the editor's unsaved state → 500 Internal Server Error.
    const { saveChanges: editorSave } = await import('../../automation/editor-actions.js');
    const saveResult = await editorSave(page);
    logger.info({ saveResult: saveResult.message }, 'blank_api: saved editor state after adding section');
    await page.waitForTimeout(2000);

    // Re-enter edit mode if save exited it (Done button exits edit mode)
    if (saveResult.message?.includes('Done')) {
      logger.info('blank_api: save clicked Done — re-entering edit mode');
      const { enterEditMode } = await import('../../automation/site-navigator.js');
      await enterEditMode(page);
      await page.waitForTimeout(1500);
    }

    // Step 2: Extract pageSectionsId from the editor DOM
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) {
      return { success: false, blocksAdded: 0, error: 'No sqs-site-frame found after adding section' };
    }

    const pageSectionsId = await siteFrame.evaluate(() => {
      const article = document.querySelector('article[data-page-sections]');
      return article?.getAttribute('data-page-sections') ?? null;
    }).catch(() => null);

    if (!pageSectionsId) {
      return { success: false, blocksAdded: 0, error: 'Could not find data-page-sections attribute' };
    }

    // Step 3: Get collectionId
    const client = createContentSaveClient(subdomain);
    const pageUrl = page.url();
    const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
    const slug = slugMatch?.[1] ?? '';
    const ids = await client.getPageIds(slug);

    if (!ids) {
      return { success: false, blocksAdded: 0, error: `Could not get page IDs for slug "${slug}". URL: ${pageUrl}` };
    }

    logger.info({ pageSectionsId, collectionId: ids.collectionId, slug }, 'blank_api: got page IDs');

    // Step 4: Find the new section (last section)
    const sectionsData = await client.getPageSections(pageSectionsId);
    const sectionIndex = sectionsData.sections.length - 1;
    logger.info({ sectionIndex, totalSections: sectionsData.sections.length }, 'blank_api: found sections');

    if (sectionIndex < 0) {
      return { success: false, blocksAdded: 0, error: 'No sections found after adding blank section' };
    }

    // Step 5: Try adding text blocks via Content Save API (fast path)
    let blocksAdded = 0;
    let apiFailed = false;

    for (const block of apiBlocks) {
      const result = await client.addTextBlock(
        pageSectionsId,
        ids.collectionId,
        sectionIndex,
        block.html,
        block.layout,
        block.formatting,
      );

      if (result.success) {
        blocksAdded++;
        logger.info(
          { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
          'blank_api: text block added via API',
        );
      } else {
        const contentSnippet = block.html.replace(/<[^>]+>/g, '').substring(0, 60);
        logger.warn(
          { error: result.error, sectionIndex, blockIndex: blocksAdded, contentSnippet },
          'blank_api: addTextBlock API failed — switching to UI fallback',
        );
        apiFailed = true;
        break; // Stop API attempts, switch to UI fallback for remaining blocks
      }
    }

    // Step 6: Fallback — if API failed, use UI to create blocks + API to fill content.
    // The Squarespace API may reject client-generated block IDs on PUT.
    // Fallback: addBlockToSection (UI creates block with server-side ID) → updateTextBlock (API fills content).
    if (apiFailed) {
      logger.info(
        { apiBlocksAdded: blocksAdded, remaining: apiBlocks.length - blocksAdded },
        'blank_api: switching to UI+API fallback for remaining blocks',
      );

      const remainingBlocks = apiBlocks.slice(blocksAdded);
      const fallbackResult = await executeBlankApiFallback(
        page, client, pageSectionsId, ids.collectionId, sectionIndex, remainingBlocks,
      );
      blocksAdded += fallbackResult.blocksAdded;
      if (fallbackResult.errors.length > 0) {
        logger.warn({ errors: fallbackResult.errors }, 'blank_api: UI fallback had errors');
      }
    }

    // Step 7: Reload the page to show changes
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    if (blocksAdded === 0) {
      return { success: false, blocksAdded: 0, error: 'All block additions failed (API + UI fallback)' };
    }

    return { success: true, blocksAdded };
  } catch (err) {
    return { success: false, blocksAdded: 0, error: errMsg(err) };
  }
}

/**
 * UI+API fallback for adding text blocks when the Content Save API rejects new blocks.
 *
 * Flow per block:
 * 1. Enter section edit mode on the target section
 * 2. addBlockToSection("Text") — creates a text block via UI (server-assigned ID)
 * 3. Save changes to persist the new block
 * 4. updateTextBlock — uses Content Save API to replace placeholder text with actual content
 *
 * This avoids client-generated block IDs (which may cause 500 errors) by letting
 * Squarespace create blocks through its normal UI flow, then filling content via API.
 */
async function executeBlankApiFallback(
  page: import('playwright').Page,
  client: ReturnType<typeof createContentSaveClient>,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  blocks: Array<{ html: string; layout?: { columns?: number } }>,
): Promise<{ blocksAdded: number; errors: string[] }> {
  const { handleEnterSectionEditMode } = await import('../../automation/actions/section-management-handlers.js');
  const { handleAddBlockToSection } = await import('../../automation/actions/block-management-handlers.js');
  const { saveChanges: editorSave } = await import('../../automation/editor-actions.js');

  let blocksAdded = 0;
  const errors: string[] = [];

  // We may need to re-enter edit mode after save
  const { enterEditMode } = await import('../../automation/site-navigator.js');
  try {
    await enterEditMode(page);
    await page.waitForTimeout(1000);
    logger.info('blank_api fallback: re-entered edit mode');
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'blank_api fallback: enterEditMode failed (may already be in edit mode)');
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    logger.info({ blockIndex: i, total: blocks.length }, 'blank_api fallback: adding block via UI');

    try {
      // Step A: Enter section edit mode on the target section
      const editModeResult = await handleEnterSectionEditMode(page, {
        action: 'enterSectionEditMode',
        sectionIndex: 'last',
      });

      if (!editModeResult.success) {
        errors.push(`Block ${i}: enterSectionEditMode failed — ${editModeResult.message}`);
        logger.warn({ error: editModeResult.message }, 'blank_api fallback: enterSectionEditMode failed');
        continue;
      }

      // Step B: Add a Text block via UI (creates block with server-assigned ID)
      const addResult = await handleAddBlockToSection(page, {
        action: 'addBlockToSection',
        blockType: 'Text',
      });

      if (!addResult.success) {
        errors.push(`Block ${i}: addBlockToSection failed — ${addResult.message}`);
        logger.warn({ error: addResult.message }, 'blank_api fallback: addBlockToSection failed');
        // Press Escape to dismiss any overlay
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        continue;
      }

      logger.info({ blockIndex: i }, 'blank_api fallback: text block added via UI');

      // Step C: Dismiss the text editor (click outside or press Escape)
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      // Step D: Save to persist the new block
      await editorSave(page);
      await page.waitForTimeout(1500);

      // Step E: Fill the block content via API.
      // Find the last text block in the target section (the one we just added)
      // and replace its placeholder content with actual content.
      const contentSnippet = block.html.replace(/<[^>]+>/g, '').substring(0, 60);
      const fillResult = await client.fillLastTextBlockInSection(
        pageSectionsId, collectionId, sectionIndex, block.html,
      );
      if (fillResult.success) {
        blocksAdded++;
        logger.info(
          { blockIndex: i, blockId: fillResult.blockId, contentSnippet },
          'blank_api fallback: content filled via API',
        );
      } else {
        errors.push(`Block ${i}: could not fill content — ${fillResult.error}`);
        logger.warn(
          { blockIndex: i, error: fillResult.error, sectionIndex, contentSnippet },
          'blank_api fallback: fill failed',
        );
      }
    } catch (err) {
      errors.push(`Block ${i}: ${errMsg(err)}`);
      logger.error({ blockIndex: i, error: errMsg(err) }, 'blank_api fallback: unexpected error');
    }
  }

  logger.info(
    { blocksAdded, totalBlocks: blocks.length, errorCount: errors.length },
    'blank_api fallback: completed',
  );

  return { blocksAdded, errors };
}

// ─── Operation Batching ─────────────────────────────────────────────────────

/**
 * Execute a large content plan in batches.
 *
 * Instead of sending all 40+ operations to the browser agent at once (which
 * overwhelms it), we split into batches of 3 operations and execute each batch
 * as a separate `executeBrowserTask()` call on the SAME page.
 *
 * Benefits:
 * - Fresh conversation context per batch (no stale buildup)
 * - Each batch has a small instruction (~200 tokens vs ~2000)
 * - Within the step budget (40 steps for 3 ops vs 96 steps for 40 ops)
 * - Tim gets per-batch progress updates
 */
async function executeBatchedPlan(
  conversation: Conversation,
  plan: ContentPlan,
  task: Task,
): Promise<void> {
  const batches = chunkOperations(plan.operations, BATCH_SIZE);
  const totalBatches = batches.length;

  await sendToTim(`🔄 Large plan with ${plan.operations.length} operations — executing in ${totalBatches} batches of ${BATCH_SIZE}...`, conversation.id);

  logger.info(
    { conversationId: conversation.id, operationCount: plan.operations.length, batchCount: totalBatches },
    'Starting batched plan execution',
  );

  // Transition task to executing — emits task_update SSE so dashboard shows live progress
  updateTaskStatus(task.id, 'executing');
  logAction(task.id, 'task_executing', `Starting batched plan: ${plan.operations.length} operations in ${totalBatches} batches`);

  const browserManager = getBrowserManager({ headless: true });
  const batchSessionId = `batch-${conversation.id}`;
  const batchSession = await browserManager.createSession(batchSessionId);
  let completedBatches = 0;
  let failedBatches = 0;

  try {
    await ensureLoggedIn(batchSession);
    const page = await batchSession.getPage();

    // Discover sites and navigate to the target page (same as executeTask)
    const { discoverSites } = await import('../../automation/site-discovery.js');
    await discoverSites(page);

    const client = await resolveSite(task.siteId, page);
    await navigateToSite(page, client);

    // Detect page-creation tasks — navigate to Pages panel instead of
    // trying to open a page that doesn't exist yet (same guard as executeTask)
    const isPageCreationTask = taskIsPageCreation(task);

    if (isPageCreationTask) {
      const pagesUrl = `${derivePublicBaseUrl(client.site.adminUrl)}/config/pages`;
      logger.info({ pagesUrl }, 'Batched plan: page creation task — navigating to Pages panel');
      await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    } else if (task.targetPage) {
      await navigateToPage(page, client, task.targetPage);
      await enterEditMode(page);
    }

    const siteContext = {
      pages: client.site.pages,
      siteName: client.name,
    };

    // Live progress callback for batched execution
    const { dashboardEvents: batchDashEvents } = await import('../../services/dashboard-events.js');
    const { sendToTim: sendBatchStatusToTim } = await import('../../services/whatsapp.js');
    let batchLastChatUpdate = Date.now();
    const BATCH_CHAT_INTERVAL_MS = 3 * 60 * 1000;

    const batchOnStepComplete = (step: import('../../automation/browser-agent.js').StepProgressEvent) => {
      batchDashEvents.emit('dashboard', {
        type: 'agent_step' as const,
        data: {
          taskId: task.id,
          stepNumber: step.stepNumber,
          maxSteps: step.maxSteps,
          action: step.action,
          reasoning: step.reasoning,
          success: step.success,
          screenshotFilename: step.screenshotPath?.split('/').pop() ?? '',
          done: step.done,
        },
        timestamp: new Date().toISOString(),
      });

      const now = Date.now();
      if (now - batchLastChatUpdate >= BATCH_CHAT_INTERVAL_MS && !step.done) {
        batchLastChatUpdate = now;
        const pct = Math.round((step.stepNumber / step.maxSteps) * 100);
        sendBatchStatusToTim(`🔄 Still working… Step ${step.stepNumber}/${step.maxSteps} (${pct}%) — ${step.action}`, conversation.id)
          .catch((err) => logger.warn({ error: err }, 'Failed to send batch chat status update'));
      }
    };

    logger.info({
      stepsPerBatch: STEPS_PER_BATCH,
      batchSize: BATCH_SIZE,
      stepsPerOp: Math.round(STEPS_PER_BATCH / BATCH_SIZE),
    }, 'Batch step budget');

    // Execute each batch sequentially on the same page
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchNum = i + 1;

      try {
        logger.info(
          { batchNum, totalBatches, operationCount: batch.length },
          'Executing batch',
        );

        const batchOps = batch
          .map((op) => op.content.heading || op.operationType.replace(/_/g, ' '))
          .join(', ');

        // Emit agent_activity: browser_agent started for this batch
        batchDashEvents.emit('dashboard', {
          type: 'agent_activity' as const,
          data: { agent: 'browser_agent', status: 'started', message: `Batch ${batchNum}/${totalBatches}: ${batchOps}`, taskId: task.id },
          timestamp: new Date().toISOString(),
        });

        const batchInstruction = buildBatchInstruction(batch, batchNum, totalBatches, plan.summary);

        const batchResult = await executeBrowserTask(page, batchInstruction, {
          maxSteps: STEPS_PER_BATCH,
          model: MODEL_SONNET,
          siteId: task.siteId,
          targetPage: task.targetPage,
          onStepComplete: batchOnStepComplete,
        }, siteContext);

        if (batchResult.success) {
          completedBatches++;

          batchDashEvents.emit('dashboard', {
            type: 'agent_activity' as const,
            data: {
              agent: 'browser_agent',
              status: 'completed',
              message: `Batch ${batchNum}/${totalBatches} done in ${batchResult.steps.length} steps (${Math.round(batchResult.durationMs / 1000)}s): ${batchOps}`,
              taskId: task.id,
              detail: { steps: batchResult.steps.length, durationMs: batchResult.durationMs },
            },
            timestamp: new Date().toISOString(),
          });

          await sendToTim(`✅ Batch ${batchNum}/${totalBatches}: ${batchOps}`, conversation.id);
        } else {
          failedBatches++;

          batchDashEvents.emit('dashboard', {
            type: 'agent_activity' as const,
            data: {
              agent: 'browser_agent',
              status: 'failed',
              message: `Batch ${batchNum}/${totalBatches} failed after ${batchResult.steps.length} steps: ${batchOps}`,
              taskId: task.id,
            },
            timestamp: new Date().toISOString(),
          });

          logger.warn(
            { batchNum, error: batchResult.summary },
            'Batch failed, continuing to next batch',
          );
          await sendToTim(`⚠️ Batch ${batchNum}/${totalBatches}: Had issues, continuing...`, conversation.id);
        }

        // Brief pause between batches to let the editor settle
        await page.waitForTimeout(2000);
      } catch (err) {
        failedBatches++;
        const errorMessage = errMsg(err);
        logger.error({ batchNum, error: errorMessage }, 'Batch execution error');

        batchDashEvents.emit('dashboard', {
          type: 'agent_activity' as const,
          data: { agent: 'browser_agent', status: 'failed', message: `Batch ${batchNum}/${totalBatches} error: ${errorMessage.substring(0, 100)}`, taskId: task.id },
          timestamp: new Date().toISOString(),
        });

        await sendToTim(`❌ Batch ${batchNum}/${totalBatches}: Error — ${errorMessage}`, conversation.id);
      }
    }

    // Safety-net: save all changes after all batches
    const saveResult = await saveChanges(page);
    if (saveResult.success) {
      logger.info('Batched plan: safety-net save completed');
    }

    // Take final screenshot
    let screenshotPath: string | undefined;
    try {
      const { takeScreenshot } = await import('../../utils/screenshot.js');
      screenshotPath = await takeScreenshot(page, 'batched-plan-final');
    } catch {
      // Non-critical
    }

    // Update task status
    if (failedBatches === 0) {
      updateTaskStatus(task.id, 'done');
    } else if (completedBatches > 0) {
      updateTaskStatus(task.id, 'done', `${failedBatches} batch(es) had issues`);
    } else {
      updateTaskStatus(task.id, 'failed', 'All batches failed');
    }

    // Send final summary
    const summary = `All done! ${completedBatches}/${totalBatches} batches completed.${failedBatches > 0 ? ` ${failedBatches} had issues.` : ''}`;

    if (screenshotPath) {
      try {
        await sendImageToTim(screenshotPath, summary, conversation.id);
      } catch {
        await sendToTim(summary, conversation.id);
      }
    } else {
      await sendToTim(summary, conversation.id);
    }
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error({ error: errorMessage }, 'Batched plan execution failed');
    updateTaskStatus(task.id, 'failed', errorMessage);
    await sendToTim(`❌ Batched execution failed: ${errorMessage}`, conversation.id);
  } finally {
    await batchSession.close();
  }

  // Mark completed AFTER all messages sent (so dashboard source is still active)
  updateConversationStatus(conversation.id, 'completed');
}

/**
 * Split operations into chunks of the given batch size.
 */
function chunkOperations(
  operations: import('../../agents/types.js').ContentOperation[],
  batchSize: number,
): import('../../agents/types.js').ContentOperation[][] {
  const chunks: import('../../agents/types.js').ContentOperation[][] = [];
  for (let i = 0; i < operations.length; i += batchSize) {
    chunks.push(operations.slice(i, i + batchSize));
  }
  return chunks;
}

/**
 * Estimate the step budget for a task based on its type, description, and complexity signals.
 *
 * Simple tasks (change text, update phone number) need ~20 steps.
 * Medium tasks (replace image, update button) need ~30 steps.
 * Complex tasks (add content, multi-element edits) need ~50 steps.
 * Page creation tasks need ~50 steps.
 *
 * The description length and keyword count are used as secondary signals —
 * longer descriptions with multiple action keywords suggest more work.
 */
function estimateStepBudget(task: Task, isPageCreation: boolean, taskDescription: string): number {
  if (isPageCreation) return 50;

  const desc = taskDescription.toLowerCase();

  // Count complexity signals in the description
  const multiEditKeywords = [
    'and then', 'also', 'additionally', 'as well',
    'step 1', 'step 2', 'step 3',
    'first,', 'second,', 'third,',
    'update all', 'change all', 'replace all',
    'each project', 'each section', 'every',
  ];
  const complexityHits = multiEditKeywords.filter((kw) => desc.includes(kw)).length;

  // Simple single-action task types
  const simpleTypes: Set<string> = new Set(['remove_content']);
  const mediumTypes: Set<string> = new Set(['replace_file', 'upload_file_and_link']);
  const complexTypes: Set<string> = new Set(['add_content', 'update_menu_block']);

  let base: number;
  if (simpleTypes.has(task.taskType)) {
    base = 25;
  } else if (mediumTypes.has(task.taskType)) {
    base = 35;
  } else if (complexTypes.has(task.taskType)) {
    base = 50;
  } else {
    // general_edit: classify by description signals
    // Short descriptions with no complexity keywords → simple edit
    if (desc.length < 150 && complexityHits === 0) {
      base = 25;
    } else if (desc.length < 400 && complexityHits <= 1) {
      base = 35;
    } else {
      base = 50;
    }
  }

  // Boost for multi-step descriptions (each complexity keyword adds ~5 steps, capped)
  const boost = Math.min(30, complexityHits * 5);

  // Final budget: base + boost, floored at 20, capped at 80
  // (content plan tasks go through the separate planSteps formula above, capped at 120)
  return Math.min(80, Math.max(20, base + boost));
}

/**
 * Build a focused instruction string for a single batch.
 * Keeps the instruction small and clear so the browser agent doesn't get confused.
 */
function buildBatchInstruction(
  batch: import('../../agents/types.js').ContentOperation[],
  batchNum: number,
  totalBatches: number,
  planSummary: string,
): string {
  const stepLines = batch
    .map((op, i) => {
      const typeLabel = op.operationType?.replace(/_/g, ' ') ?? 'action';
      return `## Step ${i + 1} — ${typeLabel}\n${op.editorInstruction}`;
    })
    .join('\n\n');

  return (
    `You are executing batch ${batchNum} of ${totalBatches} for: "${planSummary}"\n` +
    `Complete these ${batch.length} steps IN ORDER, then STOP.\n\n` +
    `## ACTION GUIDE (which click action to use)\n` +
    `- **Admin UI** (ADD SECTION, + Add Blank, Edit Section, ADD BLOCK, block picker, Save, Done, toolbars, panels): use **click** (main frame)\n` +
    `- **Page content** (text blocks, images, buttons, sections rendered on the page): use **clickInIframe** or **dblclickInIframe**\n` +
    `- If click fails on an admin button, try **jsClick** with frame: "main"\n\n` +
    stepLines +
    `\n\nIMPORTANT: After completing these ${batch.length} steps, STOP. Do not attempt additional operations. ` +
    `Scroll down slightly so the next batch can continue adding content below.`
  );
}

// ─── URL Helpers ─────────────────────────────────────────────────────────────

/**
 * Derive the public site base URL from the admin URL.
 * e.g., 'https://smyth-tavern.squarespace.com/config/website'
 *    → 'https://smyth-tavern.squarespace.com'
 */
function derivePublicBaseUrl(adminUrl: string): string {
  const configIndex = adminUrl.indexOf('/config');
  return configIndex !== -1 ? adminUrl.substring(0, configIndex) : adminUrl;
}

// ─── Multi-Site Expansion ───────────────────────────────────────────────────

/**
 * Expand tasks with applyToAllSites=true into individual tasks per site.
 * Returns a new list of task IDs (original + cloned).
 */
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
        applyToAllSites: false, // Individual task — no longer multi-site
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
