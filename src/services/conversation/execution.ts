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
import { createContentSaveClient, ContentSaveClient, type PageSection } from '../../services/content-save.js';
import { extractLearnings } from '../../agents/learning-agent.js';
import { SiteReader, type SquarespacePageData } from '../../services/site-reader.js';
import { taskIsPageCreation } from './planning.js';
import { buildTaskDescription, describeTask, diagnoseFailure } from './helpers.js';
import { getCachedDiscovery, validateTemplateIndex, invalidateTemplateCache } from '../../services/template-discovery.js';
import {
  validateOperation,
  capturePreSnapshot,
  formatValidationForSupervisor,
  type ValidationResult,
  type PreOperationSnapshot,
} from '../../services/content-validator.js';
import { type LinkValidationOptions } from '../../services/link-validator.js';
import type { ContentPlan, ContentOperation, SupervisorVerdict, ApiTextBlock } from '../../agents/types.js';
import { isApiButtonBlock, isApiImageBlock, isApiGalleryBlock, isApiDividerBlock, isApiVideoBlock, isApiQuoteBlock, isApiCodeBlock } from '../../agents/types.js';
import type { Task } from '../../models/task.js';
import type { Conversation } from '../../models/conversation.js';
import {
  createPlanOperations,
  updateOperationStatus,
  getOperationsByConversation,
  type PlanOperation,
} from '../../db/plan-operations.js';
import { classifyPlanForApi } from '../../services/plan-classifier.js';
import { executeContentPlanViaApi } from '../../services/api-executor.js';

// ─── Batch Constants ────────────────────────────────────────────────────────

const BATCH_SIZE = 3;        // operations per batch
const STEPS_PER_BATCH = 40;  // browser agent steps per batch (~13 steps per operation)
export const BATCH_THRESHOLD = 5;   // batch when ≥6 operations (lowered from 8 to catch 8-project requests)

// ─── Two-Pass Constants ─────────────────────────────────────────────────────

