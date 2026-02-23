/**
 * Learning Agent — extracts reusable patterns from browser agent executions.
 *
 * Runs AFTER every task (whether success or failure). Analyzes the browser
 * agent's step history and supervisor verdict to extract concrete learnings
 * about the Squarespace editor.
 *
 * Enhanced features:
 * - Uses full EnrichedStep data (no truncation) when available
 * - Extracts positive AND negative learnings
 * - Auto-detects negative patterns from failed steps (no LLM needed)
 * - Detects multi-step workflow sequences (no LLM needed)
 * - Requests 0-5 learnings per task (up from 0-3)
 *
 * Uses Claude Haiku for cost efficiency (~$0.003 per extraction).
 * Does NOT modify code — only writes text patterns to the learnings DB table.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { BrowserAgentResult, EnrichedStep } from '../automation/browser-agent.js';
import type { SupervisorVerdict } from './types.js';
import { upsertLearning, type CreateLearningInput, type LearningCategory } from '../db/learnings.js';
import { logger } from '../utils/logger.js';
import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_HAIKU } from '../config/models.js';
import { errMsg } from '../utils/errors.js';

// ─── Public API ──────────────────────────────────────────────────────────────

export interface LearningContext {
  taskId: string;
  taskDescription: string;
  siteId: string;
  targetPage?: string;
  agentResult: BrowserAgentResult;
  supervisorVerdict?: SupervisorVerdict;
}

export interface LearningExtractionResult {
  learningsExtracted: number;
  tokenUsage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

/**
 * Analyze a completed task execution and extract reusable learnings.
 * Designed to be called fire-and-forget (non-blocking).
 */
export async function extractLearnings(ctx: LearningContext): Promise<LearningExtractionResult> {
  const start = Date.now();

  try {
    const enrichedSteps = ctx.agentResult.enrichedSteps;
    const legacySteps = ctx.agentResult.steps;

    // Skip extraction if there are no steps to analyze
    if (enrichedSteps.length === 0 && legacySteps.length === 0) {
      return { learningsExtracted: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 };
    }

    // Emit agent activity — Learning Agent started
    const { dashboardEvents } = await import('../services/dashboard-events.js');
    dashboardEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: { agent: 'learning', status: 'started', message: 'Analyzing execution for reusable patterns...', taskId: ctx.taskId },
      timestamp: new Date().toISOString(),
    });

    // 1. Auto-extract negative learnings from failed steps (code-only, no LLM)
    const autoNegatives = extractAutoNegativeLearnings(enrichedSteps, !ctx.agentResult.success);

    // 2. Detect multi-step sequences from successful runs (code-only, no LLM)
    const sequences = detectSequences(enrichedSteps);

    // 3. Detect Content Save API usage patterns (code-only, no LLM)
    const apiLearnings = extractApiUsageLearnings(enrichedSteps);

    // 4. LLM-based extraction (Haiku)
    const prompt = buildExtractionPrompt(ctx);

    const response = await getAnthropicClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 1536,
      messages: [{ role: 'user', content: prompt }],
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const rawLearnings = parseLearnings(text);

    // Combine: LLM learnings + auto-negatives + sequences + API patterns
    const allLearnings: CreateLearningInput[] = [...rawLearnings, ...autoNegatives, ...sequences, ...apiLearnings];
    let count = 0;

    for (const learning of allLearnings) {
      try {
        upsertLearning({
          ...learning,
          sourceTaskId: ctx.taskId,
          siteId: learning.siteId ?? ctx.siteId,
          pageContext: learning.pageContext ?? ctx.targetPage,
        });
        count++;
      } catch (err) {
        logger.warn(
          { error: errMsg(err), patternKey: learning.patternKey },
          'Failed to store learning',
        );
      }
    }

    dashboardEvents.emit('dashboard', {
      type: 'agent_activity' as const,
      data: {
        agent: 'learning',
        status: 'completed',
        message: `Extracted ${count} pattern(s) (${rawLearnings.length} LLM + ${autoNegatives.length} auto + ${sequences.length} sequences + ${apiLearnings.length} API)`,
        taskId: ctx.taskId,
        detail: { learningsExtracted: count },
      },
      timestamp: new Date().toISOString(),
    });

    logger.info(
      {
        taskId: ctx.taskId,
        learningsExtracted: count,
        llmLearnings: rawLearnings.length,
        autoNegatives: autoNegatives.length,
        sequences: sequences.length,
        apiLearnings: apiLearnings.length,
        inputTokens,
        outputTokens,
      },
      'Learning agent: extraction complete',
    );

    return {
      learningsExtracted: count,
      tokenUsage: { inputTokens, outputTokens },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    // Emit learning agent failure (dynamic import may have already happened above,
    // but if extraction failed before it, we need a fresh import)
    try {
      const { dashboardEvents: evts } = await import('../services/dashboard-events.js');
      evts.emit('dashboard', {
        type: 'agent_activity' as const,
        data: { agent: 'learning', status: 'failed', message: `Learning extraction failed: ${errMsg(err).substring(0, 80)}`, taskId: ctx.taskId },
        timestamp: new Date().toISOString(),
      });
    } catch { /* swallow — never fail the error handler */ }
    logger.error({ error: errMsg(err), taskId: ctx.taskId }, 'Learning agent failed');
    return {
      learningsExtracted: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      durationMs: Date.now() - start,
    };
  }
}

