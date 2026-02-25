/**
 * Post-operation content validation — lightweight "micro-verification" that runs
 * inline after each operation to catch drift and errors immediately, rather than
 * waiting for the full supervisor cycle at the end.
 *
 * Reads the current page state via Content Save API and checks that the expected
 * content actually landed. Never throws — always returns a result so execution
 * can continue even if validation fails.
 */

import type { ContentOperation } from '../agents/types.js';
import type { ContentSaveClient, PageSection } from './content-save.js';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ValidationResult {
  passed: boolean;
  operationType: string;
  checks: ValidationCheck[];
  summary: string;
}

export interface ValidationCheck {
  /** e.g., "text_content_match", "section_exists", "block_count" */
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

/** Snapshot of section state before an operation, for before/after comparison. */
export interface PreOperationSnapshot {
  sectionCount: number;
  /** Block counts per section index */
  blockCounts: Map<number, number>;
  /** Captured at this timestamp */
  capturedAt: number;
}

// ── Text Matching ───────────────────────────────────────────────────────────

/**
 * Strip HTML tags, decode common entities, and normalize whitespace.
 * Exported for use by validation logic and tests.
 */
export function stripHtmlForComparison(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fuzzy content comparison: strip HTML, normalize whitespace, compare using
 * a simple longest-common-subsequence ratio.
 *
 * @param expected  The text we wanted to see (may be HTML or plain text)
 * @param actual    The text we actually found (may be HTML or plain text)
 * @param threshold Similarity ratio (0–1, default 0.8) required to pass
 * @returns true if the texts are similar enough
 */
export function contentMatches(
  expected: string,
  actual: string,
  threshold: number = 0.8,
): boolean {
  const a = stripHtmlForComparison(expected).toLowerCase();
  const b = stripHtmlForComparison(actual).toLowerCase();

  // Exact match (fast path)
  if (a === b) return true;

  // Empty expected always fails unless actual is also empty
  if (a.length === 0) return b.length === 0;

  // Containment check: if expected is fully contained in actual, pass
  if (b.includes(a)) return true;

  // LCS-based similarity ratio
  const ratio = similarityRatio(a, b);
  return ratio >= threshold;
}

/**
 * Compute similarity ratio between two strings using a simple
 * longest-common-subsequence approach. Returns 0–1.
 *
 * Uses an optimized space approach (two rows only) to keep memory
 * reasonable for typical block content (< 2000 chars).
 */
export function similarityRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // For very long strings, fall back to a cheaper heuristic (word overlap)
  if (a.length > 2000 || b.length > 2000) {
    return wordOverlapRatio(a, b);
  }

  const m = a.length;
  const n = b.length;
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    // Swap rows
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  const lcsLen = prev[n];
  const maxLen = Math.max(m, n);
  return lcsLen / maxLen;
}

/**
 * Word-level overlap ratio for long texts. Cheaper than character-level LCS.
 */
function wordOverlapRatio(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ── Snapshot Capture ────────────────────────────────────────────────────────

/**
 * Capture a lightweight snapshot of the current page state before an operation.
 * Used for before/after comparison in section and block count checks.
 */
export async function capturePreSnapshot(
  client: ContentSaveClient,
  pageSectionsId: string,
): Promise<PreOperationSnapshot | null> {
  try {
    const data = await client.getPageSections(pageSectionsId);
    const sections = data.sections ?? [];
    const blockCounts = new Map<number, number>();
    for (let i = 0; i < sections.length; i++) {
      blockCounts.set(i, sections[i].fluidEngineContext?.gridContents?.length ?? 0);
    }
    return {
      sectionCount: sections.length,
      blockCounts,
      capturedAt: Date.now(),
    };
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'content-validator: failed to capture pre-operation snapshot');
    return null;
  }
}

// ── Core Validation ─────────────────────────────────────────────────────────

/**
 * Validate that an operation's expected outcome matches the current page state.
 *
 * This is a lightweight check — it reads the page sections via API and verifies
 * key properties (section count, block content, etc.) without taking screenshots
 * or running the full supervisor LLM.
 *
 * @param operation     The content operation that was just executed
 * @param client        An authenticated ContentSaveClient
 * @param pageSectionsId  The page sections ID for API reads
 * @param preSnapshot   Optional pre-operation snapshot for before/after comparison
 * @returns ValidationResult — never throws
 */
export async function validateOperation(
  operation: ContentOperation,
  client: ContentSaveClient,
  pageSectionsId: string,
  preSnapshot?: PreOperationSnapshot | null,
): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];
  const opType = operation.operationType;

  try {
    const data = await client.getPageSections(pageSectionsId);
    const sections = data.sections ?? [];

    switch (opType) {
      case 'add_section':
        validateAddSection(checks, sections, preSnapshot);
        break;

      case 'modify_text':
        validateModifyText(checks, sections, operation);
        break;

      case 'add_block':
        validateAddBlock(checks, sections, operation, preSnapshot);
        break;

      case 'remove_block':
        validateRemoveBlock(checks, sections, operation, preSnapshot);
        break;

      case 'replace_image':
        validateReplaceImage(checks, sections, operation);
        break;

      case 'modify_style':
        validateModifyStyle(checks, sections, operation);
        break;

      default:
        // For unknown operation types, just confirm we can read sections
        checks.push({
          name: 'api_readable',
          passed: true,
          expected: 'Page sections readable via API',
          actual: `${sections.length} sections found`,
        });
        break;
    }
  } catch (err) {
    checks.push({
      name: 'api_read',
      passed: false,
      expected: 'Able to read page sections via API',
      actual: `API error: ${errMsg(err)}`,
    });
  }

  const allPassed = checks.length > 0 && checks.every((c) => c.passed);
  const failedChecks = checks.filter((c) => !c.passed);
  const summary = allPassed
    ? `All ${checks.length} checks passed for ${opType}`
    : `${failedChecks.length}/${checks.length} checks failed for ${opType}: ${failedChecks.map((c) => c.name).join(', ')}`;

  if (!allPassed) {
    logger.warn(
      { opType, failedChecks: failedChecks.map((c) => ({ name: c.name, expected: c.expected, actual: c.actual })) },
      `content-validator: validation failed — ${summary}`,
    );
  } else {
    logger.info({ opType, checkCount: checks.length }, `content-validator: all checks passed`);
  }

  return { passed: allPassed, operationType: opType, checks, summary };
}

