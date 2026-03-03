/**
 * Supervisor Agent — Post-execution visual verification & self-healing.
 *
 * After the browser agent reports "done", the supervisor:
 * 1. Takes a fresh screenshot of the page
 * 2. Sends it to Claude Haiku for cheap verification ("did it actually work?")
 * 3. If fail/unclear → escalates to Claude Sonnet for diagnosis + corrective instructions
 * 4. If recoverable → retries the browser agent once with corrective instructions
 * 5. Returns detailed result (verdict, diagnosis, retry outcome)
 *
 * Enabled via ENABLE_SUPERVISOR=true env var.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import type { Page, Frame } from 'playwright';
import type { AgentResult, SupervisorVerdict, SupervisorResult, ContentPlan, JsonVerificationEvidence, ExtractedBlockSummary } from './types.js';
import type { BrowserAgentResult, AgentStep } from '../automation/browser-agent.js';
import { SiteReader, type SquarespacePageData } from '../services/site-reader.js';
import { createContentSaveClient, type PageSection, type GridContent } from '../services/content-save.js';
import { takeScreenshot } from '../utils/screenshot.js';
import { logger } from '../utils/logger.js';
import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_SONNET } from '../config/models.js';
import { errMsg, errContext } from '../utils/errors.js';

// ─── JSON Verification Options ───────────────────────────────────────────────

/** Options for JSON-based verification via SiteReader (passed from execution.ts) */
export interface SupervisorJsonOptions {
  /** Base URL of the public site (e.g., 'https://smyth-tavern.squarespace.com') */
  siteBaseUrl: string;
  /** The page slug being edited (e.g., 'home', 'menus') */
  pageSlug: string;
  /** Pre-edit JSON snapshot captured before the browser agent ran */
  beforeSnapshot: SquarespacePageData;
}

/** Options for API-based verification via ContentSaveClient (works on private/trial sites) */
export interface SupervisorApiOptions {
  /** Squarespace site subdomain (e.g., 'smyth-tavern') */
  subdomain: string;
  /** The page sections ID (from data-page-sections DOM attribute) */
  pageSectionsId: string;
  /** The collection ID (from GetCollections API) */
  collectionId: string;
  /** Pre-edit sections snapshot captured before the browser agent ran */
  beforeSections: PageSection[];
  /** Operation type for targeted verification (e.g., 'create_page', 'delete_page') */
  operationType?: string;
  /** Expected page slug for navigation verification */
  expectedSlug?: string;
}

// ─── DOM Evidence Types ───────────────────────────────────────────────────────

interface DomCheckResult {
  operationIndex: number;
  heading: { expected: string; found: boolean; actual?: string } | null;
  bodyText: { expected: string; found: boolean; snippet?: string } | null;
  button: { expected: string; found: boolean; actual?: string } | null;
  image: { query: string; found: boolean; src?: string; alt?: string } | null;
  overallPresent: boolean;
}