// ─── Prompt Builder ─────────────────────────────────────────────────────────

function buildExtractionPrompt(ctx: LearningContext): string {
  const enrichedSteps = ctx.agentResult.enrichedSteps;
  const hasEnrichedSteps = enrichedSteps.length > 0;

  // Use enriched steps when available (full data), fall back to legacy steps (truncated)
  const stepSummary = hasEnrichedSteps
    ? enrichedSteps
        .map((s) => {
          const actionJson = JSON.stringify(s.action);
          const panelStr = s.openPanels.length > 0 ? ` [panels: ${s.openPanels.join(', ')}]` : '';
          const changeStr = s.pageChanged ? ' [page changed]' : ' [no visible change]';
          const selectorStr = s.selectorUsed ? ` selector="${s.selectorUsed}" (${s.selectorWorked ? 'worked' : 'failed'})` : '';
          return `Step ${s.stepNumber} (${s.durationMs}ms): ${s.reasoning}\n  Action: ${actionJson}${selectorStr}\n  Result: ${s.result.success ? 'OK' : 'FAIL'}: ${s.result.message}${panelStr}${changeStr}`;
        })
        .join('\n\n')
    : ctx.agentResult.steps
        .map((s) => {
          const actionStr = JSON.stringify(s.action).substring(0, 150);
          return `Step ${s.stepNumber}: [${s.result.success ? 'OK' : 'FAIL'}] ${s.reasoning.substring(0, 100)} → ${actionStr} → ${s.result.message.substring(0, 80)}`;
        })
        .join('\n');

  const outcome = ctx.agentResult.success ? 'SUCCESS' : 'FAILURE';
  const supervisorInfo = ctx.supervisorVerdict
    ? `\nSupervisor verdict: ${ctx.supervisorVerdict.status} (confidence: ${ctx.supervisorVerdict.confidence})\n${ctx.supervisorVerdict.diagnosis ? `Supervisor diagnosis: ${ctx.supervisorVerdict.diagnosis}` : ''}`
    : '';

  return `You are analyzing a browser automation session on the Squarespace editor to extract REUSABLE patterns.

## Task Context
Site: ${ctx.siteId}
Page: ${ctx.targetPage ?? 'unknown'}
Task: ${ctx.taskDescription.substring(0, 500)}
Outcome: ${outcome}
Steps taken: ${ctx.agentResult.steps.length}
${supervisorInfo}

## Step Log
${stepSummary}

## What to Extract

Analyze the steps above and extract 0-5 reusable learnings. Focus on:

1. **selector_discovery**: CSS selectors that WORKED or FAILED in the Squarespace editor
   - e.g., "The section edit button uses aria-label='Edit Section', not data-test='edit-section'"
2. **interaction_pattern**: Multi-step click sequences that worked
   - e.g., "To edit a text block: clickInIframe on the text → wait 500ms → dblclickInIframe to enter edit mode"
3. **failure_recovery**: What went wrong and what fixed it
   - e.g., "When the overlay blocks clicks, use clickInIframe instead of click"
4. **editor_workflow**: General Squarespace editor behaviors learned
   - e.g., "After adding a text block, the cursor is already focused — type immediately without clicking"
5. **site_specific**: Patterns unique to this site's structure
   - e.g., "This site's homepage has a hero section, then a menu preview, then a footer"
6. **editor_workflow**: Content Save API fast path usage
   - Check if any editTextBlock steps used the Content Save API (look for "via Content Save API" in results)
   - Note whether it succeeded or fell back to UI automation ("API fast path unavailable"), and what conditions affected availability
7. **negative_pattern**: Things that FAILED and should NOT be repeated
   - e.g., "Do NOT click the Design panel icon when trying to add content — it opens styling options"
   - e.g., "The selector '.menu-item-delete' does not exist — use the trash icon in the menu editor instead"
   - Set "polarity": "negative" for these learnings

Rules:
- Only extract CONCRETE, ACTIONABLE patterns — not vague observations
- Each learning must include a specific "prompt_tip" that could be injected into a system prompt
- If the task succeeded cleanly with no issues, you may return 0 learnings (nothing new to learn)
- If the task FAILED, focus on what SHOULD have been done differently and what to AVOID
- Include specific CSS selectors, action sequences, or timing if relevant
- Pay special attention to steps marked [no visible change] — these often indicate wasted actions
- Mark whether the learning is universal (any Squarespace site) or site-specific

Respond with JSON only:
{
  "learnings": [
    {
      "category": "selector_discovery",
      "patternKey": "section-edit-button-aria-label",
      "description": "The section edit button in Squarespace Fluid Engine uses aria-label='Edit Section'",
      "promptTip": "To enter section edit mode, click the button with selector [aria-label='Edit Section'] — do NOT look for a data-test attribute.",
      "selectors": ["[aria-label='Edit Section']"],
      "confidence": 0.7,
      "polarity": "positive",
      "isUniversal": true
    },
    {
      "category": "negative_pattern",
      "patternKey": "dont-click-design-panel",
      "description": "Clicking the design icon opens styling options, not content editing",
      "promptTip": "Do NOT click the design/styling icon (gear/paintbrush) when trying to add or edit content. Use Edit Section instead.",
      "confidence": 0.7,
      "polarity": "negative",
      "isUniversal": true
    }
  ]
}

Return {"learnings": []} if there is nothing new worth recording.`;
}