// ── Per-Type Validators ─────────────────────────────────────────────────────

function validateAddSection(
  checks: ValidationCheck[],
  sections: PageSection[],
  preSnapshot?: PreOperationSnapshot | null,
): void {
  if (preSnapshot) {
    const countIncreased = sections.length > preSnapshot.sectionCount;
    checks.push({
      name: 'section_count_increased',
      passed: countIncreased,
      expected: `> ${preSnapshot.sectionCount} sections`,
      actual: `${sections.length} sections`,
    });
  }

  // Check the last section exists and has fluid engine context
  const lastSection = sections[sections.length - 1];
  if (lastSection) {
    checks.push({
      name: 'new_section_exists',
      passed: true,
      expected: 'New section at end of page',
      actual: `Section "${lastSection.sectionName}" (id: ${lastSection.id})`,
    });
  } else {
    checks.push({
      name: 'new_section_exists',
      passed: false,
      expected: 'At least one section on page',
      actual: '0 sections found',
    });
  }
}

function validateModifyText(
  checks: ValidationCheck[],
  sections: PageSection[],
  operation: ContentOperation,
): void {
  // Check that the expected text content can be found in the page
  const expectedTexts: string[] = [];
  if (operation.content.heading) expectedTexts.push(operation.content.heading);
  if (operation.content.bodyText) expectedTexts.push(operation.content.bodyText);

  if (expectedTexts.length === 0) {
    checks.push({
      name: 'text_content_specified',
      passed: false,
      expected: 'Operation should specify heading or bodyText',
      actual: 'No expected text content in operation',
    });
    return;
  }

  // Gather all text from all blocks on the page
  const allBlockTexts = extractAllBlockTexts(sections);

  for (const expected of expectedTexts) {
    const found = allBlockTexts.some((blockText) => contentMatches(expected, blockText));
    checks.push({
      name: 'text_content_match',
      passed: found,
      expected: truncate(expected, 120),
      actual: found
        ? 'Found matching text block'
        : `Not found in ${allBlockTexts.length} text blocks`,
    });
  }
}