interface DomEvidence {
  checks: DomCheckResult[];
  allPresent: boolean;
  summary: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if the supervisor is enabled via env var.
 */
export function isSupervisorEnabled(): boolean {
  return process.env.ENABLE_SUPERVISOR === 'true';
}

/**
 * Verify a browser agent's result and optionally retry with corrective instructions.
 *
 * @param page - The Playwright page (still on the target site, post-agent)
 * @param taskDescription - The original task text given to the browser agent
 * @param agentResult - The BrowserAgentResult from executeBrowserTask
 * @param retryFn - Callback to re-run the browser agent with corrective instructions
 * @param contentPlan - Optional approved ContentPlan — when provided, the supervisor
 *                      verifies each plan operation individually instead of a generic check
 * @param jsonOptions - Optional SiteReader options for JSON-based verification (before snapshot + site URL)
 * @param apiOptions - Optional Content Save API options for verification (works on private sites)
 */
export async function superviseBrowserResult(
  page: Page,
  taskDescription: string,
  agentResult: BrowserAgentResult,
  retryFn: (correctiveInstructions: string) => Promise<BrowserAgentResult>,
  contentPlan?: ContentPlan,
  jsonOptions?: SupervisorJsonOptions,
  apiOptions?: SupervisorApiOptions,
  validationEvidence?: string,
): Promise<AgentResult<SupervisorResult>> {
  const start = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    // 1. Take a fresh verification screenshot
    const verificationScreenshotPath = await takeScreenshot(page, 'supervisor-verify');
    const screenshotBuffer = readFileSync(verificationScreenshotPath);
    const base64 = screenshotBuffer.toString('base64');

    // 1b. JSON-based evidence — try Content Save API first (works on private sites),
    // fall back to SiteReader (public ?format=json-pretty endpoint)
    let jsonEvidence: JsonVerificationEvidence | undefined;
    if (apiOptions) {
      try {
        jsonEvidence = await collectApiEvidence(apiOptions);
        logger.info(
          { changesDetected: jsonEvidence.changesDetected, available: jsonEvidence.available, source: 'api' },
          'Supervisor: API evidence collected',
        );
      } catch (err) {
        logger.warn(
          { error: errMsg(err) },
          'Supervisor: API evidence collection failed, falling back to SiteReader',
        );
      }
    }
    if (!jsonEvidence && jsonOptions) {
      try {
        jsonEvidence = await collectJsonEvidence(jsonOptions);
        logger.info(
          { changesDetected: jsonEvidence.changesDetected, available: jsonEvidence.available, source: 'sitereader' },
          'Supervisor: JSON evidence collected via SiteReader',
        );
      } catch (err) {
        logger.warn(
          { error: errMsg(err) },
          'Supervisor: JSON evidence collection failed, continuing with screenshot+DOM',
        );
        jsonEvidence = {
          available: false,
          summary: 'Both API and SiteReader evidence collection failed',
          changesDetected: false,
          error: errMsg(err),
        };
      }
    }

    // 2. DOM-based evidence extraction (when plan is available)
    let domEvidence: DomEvidence | undefined;
    if (contentPlan) {
      try {
        domEvidence = await extractDomEvidence(page, contentPlan);
        logger.info(
          { allPresent: domEvidence.allPresent, checks: domEvidence.checks.length },
          'Supervisor: DOM evidence extracted',
        );

        // Fast path: if DOM definitively shows ALL content is present, pass immediately
        // Enhanced: if JSON also confirms changes, boost confidence
        if (domEvidence.allPresent) {
          const jsonConfirmed = jsonEvidence?.available && jsonEvidence.changesDetected;
          const confidence = jsonConfirmed ? 0.99 : 0.98;
          const evidenceSource = jsonConfirmed ? 'DOM + JSON' : 'DOM';
          logger.info({ jsonConfirmed }, `Supervisor: ${evidenceSource} confirms all plan content present — auto-pass`);
          return {
            success: true,
            data: {
              verdict: {
                status: 'pass',
                observedState: `${evidenceSource} verification confirmed all ${contentPlan.operations.length} operations present`,
                expectedState: 'All plan operations completed',
                confidence,
                jsonEvidence,
              },
              retryAttempted: false,
              verificationScreenshotPath,
              jsonVerificationUsed: jsonEvidence?.available ?? false,
              tokenUsage: { inputTokens: 0, outputTokens: 0 },
              durationMs: Date.now() - start,
            },
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            durationMs: Date.now() - start,
          };
        }
      } catch (err) {
        logger.warn(
          { error: errMsg(err) },
          'Supervisor: DOM evidence extraction failed, falling back to vision-only',
        );
      }
    }

    // 3. Quick verification with Sonnet
    logger.info(
      { taskDescription: taskDescription.substring(0, 100) },
      'Supervisor: verifying browser agent result',
    );

    // Use plan-aware verification when a content plan is provided (stricter checklist)
    // Include DOM + JSON + inline validation evidence for more reliable verification
    const domEvidenceText = domEvidence ? formatDomEvidenceForPrompt(domEvidence) : '';
    const jsonEvidenceText = jsonEvidence?.available ? formatJsonEvidenceForPrompt(jsonEvidence) : '';
    const validationText = validationEvidence ?? '';
    const combinedEvidenceText = [jsonEvidenceText, validationText].filter(Boolean).join('\n\n');
    const verificationPrompt = contentPlan
      ? buildPlanAwareVerificationPrompt(taskDescription, agentResult.summary, contentPlan, domEvidenceText, combinedEvidenceText)
      : buildVerificationPrompt(taskDescription, agentResult.summary, combinedEvidenceText);

    const verifyResponse = await getAnthropicClient().messages.create({
      model: MODEL_SONNET,
      max_tokens: contentPlan ? 1024 : 512,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: base64 },
            },
            {
              type: 'text',
              text: verificationPrompt,
            },
          ],
        },
      ],
    });

    totalInputTokens += verifyResponse.usage.input_tokens;
    totalOutputTokens += verifyResponse.usage.output_tokens;

    const verdictText = verifyResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let verdict = parseVerdict(verdictText);
    // Attach JSON evidence to verdict
    if (jsonEvidence) verdict = { ...verdict, jsonEvidence };

    // 3. If pass → return immediately (cheapest path, ~80% of calls)
    if (verdict.status === 'pass') {
      logger.info({ confidence: verdict.confidence }, 'Supervisor: task verified as correct');
      return {
        success: true,
        data: {
          verdict,
          retryAttempted: false,
          verificationScreenshotPath,
          jsonVerificationUsed: jsonEvidence?.available ?? false,
          tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          durationMs: Date.now() - start,
        },
        tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        durationMs: Date.now() - start,
      };
    }

    // 4. Fail or unclear → escalate to Sonnet for diagnosis + corrective instructions
    logger.warn(
      { status: verdict.status, diagnosis: verdict.diagnosis },
      'Supervisor: verification failed, escalating to Sonnet for diagnosis',
    );

    const diagnosisPrompt = contentPlan
      ? buildPlanAwareDiagnosisPrompt(taskDescription, agentResult.summary, agentResult.steps, verdict, contentPlan)
      : buildDiagnosisPrompt(taskDescription, agentResult.summary, agentResult.steps, verdict);

    const diagnosisResponse = await getAnthropicClient().messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: base64 },
            },
            {
              type: 'text',
              text: diagnosisPrompt,
            },
          ],
        },
      ],
    });

    totalInputTokens += diagnosisResponse.usage.input_tokens;
    totalOutputTokens += diagnosisResponse.usage.output_tokens;

    const diagnosisText = diagnosisResponse.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const diagnosis = parseDiagnosis(diagnosisText);

    // Update verdict with Sonnet's better diagnosis
    verdict = {
      ...verdict,
      diagnosis: diagnosis.diagnosis,
      correctiveInstructions: diagnosis.correctiveInstructions,
    };

    // 5. If not recoverable → return failure with diagnosis (no retry)
    if (!diagnosis.isRecoverable) {
      logger.warn(
        { diagnosis: diagnosis.diagnosis },
        'Supervisor: issue is not recoverable via retry',
      );
      return {
        success: false,
        data: {
          verdict,
          retryAttempted: false,
          verificationScreenshotPath,
          jsonVerificationUsed: jsonEvidence?.available ?? false,
          tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          durationMs: Date.now() - start,
        },
        tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        durationMs: Date.now() - start,
      };
    }

    // 6. Attempt retries with corrective instructions (up to MAX_RETRIES)
    const MAX_RETRIES = 2;
    let lastRetryResult: BrowserAgentResult | undefined;
    let lastRetryScreenshotPath = verificationScreenshotPath;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      logger.info(
        { attempt, maxRetries: MAX_RETRIES, correctiveInstructions: verdict.correctiveInstructions?.substring(0, 200) },
        'Supervisor: attempting retry with corrective instructions',
      );

      const retryResult = await retryFn(verdict.correctiveInstructions!);
      lastRetryResult = retryResult;

      // Verify the retry result
      const retryScreenshotPath = await takeScreenshot(page, `supervisor-retry-verify-${attempt}`);
      lastRetryScreenshotPath = retryScreenshotPath;
      const retryBuffer = readFileSync(retryScreenshotPath);
      const retryBase64 = retryBuffer.toString('base64');

      // Re-collect JSON evidence after retry — try API first, fall back to SiteReader
      let retryJsonEvidence: JsonVerificationEvidence | undefined;
      if (apiOptions) {
        try {
          retryJsonEvidence = await collectApiEvidence(apiOptions);
          logger.info({ attempt, changesDetected: retryJsonEvidence.changesDetected, source: 'api' }, 'Supervisor: retry API evidence collected');
        } catch {
          // API evidence failed — fall through to SiteReader
        }
      }
      if (!retryJsonEvidence && jsonOptions) {
        try {
          retryJsonEvidence = await collectJsonEvidence(jsonOptions);
          logger.info({ attempt, changesDetected: retryJsonEvidence.changesDetected, source: 'sitereader' }, 'Supervisor: retry JSON evidence collected');
        } catch {
          // JSON evidence failed — continue with screenshot+DOM
        }
      }

      // Re-extract DOM evidence after retry
      let retryDomEvidenceText = '';
      if (contentPlan) {
        try {
          const retryDomEvidence = await extractDomEvidence(page, contentPlan);
          logger.info({ allPresent: retryDomEvidence.allPresent, attempt }, 'Supervisor: retry DOM evidence extracted');

          // Fast path: DOM confirms everything present after retry
          if (retryDomEvidence.allPresent) {
            const retryJsonConfirmed = retryJsonEvidence?.available && retryJsonEvidence.changesDetected;
            const confidence = retryJsonConfirmed ? 0.99 : 0.98;
            const evidenceSource = retryJsonConfirmed ? 'DOM + JSON' : 'DOM';
            logger.info({ attempt, retryJsonConfirmed }, `Supervisor: retry ${evidenceSource} confirms all plan content present — auto-pass`);
            return {
              success: true,
              data: {
                verdict: {
                  status: 'pass',
                  observedState: `${evidenceSource} verification confirmed all ${contentPlan.operations.length} operations present after retry attempt ${attempt}`,
                  expectedState: 'All plan operations completed',
                  diagnosis: verdict.diagnosis,
                  confidence,
                  jsonEvidence: retryJsonEvidence,
                },
                retryAttempted: true,
                retryResult: {
                  success: retryResult.success,
                  summary: retryResult.summary,
                  screenshotPath: retryResult.screenshotPath,
                },
                verificationScreenshotPath: retryScreenshotPath,
                jsonVerificationUsed: retryJsonEvidence?.available ?? false,
                tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
                durationMs: Date.now() - start,
              },
              tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
              durationMs: Date.now() - start,
            };
          }

          retryDomEvidenceText = formatDomEvidenceForPrompt(retryDomEvidence);
        } catch {
          // DOM extraction failed — continue with vision-only
        }
      }

      const retryJsonEvidenceText = retryJsonEvidence?.available ? formatJsonEvidenceForPrompt(retryJsonEvidence) : '';
      const retryVerificationPrompt = contentPlan
        ? buildPlanAwareVerificationPrompt(taskDescription, retryResult.summary, contentPlan, retryDomEvidenceText, retryJsonEvidenceText)
        : buildVerificationPrompt(taskDescription, retryResult.summary, retryJsonEvidenceText);

      const retryVerifyResponse = await getAnthropicClient().messages.create({
        model: MODEL_SONNET,
        max_tokens: contentPlan ? 1024 : 512,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: retryBase64 },
              },
              {
                type: 'text',
                text: retryVerificationPrompt,
              },
            ],
          },
        ],
      });

      totalInputTokens += retryVerifyResponse.usage.input_tokens;
      totalOutputTokens += retryVerifyResponse.usage.output_tokens;

      const retryVerdictText = retryVerifyResponse.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      let retryVerdict = parseVerdict(retryVerdictText);
      // Attach retry JSON evidence to verdict
      if (retryJsonEvidence) retryVerdict = { ...retryVerdict, jsonEvidence: retryJsonEvidence };

      logger.info(
        { attempt, retrySuccess: retryVerdict.status === 'pass', retryVerdict: retryVerdict.status },
        'Supervisor: retry verification complete',
      );

      // If retry passed, return success
      if (retryVerdict.status === 'pass') {
        return {
          success: true,
          data: {
            verdict: retryVerdict,
            retryAttempted: true,
            retryResult: {
              success: retryResult.success,
              summary: retryResult.summary,
              screenshotPath: retryResult.screenshotPath,
            },
            verificationScreenshotPath: retryScreenshotPath,
            jsonVerificationUsed: retryJsonEvidence?.available ?? false,
            tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
            durationMs: Date.now() - start,
          },
          tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          durationMs: Date.now() - start,
        };
      }

      // If not the last attempt, get new corrective instructions for next retry
      if (attempt < MAX_RETRIES) {
        logger.info({ attempt }, 'Supervisor: retry failed, getting new corrective instructions for next attempt');

        const reDiagnosisPrompt = contentPlan
          ? buildPlanAwareDiagnosisPrompt(taskDescription, retryResult.summary, retryResult.steps, retryVerdict, contentPlan)
          : buildDiagnosisPrompt(taskDescription, retryResult.summary, retryResult.steps, retryVerdict);

        const reDiagnosisResponse = await getAnthropicClient().messages.create({
          model: MODEL_SONNET,
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: retryBase64 },
                },
                {
                  type: 'text',
                  text: reDiagnosisPrompt,
                },
              ],
            },
          ],
        });

        totalInputTokens += reDiagnosisResponse.usage.input_tokens;
        totalOutputTokens += reDiagnosisResponse.usage.output_tokens;

        const reDiagnosisText = reDiagnosisResponse.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');

        const reDiagnosis = parseDiagnosis(reDiagnosisText);

        // If the re-diagnosis says it's not recoverable, stop retrying
        if (!reDiagnosis.isRecoverable) {
          logger.warn({ attempt }, 'Supervisor: re-diagnosis says issue is not recoverable, stopping retries');
          break;
        }

        // Update verdict with new corrective instructions for next iteration
        verdict = {
          ...verdict,
          diagnosis: reDiagnosis.diagnosis,
          correctiveInstructions: reDiagnosis.correctiveInstructions,
        };
      }
    }

    // All retries exhausted — return failure
    logger.warn(
      { totalRetries: MAX_RETRIES },
      'Supervisor: all retry attempts exhausted',
    );

    return {
      success: false,
      data: {
        verdict,
        retryAttempted: true,
        retryResult: lastRetryResult ? {
          success: lastRetryResult.success,
          summary: lastRetryResult.summary,
          screenshotPath: lastRetryResult.screenshotPath,
        } : undefined,
        verificationScreenshotPath: lastRetryScreenshotPath,
        jsonVerificationUsed: jsonEvidence?.available ?? false,
        tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        durationMs: Date.now() - start,
      },
      tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error(errContext(err), 'Supervisor agent failed');
    return {
      success: false,
      error: errorMessage,
      tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      durationMs: Date.now() - start,
    };
  }
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

