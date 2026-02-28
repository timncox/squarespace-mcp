/**
 * Plan Classifier — determines whether a ContentPlan can run via API.
 *
 * Pure logic (no LLM). Inspects each operation's type, contentStrategy,
 * and properties to classify the overall plan as:
 *   - full_api: every operation can be handled by ApiExecutor
 *   - partial_api: some operations can be API, rest need browser
 *   - browser_required: nothing can be routed to API
 */

import type { ContentPlan, ContentOperation } from '../agents/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type PlanApiCapability = 'full_api' | 'partial_api' | 'browser_required';

export interface PlanClassification {
  capability: PlanApiCapability;
  /** Operations that the API executor can handle */
  apiOperations: ContentOperation[];
  /** Operations that require the browser agent */
  browserOperations: ContentOperation[];
  /** Human-readable reason for the classification */
  reason: string;
}

// ── Operation Classification ─────────────────────────────────────────────────

/**
 * Determine whether a single operation can be executed via API.
 *
 * API-capable operations:
 *   - create_page (via createPageViaApi)
 *   - add_section with contentStrategy 'blank_api' (addBlankSection + content fill)
 *   - add_section with contentStrategy 'template' and replacements (copyTemplateSection + replacements)
 *   - add_block (addTextBlock / addButtonBlock / addImageBlock)
 *   - add_gallery (addImageBlockBatch)
 *   - modify_text (patchTextBlock / updateTextBlock)
 *   - replace_image (uploadImage + updateImageBlock)
 *   - remove_block (removeBlock)
 *   - modify_block (updateButtonBlock / updateMenuBlock / updateImageBlock)
 *   - modify_style (editSectionStyle)
 *
 * Browser-required:
 *   - contentStrategy 'manual' (needs full browser control)
 *   - blog posts (createBlogPost is untested via API)
 *   - operations with referenceImagePath (visual context needed)
 */
function canRunViaApi(op: ContentOperation): boolean {
  const { operationType, content } = op;

  // Manual strategy always needs browser
  if (content.contentStrategy === 'manual') return false;

  // Reference image requires visual interpretation
  if (content.imageQuery && !content.imagePath) return false;

  switch (operationType) {
    case 'create_page':
      return true;

    case 'add_section': {
      if (content.contentStrategy === 'blank_api') return true;
      if (content.contentStrategy === 'template') {
        // Template ops need category + index to look up catalog entry
        return !!(content.templateCategory && content.templateIndex != null);
      }
      // No strategy specified — can't route
      return false;
    }

    case 'add_block':
      return true;

    case 'add_gallery':
      return true;

    case 'modify_text':
      return true;

    case 'replace_image':
      // Need either imagePath (local file) for upload, or just metadata update
      return true;

    case 'remove_block':
      return true;

    case 'modify_block':
      return true;

    case 'modify_style':
      return true;

    default:
      // Unknown operation type — assume browser required
      return false;
  }
}

// ── Plan Classification ──────────────────────────────────────────────────────

/**
 * Classify a ContentPlan for API execution capability.
 *
 * Returns which operations can go via API and which need the browser.
 */
export function classifyPlanForApi(plan: ContentPlan): PlanClassification {
  if (!plan.operations || plan.operations.length === 0) {
    return {
      capability: 'browser_required',
      apiOperations: [],
      browserOperations: [],
      reason: 'Plan has no operations',
    };
  }

  const apiOps: ContentOperation[] = [];
  const browserOps: ContentOperation[] = [];

  for (const op of plan.operations) {
    if (canRunViaApi(op)) {
      apiOps.push(op);
    } else {
      browserOps.push(op);
    }
  }

  let capability: PlanApiCapability;
  let reason: string;

  if (browserOps.length === 0) {
    capability = 'full_api';
    reason = `All ${apiOps.length} operations can run via API`;
  } else if (apiOps.length === 0) {
    capability = 'browser_required';
    const reasons = browserOps.map(op => {
      if (op.content.contentStrategy === 'manual') return `${op.operationType}: manual strategy`;
      return `${op.operationType}: not API-capable`;
    });
    reason = `No operations can run via API: ${reasons.join('; ')}`;
  } else {
    capability = 'partial_api';
    reason = `${apiOps.length} via API, ${browserOps.length} via browser`;
  }

  return { capability, apiOperations: apiOps, browserOperations: browserOps, reason };
}