function validateAddBlock(
  checks: ValidationCheck[],
  sections: PageSection[],
  operation: ContentOperation,
  preSnapshot?: PreOperationSnapshot | null,
): void {
  // Check block count increased in at least one section
  if (preSnapshot) {
    const currentTotalBlocks = sections.reduce(
      (sum, s) => sum + (s.fluidEngineContext?.gridContents?.length ?? 0),
      0,
    );
    const preTotalBlocks = Array.from(preSnapshot.blockCounts.values()).reduce((a, b) => a + b, 0);

    checks.push({
      name: 'block_count_increased',
      passed: currentTotalBlocks > preTotalBlocks,
      expected: `> ${preTotalBlocks} total blocks`,
      actual: `${currentTotalBlocks} total blocks`,
    });
  }

  // Check for expected text content in new blocks
  const apiBlocks = operation.content.apiBlocks;
  if (apiBlocks && apiBlocks.length > 0) {
    const allBlockTexts = extractAllBlockTexts(sections);

    for (let i = 0; i < apiBlocks.length; i++) {
      const expectedText = stripHtmlForComparison(apiBlocks[i].html);
      if (expectedText.length === 0) continue;

      // Use a shorter snippet for matching (first 80 chars) to avoid minor truncation issues
      const snippet = expectedText.substring(0, 80);
      const found = allBlockTexts.some((bt) => contentMatches(snippet, bt, 0.6));

      checks.push({
        name: 'block_text_present',
        passed: found,
        expected: truncate(expectedText, 100),
        actual: found
          ? 'Found matching content'
          : `Not found in ${allBlockTexts.length} text blocks`,
      });
    }
  }
}

function validateRemoveBlock(
  checks: ValidationCheck[],
  sections: PageSection[],
  operation: ContentOperation,
  preSnapshot?: PreOperationSnapshot | null,
): void {
  if (preSnapshot) {
    const currentTotalBlocks = sections.reduce(
      (sum, s) => sum + (s.fluidEngineContext?.gridContents?.length ?? 0),
      0,
    );
    const preTotalBlocks = Array.from(preSnapshot.blockCounts.values()).reduce((a, b) => a + b, 0);

    checks.push({
      name: 'block_count_decreased',
      passed: currentTotalBlocks < preTotalBlocks,
      expected: `< ${preTotalBlocks} total blocks`,
      actual: `${currentTotalBlocks} total blocks`,
    });
  }

  // Check the removed text is no longer present
  const heading = operation.content.heading;
  if (heading) {
    const allBlockTexts = extractAllBlockTexts(sections);
    const stillPresent = allBlockTexts.some((bt) => contentMatches(heading, bt, 0.9));

    checks.push({
      name: 'removed_text_absent',
      passed: !stillPresent,
      expected: `Text "${truncate(heading, 60)}" should be absent`,
      actual: stillPresent ? 'Text still found on page' : 'Text not found (good)',
    });
  }
}

function validateReplaceImage(
  checks: ValidationCheck[],
  sections: PageSection[],
  operation: ContentOperation,
): void {
  const expectedAlt = operation.content.imageAltText;
  if (!expectedAlt) {
    checks.push({
      name: 'image_alt_specified',
      passed: false,
      expected: 'Operation should specify imageAltText',
      actual: 'No imageAltText in operation',
    });
    return;
  }

  // Search all image blocks for matching alt text
  const imageBlocks = extractImageBlocks(sections);
  const found = imageBlocks.some((img) => {
    const altMatch = img.altText && contentMatches(expectedAlt, img.altText, 0.7);
    const titleMatch = img.title && contentMatches(expectedAlt, img.title, 0.7);
    return altMatch || titleMatch;
  });

  checks.push({
    name: 'image_alt_match',
    passed: found,
    expected: truncate(expectedAlt, 80),
    actual: found
      ? 'Found image block with matching alt/title'
      : `Not found in ${imageBlocks.length} image blocks`,
  });
}