function buildVerificationPrompt(taskDescription: string, agentSummary: string, jsonEvidenceText?: string): string {
  return `You are a STRICT QA supervisor for a Squarespace website editing agent. Your job is to VERIFY that changes were ACTUALLY made — do NOT trust the agent's claim.

## Task the agent was given:
---
${taskDescription}
---

## Agent's claim (DO NOT TRUST — verify visually):
"${agentSummary}"
${jsonEvidenceText ? `\n${jsonEvidenceText}\n` : ''}
## Your job: Look at the screenshot and verify the ACTUAL state of the page.

CRITICAL RULES:
- The agent LIES sometimes — it may claim success when nothing changed. You MUST verify by looking at the screenshot.
- If the task was to change text from "X" to "Y", check: does the screenshot show "Y"? If it still shows "X", that is a FAIL.
- If the task was to add content, check: is that content VISIBLE in the screenshot? Empty blocks or placeholder text ("Write here...") means the content was NOT added — that is a FAIL.
- If the task was to add a text block with specific text, a blank/empty text block is a FAIL.
- The screenshot may show the Squarespace editor UI (with "ADD BLOCK", "EDIT SECTION" buttons, etc.). This is normal — focus on the actual page content within the editor.
- "pass" requires POSITIVE VISUAL EVIDENCE that the change was made. No evidence = FAIL.
- When in doubt, FAIL. It is better to flag a false negative than to approve incomplete work.
- NOTE: The editTextBlock action has two modes. If the agent's summary or steps mention "via Content Save API", the text was updated through a direct HTTP call (~500ms) without UI interaction — this is highly reliable. If steps mention "API fast path unavailable", the UI automation fallback was used instead. Either way, verify the ACTUAL text on the page.

Respond with JSON only:
{
  "status": "pass" | "fail" | "unclear",
  "observedState": "Describe EXACTLY what text/content you see in the screenshot",
  "expectedState": "What the page should show if the task was done correctly",
  "diagnosis": "If fail: what specifically is wrong or missing",
  "confidence": 0.95
}

Status definitions:
- "pass": The requested change is VISUALLY CONFIRMED in the screenshot
- "fail": The change is NOT visible, or the wrong thing was changed, or content is missing/empty
- "unclear": Cannot determine (content might be below fold, page is loading, etc.) — set confidence below 0.7`;
}