/** Minimum section additions to trigger two-pass execution */
const TWO_PASS_SECTION_THRESHOLD = 3;

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
export async function executeTasks(conversation: Conversation, contentPlan?: ContentPlan, trackedOps?: PlanOperation[]): Promise<void> {
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

        // Mark pending tracked operations for this task as executing
        const taskTrackedOps = (trackedOps ?? []).filter((o) => o.status === 'pending');
        for (const tracked of taskTrackedOps) {
          updateOperationStatus(tracked.id, 'executing');
        }

        const result = await executeTask(session, task, contentPlan, conversation.id);

        if (result.success) {
          updateTaskStatus(taskId, 'done');
          completed++;

          // Mark tracked operations as succeeded
          for (const tracked of taskTrackedOps) {
            updateOperationStatus(tracked.id, 'succeeded');
          }

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

          // Reset tracked operations to pending for retry
          for (const tracked of taskTrackedOps) {
            updateOperationStatus(tracked.id, 'pending');
          }
        } else {
          updateTaskStatus(taskId, 'failed', result.error);
          failed++;
          logAction(taskId, 'task_failed', result.error);

          // Mark tracked operations as failed
          for (const tracked of taskTrackedOps) {
            updateOperationStatus(tracked.id, 'failed', result.error);
          }

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

        // Mark tracked operations as failed
        const errorTrackedOps = (trackedOps ?? []).filter((o) => o.status === 'executing');
        for (const tracked of errorTrackedOps) {
          updateOperationStatus(tracked.id, 'failed', errorMessage);
        }

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

  // ── Persist plan operations for granular tracking ───────────────────────
  let trackedOps: PlanOperation[] = [];
  if (plan && plan.operations.length > 0) {
    try {
      trackedOps = createPlanOperations(conversation.id, plan);
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Failed to persist plan operations (non-blocking)');
    }
  }

  // ── Two-Pass Gate (checked FIRST) ────────────────────────────────────
  // For plans with page creation or 3+ section additions, use two-pass
  // execution to ensure all structural elements are persisted before
  // any content operations begin. This is more reliable than single-pass
  // because the Content Save API can see all sections after the save.
  if (plan && shouldUseTwoPass(plan) && conversation.taskIds.length > 0) {
    const tasks = conversation.taskIds.map(id => getTask(id)).filter((t): t is Task => t !== null);
    if (tasks.length > 0) {
      logger.info(
        { operationCount: plan.operations.length },
        'Plan qualifies for two-pass execution',
      );
      await executeTwoPassPlan(conversation, tasks, plan);
      return; // Done — skip normal execution path
    }
  }

  // ── Template Index Validation ─────────────────────────────────────────────
  // If we have cached template discovery data, validate that template indexes
  // in the plan still match expectations. Stale indexes are logged as warnings
  // to help diagnose template drift issues.
  if (plan) {
    validatePlanTemplateIndexes(plan);
    // Warn about template operations missing replacements — these will add
    // sections with placeholder content that never gets customized
    for (const op of plan.operations) {
      if (op.content.contentStrategy === 'template' && !op.content.replacements) {
        logger.warn({ placement: op.placement, templateCategory: op.content.templateCategory },
          'Template operation missing replacements — will have placeholder content');
      }
    }
  }

  // ── API Executor Gate (primary path) ──────────────────────────────────
  // Classify the plan and run API-capable operations via the API executor,
  // bypassing browser automation entirely. Only falls through to the
  // browser agent for operations that require manual/visual control.
  if (plan && conversation.taskIds.length > 0) {
    const classification = classifyPlanForApi(plan);
    const primaryTask = getTask(conversation.taskIds[0]);

    if (primaryTask && (classification.capability === 'full_api' || classification.capability === 'partial_api')) {
      const subdomain = primaryTask.siteId;
      logger.info(
        {
          capability: classification.capability,
          apiOps: classification.apiOperations.length,
          browserOps: classification.browserOperations.length,
          reason: classification.reason,
        },
        'api-executor: routing plan through API executor',
      );

      // Build a plan containing only the API-capable operations
      const apiPlan: ContentPlan = {
        ...plan,
        operations: classification.apiOperations,
      };

      const { dashboardEvents } = await import('../../services/dashboard-events.js');
      dashboardEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: {
          agent: 'api_executor',
          status: 'started',
          message: `API executor: ${classification.apiOperations.length} operations via API`,
          taskId: primaryTask.id,
        },
        timestamp: new Date().toISOString(),
      });

      const apiResult = await executeContentPlanViaApi(apiPlan, subdomain, trackedOps);

      dashboardEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: {
          agent: 'api_executor',
          status: apiResult.success ? 'completed' : 'failed',
          message: apiResult.summary,
          taskId: primaryTask.id,
        },
        timestamp: new Date().toISOString(),
      });

      // Combine browser-required ops with API-failed ops
      const remainingOps = [
        ...classification.browserOperations,
        ...apiResult.failedOperations,
      ];

      if (remainingOps.length === 0) {
        // All operations succeeded via API — done!
        for (const taskId of conversation.taskIds) {
          updateTaskStatus(taskId, 'done');
        }
        updateConversationStatus(conversation.id, 'completed');
        await sendToTim(`All done! ${apiResult.summary}`, conversation.id);
        return;
      }

      // Some operations need the browser — update the plan and fall through
      plan.operations = remainingOps;
      logger.info(
        { remainingOps: remainingOps.length },
        'api-executor: falling through to browser agent for remaining operations',
      );
    }
  }

  // ── Batching Gate ─────────────────────────────────────────────────────
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
      await executeBatchedPlan(conversation, plan, primaryTask, trackedOps);
      return; // Done — skip normal execution path
    }
  }

  // ── Blank API operations: execute directly without browser agent ──────
  // Skip if the plan includes a create_page operation OR the task description
  // indicates page creation — the page doesn't exist yet, so blank_api ops
  // can't navigate to it. Let everything go through the browser agent in
  // sequence (create page first, then add sections).
  if (plan) {
    const primaryTaskForGate = conversation.taskIds.length > 0
      ? getTask(conversation.taskIds[0])
      : null;
    const hasPageCreation = plan.operations.some(op =>
      op.operationType === 'create_page' || op.targetPage === 'new',
    ) || (primaryTaskForGate ? taskIsPageCreation(primaryTaskForGate) : false);
    const blankApiOps = hasPageCreation
      ? []  // defer to browser agent — page must be created first
      : plan.operations.filter(op => op.content.contentStrategy === 'blank_api');

    if (blankApiOps.length > 0) {
      // We need a browser page to add blank sections, but text population is via API
      const blankApiBrowserManager = getBrowserManager({ headless: true });
      const blankApiSessionId = `blank-api-${conversation.id}`;
      const blankApiSession = await blankApiBrowserManager.createSession(blankApiSessionId);
      let blankApiSucceeded = 0;
      let blankApiFailed = 0;
      let blankApiCatastrophicFailure = false;

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
            const blankApiValidations: ValidationResult[] = [];

            // Pre-extract page IDs once for all blank_api operations (avoids per-op DOM access)
            let preExtractedPageSectionsId: string | undefined;
            let preExtractedCollectionId: string | undefined;
            try {
              const siteFrame = page.frame({ name: 'sqs-site-frame' });
              if (siteFrame) {
                preExtractedPageSectionsId = await siteFrame.evaluate(() => {
                  const article = document.querySelector('article[data-page-sections]');
                  return article?.getAttribute('data-page-sections') ?? null;
                }).catch(() => null) ?? undefined;
              }
              if (preExtractedPageSectionsId) {
                const idsClient = createContentSaveClient(subdomain);
                // Derive page slug from multiple sources — the operation's targetPage
                // is most reliable, followed by iframe URL, then outer config URL
                const opSlug = blankApiOps[0]?.targetPage ?? '';
                const iframeSlug = page.frame({ name: 'sqs-site-frame' })?.url()
                  .match(/squarespace\.com\/([^?#/]+)/)?.[1] ?? '';
                const outerSlug = page.url().match(/squarespace\.com\/config\/pages\/([^/?#]+)/)?.[1] ?? '';
                const slug = opSlug || iframeSlug || outerSlug || primaryTask.targetPage || '';
                logger.info({ opSlug, iframeSlug, outerSlug, resolvedSlug: slug },
                  'blank_api: resolving page slug for pre-extraction');
                const pageIds = await idsClient.getPageIds(slug);
                if (pageIds) {
                  preExtractedCollectionId = pageIds.collectionId;
                }
                logger.info(
                  { pageSectionsId: preExtractedPageSectionsId, collectionId: preExtractedCollectionId },
                  'blank_api: pre-extracted page IDs for API-first section addition',
                );
              }
            } catch (err) {
              logger.warn({ error: errMsg(err) }, 'blank_api: failed to pre-extract page IDs (will extract per-op)');
            }

            for (let i = 0; i < blankApiOps.length; i++) {
              const op = blankApiOps[i];
              const heading = op.content.heading ?? `Section ${i + 1}`;

              // Find the matching tracked operation for status updates
              const trackedOp = findTrackedOp(trackedOps, plan!.operations, op);
              if (trackedOp) updateOperationStatus(trackedOp.id, 'executing');

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

              const result = await executeBlankApiOperation(page, op, subdomain, {
                pageSectionsId: preExtractedPageSectionsId,
                collectionId: preExtractedCollectionId,
                siteBaseUrl: derivePublicBaseUrl(client.site.adminUrl),
              });

              // Update tracked operation status
              if (trackedOp) {
                updateOperationStatus(
                  trackedOp.id,
                  result.success ? 'succeeded' : 'failed',
                  result.success ? undefined : result.error,
                );
              }

              if (result.success) {
                blankApiSucceeded++;
              } else {
                blankApiFailed++;
              }

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

              // Emit validation result SSE event
              if (result.validation) {
                blankApiValidations.push(result.validation);
                dashboardEvents.emit('dashboard', {
                  type: 'agent_activity' as const,
                  data: {
                    agent: 'content_validator',
                    status: result.validation.passed ? 'completed' : 'failed',
                    message: `Validation ${result.validation.passed ? 'passed' : 'FAILED'}: ${result.validation.summary}`,
                    taskId: primaryTask.id,
                    detail: {
                      operationType: result.validation.operationType,
                      checks: result.validation.checks,
                    },
                  },
                  timestamp: new Date().toISOString(),
                });
              }

              if (result.success) {
                logger.info({ heading, blocksAdded: result.blocksAdded }, 'blank_api operation completed');
              } else {
                logger.warn({ heading, error: result.error }, 'blank_api operation failed');
              }
            }

            // Log validation summary for blank_api batch
            if (blankApiValidations.length > 0) {
              const passedCount = blankApiValidations.filter(v => v.passed).length;
              logger.info(
                { total: blankApiValidations.length, passed: passedCount, failed: blankApiValidations.length - passedCount },
                'blank_api: validation summary',
              );
            }
          }

          // Save changes
          await saveChanges(page);
        }
      } catch (err) {
        logger.error({ error: errMsg(err) }, 'Failed to execute blank_api operations');
        blankApiCatastrophicFailure = true;
      } finally {
        await blankApiSession.close();
      }

      // Only remove blank_api ops that succeeded — failed ops stay for browser agent fallback
      if (blankApiCatastrophicFailure || blankApiSucceeded === 0) {
        // Entire block failed (e.g. navigation error, page not found) — keep all ops for browser agent
        logger.warn(
          { succeeded: blankApiSucceeded, failed: blankApiFailed, catastrophic: blankApiCatastrophicFailure },
          'blank_api: all operations failed — deferring to browser agent',
        );
      } else {
        // Remove successfully completed blank_api ops from the plan
        plan.operations = plan.operations.filter(op => op.content.contentStrategy !== 'blank_api');

        // If no operations remain, we're done
        if (plan.operations.length === 0) {
          for (const taskId of conversation.taskIds) {
            updateTaskStatus(taskId, 'done');
          }
          updateConversationStatus(conversation.id, 'completed');
          await sendToTim('All done! Content added via API.', conversation.id);
          return;
        }
      }
    }
  }

  // ── Template operations: execute directly via handleAddSectionFromTemplate ──
  // Skip if the plan includes a create_page operation OR the task description
  // indicates page creation — same reasoning as blank_api.
  if (plan) {
    const primaryTaskForTemplateGate = conversation.taskIds.length > 0
      ? getTask(conversation.taskIds[0])
      : null;
    const hasPageCreationForTemplate = plan.operations.some(op =>
      (op.operationType as string) === 'create_page' || op.targetPage === 'new',
    ) || (primaryTaskForTemplateGate ? taskIsPageCreation(primaryTaskForTemplateGate) : false);
    const templateOps = hasPageCreationForTemplate
      ? []  // defer to browser agent — page must be created first
      : plan.operations.filter(op =>
          op.content.contentStrategy === 'template' &&
          op.content.replacements &&
          op.content.templateCategory,
        );

    if (templateOps.length > 0) {
      const templateBrowserManager = getBrowserManager({ headless: true });
      const templateSessionId = `template-${conversation.id}`;
      const templateSession = await templateBrowserManager.createSession(templateSessionId);
      const succeededOps = new Set<import('../../agents/types.js').ContentOperation>();

      try {
        await ensureLoggedIn(templateSession);
        const page = await templateSession.getPage();

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

          const { dashboardEvents } = await import('../../services/dashboard-events.js');

          for (let i = 0; i < templateOps.length; i++) {
            const op = templateOps[i];
            const heading = op.content.heading ?? `Template ${i + 1}`;

            dashboardEvents.emit('dashboard', {
              type: 'agent_activity' as const,
              data: {
                agent: 'browser_agent',
                status: 'started',
                message: `template: Adding "${heading}" (${i + 1}/${templateOps.length})`,
                taskId: primaryTask.id,
              },
              timestamp: new Date().toISOString(),
            });

            const result = await executeTemplateOperation(page, op);

            dashboardEvents.emit('dashboard', {
              type: 'agent_activity' as const,
              data: {
                agent: 'browser_agent',
                status: result.success ? 'completed' : 'failed',
                message: result.success
                  ? `template: Added "${heading}"`
                  : `template: Failed — ${result.error}`,
                taskId: primaryTask.id,
              },
              timestamp: new Date().toISOString(),
            });

            if (result.success) {
              succeededOps.add(op);
              logger.info({ heading }, 'template operation completed');
            } else {
              logger.warn({ heading, error: result.error }, 'template operation failed — will fall through to browser agent');
            }
          }

          // Save after all template operations
          await saveChanges(page);
        }
      } catch (err) {
        logger.error({ error: errMsg(err) }, 'Failed to execute template operations');
      } finally {
        await templateSession.close();
      }

      // Remove only SUCCEEDED template ops from the plan — failed ops fall through to browser agent
      if (succeededOps.size > 0) {
        plan.operations = plan.operations.filter(op => !succeededOps.has(op));
      }

      // If no operations remain, we're done
      if (plan.operations.length === 0) {
        for (const taskId of conversation.taskIds) {
          updateTaskStatus(taskId, 'done');
        }
        updateConversationStatus(conversation.id, 'completed');
        await sendToTim('All done! Content added via template fast path.', conversation.id);
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
  await executeTasks(conversation, plan, trackedOps);
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

    // ─── Inline Content Validation ─────────────────────────────────────
    // Quick API-based check that content landed correctly before the full supervisor cycle.
    let inlineValidations: ValidationResult[] = [];
    let inlineValidationEvidence = '';

    if (agentResult.success && contentPlan && apiSubdomain && apiPageSectionsId) {
      try {
        const valClient = createContentSaveClient(apiSubdomain);
        const linkValOpts: LinkValidationOptions | undefined = siteBaseUrl
          ? { siteBaseUrl }
          : undefined;
        for (const op of contentPlan.operations) {
          const valResult = await validateOperation(op, valClient, apiPageSectionsId, null, linkValOpts);
          inlineValidations.push(valResult);

          agentEvents.emit('dashboard', {
            type: 'agent_activity' as const,
            data: {
              agent: 'content_validator',
              status: valResult.passed ? 'completed' : 'failed',
              message: `Validation ${valResult.passed ? 'passed' : 'FAILED'}: ${valResult.summary}`,
              taskId: task.id,
              detail: { operationType: valResult.operationType, checks: valResult.checks },
            },
            timestamp: new Date().toISOString(),
          });
        }

        if (inlineValidations.length > 0) {
          inlineValidationEvidence = formatValidationForSupervisor(inlineValidations);
          const passCount = inlineValidations.filter(v => v.passed).length;
          logger.info(
            { taskId: task.id, total: inlineValidations.length, passed: passCount, failed: inlineValidations.length - passCount },
            'Inline content validation completed',
          );
        }
      } catch (err) {
        logger.warn({ taskId: task.id, error: errMsg(err) }, 'Inline content validation failed (non-fatal)');
      }
    }

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
        inlineValidationEvidence || undefined,
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
  options?: { pageSectionsId?: string; collectionId?: string; siteBaseUrl?: string },
): Promise<{ success: boolean; blocksAdded: number; error?: string; validation?: ValidationResult }> {
  const apiBlocks = operation.content.apiBlocks;
  if (!apiBlocks || apiBlocks.length === 0) {
    return { success: false, blocksAdded: 0, error: 'No apiBlocks provided for blank_api operation' };
  }

  // Resolve layout preset into per-block grid coordinates
  if (operation.content.layoutPreset) {
    const { resolveLayoutPreset } = await import('../../config/layout-presets.js');
    const slots = resolveLayoutPreset(operation.content.layoutPreset, apiBlocks.length);
    if (slots) {
      logger.info(
        { preset: operation.content.layoutPreset, blockCount: apiBlocks.length, slotCount: slots.length },
        'blank_api: resolved layout preset into grid slots',
      );
      for (let i = 0; i < apiBlocks.length && i < slots.length; i++) {
        const slot = slots[i];
        apiBlocks[i].layout = {
          ...apiBlocks[i].layout,
          startX: slot.startX,
          endX: slot.endX,
          startY: slot.startY,
          endY: slot.endY,
        };
      }
    } else {
      logger.warn(
        { preset: operation.content.layoutPreset },
        'blank_api: unknown layout preset — falling back to default stacked layout',
      );
    }
  }

  try {
    // ── API-first path: try addBlankSection via Content Save API (~200ms) ──
    // The API persists server-side — no saveChanges() needed.
    let pageSectionsId = options?.pageSectionsId ?? null;
    let collectionId = options?.collectionId ?? null;
    let usedApiPath = false;

    if (pageSectionsId) {
      try {
        const apiClient = createContentSaveClient(subdomain);
        const apiResult = await apiClient.addBlankSection(pageSectionsId, collectionId ?? '');
        if (apiResult.success) {
          usedApiPath = true;
          logger.info(
            { sectionId: apiResult.sectionId, pageSectionsId },
            'blank_api: blank section added via API (~200ms)',
          );
        } else {
          logger.warn(
            { error: apiResult.error },
            'blank_api: API addBlankSection failed — falling back to UI',
          );
        }
      } catch (apiErr) {
        logger.warn(
          { error: errMsg(apiErr) },
          'blank_api: API addBlankSection error — falling back to UI',
        );
      }
    }

    // ── UI fallback path: add blank section via handleAddSection (~5s) ──
    if (!usedApiPath) {
      const { handleAddSection } = await import('../../automation/actions/section-management-handlers.js');
      const addSectionResult = await handleAddSection(page, { action: 'addSection' });

      if (!addSectionResult.success) {
        return { success: false, blocksAdded: 0, error: `Failed to add blank section: ${addSectionResult.message}` };
      }

      logger.info('blank_api: blank section added via UI');

      // Save the editor to persist the blank section to the server.
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
    }

    // ── Extract page IDs if not provided ──
    if (!pageSectionsId) {
      const siteFrame = page.frame({ name: 'sqs-site-frame' });
      if (!siteFrame) {
        return { success: false, blocksAdded: 0, error: 'No sqs-site-frame found after adding section' };
      }

      pageSectionsId = await siteFrame.evaluate(() => {
        const article = document.querySelector('article[data-page-sections]');
        return article?.getAttribute('data-page-sections') ?? null;
      }).catch(() => null);

      if (!pageSectionsId) {
        return { success: false, blocksAdded: 0, error: 'Could not find data-page-sections attribute' };
      }
    }

    if (!collectionId) {
      const client = createContentSaveClient(subdomain);
      // Derive page slug: try operation's targetPage, then iframe URL, then outer URL
      const opSlug = operation.targetPage ?? '';
      const iframeSlug = page.frame({ name: 'sqs-site-frame' })?.url()
        .match(/squarespace\.com\/([^?#/]+)/)?.[1] ?? '';
      const outerSlug = page.url().match(/squarespace\.com\/config\/pages\/([^/?#]+)/)?.[1] ?? '';
      const slug = opSlug || iframeSlug || outerSlug || '';
      logger.info({ opSlug, iframeSlug, outerSlug, resolvedSlug: slug },
        'blank_api: resolving page slug for collectionId');
      const ids = await client.getPageIds(slug);

      if (!ids) {
        return { success: false, blocksAdded: 0, error: `Could not get page IDs for slug "${slug}". URL: ${page.url()}` };
      }
      collectionId = ids.collectionId;
    }

    logger.info({ pageSectionsId, collectionId, usedApiPath }, 'blank_api: got page IDs');

    // Create client for block operations (may already exist from ID extraction)
    const client = createContentSaveClient(subdomain);

    // Capture pre-operation snapshot for validation
    const preSnapshot = await capturePreSnapshot(client, pageSectionsId);

    // Step 4: Find the new section (last section)
    const sectionsData = await client.getPageSections(pageSectionsId);
    const sectionIndex = sectionsData.sections.length - 1;
    logger.info({ sectionIndex, totalSections: sectionsData.sections.length }, 'blank_api: found sections');

    if (sectionIndex < 0) {
      return { success: false, blocksAdded: 0, error: 'No sections found after adding blank section' };
    }

    // Step 5: Try adding blocks via Content Save API (fast path)
    let blocksAdded = 0;
    let apiFailed = false;

    for (const block of apiBlocks) {
      if (isApiGalleryBlock(block)) {
        // Gallery block — batch upload images + add as image blocks in grid layout
        const galleryResult = await executeGalleryBlock(
          client, pageSectionsId, collectionId!, sectionIndex, subdomain, block,
        );
        if (galleryResult.success) {
          blocksAdded += galleryResult.blocksAdded;
          logger.info(
            { blocksAdded: galleryResult.blocksAdded, sectionIndex, total: apiBlocks.length },
            'blank_api: gallery block added via API',
          );
        } else {
          logger.warn(
            { error: galleryResult.error, sectionIndex },
            'blank_api: gallery block failed',
          );
          // Gallery failures are non-fatal — continue with remaining blocks
        }
      } else if (isApiImageBlock(block)) {
        // Image block — upload image + add via API
        const imageResult = await executeImageBlock(
          client, pageSectionsId, collectionId!, sectionIndex, subdomain, block,
        );
        if (imageResult.success) {
          blocksAdded++;
          logger.info(
            { blockId: imageResult.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
            'blank_api: image block added via API',
          );
        } else {
          logger.warn(
            { error: imageResult.error, sectionIndex, imagePath: block.imagePath },
            'blank_api: image block failed',
          );
          // Image failures are non-fatal — continue with remaining blocks
        }
      } else if (isApiButtonBlock(block)) {
        // Button block — use addButtonBlock API
        const result = await client.addButtonBlock(
          pageSectionsId,
          collectionId!,
          sectionIndex,
          block.label,
          block.url,
          block.layout,
        );

        if (result.success) {
          blocksAdded++;
          logger.info(
            { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length, label: block.label },
            'blank_api: button block added via API',
          );
        } else {
          logger.warn(
            { error: result.error, sectionIndex, blockIndex: blocksAdded, label: block.label },
            'blank_api: addButtonBlock API failed — switching to UI fallback',
          );
          apiFailed = true;
          break;
        }
      } else if (isApiDividerBlock(block)) {
        // Divider block
        const result = await client.addDividerBlock(
          pageSectionsId,
          collectionId!,
          sectionIndex,
          block.layout,
        );

        if (result.success) {
          blocksAdded++;
          logger.info(
            { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
            'blank_api: divider block added via API',
          );
        } else {
          logger.warn(
            { error: result.error, sectionIndex },
            'blank_api: addDividerBlock API failed — switching to UI fallback',
          );
          apiFailed = true;
          break;
        }
      } else if (isApiVideoBlock(block)) {
        // Video block
        const result = await client.addVideoBlock(
          pageSectionsId,
          collectionId!,
          sectionIndex,
          block.videoUrl,
          { title: block.title, description: block.description, layout: block.layout },
        );

        if (result.success) {
          blocksAdded++;
          logger.info(
            { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length, videoUrl: block.videoUrl },
            'blank_api: video block added via API',
          );
        } else {
          logger.warn(
            { error: result.error, sectionIndex, videoUrl: block.videoUrl },
            'blank_api: addVideoBlock API failed — switching to UI fallback',
          );
          apiFailed = true;
          break;
        }
      } else if (isApiQuoteBlock(block)) {
        // Quote block
        const result = await client.addQuoteBlock(
          pageSectionsId,
          collectionId!,
          sectionIndex,
          block.quoteText,
          block.attribution,
          block.layout,
        );

        if (result.success) {
          blocksAdded++;
          logger.info(
            { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
            'blank_api: quote block added via API',
          );
        } else {
          logger.warn(
            { error: result.error, sectionIndex },
            'blank_api: addQuoteBlock API failed — switching to UI fallback',
          );
          apiFailed = true;
          break;
        }
      } else if (isApiCodeBlock(block)) {
        // Code block
        const result = await client.addCodeBlock(
          pageSectionsId,
          collectionId!,
          sectionIndex,
          block.code,
          block.language,
          block.layout,
        );

        if (result.success) {
          blocksAdded++;
          logger.info(
            { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
            'blank_api: code block added via API',
          );
        } else {
          logger.warn(
            { error: result.error, sectionIndex },
            'blank_api: addCodeBlock API failed — switching to UI fallback',
          );
          apiFailed = true;
          break;
        }
      } else {
        // Text block — existing flow
        const blockHtml = block.richContent
          ? ContentSaveClient.buildRichHtml(block.richContent)
          : block.html;

        const result = await client.addTextBlock(
          pageSectionsId,
          collectionId!,
          sectionIndex,
          blockHtml,
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
    }

    // Step 6: Fallback — if API failed, use UI to create blocks + API to fill content.
    // The Squarespace API may reject client-generated block IDs on PUT.
    // Fallback: addBlockToSection (UI creates block with server-side ID) → updateTextBlock (API fills content).
    // Note: UI fallback only handles text blocks — other block types have no UI fallback path.
    if (apiFailed) {
      const remainingTextBlocks = apiBlocks.slice(blocksAdded).filter((b): b is ApiTextBlock =>
        !isApiButtonBlock(b) && !isApiImageBlock(b) && !isApiGalleryBlock(b)
        && !isApiDividerBlock(b) && !isApiVideoBlock(b) && !isApiQuoteBlock(b) && !isApiCodeBlock(b),
      );
      logger.info(
        { apiBlocksAdded: blocksAdded, remaining: apiBlocks.length - blocksAdded, textBlocksForFallback: remainingTextBlocks.length },
        'blank_api: switching to UI+API fallback for remaining blocks',
      );

      if (remainingTextBlocks.length > 0) {
        const fallbackResult = await executeBlankApiFallback(
          page, client, pageSectionsId, collectionId!, sectionIndex, remainingTextBlocks,
        );
        blocksAdded += fallbackResult.blocksAdded;
        if (fallbackResult.errors.length > 0) {
          logger.warn({ errors: fallbackResult.errors }, 'blank_api: UI fallback had errors');
        }
      }
    }

    // Step 6b: Apply section styling if specified (non-blocking)
    // Try API-first (fast path ~200ms) when we already have client/IDs, fall back to UI handler
    const { sectionPadding, blockSpacing, sectionTheme } = operation.content;
    if (sectionPadding || blockSpacing || sectionTheme) {
      try {
        let styled = false;
        if (client && pageSectionsId && collectionId) {
          const styleResult = await client.editSectionStyle(pageSectionsId, collectionId, sectionIndex, {
            sectionTheme,
            blockSpacing: blockSpacing ?? undefined,
            paddingTop: sectionPadding ?? undefined,
            paddingBottom: sectionPadding ?? undefined,
          });
          if (styleResult.success) {
            styled = true;
            logger.info({ sectionTheme, sectionPadding, blockSpacing, api: true }, 'blank_api: section styling applied via API');
          }
        }
        if (!styled) {
          const { handleEditSectionStyle } = await import('../../automation/actions/section-management-handlers.js');
          const heading = operation.content.heading ?? 'blank section';
          await handleEditSectionStyle(page, {
            action: 'editSectionStyle',
            searchText: heading,
            sectionTheme,
            sectionPadding,
            blockSpacing,
          });
          logger.info({ sectionTheme, sectionPadding, blockSpacing }, 'blank_api: section styling applied via UI');
        }
      } catch (styleErr) {
        logger.warn({ error: errMsg(styleErr) }, 'blank_api: section styling failed (non-blocking)');
      }
    }

    // Step 7: Reload the page to show changes
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    if (blocksAdded === 0) {
      return { success: false, blocksAdded: 0, error: 'All block additions failed (API + UI fallback)' };
    }

    // Step 8: Post-operation validation — read page state back and verify content landed
    let validation: ValidationResult | undefined;
    try {
      const blankApiLinkValOpts: LinkValidationOptions | undefined = options?.siteBaseUrl
        ? { siteBaseUrl: options.siteBaseUrl }
        : undefined;
      validation = await validateOperation(operation, client, pageSectionsId, preSnapshot, blankApiLinkValOpts);
      logger.info(
        { passed: validation.passed, opType: operation.operationType, checks: validation.checks.length },
        'blank_api: post-operation validation completed',
      );
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'blank_api: post-operation validation failed (non-fatal)');
    }

    return { success: true, blocksAdded, validation };
  } catch (err) {
    return { success: false, blocksAdded: 0, error: errMsg(err) };
  }
}

// ─── API-First Template Copy ─────────────────────────────────────────────────

/**
 * Try to copy a template section via the Content Save API (~300ms).
 * Returns the copy result if successful, or null if any step fails (caller falls through to UI).
 */
async function tryCopyTemplateViaApi(
  subdomain: string,
  pageSectionsId: string,
  categoryName: string,
  templateIndex: number,
): Promise<import('../../services/content-save.js').CopyTemplateSectionResult | null> {
  try {
    const { getOrFetchCatalog, lookupCatalogEntry } = await import('../../services/section-catalog.js');

    // Step 1: Get catalog (cached, ~0ms on hit)
    const catalog = await getOrFetchCatalog(subdomain);
    if (!catalog) {
      logger.warn({ subdomain }, 'tryCopyTemplateViaApi: catalog fetch failed');
      return null;
    }

    // Step 2: Look up the specific template entry
    const entry = lookupCatalogEntry(catalog, categoryName, templateIndex);
    if (!entry) {
      logger.warn(
        { categoryName, templateIndex },
        'tryCopyTemplateViaApi: entry not found in catalog',
      );
      return null;
    }

    // Step 3: Copy the template section
    const client = createContentSaveClient(subdomain);
    const result = await client.copyTemplateSection(
      entry.websiteId, entry.collectionId, entry.sectionId,
    );

    if (!result.success) {
      logger.warn(
        { error: result.error, categoryName, templateIndex },
        'tryCopyTemplateViaApi: copy failed',
      );
      return null;
    }

    logger.info(
      { sectionId: result.sectionId, categoryName, templateIndex },
      'tryCopyTemplateViaApi: template section copied via API (~300ms)',
    );
    return result;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'tryCopyTemplateViaApi: error');
    return null;
  }
}

// ─── Template Operation Execution ────────────────────────────────────────────

/**
 * Execute a template operation: add template section, save, then replace
 * placeholder content via Content Save API.
 *
 * Flow:
 * 1. Add template section via handleAddSection (UI — picks category + template)
 * 2. Save editor state (so Content Save API has the new section)
 * 3. Replace placeholder texts/buttons via Content Save API (fast, reliable)
 * 4. Apply section styling if specified
 *
 * This is the "template fast path" — ~10s vs ~60s through the browser agent.
 * Modeled after executeBlankApiOperation's save-first pattern.
 */
async function executeTemplateOperation(
  page: import('playwright').Page,
  operation: import('../../agents/types.js').ContentOperation,
): Promise<{ success: boolean; error?: string }> {
  const { content } = operation;
  const category = content.templateCategory;
  const templateName = content.templateName;
  const templateIndex = content.templateIndex;
  const replacements = content.replacements;

  if (!category) {
    return { success: false, error: 'No templateCategory provided for template operation' };
  }

  try {
    // ── Step 1: Try API-first template copy (~300ms) ──
    let usedApiPath = false;
    const subdomain = page.url().match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i)?.[1];

    if (subdomain && templateIndex !== undefined) {
      const siteFrame = page.frame({ name: 'sqs-site-frame' });
      const pageSectionsId = siteFrame
        ? await siteFrame.evaluate(() => {
            const article = document.querySelector('article[data-page-sections]');
            return article?.getAttribute('data-page-sections') ?? null;
          }).catch(() => null)
        : null;

      if (pageSectionsId) {
        const copyResult = await tryCopyTemplateViaApi(
          subdomain, pageSectionsId, category, templateIndex,
        );
        if (copyResult) {
          usedApiPath = true;
          logger.info(
            { category, templateIndex, sectionId: copyResult.sectionId },
            'template: section added via API (~300ms)',
          );
        }
      }
    }

    // ── UI fallback: add template section via handleAddSection (~5-30s) ──
    if (!usedApiPath) {
      const { handleAddSection } = await import('../../automation/actions/section-management-handlers.js');
      const addResult = await handleAddSection(page, {
        action: 'addSection',
        category,
        template: templateName ?? category,
        templateIndex,
      });

      if (!addResult.success) {
        return { success: false, error: `Failed to add template section: ${addResult.message}` };
      }

      logger.info({ category, templateName, templateIndex }, 'template: section added via UI');

      // Save editor state so Content Save API has the new section data.
      const { saveChanges: editorSave } = await import('../../automation/editor-actions.js');
      const saveResult = await editorSave(page);
      logger.info({ saveResult: saveResult.message }, 'template: saved editor state after adding section');
      await page.waitForTimeout(2000);

      // Re-enter edit mode if save exited it
      if (saveResult.message?.includes('Done')) {
        logger.info('template: save clicked Done — re-entering edit mode');
        const { enterEditMode: reEnterEditMode } = await import('../../automation/site-navigator.js');
        await reEnterEditMode(page);
        await page.waitForTimeout(1500);
      }
    }

    // Step 3: Replace placeholder content via Content Save API
    if (replacements && (replacements.texts?.length || replacements.buttons?.length || replacements.removeBlocks?.length)) {
      // Extract page IDs for Content Save API
      const siteFrame2 = page.frame({ name: 'sqs-site-frame' });
      const pageSectionsId2 = siteFrame2
        ? await siteFrame2.evaluate(() => {
            const article = document.querySelector('article[data-page-sections]');
            return article?.getAttribute('data-page-sections') ?? null;
          }).catch(() => null)
        : null;

      const subdomain2 = page.url().match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i)?.[1];

      if (pageSectionsId2 && subdomain2) {
        const client = createContentSaveClient(subdomain2);
        // Derive page slug: try operation's targetPage, then iframe URL, then outer URL
        const opSlug3 = operation.targetPage ?? '';
        const iframeSlug3 = siteFrame2?.url().match(/squarespace\.com\/([^?#/]+)/)?.[1] ?? '';
        const outerSlug3 = page.url().match(/squarespace\.com\/config\/pages\/([^/?#]+)/)?.[1] ?? '';
        const slug = opSlug3 || iframeSlug3 || outerSlug3 || '';
        const ids = await client.getPageIds(slug);

        if (ids) {
          // Find the last section (the one we just added)
          const sectionsData = await client.getPageSections(pageSectionsId2);
          const sectionIndex = sectionsData.sections.length - 1;

          if (sectionIndex >= 0) {
            let apiReplacements = 0;
            let apiFailed = 0;

            // 3a. Replace text blocks
            if (replacements.texts) {
              for (const textRep of replacements.texts) {
                const findResult = await client.updateTextBlock(pageSectionsId2, ids.collectionId, textRep.searchText, textRep.newText);

                if (findResult.success) {
                  apiReplacements++;
                  logger.info({ searchText: textRep.searchText.substring(0, 30) }, 'template: text replaced via API');
                } else {
                  apiFailed++;
                  logger.warn({ searchText: textRep.searchText.substring(0, 30), error: findResult.error }, 'template: text replacement failed via API');
                }
              }
            }

            // 3b. Remove unwanted blocks
            if (replacements.removeBlocks) {
              for (const blockText of replacements.removeBlocks) {
                const removeResult = await client.removeBlock(pageSectionsId2, ids.collectionId, blockText);
                if (removeResult.success) {
                  apiReplacements++;
                  logger.info({ searchText: blockText.substring(0, 30) }, 'template: block removed via API');
                } else {
                  apiFailed++;
                  logger.warn({ searchText: blockText.substring(0, 30) }, 'template: block removal failed via API');
                }
              }
            }

            logger.info({ apiReplacements, apiFailed }, 'template: API replacements completed');
          }
        }
      } else {
        logger.warn('template: could not extract page IDs for Content Save API — replacements skipped');
      }
    }

    // Step 3b: Handle image replacements via UI (Content Save API doesn't handle image uploads)
    if (replacements?.images?.length) {
      // Re-enter edit mode for the new section
      const { handleEnterSectionEditMode } = await import('../../automation/actions/section-management-handlers.js');
      await handleEnterSectionEditMode(page, { action: 'enterSectionEditMode', sectionIndex: 'last' });
      await page.waitForTimeout(1000);

      const { handleReplaceImage } = await import('../../automation/actions/image-handlers.js');
      for (const imgRep of replacements.images) {
        const result = await handleReplaceImage(page, {
          action: 'replaceImage',
          searchText: imgRep.searchText,
          imagePath: imgRep.imagePath,
          altText: imgRep.altText,
        });
        if (result.success) {
          logger.info({ searchText: imgRep.searchText.substring(0, 30) }, 'template: image replaced');
        } else {
          logger.warn({ searchText: imgRep.searchText.substring(0, 30), error: result.message }, 'template: image replacement failed');
        }
      }
    }

    // Step 4: Apply section styling if specified
    // Try API-first (fast path ~200ms) with direct client, fall back to UI handler
    if (content.sectionPadding || content.blockSpacing || content.sectionTheme ||
        content.sectionHeight || content.contentWidth || content.verticalAlignment) {
      try {
        let styled = false;
        const subdomainStyle = page.url().match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i)?.[1];
        if (subdomainStyle) {
          const siteFrameStyle = page.frame({ name: 'sqs-site-frame' });
          const psIdStyle = siteFrameStyle
            ? await siteFrameStyle.evaluate(() => {
                const article = document.querySelector('article[data-page-sections]');
                return article?.getAttribute('data-page-sections') ?? null;
              }).catch(() => null)
            : null;

          if (psIdStyle) {
            const styleClient = createContentSaveClient(subdomainStyle);
            const sectionsData = await styleClient.getPageSections(psIdStyle);
            const lastIdx = sectionsData.sections.length - 1;
            if (lastIdx >= 0) {
              const slugStyle = page.url().match(/squarespace\.com\/config\/pages\/([^/?#]+)/)?.[1] ?? '';
              const idsStyle = await styleClient.getPageIds(slugStyle);
              if (idsStyle) {
                const styleResult = await styleClient.editSectionStyle(psIdStyle, idsStyle.collectionId, lastIdx, {
                  sectionTheme: content.sectionTheme,
                  sectionHeight: content.sectionHeight,
                  contentWidth: content.contentWidth,
                  verticalAlignment: content.verticalAlignment,
                  blockSpacing: content.blockSpacing ?? undefined,
                  paddingTop: content.sectionPadding ?? undefined,
                  paddingBottom: content.sectionPadding ?? undefined,
                });
                if (styleResult.success) {
                  styled = true;
                  logger.info({ updatedFields: styleResult.updatedFields, api: true }, 'template: section styling applied via API');
                }
              }
            }
          }
        }
        if (!styled) {
          const { handleEditSectionStyle } = await import('../../automation/actions/section-management-handlers.js');
          const heading = content.heading ?? category;
          await handleEditSectionStyle(page, {
            action: 'editSectionStyle',
            searchText: heading,
            sectionTheme: content.sectionTheme,
            sectionHeight: content.sectionHeight,
            contentWidth: content.contentWidth,
            verticalAlignment: content.verticalAlignment,
            sectionPadding: content.sectionPadding,
            blockSpacing: content.blockSpacing,
          });
        }
      } catch (styleErr) {
        logger.warn({ error: errMsg(styleErr) }, 'template: section styling failed (non-blocking)');
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
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
// ─── Image & Gallery Block Execution ─────────────────────────────────────

/**
 * Execute a single image block: upload image via MediaUploadClient, then add
 * the image block to the section via Content Save API.
 */
async function executeImageBlock(
  client: ReturnType<typeof createContentSaveClient>,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  subdomain: string,
  block: import('../../agents/types.js').ApiImageBlock,
): Promise<{ success: boolean; blockId?: string; error?: string }> {
  try {
    // Validate image file exists
    const { existsSync } = await import('fs');
    if (!existsSync(block.imagePath)) {
      return { success: false, error: `Image file not found: ${block.imagePath}` };
    }

    // Upload image via MediaUploadClient (dynamic import to avoid circular deps)
    const { createMediaUploadClient } = await import('../../services/media-upload.js');
    const mediaClient = createMediaUploadClient(subdomain);
    const uploadResult = await mediaClient.uploadImage(block.imagePath);

    if (uploadResult.status !== 'success' || !uploadResult.assetUrl) {
      return { success: false, error: `Image upload failed: ${uploadResult.failureReason ?? 'no asset URL'}` };
    }

    logger.info(
      { imagePath: block.imagePath, assetUrl: uploadResult.assetUrl },
      'Image uploaded successfully for image block',
    );

    // Add image block via Content Save API
    const addResult = await client.addImageBlock(
      pageSectionsId,
      collectionId,
      sectionIndex,
      uploadResult.assetUrl,
      {
        altText: block.altText,
        title: block.title,
        layout: block.layout,
      },
    );

    if (!addResult.success) {
      return { success: false, error: `addImageBlock failed: ${addResult.error}` };
    }

    return { success: true, blockId: addResult.blockId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

/**
 * Execute a gallery block: batch-upload images via MediaUploadClient, then
 * add them as image blocks in a grid layout via Content Save API.
 */
async function executeGalleryBlock(
  client: ReturnType<typeof createContentSaveClient>,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  subdomain: string,
  block: import('../../agents/types.js').ApiGalleryBlock,
): Promise<{ success: boolean; blocksAdded: number; error?: string }> {
  if (!block.images || block.images.length === 0) {
    return { success: false, blocksAdded: 0, error: 'No images provided in gallery block' };
  }

  try {
    // Validate all image files exist
    const { existsSync } = await import('fs');
    const missingImages = block.images.filter(img => !existsSync(img.imagePath));
    if (missingImages.length > 0) {
      logger.warn(
        { missing: missingImages.map(i => i.imagePath) },
        'Gallery: some image files not found — will upload available ones',
      );
    }

    const validImages = block.images.filter(img => existsSync(img.imagePath));
    if (validImages.length === 0) {
      return { success: false, blocksAdded: 0, error: 'No valid image files found for gallery' };
    }

    // Batch upload images via MediaUploadClient
    const { createMediaUploadClient } = await import('../../services/media-upload.js');
    const mediaClient = createMediaUploadClient(subdomain);
    const uploadResults = await mediaClient.uploadImages(
      validImages.map(img => img.imagePath),
      3, // concurrency
    );

    // Map upload results back to image specs (only successfully uploaded ones)
    const columns = block.columns ?? 3;
    const columnWidth = Math.floor(24 / columns);
    const imageSpecs: Array<{
      assetUrl: string;
      altText?: string;
      title?: string;
      layout?: { startX: number; endX: number; startY: number; endY: number };
    }> = [];

    for (let i = 0; i < uploadResults.length; i++) {
      const uploadResult = uploadResults[i];
      if (!uploadResult.success || (!uploadResult.assetUrl && !uploadResult.assetId)) {
        logger.warn(
          { originalPath: uploadResult.originalPath, error: uploadResult.error, success: uploadResult.success, hasUrl: !!uploadResult.assetUrl, hasId: !!uploadResult.assetId },
          'Gallery: image upload failed — skipping this image',
        );
        continue;
      }

      // If we have assetId but no assetUrl, construct the CDN URL
      const assetUrl = uploadResult.assetUrl
        ?? `https://images.squarespace-cdn.com/content/v1/${uploadResult.assetId}`;

      const imgSpec = validImages[i];

      // Calculate grid position for this image
      const col = imageSpecs.length % columns;
      const row = Math.floor(imageSpecs.length / columns);
      const rowHeight = 8; // default image row height
      const gapRows = 2;  // gap between rows

      const startX = 1 + (col * columnWidth);
      const endX = Math.min(startX + columnWidth, 25);
      const startY = row * (rowHeight + gapRows);
      const endY = startY + rowHeight;

      imageSpecs.push({
        assetUrl,
        altText: imgSpec.altText,
        title: imgSpec.title,
        layout: { startX, endX, startY, endY },
      });
    }

    if (imageSpecs.length === 0) {
      return { success: false, blocksAdded: 0, error: 'All image uploads failed for gallery' };
    }

    logger.info(
      { totalImages: block.images.length, uploaded: imageSpecs.length, columns, galleryStyle: block.galleryStyle },
      'Gallery: images uploaded, adding to section',
    );

    // Add all image blocks in a single batch PUT
    const batchResult = await client.addImageBlockBatch(
      pageSectionsId,
      collectionId,
      sectionIndex,
      imageSpecs,
    );

    if (!batchResult.success) {
      return { success: false, blocksAdded: 0, error: `addImageBlockBatch failed: ${batchResult.error}` };
    }

    return { success: true, blocksAdded: batchResult.blocks.length };
  } catch (err) {
    return { success: false, blocksAdded: 0, error: errMsg(err) };
  }
}

// ─── Blank API Fallback ──────────────────────────────────────────────────

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

// ─── Two-Pass Execution ─────────────────────────────────────────────────────

/**
 * Split plan operations into structural (pass 1) and content (pass 2) operations.
 *
 * Structural operations create pages or add sections. Content operations modify
 * text, add blocks, replace images, remove blocks, or change styles within
 * existing sections.
 *
 * Operations that are both structural AND have content (e.g., add_section with
 * replacements or apiBlocks) appear in BOTH passes: the structural pass adds the
 * section, and the content pass fills in the content.
 */
export function splitOperationsIntoPasses(operations: ContentOperation[]): {
  structural: ContentOperation[];
  content: ContentOperation[];
} {
  const structural: ContentOperation[] = [];
  const content: ContentOperation[] = [];

  for (const op of operations) {
    const isCreatePage = op.operationType === 'create_page' || op.targetPage === 'new';
    const isAddSection = op.operationType === 'add_section';

    if (isCreatePage) {
      // Page creation is purely structural
      structural.push(op);
    } else if (isAddSection) {
      // Section additions are structural — always add to pass 1
      structural.push(op);

      // If the section also has content to fill, add a content-only copy to pass 2
      const hasReplacements = op.content.replacements &&
        ((op.content.replacements.texts?.length ?? 0) > 0 ||
         (op.content.replacements.buttons?.length ?? 0) > 0 ||
         (op.content.replacements.images?.length ?? 0) > 0 ||
         (op.content.replacements.removeBlocks?.length ?? 0) > 0);
      const hasApiBlocks = (op.content.apiBlocks?.length ?? 0) > 0;
      const hasStyle = op.content.sectionTheme || op.content.sectionPadding ||
        op.content.blockSpacing || op.content.sectionHeight || op.content.contentWidth;

      if (hasReplacements || hasApiBlocks || hasStyle) {
        content.push(op);
      }
    } else {
      // Everything else is content work
      content.push(op);
    }
  }

  return { structural, content };
}

/**
 * Determine whether a plan should use two-pass execution.
 *
 * Two-pass is beneficial when:
 * - The plan has create_page operations (page must exist before sections)
 * - The plan has 3+ section additions (bulk structural work benefits from save-once)
 */
export function shouldUseTwoPass(plan: ContentPlan): boolean {
  const hasPageCreation = plan.operations.some(
    op => op.operationType === 'create_page' || op.targetPage === 'new',
  );

  const sectionAdditions = plan.operations.filter(
    op => op.operationType === 'add_section',
  ).length;

  return hasPageCreation || sectionAdditions >= TWO_PASS_SECTION_THRESHOLD;
}

/**
 * Execute a content plan in two passes: structure first, content second.
 *
 * Pass 1 (Structure): Creates pages and adds all sections (blank or template).
 *   After all structural ops, saves the editor and waits for Squarespace to persist.
 *
 * Pass 2 (Content): Fills text via API, applies replacements, removes blocks,
 *   applies section styles. All sections are guaranteed to exist server-side.
 *
 * Section tracking: After pass 1, re-fetches page sections via API to discover
 * the actual section IDs assigned by Squarespace. Maps operations to sections
 * by insertion order.
 */
async function executeTwoPassPlan(
  conversation: Conversation,
  tasks: Task[],
  plan: ContentPlan,
): Promise<void> {
  const primaryTask = tasks[0];
  if (!primaryTask) {
    logger.error('executeTwoPassPlan: no tasks provided');
    updateConversationStatus(conversation.id, 'completed');
    return;
  }

  const { structural, content } = splitOperationsIntoPasses(plan.operations);
  logger.info(
    { structuralCount: structural.length, contentCount: content.length },
    'Two-pass plan: operations split',
  );

  updateTaskStatus(primaryTask.id, 'executing');
  logAction(primaryTask.id, 'task_executing', `Two-pass plan: ${structural.length} structural + ${content.length} content ops`);

  const { dashboardEvents } = await import('../../services/dashboard-events.js');

  const browserManager = getBrowserManager({ headless: true });
  const sessionId = `two-pass-${conversation.id}`;
  const session = await browserManager.createSession(sessionId);

  try {
    await ensureLoggedIn(session);
    const page = await session.getPage();

    // Discover sites and navigate
    const { discoverSites } = await import('../../automation/site-discovery.js');
    await discoverSites(page);

    const client = await resolveSite(primaryTask.siteId, page);
    await navigateToSite(page, client);

    // Detect page-creation in structural ops
    const hasPageCreation = structural.some(
      op => op.operationType === 'create_page' || op.targetPage === 'new',
    );

    if (hasPageCreation) {
      // Navigate to Pages panel for page creation
      const pagesUrl = `${derivePublicBaseUrl(client.site.adminUrl)}/config/pages`;
      logger.info({ pagesUrl }, 'Two-pass: navigating to Pages panel for page creation');
      await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    } else if (primaryTask.targetPage) {
      await navigateToPage(page, client, primaryTask.targetPage);
      await enterEditMode(page);
    }

    const siteContext = {
      pages: client.site.pages,
      siteName: client.name,
    };

    await sendToTim(
      `Starting two-pass execution: ${structural.length} structural ops, then ${content.length} content ops...`,
      conversation.id,
    );

    // ── Pass 1: Structural Operations ──────────────────────────────────
    dashboardEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: {
        agent: 'browser_agent',
        status: 'started',
        message: `Pass 1 (Structure): ${structural.length} operations`,
        taskId: primaryTask.id,
      },
      timestamp: new Date().toISOString(),
    });

    // Track which section indices were added (in order) for pass 2 mapping
    let sectionCountBefore = 0;
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (siteFrame) {
      sectionCountBefore = await siteFrame.locator('.page-section').count().catch(() => 0);
    }

    let pass1Succeeded = 0;
    let pass1Failed = 0;

    for (let i = 0; i < structural.length; i++) {
      const op = structural[i];
      const label = op.content.heading ?? op.operationType.replace(/_/g, ' ');

      dashboardEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: {
          agent: 'browser_agent',
          status: 'started',
          message: `Pass 1 [${i + 1}/${structural.length}]: ${label}`,
          taskId: primaryTask.id,
        },
        timestamp: new Date().toISOString(),
      });

      try {
        if (op.operationType === 'create_page') {
          // Page creation — use handleCreatePage directly with blank template
          // to avoid the browser agent selecting a template page (e.g., Gallery)
          // when we want a blank page for content to be added in pass 2.
          const pageName = op.content.heading ?? label;
          const { handleCreatePage } = await import('../../automation/actions/page-management-handlers.js');
          const createResult = await handleCreatePage(page, {
            action: 'createPage',
            title: pageName,
            template: 'Blank',
          });

          if (createResult.success) {
            pass1Succeeded++;
            logger.info({ label, pageName }, 'Two-pass pass 1: page created');

            // After page creation, enter edit mode on the new page
            try {
              await enterEditMode(page);
            } catch {
              logger.warn('Two-pass: could not enter edit mode after page creation');
            }

            // Re-measure section count — we're now on a fresh page (usually 0 sections)
            const newSiteFrame = page.frame({ name: 'sqs-site-frame' });
            if (newSiteFrame) {
              sectionCountBefore = await newSiteFrame.locator('.page-section').count().catch(() => 0);
              logger.info({ sectionCountBefore }, 'Two-pass: re-measured section count after page creation');
            } else {
              sectionCountBefore = 0;
            }
          } else {
            pass1Failed++;
            logger.warn({ label, error: createResult.summary }, 'Two-pass pass 1: page creation failed');
          }
        } else if (op.operationType === 'add_section') {
          // Two-pass pass 1 MUST use the UI handler (not API) because the
          // post-pass-1 saveChanges() pushes the editor's in-memory state to
          // the server. API-added sections are invisible to the editor, so
          // saveChanges() would overwrite them with the stale editor state.
          const { handleAddSection } = await import('../../automation/actions/section-management-handlers.js');

          const strategy = op.content.contentStrategy;
          let addResult;

          if (strategy === 'template' && op.content.templateCategory) {
            // Add template section (structural only — replacements happen in pass 2)
            addResult = await handleAddSection(page, {
              action: 'addSection',
              category: op.content.templateCategory,
              template: op.content.templateName,
              templateIndex: op.content.templateIndex,
            });
          } else {
            // Add blank section
            addResult = await handleAddSection(page, { action: 'addSection' });
          }

          if (addResult.success) {
            pass1Succeeded++;
            logger.info({ label, strategy }, 'Two-pass pass 1: section added');
          } else {
            pass1Failed++;
            logger.warn({ label, error: addResult.message }, 'Two-pass pass 1: add section failed');
          }

          // Wait for section to settle before adding the next one
          await page.waitForTimeout(1500);
        }
      } catch (err) {
        pass1Failed++;
        logger.error({ error: errMsg(err), label }, 'Two-pass pass 1: operation error');
      }
    }

    logger.info(
      { succeeded: pass1Succeeded, failed: pass1Failed },
      'Two-pass pass 1 complete',
    );

    dashboardEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: {
        agent: 'browser_agent',
        status: pass1Failed === structural.length ? 'failed' : 'completed',
        message: `Pass 1 done: ${pass1Succeeded}/${structural.length} structural ops succeeded`,
        taskId: primaryTask.id,
      },
      timestamp: new Date().toISOString(),
    });

    // ── Save after ALL structural ops ──────────────────────────────────
    // This is the key benefit of two-pass: one save persists all sections
    // to the server before any content operations begin.
    logger.info('Two-pass: saving all structural changes');
    const saveResult = await saveChanges(page);
    logger.info({ message: saveResult.message }, 'Two-pass: editor save result');
    await page.waitForTimeout(2000); // Let Squarespace fully persist

    // Re-enter edit mode if save exited it
    if (saveResult.message?.includes('Done')) {
      logger.info('Two-pass: save clicked Done — re-entering edit mode');
      await enterEditMode(page);
      await page.waitForTimeout(1500);
    }

    // ── Skip pass 2 if no content operations ───────────────────────────
    if (content.length === 0) {
      logger.info('Two-pass: no content operations — done');
      updateTaskStatus(primaryTask.id, pass1Failed === 0 ? 'done' : 'done');
      for (const t of tasks) {
        updateTaskStatus(t.id, 'done');
      }
      updateConversationStatus(conversation.id, 'completed');
      await sendToTim(
        `All done! ${pass1Succeeded}/${structural.length} sections added.`,
        conversation.id,
      );
      return;
    }

    // ── Section tracking: discover actual section IDs ──────────────────
    // After pass 1, re-fetch page sections via API to map content operations
    // to their target sections by order.
    const subdomain = page.url().match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i)?.[1];
    let pageSectionsId: string | null = null;
    let collectionId: string | null = null;
    let sectionIds: string[] = [];

    if (subdomain) {
      const siteFramePost = page.frame({ name: 'sqs-site-frame' });
      if (siteFramePost) {
        pageSectionsId = await siteFramePost.evaluate(() => {
          const article = document.querySelector('article[data-page-sections]');
          return article?.getAttribute('data-page-sections') ?? null;
        }).catch(() => null);
      }

      if (pageSectionsId) {
        try {
          const apiClient = createContentSaveClient(subdomain);
          // Derive page slug: prefer the content operation's targetPage (since
          // task.targetPage may be empty for create_page plans), then fall back
          // to extracting it from the current browser URL.
          const opTargetPage = content[0]?.targetPage;
          // Extract slug from browser URL (outer frame or iframe) — editor URL
          // may be /config/pages/gallery or just /gallery in the iframe
          const outerUrl = page.url();
          const iframeUrl = page.frame({ name: 'sqs-site-frame' })?.url() ?? '';
          const urlSlug = iframeUrl.match(/squarespace\.com\/([^?#/]+)/)?.[1]
            ?? outerUrl.match(/squarespace\.com\/([^?#/]+)/)?.[1]
            ?? '';
          const pageSlug = opTargetPage || primaryTask.targetPage || urlSlug || '';
          logger.info({ opTargetPage, taskTargetPage: primaryTask.targetPage, urlSlug, pageSlug },
            'Two-pass pass 2: resolving page slug for collectionId');
          const ids = await apiClient.getPageIds(pageSlug);
          if (ids) {
            collectionId = ids.collectionId;
          }

          const sectionsData = await apiClient.getPageSections(pageSectionsId);
          sectionIds = sectionsData.sections.map(s => s.id);

          logger.info(
            { pageSectionsId, collectionId, totalSections: sectionIds.length, newSections: sectionIds.length - sectionCountBefore },
            'Two-pass: section IDs discovered after pass 1',
          );
        } catch (err) {
          logger.warn({ error: errMsg(err) }, 'Two-pass: failed to discover section IDs');
        }
      }
    }

    // ── Pass 2: Content Operations ─────────────────────────────────────
    await sendToTim(
      `Structure complete (${pass1Succeeded} sections). Now filling content...`,
      conversation.id,
    );

    dashboardEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: {
        agent: 'browser_agent',
        status: 'started',
        message: `Pass 2 (Content): ${content.length} operations`,
        taskId: primaryTask.id,
      },
      timestamp: new Date().toISOString(),
    });

    let pass2Succeeded = 0;
    let pass2Failed = 0;
    const manualOps: ContentOperation[] = [];

    // Map content ops to their target section indices.
    // Structural ops that also appear in content are ordered by their position
    // in the structural array, which corresponds to section addition order.
    // New sections start at index sectionCountBefore.
    const structuralAddSectionOps = structural.filter(op => op.operationType === 'add_section');

    for (let i = 0; i < content.length; i++) {
      const op = content[i];
      const label = op.content.heading ?? op.operationType.replace(/_/g, ' ');
      const strategy = op.content.contentStrategy;

      dashboardEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: {
          agent: 'browser_agent',
          status: 'started',
          message: `Pass 2 [${i + 1}/${content.length}]: ${label}`,
          taskId: primaryTask.id,
        },
        timestamp: new Date().toISOString(),
      });

      try {
        // Determine the section index for this content operation
        // by finding its position among the structural add_section ops
        const structuralIndex = structuralAddSectionOps.findIndex(
          sOp => sOp === op || (sOp.content.heading === op.content.heading && sOp.placement === op.placement),
        );
        const targetSectionIndex = structuralIndex >= 0
          ? sectionCountBefore + structuralIndex
          : -1; // Could not map — will rely on text search or last section

        if (strategy === 'blank_api') {
          // Content-only blank_api: skip adding section (done in pass 1), just add text blocks
          const result = await executeContentOnlyBlankApi(
            page, op, subdomain ?? '', pageSectionsId, collectionId, targetSectionIndex,
          );
          if (result.success) {
            pass2Succeeded++;
            logger.info({ label, blocksAdded: result.blocksAdded }, 'Two-pass pass 2: blank_api content filled');
          } else {
            pass2Failed++;
            logger.warn({ label, error: result.error }, 'Two-pass pass 2: blank_api content failed');
          }
        } else if (strategy === 'template') {
          // Content-only template: skip adding section (done in pass 1), just do replacements + removals
          const result = await executeContentOnlyTemplate(
            page, op, subdomain ?? '', pageSectionsId, collectionId, targetSectionIndex,
          );
          if (result.success) {
            pass2Succeeded++;
            logger.info({ label, replacementsDone: result.replacementsDone }, 'Two-pass pass 2: template content filled');
          } else {
            pass2Failed++;
            logger.warn({ label, error: result.error }, 'Two-pass pass 2: template content failed');
          }
        } else if (strategy === 'manual') {
          // Manual ops require the browser agent — collect them for a batched run
          manualOps.push(op);
        } else {
          // Non-add_section content ops (modify_text, replace_image, etc.)
          // Try Content Save API for text modifications
          if (op.operationType === 'modify_text' && subdomain && pageSectionsId && collectionId) {
            const apiClient = createContentSaveClient(subdomain);
            const searchText = op.content.heading ?? '';
            const newText = op.content.bodyText ?? '';
            if (searchText && newText) {
              const result = await apiClient.updateTextBlock(pageSectionsId, collectionId, searchText, newText);
              if (result.success) {
                pass2Succeeded++;
                logger.info({ label }, 'Two-pass pass 2: text modified via API');
                continue;
              }
            }
          }
          // Fall through to manual for anything the API can't handle
          manualOps.push(op);
        }
      } catch (err) {
        pass2Failed++;
        logger.error({ error: errMsg(err), label }, 'Two-pass pass 2: operation error');
      }
    }

    // Execute any manual/remaining ops via browser agent
    if (manualOps.length > 0) {
      logger.info({ count: manualOps.length }, 'Two-pass pass 2: executing manual ops via browser agent');

      const stepLines = manualOps
        .map((op, i) => {
          const typeLabel = op.operationType?.replace(/_/g, ' ') ?? 'action';
          return `## Step ${i + 1} — ${typeLabel}\n${op.editorInstruction}`;
        })
        .join('\n\n');

      const manualInstruction =
        `You are executing ${manualOps.length} content operations. All sections have already been added — ` +
        `DO NOT add any new sections. Only modify existing content.\n\n` +
        `## ACTION GUIDE\n` +
        `- **Admin UI** buttons: use **click** (main frame)\n` +
        `- **Page content** (text, images, buttons): use **clickInIframe** or **dblclickInIframe**\n\n` +
        stepLines;

      const maxSteps = Math.min(120, Math.max(40, manualOps.length * 20));

      const manualResult = await executeBrowserTask(page, manualInstruction, {
        maxSteps,
        model: MODEL_SONNET,
        siteId: primaryTask.siteId,
        targetPage: primaryTask.targetPage,
      }, siteContext);

      if (manualResult.success) {
        pass2Succeeded += manualOps.length;
        logger.info({ steps: manualResult.steps.length }, 'Two-pass pass 2: manual ops completed');
      } else {
        pass2Failed += manualOps.length;
        logger.warn({ error: manualResult.summary }, 'Two-pass pass 2: manual ops failed');
      }
    }

    // Apply section styling after content operations (API fast path via handler)
    const styledOps = content.filter(op =>
      op.content.sectionTheme || op.content.sectionPadding ||
      op.content.blockSpacing || op.content.sectionHeight || op.content.contentWidth,
    );

    if (styledOps.length > 0) {
      const { handleEditSectionStyle } = await import('../../automation/actions/section-management-handlers.js');

      for (const op of styledOps) {
        const searchText = op.content.heading ?? op.placement ?? '';
        if (!searchText) continue;

        try {
          await handleEditSectionStyle(page, {
            action: 'editSectionStyle',
            searchText,
            sectionTheme: op.content.sectionTheme,
            sectionHeight: op.content.sectionHeight,
            contentWidth: op.content.contentWidth,
            verticalAlignment: op.content.verticalAlignment,
            sectionPadding: op.content.sectionPadding,
            blockSpacing: op.content.blockSpacing,
          });
          logger.info({ searchText }, 'Two-pass: section style applied');
        } catch (err) {
          logger.warn({ error: errMsg(err), searchText }, 'Two-pass: section style failed');
        }
      }
    }

    dashboardEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: {
        agent: 'browser_agent',
        status: pass2Failed === content.length ? 'failed' : 'completed',
        message: `Pass 2 done: ${pass2Succeeded}/${content.length} content ops succeeded`,
        taskId: primaryTask.id,
      },
      timestamp: new Date().toISOString(),
    });

    // ── Final save + screenshot ────────────────────────────────────────
    const finalSave = await saveChanges(page);
    logger.info({ message: finalSave.message }, 'Two-pass: final save');

    let screenshotPath: string | undefined;
    try {
      const { takeScreenshot } = await import('../../utils/screenshot.js');
      screenshotPath = await takeScreenshot(page, 'two-pass-final');
    } catch {
      // Non-critical
    }

    // ── Update task statuses ───────────────────────────────────────────
    const totalOps = structural.length + content.length;
    const totalSucceeded = pass1Succeeded + pass2Succeeded;
    const totalFailed = pass1Failed + pass2Failed;

    if (totalFailed === 0) {
      for (const t of tasks) {
        updateTaskStatus(t.id, 'done');
      }
    } else if (totalSucceeded > 0) {
      for (const t of tasks) {
        updateTaskStatus(t.id, 'done', `${totalFailed} operation(s) had issues`);
      }
    } else {
      for (const t of tasks) {
        updateTaskStatus(t.id, 'failed', 'All operations failed');
      }
    }

    // Send summary
    const summary = `All done! ${totalSucceeded}/${totalOps} operations completed (${pass1Succeeded} structural, ${pass2Succeeded} content).${totalFailed > 0 ? ` ${totalFailed} had issues.` : ''}`;

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
    logger.error({ error: errorMessage }, 'Two-pass execution failed');
    updateTaskStatus(primaryTask.id, 'failed', errorMessage);
    await sendToTim(`Two-pass execution failed: ${errorMessage}`, conversation.id);
  } finally {
    await session.close();
  }

  updateConversationStatus(conversation.id, 'completed');
}

// ─── Content-Only Template Operation ────────────────────────────────────────

/**
 * Execute content operations on an already-added template section.
 * Skips section creation (already done in pass 1). Only does:
 * - Text replacements via Content Save API
 * - Block removals via Content Save API
 * - Button/image replacements via UI handlers (fallback)
 */
async function executeContentOnlyTemplate(
  page: import('playwright').Page,
  operation: ContentOperation,
  subdomain: string,
  pageSectionsId: string | null,
  collectionId: string | null,
  targetSectionIndex: number,
): Promise<{ success: boolean; replacementsDone: number; error?: string }> {
  const replacements = operation.content.replacements;
  if (!replacements) {
    logger.warn({ placement: operation.placement, strategy: operation.content.contentStrategy },
      'Template operation has no replacements — section will have placeholder content');
    return { success: true, replacementsDone: 0 };
  }

  let replacementsDone = 0;
  const errors: string[] = [];

  // Try API-based text replacements first (fast, reliable after save)
  if (replacements.texts && replacements.texts.length > 0 && subdomain && pageSectionsId && collectionId) {
    const apiClient = createContentSaveClient(subdomain);

    for (const textRep of replacements.texts) {
      try {
        const result = await apiClient.updateTextBlock(
          pageSectionsId, collectionId, textRep.searchText, textRep.newText,
        );
        if (result.success) {
          replacementsDone++;
          logger.info(
            { searchText: textRep.searchText.substring(0, 30) },
            'Content-only template: text replaced via API',
          );
        } else {
          // Fall back to UI handler
          logger.info({ error: result.error }, 'Content-only template: API text replace failed, trying UI');
          const { handleEditTextBlock } = await import('../../automation/actions/text-editing-handlers.js');
          const uiResult = await handleEditTextBlock(page, {
            action: 'editTextBlock',
            searchText: textRep.searchText,
            newText: textRep.newText,
          });
          if (uiResult.success) {
            replacementsDone++;
          } else {
            errors.push(`text "${textRep.searchText.substring(0, 20)}": ${uiResult.message}`);
          }
        }
      } catch (err) {
        errors.push(`text "${textRep.searchText.substring(0, 20)}": ${errMsg(err)}`);
      }
    }
  } else if (replacements.texts && replacements.texts.length > 0) {
    // No API available — use UI handlers
    const { handleEditTextBlock } = await import('../../automation/actions/text-editing-handlers.js');
    for (const textRep of replacements.texts) {
      const result = await handleEditTextBlock(page, {
        action: 'editTextBlock',
        searchText: textRep.searchText,
        newText: textRep.newText,
      });
      if (result.success) {
        replacementsDone++;
      } else {
        errors.push(`text "${textRep.searchText.substring(0, 20)}": ${result.message}`);
      }
      await page.waitForTimeout(500);
    }
  }

  // Button replacements (UI only — no API fast path for buttons)
  if (replacements.buttons && replacements.buttons.length > 0) {
    const { handleEditButtonBlock } = await import('../../automation/actions/text-editing-handlers.js');
    for (const btnRep of replacements.buttons) {
      const result = await handleEditButtonBlock(page, {
        action: 'editButtonBlock',
        searchText: btnRep.searchText,
        newLabel: btnRep.newLabel,
        url: btnRep.url,
      });
      if (result.success) {
        replacementsDone++;
      } else {
        errors.push(`button "${btnRep.searchText.substring(0, 20)}": ${result.message}`);
      }
      await page.waitForTimeout(500);
    }
  }

  // Image replacements
  if (replacements.images && replacements.images.length > 0) {
    const { handleReplaceImage } = await import('../../automation/actions/image-handlers.js');
    for (const imgRep of replacements.images) {
      const result = await handleReplaceImage(page, {
        action: 'replaceImage',
        searchText: imgRep.searchText,
        imagePath: imgRep.imagePath,
        altText: imgRep.altText,
      });
      if (result.success) {
        replacementsDone++;
      } else {
        errors.push(`image "${imgRep.searchText.substring(0, 20)}": ${result.message}`);
      }
      await page.waitForTimeout(500);
    }
  }

  // Block removals via API (fast) or UI (fallback)
  if (replacements.removeBlocks && replacements.removeBlocks.length > 0) {
    if (subdomain && pageSectionsId && collectionId) {
      const apiClient = createContentSaveClient(subdomain);
      for (const blockText of replacements.removeBlocks) {
        try {
          const result = await apiClient.removeBlock(pageSectionsId, collectionId, blockText);
          if (result.success) {
            replacementsDone++;
            logger.info({ blockText: blockText.substring(0, 30) }, 'Content-only template: block removed via API');
          } else {
            // Fall back to UI
            const { handleRemoveBlock } = await import('../../automation/actions/block-management-handlers.js');
            const uiResult = await handleRemoveBlock(page, { action: 'removeBlock', searchText: blockText });
            if (uiResult.success) replacementsDone++;
            else errors.push(`remove "${blockText.substring(0, 20)}": ${uiResult.message}`);
          }
        } catch (err) {
          errors.push(`remove "${blockText.substring(0, 20)}": ${errMsg(err)}`);
        }
      }
    } else {
      const { handleRemoveBlock } = await import('../../automation/actions/block-management-handlers.js');
      for (const blockText of replacements.removeBlocks) {
        const result = await handleRemoveBlock(page, { action: 'removeBlock', searchText: blockText });
        if (result.success) replacementsDone++;
        else errors.push(`remove "${blockText.substring(0, 20)}": ${result.message}`);
        await page.waitForTimeout(500);
      }
    }
  }

  const totalExpected =
    (replacements.texts?.length ?? 0) +
    (replacements.buttons?.length ?? 0) +
    (replacements.images?.length ?? 0) +
    (replacements.removeBlocks?.length ?? 0);

  if (replacementsDone === 0 && totalExpected > 0) {
    return { success: false, replacementsDone: 0, error: `All ${totalExpected} replacements failed: ${errors.join('; ')}` };
  }

  if (errors.length > 0) {
    logger.warn({ errors, replacementsDone, totalExpected }, 'Content-only template: some replacements failed');
  }

  return { success: true, replacementsDone };
}

// ─── Content-Only Blank API Operation ───────────────────────────────────────

/**
 * Execute content operations on an already-added blank section.
 * Skips section creation (already done in pass 1). Only does:
 * - addTextBlock API calls for each apiBlock
 * - UI+API fallback if API fails
 */
async function executeContentOnlyBlankApi(
  page: import('playwright').Page,
  operation: ContentOperation,
  subdomain: string,
  pageSectionsId: string | null,
  collectionId: string | null,
  targetSectionIndex: number,
): Promise<{ success: boolean; blocksAdded: number; error?: string }> {
  const apiBlocks = operation.content.apiBlocks;
  if (!apiBlocks || apiBlocks.length === 0) {
    return { success: true, blocksAdded: 0 };
  }

  if (!subdomain || !pageSectionsId || !collectionId) {
    return { success: false, blocksAdded: 0, error: 'Missing API credentials (subdomain/pageSectionsId/collectionId)' };
  }

  const apiClient = createContentSaveClient(subdomain);

  // Determine the actual section index to target
  let sectionIndex = targetSectionIndex;
  try {
    const sectionsData = await apiClient.getPageSections(pageSectionsId);
    const totalSections = sectionsData.sections.length;
    if (sectionIndex < 0 || sectionIndex >= totalSections) {
      // Fall back to last section — handles stale index from page creation
      sectionIndex = Math.max(0, totalSections - 1);
      logger.info({ targetSectionIndex, correctedIndex: sectionIndex, totalSections },
        'Content-only blank_api: section index out of range — using last section');
    }
  } catch (err) {
    if (sectionIndex < 0) {
      return { success: false, blocksAdded: 0, error: `Failed to fetch sections: ${errMsg(err)}` };
    }
    // If fetch fails but we have a non-negative index, try it anyway
  }

  if (sectionIndex < 0) {
    return { success: false, blocksAdded: 0, error: 'No sections found' };
  }

  // Try adding blocks via API (text, button, image, and gallery blocks)
  let blocksAdded = 0;
  let apiFailed = false;

  for (const block of apiBlocks) {
    if (isApiGalleryBlock(block)) {
      // Gallery block — batch upload images + add as image blocks in grid layout
      const galleryResult = await executeGalleryBlock(
        apiClient, pageSectionsId, collectionId, sectionIndex, subdomain, block,
      );
      if (galleryResult.success) {
        blocksAdded += galleryResult.blocksAdded;
        logger.info(
          { blocksAdded: galleryResult.blocksAdded, sectionIndex, total: apiBlocks.length },
          'Content-only blank_api: gallery block added via API',
        );
      } else {
        logger.warn(
          { error: galleryResult.error, sectionIndex },
          'Content-only blank_api: gallery block failed',
        );
      }
    } else if (isApiImageBlock(block)) {
      // Image block — upload image + add via API
      const imageResult = await executeImageBlock(
        apiClient, pageSectionsId, collectionId, sectionIndex, subdomain, block,
      );
      if (imageResult.success) {
        blocksAdded++;
        logger.info(
          { blockId: imageResult.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
          'Content-only blank_api: image block added via API',
        );
      } else {
        logger.warn(
          { error: imageResult.error, sectionIndex, imagePath: block.imagePath },
          'Content-only blank_api: image block failed',
        );
      }
    } else if (isApiButtonBlock(block)) {
      // Button block — use addButtonBlock API
      const result = await apiClient.addButtonBlock(
        pageSectionsId,
        collectionId,
        sectionIndex,
        block.label,
        block.url,
        block.layout,
      );

      if (result.success) {
        blocksAdded++;
        logger.info(
          { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length, label: block.label },
          'Content-only blank_api: button block added via API',
        );
      } else {
        logger.warn(
          { error: result.error, sectionIndex, label: block.label },
          'Content-only blank_api: addButtonBlock failed — switching to UI fallback',
        );
        apiFailed = true;
        break;
      }
    } else if (isApiDividerBlock(block)) {
      // Divider block
      const result = await apiClient.addDividerBlock(
        pageSectionsId,
        collectionId,
        sectionIndex,
        block.layout,
      );

      if (result.success) {
        blocksAdded++;
        logger.info(
          { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
          'Content-only blank_api: divider block added via API',
        );
      } else {
        logger.warn(
          { error: result.error, sectionIndex },
          'Content-only blank_api: addDividerBlock failed — switching to UI fallback',
        );
        apiFailed = true;
        break;
      }
    } else if (isApiVideoBlock(block)) {
      // Video block
      const result = await apiClient.addVideoBlock(
        pageSectionsId,
        collectionId,
        sectionIndex,
        block.videoUrl,
        { title: block.title, description: block.description, layout: block.layout },
      );

      if (result.success) {
        blocksAdded++;
        logger.info(
          { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length, videoUrl: block.videoUrl },
          'Content-only blank_api: video block added via API',
        );
      } else {
        logger.warn(
          { error: result.error, sectionIndex, videoUrl: block.videoUrl },
          'Content-only blank_api: addVideoBlock failed — switching to UI fallback',
        );
        apiFailed = true;
        break;
      }
    } else if (isApiQuoteBlock(block)) {
      // Quote block
      const result = await apiClient.addQuoteBlock(
        pageSectionsId,
        collectionId,
        sectionIndex,
        block.quoteText,
        block.attribution,
        block.layout,
      );

      if (result.success) {
        blocksAdded++;
        logger.info(
          { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
          'Content-only blank_api: quote block added via API',
        );
      } else {
        logger.warn(
          { error: result.error, sectionIndex },
          'Content-only blank_api: addQuoteBlock failed — switching to UI fallback',
        );
        apiFailed = true;
        break;
      }
    } else if (isApiCodeBlock(block)) {
      // Code block
      const result = await apiClient.addCodeBlock(
        pageSectionsId,
        collectionId,
        sectionIndex,
        block.code,
        block.language,
        block.layout,
      );

      if (result.success) {
        blocksAdded++;
        logger.info(
          { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
          'Content-only blank_api: code block added via API',
        );
      } else {
        logger.warn(
          { error: result.error, sectionIndex },
          'Content-only blank_api: addCodeBlock failed — switching to UI fallback',
        );
        apiFailed = true;
        break;
      }
    } else {
      // Text block — existing flow
      const result = await apiClient.addTextBlock(
        pageSectionsId,
        collectionId,
        sectionIndex,
        block.html,
        block.layout,
      );

      if (result.success) {
        blocksAdded++;
        logger.info(
          { blockId: result.blockId, sectionIndex, blocksAdded, total: apiBlocks.length },
          'Content-only blank_api: text block added via API',
        );
      } else {
        logger.warn(
          { error: result.error, sectionIndex },
          'Content-only blank_api: addTextBlock failed — switching to UI fallback',
        );
        apiFailed = true;
        break;
      }
    }
  }

  // Fallback: UI + API for remaining blocks (text blocks only — other types have no UI fallback)
  if (apiFailed) {
    const remainingBlocks = apiBlocks.slice(blocksAdded).filter((b): b is ApiTextBlock =>
      !isApiButtonBlock(b) && !isApiImageBlock(b) && !isApiGalleryBlock(b)
      && !isApiDividerBlock(b) && !isApiVideoBlock(b) && !isApiQuoteBlock(b) && !isApiCodeBlock(b),
    );
    if (remainingBlocks.length > 0) {
      const fallbackResult = await executeBlankApiFallback(
        page, apiClient, pageSectionsId, collectionId, sectionIndex, remainingBlocks,
      );
      blocksAdded += fallbackResult.blocksAdded;
    }
  }

  if (blocksAdded === 0) {
    return { success: false, blocksAdded: 0, error: 'All block additions failed' };
  }

  return { success: true, blocksAdded };
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
  trackedOps: PlanOperation[] = [],
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

    // Prepare for batch validation — extract page IDs and subdomain for API reads
    const batchSubdomain = page.url().match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i)?.[1] ?? null;
    const batchSiteBaseUrl = derivePublicBaseUrl(client.site.adminUrl);
    let batchPageSectionsId: string | null = null;
    const batchValidations: ValidationResult[] = [];

    if (batchSubdomain) {
      try {
        const siteFrame = page.frame({ name: 'sqs-site-frame' });
        if (siteFrame) {
          batchPageSectionsId = await siteFrame.evaluate(() => {
            const article = document.querySelector('article[data-page-sections]');
            return article?.getAttribute('data-page-sections') ?? null;
          }).catch(() => null);
        }
      } catch {
        // Non-critical — validation will be skipped
      }
    }

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

        // Mark tracked operations in this batch as executing
        const batchTrackedOps = batch.map((op) => findTrackedOp(trackedOps, plan.operations, op)).filter(Boolean) as PlanOperation[];
        for (const tracked of batchTrackedOps) {
          updateOperationStatus(tracked.id, 'executing');
        }

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

          // Mark all operations in this batch as succeeded
          for (const tracked of batchTrackedOps) {
            updateOperationStatus(tracked.id, 'succeeded');
          }

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

          // Mark all operations in this batch as failed
          const batchError = batchResult.summary || 'Batch execution failed';
          for (const tracked of batchTrackedOps) {
            updateOperationStatus(tracked.id, 'failed', batchError);
          }

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

        // Save editor state between batches so next batch's API fast paths work
        const interBatchSave = await saveChanges(page);
        logger.info({ interBatchSave, batchNum }, 'Inter-batch save completed');
        await page.waitForTimeout(1000);

        // Post-batch validation: verify batch operations landed correctly
        if (batchResult.success && batchSubdomain && batchPageSectionsId) {
          try {
            const valClient = createContentSaveClient(batchSubdomain);
            const preSnap = await capturePreSnapshot(valClient, batchPageSectionsId);
            const batchLinkValOpts: LinkValidationOptions | undefined = batchSiteBaseUrl
              ? { siteBaseUrl: batchSiteBaseUrl }
              : undefined;

            for (const op of batch) {
              const valResult = await validateOperation(op, valClient, batchPageSectionsId, preSnap, batchLinkValOpts);
              batchValidations.push(valResult);

              batchDashEvents.emit('dashboard', {
                type: 'agent_activity' as const,
                data: {
                  agent: 'content_validator',
                  status: valResult.passed ? 'completed' : 'failed',
                  message: `Validation ${valResult.passed ? 'passed' : 'FAILED'}: ${valResult.summary}`,
                  taskId: task.id,
                  detail: {
                    operationType: valResult.operationType,
                    checks: valResult.checks,
                    batchNum,
                  },
                },
                timestamp: new Date().toISOString(),
              });
            }

            const batchPassCount = batch.length > 0
              ? batchValidations.slice(-batch.length).filter(v => v.passed).length
              : 0;
            logger.info(
              { batchNum, validated: batch.length, passed: batchPassCount },
              'Batch post-validation completed',
            );
          } catch (err) {
            logger.warn({ batchNum, error: errMsg(err) }, 'Batch post-validation failed (non-fatal)');
          }
        }
      } catch (err) {
        failedBatches++;
        const errorMessage = errMsg(err);
        logger.error({ batchNum, error: errorMessage }, 'Batch execution error');

        // Mark all operations in this batch as failed
        const errorBatchTracked = batch.map((op) => findTrackedOp(trackedOps, plan.operations, op)).filter(Boolean) as PlanOperation[];
        for (const tracked of errorBatchTracked) {
          updateOperationStatus(tracked.id, 'failed', errorMessage);
        }

        batchDashEvents.emit('dashboard', {
          type: 'agent_activity' as const,
          data: { agent: 'browser_agent', status: 'failed', message: `Batch ${batchNum}/${totalBatches} error: ${errorMessage.substring(0, 100)}`, taskId: task.id },
          timestamp: new Date().toISOString(),
        });

        await sendToTim(`❌ Batch ${batchNum}/${totalBatches}: Error — ${errorMessage}`, conversation.id);
      }
    }

    // Log overall validation summary for batched execution
    if (batchValidations.length > 0) {
      const valPassed = batchValidations.filter(v => v.passed).length;
      const valFailed = batchValidations.length - valPassed;
      logger.info(
        { totalValidations: batchValidations.length, passed: valPassed, failed: valFailed },
        'Batched plan: validation summary',
      );
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

// ─── Plan Operation Tracking Helpers ─────────────────────────────────────────

/**
 * Find the tracked PlanOperation that corresponds to a ContentOperation.
 * Matches by finding the operation's index in the original plan.
 */
function findTrackedOp(
  trackedOps: PlanOperation[],
  allPlanOps: ContentOperation[],
  targetOp: ContentOperation,
): PlanOperation | undefined {
  const idx = allPlanOps.indexOf(targetOp);
  if (idx === -1) {
    // Fallback: match by operationType + targetPage + placement
    return trackedOps.find(
      (t) =>
        t.operationType === targetOp.operationType &&
        t.targetPage === (targetOp.targetPage ?? null) &&
        t.placement === (targetOp.placement ?? null),
    );
  }
  return trackedOps.find((t) => t.operationIndex === idx);
}

// ─── Template Index Validation ──────────────────────────────────────────────

/**
 * Validate template indexes in a plan against cached discovery data.
 * Logs warnings for stale or mismatched indexes but does not block execution
 * (the browser agent has its own post-add verification).
 */
function validatePlanTemplateIndexes(plan: ContentPlan): void {
  const templateOps = plan.operations.filter(
    (op: ContentOperation) => op.content.templateCategory && op.content.templateIndex !== undefined,
  );

  if (templateOps.length === 0) return;

  // Group operations by siteId to minimize cache lookups
  const siteIds = [...new Set(templateOps.map((op: ContentOperation) => op.siteId))];

  for (const siteId of siteIds) {
    const discovery = getCachedDiscovery(siteId);
    if (!discovery) {
      logger.info(
        { siteId },
        'Template validation: no cached discovery data, skipping validation (will use static catalog)',
      );
      continue;
    }

    const siteOps = templateOps.filter((op: ContentOperation) => op.siteId === siteId);
    for (const op of siteOps) {
      const result = validateTemplateIndex(
        discovery,
        op.content.templateCategory!,
        op.content.templateIndex!,
        op.content.templateName,
      );

      if (!result.valid) {
        logger.warn(
          {
            siteId,
            category: op.content.templateCategory,
            templateIndex: op.content.templateIndex,
            templateName: op.content.templateName,
            reason: result.reason,
          },
          'Template validation: index may be stale — invalidating cache for rediscovery',
        );
        // Invalidate the cache so next pipeline run will rediscover
        invalidateTemplateCache(siteId);
        // Only invalidate once per site
        break;
      }
    }
  }
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
