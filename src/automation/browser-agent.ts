import Anthropic from '@anthropic-ai/sdk';
import { Page } from 'playwright';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { takeScreenshot } from '../utils/screenshot.js';
import { extractPageState, formatPageState } from './browser-agent-state.js';
import { buildSystemPrompt, buildStepMessage, type StepMessage, type SystemPromptBlock } from './browser-agent-prompt.js';
import { detectStuckPattern, getRescueHint, escalateToDocLookup, type RecentAction } from './browser-agent-rescue.js';
import { executeAgentAction, parseAgentAction, type AgentAction, type ActionResult } from './browser-agent-actions.js';
import { getRelevantLearnings } from '../db/learnings.js';
import { getRelevantMemories } from '../db/memories.js';
import type { PageConfig } from '../models/site-config.js';
import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_SONNET, MODEL_HAIKU } from '../config/models.js';
import { errMsg, errContext } from '../utils/errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Emitted after each browser agent step — used for live progress UI. */
export interface StepProgressEvent {
  stepNumber: number;
  maxSteps: number;
  action: string;        // e.g. "click", "fill", "done", "error"
  reasoning: string;     // truncated to ~200 chars
  success: boolean;
  screenshotPath?: string;
  done: boolean;         // true for terminal steps
}

export interface BrowserAgentOptions {
  maxSteps?: number;
  model?: string;
  verbose?: boolean;
  /** Site identifier for fetching relevant learnings from past executions */
  siteId?: string;
  /** Target page slug for fetching page-specific learnings */
  targetPage?: string;
  /** Base64-encoded reference image (e.g., WhatsApp screenshot) for visual context on step 1 */
  referenceImageBase64?: string;
  /** Callback invoked after each step — for live progress tracking. */
  onStepComplete?: (event: StepProgressEvent) => void;
}

export interface SiteContext {
  pages: PageConfig[];
  siteName: string;
}

export interface AgentStep {
  stepNumber: number;
  reasoning: string;
  action: AgentAction;
  result: ActionResult;
  screenshotPath?: string;
}

/** Full-fidelity step data for learning extraction — kept in memory only, not stored in DB. */
export interface EnrichedStep {
  stepNumber: number;
  timestampMs: number;
  durationMs: number;
  reasoning: string;
  action: AgentAction;
  result: ActionResult;
  pageUrl: string;
  openPanels: string[];
  screenshotHash: string;
  /** The CSS selector used in the action (if applicable) */
  selectorUsed?: string;
  /** Whether the selector resolved and action succeeded (for click/fill actions) */
  selectorWorked?: boolean;
  /** Whether the page visually changed from the previous step (screenshot hash comparison) */
  pageChanged: boolean;
}