function buildDiagnosisPrompt(
  taskDescription: string,
  agentSummary: string,
  agentSteps: AgentStep[],
  haikuVerdict: SupervisorVerdict,
): string {
  // Summarize the agent's last 5 steps for context
  const stepSummary = agentSteps
    .slice(-5)
    .map(
      (s, i) =>
        `Step ${s.stepNumber}: ${s.reasoning.substring(0, 120)} → ${s.result.success ? 'OK' : 'FAIL'}: ${s.result.message.substring(0, 80)}`,
    )
    .join('\n');

  return `You are a senior QA engineer diagnosing a browser automation failure on a Squarespace website.

## Original Task
${taskDescription}

## Agent's Claimed Summary
"${agentSummary}"

## Agent's Last Steps
${stepSummary}

## Initial Verification Finding
Status: ${haikuVerdict.status}
Observed: ${haikuVerdict.observedState}
Expected: ${haikuVerdict.expectedState}
${haikuVerdict.diagnosis ? `Initial diagnosis: ${haikuVerdict.diagnosis}` : ''}

## Your Job
Look at the screenshot and provide:
1. A precise diagnosis of what went wrong (written so the site owner immediately understands via WhatsApp)
2. Corrective instructions that the browser agent can follow to fix the issue in ONE attempt
3. Whether this is recoverable via automation or needs human intervention

Respond with JSON only:
{
  "diagnosis": "The agent deleted the entire 'Reservations' section (which contained a heading, description text, and the Reserve button) instead of removing only the Reserve button block.",
  "correctiveInstructions": "Enter edit mode. Scroll to where the Reservations section was. Add a new section. Add a text block with heading 'Reservations' and a description. Then add a button block labeled 'Reserve Now'. Save changes.",
  "isRecoverable": true,
  "confidence": 0.9
}

Rules:
- isRecoverable = true means the browser agent could realistically fix this in ~10-15 steps
- isRecoverable = false means the content is lost and a human needs to intervene (e.g., custom images deleted, complex layouts destroyed)
- Write the diagnosis as if Tim (the site owner) will read it directly on WhatsApp
- Write correctiveInstructions as step-by-step browser automation instructions
- If the page looks correct but the change might be elsewhere (below fold), set isRecoverable = true with instructions to scroll and verify
- NOTE on Content Save API: If the agent's steps show "via Content Save API", the text edit was done via direct HTTP — do NOT give UI-specific corrective instructions (like "click the text block and retype"). Instead, the retry should attempt the API path again or navigate+reload to verify. If steps show "API fast path unavailable", UI automation was used and UI-specific corrective instructions are appropriate. If the API succeeded but verification fails, the page view may be stale — suggest navigating away and back to force a refresh.`;
}

// ─── Plan-Aware Prompts ──────────────────────────────────────────────────

/**
 * When a ContentPlan exists, the supervisor verifies EACH operation individually
 * instead of doing a vague "does the page look right?" check.
 */