// ─── Response Parser ────────────────────────────────────────────────────────

function parseLearnings(text: string): CreateLearningInput[] {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    const parsed = JSON.parse(jsonStr) as { learnings?: unknown[] };

    if (!Array.isArray(parsed.learnings)) return [];

    return parsed.learnings
      .filter(
        (l): l is Record<string, unknown> =>
          typeof l === 'object' &&
          l !== null &&
          typeof (l as Record<string, unknown>).patternKey === 'string' &&
          typeof (l as Record<string, unknown>).promptTip === 'string',
      )
      .map((l) => ({
        category: (l.category as LearningCategory) ?? 'editor_workflow',
        patternKey: l.patternKey as string,
        description: (l.description as string) ?? '',
        promptTip: l.promptTip as string,
        selectors: Array.isArray(l.selectors) ? (l.selectors as string[]) : undefined,
        confidence: typeof l.confidence === 'number' ? (l.confidence as number) : 0.5,
        polarity: (l.polarity === 'negative' ? 'negative' : 'positive') as 'positive' | 'negative',
        // If isUniversal is true, siteId stays undefined (= NULL in DB = universal)
        siteId: l.isUniversal ? undefined : undefined, // siteId is set in extractLearnings() from context
        context: typeof l.context === 'object' ? (l.context as Record<string, unknown>) : undefined,
      }));
  } catch {
    logger.warn('Learning agent: could not parse extraction response');
    return [];
  }
}

// ─── Auto-Negative Extraction (code-only, no LLM) ───────────────────────────

/**
 * Scan enriched steps for repeated failures and automatically generate
 * negative learnings. Only runs when the task FAILED.
 */