export interface BrowserAgentResult {
  success: boolean;
  summary: string;
  steps: AgentStep[];
  /** Full-fidelity step log for learning extraction */
  enrichedSteps: EnrichedStep[];
  screenshotPath?: string;
  tokenUsage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

// ─── Core Agent Loop ───────────────────────────────────────────────────────

/**
 * Execute a browser editing task using the AI agent loop.
 *
 * The agent:
 * 1. Takes a screenshot + extracts DOM state
 * 2. Sends them to Claude with the task description
 * 3. Claude returns a single action as JSON
 * 4. The action is executed via Playwright
 * 5. Repeat until done/error/max steps
 */
export async function executeBrowserTask(
  page: Page,
  taskDescription: string,
  options?: BrowserAgentOptions,
  siteContext?: SiteContext,
): Promise<BrowserAgentResult> {
  const startTime = Date.now();
  const maxSteps = options?.maxSteps ?? 20;
  const model = options?.model ?? MODEL_SONNET;
  const verbose = options?.verbose ?? false;
  const onStepComplete = options?.onStepComplete;

  /** Safely invoke the onStepComplete callback (never throws). */
  const emitStep = (event: StepProgressEvent) => {
    try { onStepComplete?.(event); } catch { /* never crash the agent loop */ }
  };

  // Fetch learnings from past executions for this site/page context
  const learnings = getRelevantLearnings(options?.siteId, options?.targetPage);
  if (learnings.length > 0) {
    logger.info({ count: learnings.length, siteId: options?.siteId }, 'Injecting learned patterns into agent prompt');
  }

  // Fetch user memories (site rules only — keeps prompt lean)
  const userMemories = getRelevantMemories(options?.siteId, ['site_rule']).map((m) => ({
    content: m.content,
    siteId: m.siteId ?? undefined,
  }));
  if (userMemories.length > 0) {
    logger.info({ count: userMemories.length, siteId: options?.siteId }, 'Injecting user memories into agent prompt');
  }

  const systemPrompt = buildSystemPrompt(siteContext, learnings, userMemories);
  const steps: AgentStep[] = [];
  const enrichedSteps: EnrichedStep[] = [];
  const conversationHistory: Array<StepMessage | { role: 'assistant'; content: string }> = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastScreenshotPath: string | undefined;
  let previousScreenshotHash: string | undefined;

  // For stuck detection (screenshot-based — hard stuck, gives up)
  const recentScreenshotHashes: string[] = [];
  // For action-based stuck detection (soft stuck — triggers rescue hints)
  const recentActions: RecentAction[] = [];
  let activeRescueHint: string | undefined;
  let stepsAfterRescue = 0;
  let dynamicLookupAttempted = false;
  let lastStuckPattern: string | undefined;
  // For auto-footer-escape (max 2 auto-escapes before letting the agent handle it)
  let footerEscapeCount = 0;
  // Circuit breaker: abort early if N consecutive actions fail (saves tokens on hopeless runs)
  const CIRCUIT_BREAKER_THRESHOLD = 5;
  let consecutiveFailures = 0;
  // One-shot verification gate: first "done" triggers a verification challenge,
  // second "done" is accepted. Resets if agent takes a non-done action.
  let doneVerified = false;
  // For rate-limit retries: skip re-taking screenshot (nothing changed)
  let reuseScreenshot = false;
  let cachedScreenshotBase64: string | undefined;
  let cachedScreenshotBuffer: Buffer | undefined;

  logger.info({ taskDescription, maxSteps, model }, 'Starting browser agent');

  for (let stepNum = 1; stepNum <= maxSteps; stepNum++) {
    const stepStartTime = Date.now();
    try {
      // 1. Take screenshot (or reuse from rate-limit retry)
      let screenshotBuffer: Buffer;
      let screenshotBase64: string;

      if (reuseScreenshot && cachedScreenshotBase64 && cachedScreenshotBuffer) {
        // Rate-limit retry — reuse previous screenshot (page hasn't changed)
        screenshotBuffer = cachedScreenshotBuffer;
        screenshotBase64 = cachedScreenshotBase64;
        reuseScreenshot = false;
        logger.info({ step: stepNum }, 'Reusing cached screenshot (rate-limit retry)');
      } else {
        // Normal path: take fresh screenshot (JPEG quality 55 — balances token cost
        // vs readability of small UI labels/buttons that caused misclicks at q40)
        screenshotBuffer = await page.screenshot({
          type: 'jpeg',
          quality: 55,
          fullPage: false,
        }) as Buffer;
        screenshotBase64 = screenshotBuffer.toString('base64');
        // Cache for potential rate-limit retry
        cachedScreenshotBuffer = screenshotBuffer;
        cachedScreenshotBase64 = screenshotBase64;
      }

      // Save screenshot to disk for audit trail
      lastScreenshotPath = await takeScreenshot(page, `agent-step-${stepNum}`);

      // 2. Stuck detection: check if last N screenshots are identical
      // Use 6 identical screenshots as the HARD threshold (gives up).
      // Use 3 identical screenshots as a SOFT threshold (injects rescue hint early).
      // Sprint 4: lowered from 8/5 — the agent rarely recovers after 6 identical
      // screenshots, so failing fast saves tokens and lets the supervisor retry sooner.
      const STUCK_THRESHOLD = 6;
      const SOFT_STUCK_THRESHOLD = 3;
      const hash = createHash('md5').update(screenshotBuffer).digest('hex');
      recentScreenshotHashes.push(hash);
      if (recentScreenshotHashes.length > STUCK_THRESHOLD) recentScreenshotHashes.shift();

      // Soft stuck: 3 identical screenshots → inject rescue hint proactively
      // (only if no rescue hint is already active)
      if (
        !activeRescueHint &&
        recentScreenshotHashes.length >= SOFT_STUCK_THRESHOLD
      ) {
        const lastN = recentScreenshotHashes.slice(-SOFT_STUCK_THRESHOLD);
        const allSame = lastN.every((h) => h === lastN[0]);
        if (allSame) {
          const pattern = detectStuckPattern(recentActions) ?? 'generic_stuck';
          const recentReasoningText = recentActions.slice(-3).map((a) => a.reasoning).join(' ');
          const hint = getRescueHint(pattern as Parameters<typeof getRescueHint>[0], recentReasoningText);
          if (hint) {
            activeRescueHint = hint;
            stepsAfterRescue = 0;
            lastStuckPattern = pattern;
            logger.warn(
              { step: stepNum, threshold: SOFT_STUCK_THRESHOLD, pattern },
              'Soft stuck detected — injecting rescue hint early',
            );
          }
        }
      }

      // Hard stuck: 6 identical screenshots → escalate or give up
      if (
        recentScreenshotHashes.length === STUCK_THRESHOLD &&
        recentScreenshotHashes.every((h) => h === recentScreenshotHashes[0])
      ) {
        // Hard stuck — 6 identical screenshots. Try dynamic doc lookup as last resort
        // before giving up, if we haven't already.
        if (!dynamicLookupAttempted) {
          logger.warn({ threshold: STUCK_THRESHOLD }, 'Hard stuck — trying dynamic doc lookup before giving up');
          dynamicLookupAttempted = true;
          const recentReasoning = recentActions.slice(-3).map((a) => a.reasoning).join(' ');
          const pattern = detectStuckPattern(recentActions) ?? 'generic_stuck';
          try {
            const dynamicHint = await escalateToDocLookup(
              pattern as Parameters<typeof escalateToDocLookup>[0],
              recentReasoning,
            );
            if (dynamicHint) {
              activeRescueHint = dynamicHint;
              stepsAfterRescue = 0;
              lastStuckPattern = pattern;
              recentScreenshotHashes.length = 0; // Reset to give the hint a chance
              logger.info({ hintLength: dynamicHint.length }, 'Injected dynamic doc hint — resuming agent');
              continue; // Give the agent another chance with the dynamic hint
            }
          } catch (err) {
            logger.warn(
              { error: errMsg(err) },
              'Dynamic doc lookup failed during hard stuck — giving up',
            );
          }
        }

        logger.warn({ threshold: STUCK_THRESHOLD }, 'Agent stuck — identical screenshots');
        return {
          success: false,
          summary: `Agent got stuck — page is not changing between actions (${STUCK_THRESHOLD} identical screenshots)`,
          steps,
          enrichedSteps,
          screenshotPath: lastScreenshotPath,
          tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          durationMs: Date.now() - startTime,
        };
      }

      // Track whether the page changed (for learning)
      const pageChanged = previousScreenshotHash !== undefined && hash !== previousScreenshotHash;
      previousScreenshotHash = hash;

      // 3. Extract page state
      const pageState = await extractPageState(page);
      const pageStateText = formatPageState(pageState);

      // 3.5 Auto-escape footer: if page state detects we're in the footer,
      // exit immediately WITHOUT burning a Claude API call. This saves tokens
      // and prevents the agent from wasting steps trying to work in the footer.
      // EXCEPTION: If the task description mentions footer-related keywords,
      // the user wants to edit the footer — do NOT auto-escape.
      // Guard: only auto-escape up to 2 times to avoid infinite loops.
      const isFooterTask = /\b(footer|site footer|hours|opening hours|business hours|contact info|address|phone number)\b/i.test(taskDescription);
      if (pageState.isEditingFooter && !isFooterTask && footerEscapeCount < 2) {
        footerEscapeCount++;
        logger.warn({ step: stepNum, escapeAttempt: footerEscapeCount }, 'Auto-escaping footer edit mode');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        const siteFrame = page.frame({ name: 'sqs-site-frame' });
        if (siteFrame) {
          await siteFrame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        }
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await page.waitForTimeout(500);
        // Don't count this as a step — decrement and retry
        stepNum--;
        continue;
      } else if (!pageState.isEditingFooter) {
        // Reset footer escape counter when we're back in page content
        footerEscapeCount = 0;
      }

      // 4. Build step message
      const previousResult = steps.length > 0
        ? `${steps[steps.length - 1].result.success ? '✅' : '❌'} ${steps[steps.length - 1].result.message}`
        : undefined;

      // Build the task description — inject rescue hint if the agent is stuck
      let effectiveTaskDescription = taskDescription;
      if (activeRescueHint) {
        effectiveTaskDescription = taskDescription + '\n\n' + activeRescueHint;
        stepsAfterRescue++;
        // After 4 steps with static hint and still stuck → escalate to dynamic doc lookup
        if (stepsAfterRescue > 4) {
          if (!dynamicLookupAttempted && lastStuckPattern) {
            // Escalate: fetch real Squarespace support docs via Haiku
            dynamicLookupAttempted = true;
            const recentReasoning = recentActions
              .slice(-3)
              .map((a) => a.reasoning)
              .join(' ');
            logger.info(
              { step: stepNum, pattern: lastStuckPattern },
              'Static rescue hint expired — escalating to dynamic Squarespace doc lookup',
            );
            try {
              const dynamicHint = await escalateToDocLookup(
                lastStuckPattern as Parameters<typeof escalateToDocLookup>[0],
                recentReasoning,
              );
              if (dynamicHint) {
                activeRescueHint = dynamicHint;
                stepsAfterRescue = 0; // Reset counter for the dynamic hint
                effectiveTaskDescription = taskDescription + '\n\n' + dynamicHint;
                logger.info(
                  { step: stepNum, hintLength: dynamicHint.length },
                  'Dynamic Squarespace doc hint injected',
                );
              } else {
                // Dynamic lookup failed too — clear hint and let agent proceed unaided
                activeRescueHint = undefined;
                stepsAfterRescue = 0;
              }
            } catch (err) {
              logger.warn(
                { error: errMsg(err) },
                'Dynamic doc lookup failed — clearing rescue hint',
              );
              activeRescueHint = undefined;
              stepsAfterRescue = 0;
            }
          } else {
            // Already tried dynamic lookup, or no pattern — clear and move on
            activeRescueHint = undefined;
            stepsAfterRescue = 0;
          }
        }
      }

      const stepMessage = buildStepMessage({
        screenshotBase64,
        taskDescription: effectiveTaskDescription,
        stepNumber: stepNum,
        maxSteps,
        pageState: pageStateText,
        previousResult,
        referenceImageBase64: stepNum === 1 ? options?.referenceImageBase64 : undefined,
      });

      // Add to conversation history
      conversationHistory.push(stepMessage);

      // Truncate conversation history to control token usage.
      // Keep the FIRST exchange (contains the task description/content plan) plus
      // the last 8 exchanges for recent context. Generate a brief summary of the
      // discarded middle to bridge the context gap.
      if (conversationHistory.length > 18) {
        const first = conversationHistory.slice(0, 2); // first user msg + first assistant response
        const middle = conversationHistory.slice(2, -8);
        const recent = conversationHistory.slice(-8);

        // Build a concise summary of what was accomplished in the discarded steps
        let bridgeSummary = '';
        try {
          const middleText = middle.map((m, i) => {
            const role = (m as { role: string }).role;
            const content = (m as { content: unknown }).content;
            const text = typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? (content as Array<{ type: string; text?: string }>)
                    .filter(b => b.type === 'text')
                    .map(b => b.text)
                    .join(' ')
                : '';
            // Only include text content (skip image blocks), truncate each to 300 chars
            return text ? `[${role} ${i}] ${text.slice(0, 300)}` : '';
          }).filter(Boolean).join('\n');

          if (middleText.length > 100) {
            const summaryResp = await getAnthropicClient().messages.create({
              model: MODEL_HAIKU,
              max_tokens: 256,
              messages: [{
                role: 'user',
                content: `Summarize what this browser automation agent accomplished in these steps. List actions taken and any sections/elements edited. Be concise (3-5 bullet points):\n\n${middleText.slice(0, 4000)}`,
              }],
            });
            const summaryBlock = summaryResp.content.find(b => b.type === 'text');
            if (summaryBlock && summaryBlock.type === 'text') {
              bridgeSummary = summaryBlock.text;
            }
          }
        } catch (err) {
          logger.warn({ error: errMsg(err) }, 'Failed to generate truncation summary (non-blocking)');
        }

        conversationHistory.length = 0;
        if (bridgeSummary) {
          // Inject bridge as a user message so the agent knows what happened before.
          // Must match StepMessage format (content is an array of blocks).
          const bridgeMsg = {
            role: 'user' as const,
            content: [{
              type: 'text' as const,
              text: `[CONTEXT BRIDGE — the following summarizes ${middle.length} earlier messages that were trimmed for context limits]\n\n${bridgeSummary}\n\n[END CONTEXT BRIDGE — continue with the task from where you left off]`,
            }],
          };
          conversationHistory.push(...first, bridgeMsg, ...recent);
        } else {
          conversationHistory.push(...first, ...recent);
        }
        logger.info({ discarded: middle.length, bridgeSummary: !!bridgeSummary }, 'Conversation history truncated');
      }

      // 5. Call Claude API
      if (verbose) {
        console.log(`\n  Step ${stepNum}/${maxSteps} — calling Claude...`);
      }

      const response = await getAnthropicClient().messages.create({
        model,
        max_tokens: 1536,
        system: systemPrompt as Anthropic.TextBlockParam[],
        messages: conversationHistory as Anthropic.MessageParam[],
      });

      // Track token usage (including cache metrics)
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      // Log prompt cache performance (available on Anthropic responses)
      const usageAny = response.usage as unknown as Record<string, unknown>;
      const cacheCreation = usageAny.cache_creation_input_tokens as number | undefined;
      const cacheRead = usageAny.cache_read_input_tokens as number | undefined;
      if (cacheCreation || cacheRead) {
        logger.info(
          { step: stepNum, cacheCreation, cacheRead, inputTokens: response.usage.input_tokens },
          'Prompt cache metrics',
        );
      }

      // 6. Parse response
      const textBlock = response.content.find((b) => b.type === 'text');
      const responseText = textBlock?.type === 'text' ? textBlock.text : '';

      // Add assistant response to history
      conversationHistory.push({ role: 'assistant', content: responseText });

      // Extract reasoning and action
      const action = parseAgentAction(responseText);

      if (!action) {
        logger.warn({ responseText: responseText.substring(0, 200) }, 'Could not parse agent action');
        steps.push({
          stepNumber: stepNum,
          reasoning: 'Failed to parse action from response',
          action: { action: 'error', message: 'Unparseable response' },
          result: { success: false, message: 'Could not parse action JSON from Claude response' },
          screenshotPath: lastScreenshotPath,
        });
        continue; // Try next step
      }

      // Extract reasoning from response
      let reasoning = '';
      try {
        const parsed = JSON.parse(responseText.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
        reasoning = parsed.reasoning || '';
      } catch {
        // Try to find reasoning before the JSON
        const beforeJson = responseText.split('{')[0];
        reasoning = beforeJson.trim();
      }

      if (verbose) {
        console.log(`  Reasoning: ${reasoning.substring(0, 100)}${reasoning.length > 100 ? '...' : ''}`);
        console.log(`  Action: ${action.action}${action.action === 'done' ? ` — ${(action as { summary: string }).summary}` : ''}`);
      }

      // 7. Check for terminal actions
      if (action.action === 'done') {
        const summary = (action as { action: 'done'; summary: string }).summary;

        // ── One-shot verification gate ──────────────────────────────────
        // First "done": challenge the agent to verify its work is visible.
        // Second "done": accept and return. Resets on any non-done action.
        // Cost: 1 extra Sonnet call (~$0.005-0.01) per task.
        if (!doneVerified) {
          doneVerified = true;
          logger.info({ step: stepNum, summary }, 'First "done" — issuing verification challenge');

          // Take a fresh screenshot for the verification check
          const verifyScreenshotBuffer = await page.screenshot({
            type: 'jpeg',
            quality: 55,
            fullPage: false,
          }) as Buffer;
          const verifyScreenshotBase64 = verifyScreenshotBuffer.toString('base64');
          lastScreenshotPath = await takeScreenshot(page, `agent-step-${stepNum}-verify`);

          // Get fresh page state
          const verifyPageState = await extractPageState(page);
          const verifyPageStateText = formatPageState(verifyPageState);

          // Record this as a step (verification challenge, not final done)
          const verifyResult: ActionResult = { success: true, message: `Verification challenge issued — agent said done: "${summary}"` };
          steps.push({
            stepNumber: stepNum,
            reasoning,
            action,
            result: verifyResult,
            screenshotPath: lastScreenshotPath,
          });
          enrichedSteps.push({
            stepNumber: stepNum, timestampMs: stepStartTime, durationMs: Date.now() - stepStartTime,
            reasoning, action, result: verifyResult,
            pageUrl: verifyPageState.url, openPanels: verifyPageState.openPanels,
            screenshotHash: hash, pageChanged,
          });

          // Push assistant response (the "done" attempt) and verification challenge into history
          // The assistant response was already pushed above (line ~458)
          const verificationMessage: StepMessage = {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: verifyScreenshotBase64 },
              },
              {
                type: 'text',
                text: `## Verification Check (Step ${stepNum + 1}/${maxSteps})

You said "done" with summary: "${summary}"

**Before I accept, verify your work using this fresh screenshot:**

1. **Editor panels:** Are any editor panels/dialogs still open? If yes, close them first (press Escape or click Done/Save) so the rendered page is visible.
2. **Content visibility:** Is the content you edited actually visible in this screenshot? If it's behind a tab (menu tabs like "Kids Menu", "Dinner", etc.), inside an accordion, or on a gallery slide — **click that tab/section NOW** to make it visible.
3. **Visual confirmation:** Does the content look correct?

${verifyPageStateText}

**If everything checks out**, issue "done" again with a summary describing what you SEE on the rendered page.
**If something needs fixing** (editor still open, wrong tab showing, content not visible), take the corrective action instead.`,
              },
            ],
          };
          conversationHistory.push(verificationMessage);

          emitStep({
            stepNumber: stepNum, maxSteps, action: 'verify',
            reasoning: 'Verification challenge — confirming edit is visible',
            success: true, screenshotPath: lastScreenshotPath, done: false,
          });

          continue; // Go to next iteration — agent will respond to verification challenge
        }

        // ── Second "done" (verified) — accept and return ────────────────
        const doneResult: ActionResult = { success: true, message: summary };
        steps.push({
          stepNumber: stepNum,
          reasoning,
          action,
          result: doneResult,
          screenshotPath: lastScreenshotPath,
        });
        enrichedSteps.push({
          stepNumber: stepNum, timestampMs: stepStartTime, durationMs: Date.now() - stepStartTime,
          reasoning, action, result: doneResult,
          pageUrl: pageState.url, openPanels: pageState.openPanels,
          screenshotHash: hash, pageChanged,
        });

        logger.info({ summary, steps: stepNum, inputTokens: totalInputTokens, outputTokens: totalOutputTokens }, 'Agent completed task (verified)');

        emitStep({
          stepNumber: stepNum, maxSteps, action: 'done',
          reasoning: reasoning.substring(0, 200), success: true,
          screenshotPath: lastScreenshotPath, done: true,
        });

        return {
          success: true,
          summary,
          steps,
          enrichedSteps,
          screenshotPath: lastScreenshotPath,
          tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          durationMs: Date.now() - startTime,
        };
      }

      if (action.action === 'error') {
        const errorMsg = (action as { action: 'error'; message: string }).message;
        const errResult: ActionResult = { success: false, message: errorMsg };
        steps.push({
          stepNumber: stepNum,
          reasoning,
          action,
          result: errResult,
          screenshotPath: lastScreenshotPath,
        });
        enrichedSteps.push({
          stepNumber: stepNum, timestampMs: stepStartTime, durationMs: Date.now() - stepStartTime,
          reasoning, action, result: errResult,
          pageUrl: pageState.url, openPanels: pageState.openPanels,
          screenshotHash: hash, pageChanged,
        });

        logger.warn({ errorMsg, steps: stepNum }, 'Agent reported error');

        emitStep({
          stepNumber: stepNum, maxSteps, action: 'error',
          reasoning: reasoning.substring(0, 200), success: false,
          screenshotPath: lastScreenshotPath, done: true,
        });

        return {
          success: false,
          summary: errorMsg,
          steps,
          enrichedSteps,
          screenshotPath: lastScreenshotPath,
          tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          durationMs: Date.now() - startTime,
        };
      }

      // Reset verification gate if agent takes a non-done action
      // (it discovered more work was needed after the verification challenge)
      if (doneVerified) {
        logger.info({ step: stepNum, action: action.action }, 'Agent took action after verification challenge — resetting doneVerified');
        doneVerified = false;
      }

      // 8. Execute the action
      const result = await executeAgentAction(page, action);

      steps.push({
        stepNumber: stepNum,
        reasoning,
        action,
        result,
        screenshotPath: lastScreenshotPath,
      });

      // Build enriched step for learning extraction
      const selectorUsed = extractSelectorFromAction(action);
      const selectorActions = ['click', 'dblclick', 'clickInIframe', 'dblclickInIframe', 'jsClick', 'fill'];
      enrichedSteps.push({
        stepNumber: stepNum,
        timestampMs: stepStartTime,
        durationMs: Date.now() - stepStartTime,
        reasoning,
        action,
        result,
        pageUrl: pageState.url,
        openPanels: pageState.openPanels,
        screenshotHash: hash,
        selectorUsed,
        selectorWorked: selectorUsed && selectorActions.includes(action.action) ? result.success : undefined,
        pageChanged,
      });

      if (verbose) {
        console.log(`  Result: ${result.success ? '✅' : '❌'} ${result.message}`);
      }

      logger.info(
        { step: stepNum, action: action.action, success: result.success, message: result.message },
        'Agent step completed',
      );

      emitStep({
        stepNumber: stepNum, maxSteps, action: action.action,
        reasoning: reasoning.substring(0, 200), success: result.success,
        screenshotPath: lastScreenshotPath, done: false,
      });

      // ── Circuit breaker: abort on cascading failures ─────────────────
      // If N consecutive actions all fail, the agent is likely in an
      // unrecoverable state (wrong page, broken editor, auth expired).
      // Abort early to save tokens and let the supervisor handle it.
      if (!result.success) {
        consecutiveFailures++;
        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          const msg = `Circuit breaker tripped — ${CIRCUIT_BREAKER_THRESHOLD} consecutive action failures`;
          logger.error({ step: stepNum, consecutiveFailures }, msg);

          emitStep({
            stepNumber: stepNum, maxSteps, action: 'circuit_breaker',
            reasoning: msg, success: false,
            screenshotPath: lastScreenshotPath, done: true,
          });

          return {
            success: false,
            summary: msg,
            steps,
            enrichedSteps,
            screenshotPath: lastScreenshotPath,
            tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
            durationMs: Date.now() - startTime,
          };
        }
      } else {
        consecutiveFailures = 0; // Reset on any successful action
      }