function buildPlanAwareVerificationPrompt(
  taskDescription: string,
  agentSummary: string,
  plan: ContentPlan,
  domEvidenceText?: string,
  jsonEvidenceText?: string,
): string {
  const checklist = plan.operations
    .map((op, i) => {
      const items: string[] = [];
      items.push(`${i + 1}. [${op.operationType.replace(/_/g, ' ')}] at "${op.placement}"`);
      if (op.content.heading) items.push(`   - Should have heading: "${op.content.heading}"`);
      if (op.content.bodyText) {
        // First ~80 chars of body text is enough for visual verification
        const preview = op.content.bodyText.length > 80
          ? op.content.bodyText.substring(0, 80) + '...'
          : op.content.bodyText;
        items.push(`   - Should have body text starting with: "${preview}"`);
      }
      if (op.content.button) {
        items.push(`   - Should have button: "${op.content.button.label}"`);
      }
      if (op.content.imageQuery) {
        items.push(`   - Should have image related to: "${op.content.imageQuery}"`);
      }
      return items.join('\n');
    })
    .join('\n');

  return `You are a QA supervisor for a Squarespace website editing agent.

The agent was given a CONTENT PLAN with ${plan.operations.length} specific operations to complete.

## Original Task
${taskDescription}

## Agent's Claimed Summary
"${agentSummary}"

## Content Plan Checklist — Verify EACH item
${checklist}
${domEvidenceText ? `\n${domEvidenceText}\n` : ''}${jsonEvidenceText ? `\n${jsonEvidenceText}\n` : ''}
Look at the screenshot AND the DOM evidence AND the JSON evidence (if provided). For EACH operation in the checklist above, determine if it was actually completed.

Respond with JSON only:
{
  "status": "pass" | "fail" | "unclear",
  "observedState": "What you actually see on the page",
  "expectedState": "What should be visible based on the plan",
  "completedItems": [1, 2],
  "missingItems": [3, 4],
  "diagnosis": "If fail: which specific plan items are missing or wrong",
  "confidence": 0.9
}

Rules:
- "pass" means ALL plan items are visibly completed
- "fail" means one or more plan items are missing or wrong — list them in missingItems
- "unclear" means you cannot verify from the screenshot (e.g., content is below the fold)
- Even if some items are done, if ANY are missing → "fail"
- Partial completion is a FAIL — the plan is all-or-nothing
- Be specific about which numbered items are done vs missing
- NOTE: Text edits may have been applied via Content Save API (direct HTTP, ~500ms) instead of UI automation. If the agent's summary mentions "via Content Save API", those edits are highly reliable — focus verification on whether the correct text appears on the page.`;
}

/**
 * Plan-aware diagnosis focuses on the UNCOMPLETED items and generates
 * corrective instructions ONLY for the remaining work.
 */
function buildPlanAwareDiagnosisPrompt(
  taskDescription: string,
  agentSummary: string,
  agentSteps: AgentStep[],
  haikuVerdict: SupervisorVerdict,
  plan: ContentPlan,
): string {
  const stepSummary = agentSteps
    .slice(-5)
    .map(
      (s) =>
        `Step ${s.stepNumber}: ${s.reasoning.substring(0, 120)} → ${s.result.success ? 'OK' : 'FAIL'}: ${s.result.message.substring(0, 80)}`,
    )
    .join('\n');

  const fullChecklist = plan.operations
    .map((op, i) => {
      const items: string[] = [];
      items.push(`${i + 1}. [${op.operationType.replace(/_/g, ' ')}] at "${op.placement}"`);
      if (op.content.heading) items.push(`   Heading: "${op.content.heading}"`);
      if (op.content.bodyText) {
        const preview = op.content.bodyText.length > 120
          ? op.content.bodyText.substring(0, 120) + '...'
          : op.content.bodyText;
        items.push(`   Body: "${preview}"`);
      }
      if (op.content.button) items.push(`   Button: "${op.content.button.label}" → ${op.content.button.url}`);
      items.push(`   Editor instruction: ${op.editorInstruction.substring(0, 200)}`);
      return items.join('\n');
    })
    .join('\n\n');

  return `You are a senior QA engineer diagnosing a PARTIALLY completed content plan on a Squarespace website.

## Original Task
${taskDescription}

## Agent's Claimed Summary
"${agentSummary}"

## Agent's Last Steps
${stepSummary}

## Initial Verification Finding
Status: ${haikuVerdict.status}
Observed: ${haikuVerdict.observedState}
Expected: ${haikuVerdict.expectedState}
${haikuVerdict.diagnosis ? `Initial diagnosis: ${haikuVerdict.diagnosis}` : ''}

## Full Content Plan (${plan.operations.length} operations)
${fullChecklist}

## Your Job
1. Identify EXACTLY which plan operations were completed vs skipped/failed
2. Write corrective instructions that ONLY cover the REMAINING (uncompleted) operations
3. Do NOT re-do already completed items — the agent should pick up where it left off

Respond with JSON only:
{
  "diagnosis": "The agent completed operations 1 and 2 (added the About section heading and body text) but skipped operations 3 and 4 (the CTA button and the team photo section).",
  "correctiveInstructions": "The first two operations are already done. Now complete the remaining items: ...",
  "completedOperations": [1, 2],
  "missingOperations": [3, 4],
  "isRecoverable": true,
  "confidence": 0.9
}

Rules:
- List completed vs missing operation numbers explicitly
- Write correctiveInstructions as step-by-step browser automation instructions for ONLY the missing items
- isRecoverable = true if the remaining items can be added without undoing existing work
- isRecoverable = false only if the agent damaged existing content that can't be automated back
- Write the diagnosis so Tim (the site owner) immediately understands what's done and what's left
- NOTE on Content Save API: If the agent's steps show "via Content Save API" for text edits, those were done via direct HTTP — don't suggest UI-specific corrective steps for those operations. If steps show "API fast path unavailable", UI automation was used and UI-specific corrections are appropriate. If API edits succeeded but aren't visible, the page may need a reload before re-verifying.`;
}

// ─── DOM-Based Verification ───────────────────────────────────────────────────

/**
 * Extract concrete DOM evidence for each plan operation.
 * Queries the actual page content (primarily in the site iframe) to check
 * whether expected headings, body text, and buttons are present.
 *
 * This is 100% reliable for text presence (unlike vision which can miss
 * below-fold content). Returns structured evidence that augments the
 * screenshot-based verification prompt.
 */