function extractAutoNegativeLearnings(
  enrichedSteps: EnrichedStep[],
  taskFailed: boolean,
): CreateLearningInput[] {
  if (!taskFailed || enrichedSteps.length === 0) return [];

  const negatives: CreateLearningInput[] = [];

  // 1. Find selectors that failed multiple times
  const selectorFailures = new Map<string, number>();
  for (const step of enrichedSteps) {
    if (step.selectorUsed && step.selectorWorked === false) {
      selectorFailures.set(step.selectorUsed, (selectorFailures.get(step.selectorUsed) ?? 0) + 1);
    }
  }

  for (const [selector, count] of selectorFailures) {
    if (count >= 2) {
      negatives.push({
        category: 'selector_discovery',
        patternKey: `bad-selector-${selector.substring(0, 60)}`,
        description: `Selector "${selector}" failed ${count} times during a task`,
        promptTip: `The selector "${selector}" does not work — do not use it. Find an alternative.`,
        polarity: 'negative',
        confidence: 0.6,
        selectors: [selector],
      });
    }
  }

  // 2. Detect stuck sequences (3+ consecutive steps with no page change)
  let noChangeRun = 0;
  let stuckStartStep: EnrichedStep | undefined;
  for (const step of enrichedSteps) {
    if (!step.pageChanged && step.action.action !== 'done' && step.action.action !== 'error') {
      if (noChangeRun === 0) stuckStartStep = step;
      noChangeRun++;
    } else {
      if (noChangeRun >= 3 && stuckStartStep) {
        const actionTypes = enrichedSteps
          .slice(stuckStartStep.stepNumber - 1, stuckStartStep.stepNumber - 1 + noChangeRun)
          .map((s) => s.action.action)
          .join(', ');
        negatives.push({
          category: 'negative_pattern',
          patternKey: `stuck-${actionTypes.substring(0, 40)}-step${stuckStartStep.stepNumber}`,
          description: `${noChangeRun} consecutive actions (${actionTypes}) produced no visible change`,
          promptTip: `Avoid repeatedly doing "${actionTypes}" without checking if the page changes — this sequence was ineffective.`,
          polarity: 'negative',
          confidence: 0.5,
        });
      }
      noChangeRun = 0;
      stuckStartStep = undefined;
    }
  }

  // Check final run
  if (noChangeRun >= 3 && stuckStartStep) {
    const actionTypes = enrichedSteps
      .slice(stuckStartStep.stepNumber - 1, stuckStartStep.stepNumber - 1 + noChangeRun)
      .map((s) => s.action.action)
      .join(', ');
    negatives.push({
      category: 'negative_pattern',
      patternKey: `stuck-${actionTypes.substring(0, 40)}-step${stuckStartStep.stepNumber}`,
      description: `${noChangeRun} consecutive actions (${actionTypes}) produced no visible change`,
      promptTip: `Avoid repeatedly doing "${actionTypes}" without checking if the page changes — this sequence was ineffective.`,
      polarity: 'negative',
      confidence: 0.5,
    });
  }

  if (negatives.length > 0) {
    logger.info({ count: negatives.length }, 'Auto-extracted negative learnings from failed task');
  }

  return negatives;
}

// ─── API Usage Detection (code-only, no LLM) ─────────────────────────────────

/**
 * Detect Content Save API usage patterns from step results.
 * Runs on ALL tasks (success or failure) since API availability is worth tracking.
 */
function extractApiUsageLearnings(enrichedSteps: EnrichedStep[]): CreateLearningInput[] {
  if (enrichedSteps.length === 0) return [];

  const learnings: CreateLearningInput[] = [];
  let apiSuccessCount = 0;
  let apiFallbackCount = 0;
  let apiStaleCount = 0;

  for (const step of enrichedSteps) {
    const msg = step.result.message;

    if (msg.includes('via Content Save API')) {
      apiSuccessCount++;
    } else if (msg.includes('API fast path unavailable')) {
      apiFallbackCount++;
    }

    // Detect stale session/crumb errors from API attempts
    if ((msg.includes('crumb') && msg.includes('stale')) || msg.includes('session expired')) {
      apiStaleCount++;
    }
  }

  // Positive: API fast path worked
  if (apiSuccessCount > 0) {
    learnings.push({
      category: 'editor_workflow',
      patternKey: 'content-save-api-success',
      description: `Content Save API fast path succeeded for ${apiSuccessCount} editTextBlock action(s)`,
      promptTip: 'editTextBlock can use the Content Save API for ~500ms text updates instead of full UI automation. This path is available when the session crumb is valid.',
      confidence: 0.8,
      polarity: 'positive',
    });
  }

  // Informational: API unavailable, fell back to UI
  if (apiFallbackCount > 0 && apiSuccessCount === 0) {
    learnings.push({
      category: 'editor_workflow',
      patternKey: 'content-save-api-fallback',
      description: `Content Save API was unavailable for ${apiFallbackCount} step(s) — fell back to UI automation`,
      promptTip: 'The Content Save API fast path was not available (possibly no valid crumb/session). UI automation fallback worked but is slower.',
      confidence: 0.5,
      polarity: 'positive',
    });
  }

  // Negative: stale crumb/session caused API failures
  if (apiStaleCount > 0) {
    learnings.push({
      category: 'failure_recovery',
      patternKey: 'content-save-api-stale-session',
      description: `Content Save API failed ${apiStaleCount} time(s) due to stale session/crumb`,
      promptTip: 'The Content Save API crumb can go stale during long sessions. If API edits fail with auth errors, the UI automation fallback will handle it.',
      confidence: 0.6,
      polarity: 'negative',
    });
  }

  if (learnings.length > 0) {
    logger.info({ apiSuccessCount, apiFallbackCount, apiStaleCount }, 'Detected Content Save API usage patterns');
  }

  return learnings;
}