      // ── Action-based stuck detection ─────────────────────────────────
      // Track recent actions and check for repetitive patterns.
      // If stuck, inject a rescue hint with specific Squarespace advice.
      recentActions.push({
        action: action.action,
        selector: extractSelectorFromAction(action),
        reasoning,
        success: result.success,
        pageChanged,
      });
      if (recentActions.length > 6) recentActions.shift();

      const stuckPattern = detectStuckPattern(recentActions);
      if (stuckPattern && !activeRescueHint) {
        lastStuckPattern = stuckPattern;
        const hint = getRescueHint(stuckPattern, reasoning);
        if (hint) {
          activeRescueHint = hint;
          stepsAfterRescue = 0;
          logger.warn(
            { step: stepNum, pattern: stuckPattern, hintLength: hint.length },
            'Stuck pattern detected — injecting rescue hint',
          );
        }
      } else if (!stuckPattern && activeRescueHint && stepsAfterRescue > 0) {
        // Agent seems to have recovered — clear the rescue hint
        activeRescueHint = undefined;
        stepsAfterRescue = 0;
        lastStuckPattern = undefined;
        dynamicLookupAttempted = false; // Reset so next stuck episode can escalate
        logger.info({ step: stepNum }, 'Agent recovered from stuck state');
      }
    } catch (err) {
      const errorMessage = errMsg(err);

      // ── Rate limit (429) backoff ──────────────────────────────────

      // When the Anthropic API returns 429 (rate limit exceeded), wait
      // with exponential backoff and RETRY the same step instead of
      // consuming the step budget. Without this, every subsequent step
      // would also fail with 429, wasting the entire run.
      if (errorMessage.includes('429') || errorMessage.toLowerCase().includes('rate limit')) {
        const MAX_RATE_RETRIES = 4;
        let rateLimitResolved = false;

        for (let attempt = 1; attempt <= MAX_RATE_RETRIES; attempt++) {
          const backoffMs = Math.min(15000 * Math.pow(2, attempt - 1), 120000); // 15s, 30s, 60s, 120s
          logger.warn(
            { step: stepNum, attempt, backoffMs, error: errorMessage },
            `Rate limited (429) — waiting ${backoffMs / 1000}s before retry`,
          );
          await page.waitForTimeout(backoffMs);

          try {
            // Lightweight probe to see if rate limit has lifted.
            // Uses Haiku with minimal tokens — costs ~$0.0001 per probe.
            await getAnthropicClient().messages.create({
              model: MODEL_HAIKU,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            });
            rateLimitResolved = true;
            logger.info({ attempt }, 'Rate limit probe succeeded — resuming');
            break;
          } catch (retryErr) {
            const retryMsg = errMsg(retryErr);
            if (retryMsg.includes('429') || retryMsg.toLowerCase().includes('rate limit')) {
              logger.warn({ attempt, backoffMs }, 'Still rate limited, backing off further');
              continue;
            }
            // Different error — rate limit is likely cleared, just a different issue
            rateLimitResolved = true;
            break;
          }
        }

        if (rateLimitResolved) {
          // Retry this step — decrement so the for-loop re-runs at the same stepNum.
          // Reuse the cached screenshot since the page hasn't changed during the wait.
          stepNum--;
          reuseScreenshot = true;
          logger.info({ step: stepNum + 1 }, 'Rate limit cleared — retrying step (reusing screenshot)');
          continue;
        }

        // Exhausted retries — log and continue to next step
        logger.error({ step: stepNum, retries: MAX_RATE_RETRIES }, 'Rate limit persists after max retries');
      }

      logger.error({ step: stepNum, ...errContext(err) }, 'Agent step error');

      steps.push({
        stepNumber: stepNum,
        reasoning: 'Step threw an exception',
        action: { action: 'error', message: errorMessage },
        result: { success: false, message: errorMessage },
        screenshotPath: lastScreenshotPath,
      });

      // Don't break — let the agent try to recover
    }
  }

  // Max steps reached
  const summary = `Reached maximum steps (${maxSteps}) without completing the task`;
  logger.warn({ maxSteps, totalSteps: steps.length }, summary);

  emitStep({
    stepNumber: maxSteps, maxSteps, action: 'max_steps',
    reasoning: summary, success: false,
    screenshotPath: lastScreenshotPath, done: true,
  });

  return {
    success: false,
    summary,
    steps,
    enrichedSteps,
    screenshotPath: lastScreenshotPath,
    tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    durationMs: Date.now() - startTime,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract the CSS selector used in an agent action (if any). */
function extractSelectorFromAction(action: AgentAction): string | undefined {
  if ('selector' in action && typeof action.selector === 'string') {
    return action.selector;
  }
  return undefined;
}