async function extractDomEvidence(page: Page, plan: ContentPlan): Promise<DomEvidence> {
  const checks: DomCheckResult[] = [];

  // Try to get the site iframe (Squarespace editor renders content in an iframe)
  const siteFrame = getSiteFrame(page);

  for (let i = 0; i < plan.operations.length; i++) {
    const op = plan.operations[i];
    const check: DomCheckResult = {
      operationIndex: i + 1,
      heading: null,
      bodyText: null,
      button: null,
      image: null,
      overallPresent: true,
    };

    // Check for heading
    if (op.content.heading) {
      const headingResult = await findTextInPage(siteFrame ?? page, op.content.heading, 'h1, h2, h3, h4, h5, h6, [class*="heading"], [class*="title"]');
      check.heading = {
        expected: op.content.heading,
        found: headingResult.found,
        actual: headingResult.closestMatch,
      };
      if (!headingResult.found) check.overallPresent = false;
    }

    // Check for body text (check first 50 chars as a fingerprint)
    if (op.content.bodyText) {
      const bodyFingerprint = op.content.bodyText.substring(0, 50);
      const bodyResult = await findTextInPage(siteFrame ?? page, bodyFingerprint, 'p, div, span, li, [class*="block"]');
      check.bodyText = {
        expected: bodyFingerprint,
        found: bodyResult.found,
        snippet: bodyResult.closestMatch,
      };
      if (!bodyResult.found) check.overallPresent = false;
    }

    // Check for button
    if (op.content.button) {
      const buttonResult = await findTextInPage(siteFrame ?? page, op.content.button.label, 'a, button, [role="button"], [class*="button"], [class*="btn"]');
      check.button = {
        expected: op.content.button.label,
        found: buttonResult.found,
        actual: buttonResult.closestMatch,
      };
      if (!buttonResult.found) check.overallPresent = false;
    }

    // Check for image (when plan specifies imageQuery)
    // Squarespace images are typically <img> tags inside image blocks.
    // We check for any <img> with a non-placeholder src near the operation's section.
    // Since we can't match semantic image content, we check for the presence of
    // any non-default image (i.e., an img with a real src, not a placeholder).
    if (op.content.imageQuery) {
      const imageResult = await findImageInPage(siteFrame ?? page);
      check.image = {
        query: op.content.imageQuery,
        found: imageResult.found,
        src: imageResult.src,
        alt: imageResult.alt,
      };
      // Note: we DON'T fail overallPresent for missing images because
      // image uploads are less reliable and the supervisor should use
      // vision to verify the actual image content. We still report it.
    }

    checks.push(check);
  }

  const allPresent = checks.every((c) => c.overallPresent);

  // Build human-readable summary
  const summaryLines: string[] = [];
  for (const c of checks) {
    const items: string[] = [];
    if (c.heading) items.push(`heading "${c.heading.expected}": ${c.heading.found ? '✅ FOUND' : '❌ NOT FOUND'}`);
    if (c.bodyText) items.push(`body text: ${c.bodyText.found ? '✅ FOUND' : '❌ NOT FOUND'}`);
    if (c.button) items.push(`button "${c.button.expected}": ${c.button.found ? '✅ FOUND' : '❌ NOT FOUND'}`);
    if (c.image) items.push(`image "${c.image.query}": ${c.image.found ? `✅ FOUND (alt: ${c.image.alt ?? 'none'})` : '⚠️ NOT DETECTED (verify visually)'}`);
    summaryLines.push(`Operation ${c.operationIndex}: ${items.join(', ')}`);
  }

  return {
    checks,
    allPresent,
    summary: summaryLines.join('\n'),
  };
}

/**
 * Get the Squarespace site iframe frame handle.
 */
function getSiteFrame(page: Page): Frame | null {
  return page.frame({ name: 'sqs-site-frame' }) ?? page.frames().find((f) => f.url().includes('/config/')) ?? null;
}

/**
 * Search for text content within elements matching the given selector.
 * Uses case-insensitive partial matching.
 */
async function findTextInPage(
  context: Page | Frame,
  searchText: string,
  selector: string,
): Promise<{ found: boolean; closestMatch?: string }> {
  try {
    const needle = searchText.toLowerCase().trim();

    const result = await context.evaluate(
      ({ sel, text }: { sel: string; text: string }) => {
        const els = document.querySelectorAll(sel);
        let bestMatch = '';
        let found = false;

        for (const el of els) {
          const content = (el.textContent || '').trim();
          if (!content) continue;

          if (content.toLowerCase().includes(text)) {
            found = true;
            bestMatch = content.substring(0, 120);
            break;
          }
        }

        // Also check full page text as fallback
        if (!found) {
          const bodyText = document.body?.textContent || '';
          if (bodyText.toLowerCase().includes(text)) {
            found = true;
            // Extract surrounding context
            const idx = bodyText.toLowerCase().indexOf(text);
            bestMatch = bodyText.substring(Math.max(0, idx - 20), idx + text.length + 20).trim();
          }
        }

        return { found, bestMatch };
      },
      { sel: selector, text: needle },
    );

    return { found: result.found, closestMatch: result.bestMatch || undefined };
  } catch (err) {
    logger.debug({ error: errMsg(err) }, 'DOM text search failed');
    return { found: false };
  }
}

/**
 * Check if any non-placeholder images exist on the page.
 * Squarespace placeholder images have specific patterns (data URIs, 1x1 pixels, etc.).
 * Returns the first "real" image found with its src and alt text.
 */
async function findImageInPage(
  context: Page | Frame,
): Promise<{ found: boolean; src?: string; alt?: string }> {
  try {
    const result = await context.evaluate(() => {
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        const alt = img.getAttribute('alt') || '';
        // Skip common placeholder/UI patterns
        if (!src) continue;
        if (src.startsWith('data:image/svg')) continue;
        if (src.includes('static.squarespace.com/static/ta/') && src.includes('1x1')) continue;
        if (src.includes('placeholder')) continue;
        // Real Squarespace content images use images.squarespace-cdn.com
        if (src.includes('squarespace-cdn.com') || src.includes('images.squarespace.com') || src.startsWith('http')) {
          return { found: true, src: src.substring(0, 200), alt };
        }
      }
      return { found: false, src: undefined, alt: undefined };
    });
    return result;
  } catch (err) {
    logger.debug({ error: errMsg(err) }, 'DOM image search failed');
    return { found: false };
  }
}

/**
 * Format DOM evidence for inclusion in a verification prompt.
 */