// ─── Sequence Detection (code-only, no LLM) ─────────────────────────────────

/**
 * Detect successful multi-step workflow sequences from enriched steps.
 * Looks for runs of 3-7 consecutive successful steps where at least one
 * changed the page — these likely represent a meaningful UI workflow.
 */
function detectSequences(enrichedSteps: EnrichedStep[]): CreateLearningInput[] {
  if (enrichedSteps.length < 3) return [];

  const sequences: CreateLearningInput[] = [];
  const seenKeys = new Set<string>();

  for (let windowSize = 3; windowSize <= Math.min(7, enrichedSteps.length); windowSize++) {
    for (let i = 0; i <= enrichedSteps.length - windowSize; i++) {
      const window = enrichedSteps.slice(i, i + windowSize);

      // All steps must be successful
      if (!window.every((s) => s.result.success)) continue;

      // At least one step must change the page
      if (!window.some((s) => s.pageChanged)) continue;

      // Skip if window ends mid-task (not at a done/error or at end of sequence)
      const lastAction = window[window.length - 1].action.action;
      if (lastAction === 'wait' || lastAction === 'scroll') continue;

      // Build the action type signature for dedup
      const actionSig = window.map((s) => s.action.action).join('-');
      if (seenKeys.has(actionSig)) continue;
      seenKeys.add(actionSig);

      // Generalize selectors
      const stepsDescription = window
        .map((s, idx) => {
          const selector = generalizeSelector(s.selectorUsed);
          return `${idx + 1}. ${s.action.action}${selector ? ` on ${selector}` : ''}`;
        })
        .join(', ');

      const triggerReasoning = window[0].reasoning.substring(0, 150);

      sequences.push({
        category: 'workflow_sequence',
        patternKey: `sequence-${actionSig}`,
        description: `Successful ${windowSize}-step workflow: ${actionSig}`,
        promptTip: `Workflow for "${triggerReasoning}": ${stepsDescription}`,
        confidence: 0.5,
        polarity: 'positive',
        context: {
          sequenceSteps: window.map((s) => ({
            action: s.action.action,
            selector: generalizeSelector(s.selectorUsed),
            reasoning: s.reasoning.substring(0, 120),
          })),
        },
      });
    }
  }

  // Only keep the longest non-overlapping sequences
  const deduped = deduplicateSequences(sequences);

  if (deduped.length > 0) {
    logger.info({ count: deduped.length }, 'Detected workflow sequences');
  }

  return deduped;
}

/** Generalize a CSS selector by replacing dynamic IDs with patterns. */
function generalizeSelector(selector?: string): string | undefined {
  if (!selector) return undefined;
  return (
    selector
      // Replace dynamic Squarespace IDs: #yui_3_12_0_1_1234 → [id^="yui_"]
      .replace(/#yui_[\w]+/g, '[id^="yui_"]')
      // Replace dynamic block IDs: #block-yui_3_12_0_1_1234 → [id^="block-"]
      .replace(/#block-[\w-]+/g, '[id^="block-"]')
  );
}

/** Keep only the longest sequence when shorter ones are subsets. */
function deduplicateSequences(sequences: CreateLearningInput[]): CreateLearningInput[] {
  // Sort by sequence length (longest first)
  const sorted = [...sequences].sort((a, b) => {
    const aLen = (a.patternKey.match(/-/g) ?? []).length;
    const bLen = (b.patternKey.match(/-/g) ?? []).length;
    return bLen - aLen;
  });

  const kept: CreateLearningInput[] = [];
  const coveredActions = new Set<string>();

  for (const seq of sorted) {
    const actionSig = seq.patternKey.replace('sequence-', '');
    // Check if this action signature is a subset of an already-kept sequence
    const isSubset = [...coveredActions].some((covered) => covered.includes(actionSig));
    if (!isSubset) {
      kept.push(seq);
      coveredActions.add(actionSig);
    }
  }

  // Cap at 3 sequences per task
  return kept.slice(0, 3);
}
