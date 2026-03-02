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
 *   - add_block (addTextBlock / addButtonBlock / addImageBlock)
 *   - add_gallery (addImageBlockBatch)
 *   - modify_text (patchTextBlock / updateTextBlock)
 *   - replace_image (uploadImage + updateImageBlock)
 *   - remove_block (removeBlock)
 *   - modify_block (updateButtonBlock / updateMenuBlock / updateImageBlock)
 *   - modify_style (editSectionStyle)
 *   - modify_gallery_settings (gallery display settings)
 *   - edit_footer (footer text/content)
 *   - edit_css (custom CSS via cssCode)
 *   - edit_code_injection (header/footer code injection)
 *   - reorder_sections (section reordering via direction or explicit order)
 *   - move_block (block movement via direction)
 *   - resize_block (block resizing via width/height)
 *   - create_blog_post (blog post creation via blogCollectionId)
 *   - update_blog_post (blog post update via blogCollectionId + blogPostId)
 *
 * Browser-required:
 *   - contentStrategy 'manual' (needs full browser control)
 *   - image operations with imageQuery but no imagePath (need stock photo search)
 */
function canRunViaApi(op: ContentOperation): boolean {
  const { operationType, content } = op;

  // Manual strategy always needs browser
  if (content.contentStrategy === 'manual') return false;

  // imageQuery without imagePath only matters for image-centric operations
  // (a modify_text op with imageQuery set as context should still route to API)
  if (content.imageQuery && !content.imagePath) {
    if (operationType === 'replace_image') return false;
    if (operationType === 'add_gallery') return false;
    if (operationType === 'add_block' && content.blockType === 'image') return false;
  }

  switch (operationType) {
    case 'create_page':
    case 'delete_page':
    case 'update_page_metadata':
      return true;

    case 'add_section': {
      if (content.contentStrategy === 'blank_api') return true;
      // Infer blank_api when apiBlocks are present but strategy wasn't explicitly set
      if (content.apiBlocks && content.apiBlocks.length > 0) return true;
      // Template strategy with category + index — API can copy template sections
      if (content.contentStrategy === 'template' && content.templateCategory && content.templateIndex !== undefined) return true;
      // No strategy specified (or template without required fields) — can't route via API
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

    case 'modify_gallery_settings':
      return true;

    case 'edit_footer':
      return true;

    case 'edit_css':
      return !!content.cssCode;

    case 'edit_code_injection':
      return !!(content.codeInjectionHeader || content.codeInjectionFooter);

    case 'reorder_sections':
      return !!(content.sectionDirection || content.sectionOrder);

    case 'move_block':
      return !!content.blockDirection;

    case 'resize_block':
      return !!(content.blockWidth || content.blockHeight);

    case 'create_blog_post':
      return !!content.blogCollectionId;

    case 'update_blog_post':
      return !!(content.blogCollectionId && content.blogPostId);

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