function formatDomEvidenceForPrompt(evidence: DomEvidence): string {
  if (evidence.checks.length === 0) return '';

  return `## DOM Verification (ground truth — more reliable than screenshots)

The following checks queried the ACTUAL page content (not vision):

${evidence.summary}

Overall: ${evidence.allPresent ? 'ALL expected content found in DOM ✅' : 'SOME expected content is MISSING from DOM ❌'}

IMPORTANT: If the DOM check says content is NOT FOUND, it is definitively absent from the page — regardless of what the screenshot appears to show. Trust the DOM evidence over visual interpretation.`;
}

// ─── JSON Evidence Collection (SiteReader) ──────────────────────────────────

/**
 * Collect JSON-based evidence by comparing before/after page snapshots via SiteReader.
 * Returns structured evidence including diffs and current block inventory.
 */
async function collectJsonEvidence(
  options: SupervisorJsonOptions,
): Promise<JsonVerificationEvidence> {
  const reader = new SiteReader(options.siteBaseUrl);
  // Disable cache to ensure fresh "after" data
  reader.clearCache();

  // Brief delay to allow Squarespace to propagate saved changes to the public endpoint
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const afterSnapshot = await reader.readPage(options.pageSlug);

  if (!afterSnapshot) {
    return {
      available: false,
      summary: `Could not read page "${options.pageSlug}" — may be password-protected, unpublished, or not yet saved`,
      changesDetected: false,
      error: 'SiteReader returned null for after snapshot',
    };
  }

  const diff = reader.diffPages(options.pageSlug, options.beforeSnapshot, afterSnapshot);
  const afterBlocks = await reader.getPageBlocks(options.pageSlug);

  const blockSummaries: ExtractedBlockSummary[] = afterBlocks.map((b) => ({
    type: b.type,
    text: b.text?.substring(0, 150),
    buttonText: b.buttonText,
    buttonUrl: b.buttonUrl,
    imageAlt: b.imageAlt,
    hasImage: !!b.imageUrl,
  }));

  const changeSummaryLines = diff.changes.map((c) => {
    if (c.type === 'added') return `+ ADDED: ${c.path} = "${c.after}"`;
    if (c.type === 'removed') return `- REMOVED: ${c.path} (was "${c.before}")`;
    return `~ MODIFIED: ${c.path}: "${c.before}" → "${c.after}"`;
  });

  const summary = diff.changed
    ? `JSON diff detected ${diff.changes.length} change(s):\n${changeSummaryLines.join('\n')}`
    : 'JSON diff detected NO changes between before and after snapshots';

  return {
    available: true,
    summary,
    changesDetected: diff.changed,
    diff,
    afterBlocks: blockSummaries,
  };
}

// ─── API Evidence Collection (Content Save API) ─────────────────────────────

/**
 * Collect JSON-based evidence using the Content Save API (internal endpoint).
 * Unlike SiteReader (which uses the public ?format=json-pretty), this works on
 * private/trial sites because it uses authenticated session cookies.
 *
 * Compares before/after sections to detect text changes, block additions/removals,
 * section reordering, and image metadata changes.
 */
async function collectApiEvidence(
  options: SupervisorApiOptions,
): Promise<JsonVerificationEvidence> {
  const client = createContentSaveClient(options.subdomain);

  // Brief delay to allow Squarespace to propagate saved changes
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const afterData = await client.getPageSections(options.pageSectionsId);
  const afterSections = afterData.sections ?? [];
  const beforeSections = options.beforeSections;

  const changes: string[] = [];

  // Section count changes
  if (beforeSections.length !== afterSections.length) {
    changes.push(`Section count: ${beforeSections.length} → ${afterSections.length}`);
  }

  // Section order changes
  const beforeIds = beforeSections.map((s) => s.id);
  const afterIds = afterSections.map((s) => s.id);
  if (beforeIds.length === afterIds.length && beforeIds.some((id, i) => id !== afterIds[i])) {
    changes.push('Section order changed');
  }

  // Per-section comparison
  for (const afterSection of afterSections) {
    const beforeSection = beforeSections.find((s) => s.id === afterSection.id);
    const sectionLabel = afterSection.sectionName || afterSection.id.substring(0, 8);

    if (!beforeSection) {
      changes.push(`+ New section: "${sectionLabel}"`);
      continue;
    }

    const beforeBlocks = beforeSection.fluidEngineContext?.gridContents ?? [];
    const afterBlocks = afterSection.fluidEngineContext?.gridContents ?? [];

    // Block count changes
    if (beforeBlocks.length !== afterBlocks.length) {
      changes.push(`Section "${sectionLabel}": block count ${beforeBlocks.length} → ${afterBlocks.length}`);
    }

    // Per-block comparison
    for (const afterBlock of afterBlocks) {
      const afterValue = afterBlock.content?.value;
      if (!afterValue?.id) continue;

      const beforeBlock = beforeBlocks.find((b) => b.content?.value?.id === afterValue.id);

      if (!beforeBlock) {
        changes.push(`Section "${sectionLabel}": + new block (type ${afterValue.type})`);
        continue;
      }

      const beforeValue = beforeBlock.content?.value;

      // Text blocks (type 2): compare HTML content
      if (afterValue.type === 2) {
        const beforeHtml = String(beforeValue?.value?.html ?? beforeValue?.value?.source ?? '');
        const afterHtml = String(afterValue.value?.html ?? afterValue.value?.source ?? '');
        if (beforeHtml !== afterHtml) {
          const strip = (html: string) => html.replace(/<[^>]+>/g, '').trim();
          const beforeText = strip(beforeHtml).substring(0, 60);
          const afterText = strip(afterHtml).substring(0, 60);
          changes.push(`Text changed in "${sectionLabel}": "${beforeText}" → "${afterText}"`);
        }
      }

      // Image blocks (type 1337): compare metadata
      if (afterValue.type === 1337) {
        const bv = (beforeValue?.value ?? {}) as Record<string, unknown>;
        const av = (afterValue.value ?? {}) as Record<string, unknown>;
        for (const field of ['title', 'description', 'subtitle']) {
          const beforeField = String(bv[field] ?? '');
          const afterField = String(av[field] ?? '');
          if (beforeField !== afterField) {
            changes.push(`Image ${field} changed in "${sectionLabel}": "${beforeField.substring(0, 40)}" → "${afterField.substring(0, 40)}"`);
          }
        }
      }
    }

    // Removed blocks
    for (const beforeBlock of beforeBlocks) {
      const bid = beforeBlock.content?.value?.id;
      if (!bid) continue;
      if (!afterBlocks.some((b) => b.content?.value?.id === bid)) {
        changes.push(`Section "${sectionLabel}": - removed block (type ${beforeBlock.content?.value?.type})`);
      }
    }
  }

  // Removed sections
  for (const beforeSection of beforeSections) {
    if (!afterSections.some((s) => s.id === beforeSection.id)) {
      const label = beforeSection.sectionName || beforeSection.id.substring(0, 8);
      changes.push(`- Removed section: "${label}"`);
    }
  }

  // Navigation verification for page create/delete operations
  if (options.operationType === 'create_page' || options.operationType === 'delete_page') {
    try {
      const navResult = await client.getNavigation();
      if (navResult.success && navResult.data) {
        const allPages = [...navResult.data.mainNavigation, ...navResult.data.notLinked];
        // Flatten children too (nested pages inside folders)
        const flatPages = allPages.flatMap(p => [p, ...(p.children ?? [])]);
        const slug = options.expectedSlug?.toLowerCase();
        const pageFound = slug
          ? flatPages.some(p => p.urlSlug?.toLowerCase() === slug)
          : false;

        if (options.operationType === 'create_page') {
          if (pageFound) {
            changes.push(`✓ Navigation confirms page "${options.expectedSlug}" exists`);
          } else {
            changes.push(`✗ Navigation: page "${options.expectedSlug}" not found (may need slug check)`);
          }
        } else {
          if (!pageFound) {
            changes.push(`✓ Navigation confirms page "${options.expectedSlug}" removed`);
          } else {
            changes.push(`✗ Navigation: page "${options.expectedSlug}" still present`);
          }
        }
      }
    } catch (navErr) {
      logger.warn({ error: errMsg(navErr) }, 'Supervisor: navigation verification failed');
    }
  }

  const hasChanges = changes.length > 0;
  const summary = hasChanges
    ? `Content Save API detected ${changes.length} change(s):\n${changes.join('\n')}`
    : 'Content Save API detected NO changes between before and after snapshots';

  // Build block inventory from after sections
  const blockSummaries: ExtractedBlockSummary[] = [];
  for (const section of afterSections) {
    for (const gc of section.fluidEngineContext?.gridContents ?? []) {
      const bv = gc.content?.value;
      if (!bv) continue;

      const blockType = bv.type === 2 ? 'text' : bv.type === 1337 ? 'image' : `type-${bv.type}`;
      const stripped = bv.type === 2
        ? String(bv.value?.html ?? bv.value?.source ?? '').replace(/<[^>]+>/g, '').trim()
        : undefined;

      blockSummaries.push({
        type: blockType,
        text: stripped?.substring(0, 150),
        buttonText: bv.value?.label as string | undefined,
        imageAlt: bv.type === 1337 ? (bv.value?.title as string | undefined) : undefined,
        hasImage: bv.type === 1337,
      });
    }
  }

  return {
    available: true,
    summary,
    changesDetected: hasChanges,
    afterBlocks: blockSummaries,
  };
}