function validateModifyStyle(
  checks: ValidationCheck[],
  sections: PageSection[],
  operation: ContentOperation,
): void {
  // Style validation is limited — we can check if the section exists but
  // most style properties aren't exposed in the sections JSON directly.
  // Just verify the page is readable and has sections.
  checks.push({
    name: 'page_readable',
    passed: sections.length > 0,
    expected: 'Page has sections after style modification',
    actual: `${sections.length} sections found`,
  });

  // If sectionTheme is specified, look for it in section data
  const expectedTheme = operation.content.sectionTheme;
  if (expectedTheme) {
    // Squarespace stores theme in section.designConfig or similar — best-effort check
    const anySection = sections.find((s) => {
      const raw = JSON.stringify(s);
      return raw.toLowerCase().includes(expectedTheme.toLowerCase());
    });

    checks.push({
      name: 'section_theme_match',
      passed: !!anySection,
      expected: `Theme "${expectedTheme}" applied to a section`,
      actual: anySection
        ? `Found theme reference in section "${anySection.sectionName}"`
        : `Theme "${expectedTheme}" not found in section data`,
    });
  }
}

// ── Block Extraction Helpers ────────────────────────────────────────────────

/** Extract plain text from all text blocks across all sections. */
function extractAllBlockTexts(sections: PageSection[]): string[] {
  const texts: string[] = [];
  for (const section of sections) {
    const contents = section.fluidEngineContext?.gridContents ?? [];
    for (const gc of contents) {
      const bv = gc.content?.value;
      if (!bv) continue;

      // Text blocks (type 2)
      if (bv.type === 2) {
        const html = bv.value?.html ?? bv.value?.source ?? '';
        if (html) texts.push(stripHtmlForComparison(html));
      }

      // Any block with value.text or value.label
      if (bv.value?.text) texts.push(String(bv.value.text));
      if (bv.value?.label) texts.push(String(bv.value.label));
    }
  }
  return texts;
}

/** Extract image block metadata from all sections. */
function extractImageBlocks(sections: PageSection[]): Array<{
  title?: string;
  altText?: string;
  description?: string;
}> {
  const images: Array<{ title?: string; altText?: string; description?: string }> = [];
  for (const section of sections) {
    const contents = section.fluidEngineContext?.gridContents ?? [];
    for (const gc of contents) {
      const bv = gc.content?.value;
      if (!bv || bv.type !== 1337) continue; // 1337 = image block

      images.push({
        title: bv.value?.title as string | undefined,
        altText: (bv.value?.altText ?? bv.value?.title) as string | undefined,
        description: bv.value?.description as string | undefined,
      });
    }
  }
  return images;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** Truncate a string with ellipsis. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}

/**
 * Format validation results for inclusion in the supervisor prompt.
 * Used to give the supervisor additional evidence from inline checks.
 */
export function formatValidationForSupervisor(results: ValidationResult[]): string {
  if (results.length === 0) return '';

  const lines = ['## Inline Validation Results', ''];
  let passCount = 0;
  let failCount = 0;

  for (const result of results) {
    const icon = result.passed ? 'PASS' : 'FAIL';
    lines.push(`### ${icon}: ${result.operationType}`);
    passCount += result.passed ? 1 : 0;
    failCount += result.passed ? 0 : 1;

    for (const check of result.checks) {
      const checkIcon = check.passed ? '[OK]' : '[FAIL]';
      lines.push(`  ${checkIcon} ${check.name}: expected "${check.expected}", actual "${check.actual}"`);
    }
    lines.push('');
  }

  lines.push(`Summary: ${passCount} passed, ${failCount} failed out of ${results.length} operations.`);

  return lines.join('\n');
}