/**
 * Format JSON evidence for inclusion in a verification prompt.
 */
function formatJsonEvidenceForPrompt(evidence: JsonVerificationEvidence): string {
  if (!evidence.available) return '';

  const lines: string[] = [
    '## JSON Verification (public page data comparison)',
    '',
    'A before/after comparison of the page\'s structured JSON data was performed:',
    '',
    evidence.summary,
  ];

  // Include block inventory if available (cap at 20 to limit prompt size)
  if (evidence.afterBlocks && evidence.afterBlocks.length > 0) {
    lines.push('');
    lines.push('### Current Page Blocks (after edit):');
    for (const block of evidence.afterBlocks.slice(0, 20)) {
      const parts: string[] = [`- [${block.type}]`];
      if (block.text) parts.push(`text: "${block.text.substring(0, 80)}"`);
      if (block.buttonText) parts.push(`button: "${block.buttonText}"`);
      if (block.hasImage) parts.push(`image: alt="${block.imageAlt ?? 'none'}"`);
      lines.push(parts.join(' '));
    }
  }

  lines.push('');
  if (!evidence.changesDetected) {
    lines.push('WARNING: The JSON diff shows NO changes were made. This is a strong signal that the edit was NOT saved or NOT applied to the public page. However, some changes (like style/layout changes) may not be reflected in the JSON endpoint.');
  } else {
    lines.push('The JSON changes above confirm edits were made to the page content. Cross-reference with the screenshot and DOM evidence to determine if the CORRECT changes were made.');
  }

  return lines.join('\n');
}

// ─── Response Parsers ────────────────────────────────────────────────────────

function parseVerdict(text: string): SupervisorVerdict {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    const parsed = JSON.parse(jsonStr);

    return {
      status: parsed.status ?? 'unclear',
      observedState: parsed.observedState ?? 'Could not determine',
      expectedState: parsed.expectedState ?? 'Unknown',
      diagnosis: parsed.diagnosis,
      correctiveInstructions: parsed.correctiveInstructions,
      confidence: parsed.confidence ?? 0.5,
    };
  } catch {
    logger.warn('Supervisor: could not parse verification response as JSON');
    return {
      status: 'unclear',
      observedState: text.substring(0, 200),
      expectedState: 'Unknown',
      confidence: 0.3,
    };
  }
}

function parseDiagnosis(text: string): {
  diagnosis: string;
  correctiveInstructions: string;
  isRecoverable: boolean;
  confidence: number;
} {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    const parsed = JSON.parse(jsonStr);

    return {
      diagnosis: parsed.diagnosis ?? 'Unknown issue',
      correctiveInstructions: parsed.correctiveInstructions ?? '',
      isRecoverable: parsed.isRecoverable ?? false,
      confidence: parsed.confidence ?? 0.5,
    };
  } catch {
    logger.warn('Supervisor: could not parse diagnosis response as JSON');
    return {
      diagnosis: text.substring(0, 300),
      correctiveInstructions: '',
      isRecoverable: false,
      confidence: 0.3,
    };
  }
}
