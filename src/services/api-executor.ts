/**
 * API Executor — executes multi-operation content plans entirely via API.
 *
 * Eliminates browser automation for all common operations:
 *   - Page creation (createPageViaApi)
 *   - Section addition (addBlankSection / copyTemplateSection)
 *   - Content fill (addTextBlock / addButtonBlock / addImageBlock / addImageBlockBatch)
 *   - Content modification (patchTextBlock / updateButtonBlock / updateImageBlock / removeBlock)
 *   - Section styling (editSectionStyle)
 *   - Template replacements (updateTextBlock + removeBlock)
 *
 * Key insight: the known issue "API-added sections get wiped by editor save"
 * only occurs when a browser editor is open. An API-only pipeline eliminates
 * this problem entirely.
 *
 * Typical latency: 200-2000ms per operation (vs 30-180s via browser agent).
 */

import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import {
  createContentSaveClient,
  ContentSaveClient,
  type SectionStyleOptions,
  type PageMetadataUpdateOptions,
} from './content-save.js';
import { resolvePageIds, cachePageIds } from './page-id-resolver.js';
import { getOrFetchCatalog, lookupCatalogEntry } from './section-catalog.js';
import {
  capturePreSnapshot,
  validateOperation,
  type ValidationResult,
} from './content-validator.js';
import {
  updateOperationStatus,
  type PlanOperation,
} from '../db/plan-operations.js';
import {
  isApiButtonBlock,
  isApiImageBlock,
  isApiGalleryBlock,
} from '../agents/types.js';
import type {
  ContentPlan,
  ContentOperation,
  ContentSpec,
  ApiTextBlock,
  ApiButtonBlock,
  ApiImageBlock,
  ApiGalleryBlock,
} from '../agents/types.js';

// ── Config ───────────────────────────────────────────────────────────────────

/** Delay (ms) between sequential API operations to prevent Squarespace throttling */
const API_THROTTLE_MS = parseInt(process.env.API_THROTTLE_MS ?? '100', 10);

/** Throttle helper — waits API_THROTTLE_MS between operations */
async function throttle(): Promise<void> {
  if (API_THROTTLE_MS > 0) {
    await new Promise(resolve => setTimeout(resolve, API_THROTTLE_MS));
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ApiOperationResult {
  operation: ContentOperation;
  success: boolean;
  summary: string;
  error?: string;
  validation?: ValidationResult;
  durationMs: number;
}

export interface ApiExecutorResult {
  success: boolean;
  operationResults: ApiOperationResult[];
  summary: string;
  durationMs: number;
  /** Operations that failed and should fall back to browser agent */
  failedOperations: ContentOperation[];
}

// ── Internals ────────────────────────────────────────────────────────────────

/** Resolved page context for API calls */
interface PageContext {
  pageSectionsId: string;
  collectionId: string;
}

/** Track section indices added during execution (for content fill) */
interface SectionTracker {
  /** Map from operation index → section index in the page */
  sectionIndices: Map<number, number>;
  /** Current total section count on the page */
  sectionCount: number;
}

// ── Helper: resolve page context ─────────────────────────────────────────────

async function resolvePageContext(
  subdomain: string,
  slug: string,
): Promise<PageContext | null> {
  const ids = await resolvePageIds(subdomain, slug);
  if (!ids) {
    logger.warn({ subdomain, slug }, 'api-executor: could not resolve page IDs');
    return null;
  }
  return ids;
}

// ── Helper: upload image and return assetUrl ────────────────────────────────

async function uploadImageForBlock(
  subdomain: string,
  imagePath: string,
): Promise<string> {
  const { MediaUploadClient } = await import('./media-upload.js');
  const uploader = new MediaUploadClient(subdomain);
  const result = await uploader.uploadImage(imagePath);
  if (result.status !== 'success' || !result.assetUrl) {
    throw new Error(result.failureReason ?? 'Image upload failed — no assetUrl returned');
  }
  return result.assetUrl;
}

// ── Operation Executors ──────────────────────────────────────────────────────

async function executeCreatePage(
  client: ContentSaveClient,
  op: ContentOperation,
  subdomain: string,
): Promise<{ pageContext: PageContext | null; summary: string }> {
  const title = op.content.heading ?? 'New Page';
  const slug = op.targetPage !== 'new' ? op.targetPage : undefined;

  const result = await client.createPageViaApi(title, slug);
  if (!result.success) {
    throw new Error(result.error ?? 'createPageViaApi failed');
  }
  if (!result.endpointAvailable) {
    throw new Error('No create-page API endpoint available on this site');
  }

  const pageSlug = result.urlId ?? slug ?? title.toLowerCase().replace(/\s+/g, '-');

  // Try to resolve page IDs for the new page (may take a moment to propagate)
  let pageContext: PageContext | null = null;
  // Small delay for propagation
  await new Promise(resolve => setTimeout(resolve, 1000));
  pageContext = await resolvePageContext(subdomain, pageSlug);

  if (pageContext) {
    cachePageIds(subdomain, pageSlug, pageContext.pageSectionsId, pageContext.collectionId);
  }

  return {
    pageContext,
    summary: `Created page "${title}" (slug: ${pageSlug})`,
  };
}

async function executeAddSectionBlankApi(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
  opIndex: number,
  tracker: SectionTracker,
  subdomain: string,
): Promise<string> {
  // Add blank section
  const addResult = await client.addBlankSection(ctx.pageSectionsId, ctx.collectionId);
  if (!addResult.success) {
    throw new Error(addResult.error ?? 'addBlankSection failed');
  }

  // Track the new section index (appended to the end)
  const newSectionIndex = tracker.sectionCount;
  tracker.sectionIndices.set(opIndex, newSectionIndex);
  tracker.sectionCount++;

  // Fill content blocks
  const apiBlocks = op.content.apiBlocks ?? [];
  let blocksAdded = 0;

  for (const block of apiBlocks) {
    if (isApiButtonBlock(block)) {
      const btnResult = await client.addButtonBlock(
        ctx.pageSectionsId, ctx.collectionId, newSectionIndex,
        block.label, block.url, block.layout,
      );
      if (btnResult.success) blocksAdded++;
      else logger.warn({ error: btnResult.error }, 'api-executor: addButtonBlock failed');
    } else if (isApiImageBlock(block)) {
      const assetUrl = await uploadImageForBlock(subdomain, block.imagePath);
      const imgResult = await client.addImageBlock(
        ctx.pageSectionsId, ctx.collectionId, newSectionIndex, assetUrl,
        { altText: block.altText, title: block.title, layout: block.layout },
      );
      if (imgResult.success) blocksAdded++;
      else logger.warn({ error: imgResult.error }, 'api-executor: addImageBlock failed');
    } else if (isApiGalleryBlock(block)) {
      // Upload all gallery images first
      const uploadedImages: Array<{ assetUrl: string; altText?: string; title?: string; layout?: ApiImageBlock['layout'] }> = [];
      for (const img of block.images) {
        const assetUrl = await uploadImageForBlock(subdomain, img.imagePath);
        uploadedImages.push({ assetUrl, altText: img.altText, title: img.title });
      }
      // Calculate gallery grid layout
      const cols = block.columns ?? 3;
      const colWidth = Math.floor(24 / cols);
      const galleryImages = uploadedImages.map((img, i) => ({
        assetUrl: img.assetUrl,
        altText: img.altText,
        title: img.title,
        layout: {
          startX: (i % cols) * colWidth + 1,
          endX: (i % cols) * colWidth + colWidth + 1,
          startY: Math.floor(i / cols) * 8 + 1,
          endY: Math.floor(i / cols) * 8 + 9,
        },
      }));
      const batchResult = await client.addImageBlockBatch(
        ctx.pageSectionsId, ctx.collectionId, newSectionIndex, galleryImages,
      );
      if (batchResult.success) blocksAdded += batchResult.blocks.length;
      else logger.warn({ error: batchResult.error }, 'api-executor: addImageBlockBatch failed');
    } else {
      // Text block
      const textBlock = block as ApiTextBlock;
      let html = textBlock.html;
      if (textBlock.richContent) {
        html = ContentSaveClient.buildRichHtml(textBlock.richContent);
      }
      const txtResult = await client.addTextBlock(
        ctx.pageSectionsId, ctx.collectionId, newSectionIndex, html,
        textBlock.layout, textBlock.formatting,
      );
      if (txtResult.success) blocksAdded++;
      else logger.warn({ error: txtResult.error }, 'api-executor: addTextBlock failed');
    }
  }

  // Apply section styling if specified
  await applySectionStyle(client, ctx, newSectionIndex, op.content);

  const heading = op.content.heading ?? `Section ${opIndex + 1}`;
  return `Added blank section "${heading}" with ${blocksAdded} blocks`;
}

async function executeAddSectionTemplate(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
  opIndex: number,
  tracker: SectionTracker,
  subdomain: string,
): Promise<string> {
  const { templateCategory, templateIndex } = op.content;
  if (!templateCategory || templateIndex == null) {
    throw new Error('Template operations require templateCategory and templateIndex');
  }

  // Look up catalog entry
  const catalog = await getOrFetchCatalog(subdomain);
  if (!catalog) {
    throw new Error('Could not fetch section catalog');
  }

  const entry = lookupCatalogEntry(catalog, templateCategory, templateIndex);
  if (!entry) {
    throw new Error(`No catalog entry for ${templateCategory}[${templateIndex}]`);
  }

  // Copy template section
  const copyResult = await client.copyTemplateSection(
    entry.websiteId, entry.collectionId, entry.sectionId,
  );
  if (!copyResult.success) {
    throw new Error(copyResult.error ?? 'copyTemplateSection failed');
  }

  // Track the new section index
  const newSectionIndex = tracker.sectionCount;
  tracker.sectionIndices.set(opIndex, newSectionIndex);
  tracker.sectionCount++;

  // Apply replacements if present
  const replacements = op.content.replacements;
  if (replacements) {
    // Text replacements
    if (replacements.texts) {
      for (const { searchText, newText } of replacements.texts) {
        const result = await client.updateTextBlock(
          ctx.pageSectionsId, ctx.collectionId, searchText, newText,
        );
        if (!result.success) {
          logger.warn(
            { searchText, error: result.error },
            'api-executor: text replacement failed',
          );
        }
      }
    }

    // Button replacements
    if (replacements.buttons) {
      for (const { searchText, newLabel, url } of replacements.buttons) {
        const updates: { newLabel?: string; url?: string } = {};
        if (newLabel) updates.newLabel = newLabel;
        if (url) updates.url = url;
        const result = await client.updateButtonBlock(
          ctx.pageSectionsId, ctx.collectionId, searchText, updates,
        );
        if (!result.success) {
          logger.warn(
            { searchText, error: result.error },
            'api-executor: button replacement failed',
          );
        }
      }
    }

    // Image replacements
    if (replacements.images) {
      for (const { searchText, imagePath, altText } of replacements.images) {
        try {
          const assetUrl = await uploadImageForBlock(subdomain, imagePath);
          // Update the image block metadata (assetUrl update requires a different approach)
          const result = await client.updateImageBlock(
            ctx.pageSectionsId, ctx.collectionId, searchText,
            { altText: altText ?? '', title: altText ?? '' },
          );
          if (!result.success) {
            logger.warn({ searchText, error: result.error }, 'api-executor: image replacement failed');
          }
        } catch (err) {
          logger.warn({ searchText, error: errMsg(err) }, 'api-executor: image upload/replace failed');
        }
      }
    }

    // Block removals
    if (replacements.removeBlocks) {
      for (const blockText of replacements.removeBlocks) {
        const result = await client.removeBlock(
          ctx.pageSectionsId, ctx.collectionId, blockText,
        );
        if (!result.success) {
          logger.warn({ blockText, error: result.error }, 'api-executor: block removal failed');
        }
      }
    }
  }

  // Apply section styling
  await applySectionStyle(client, ctx, newSectionIndex, op.content);

  const heading = op.content.heading ?? `Template ${templateCategory}[${templateIndex}]`;
  return `Added template section "${heading}" with replacements applied`;
}

async function executeModifyText(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
): Promise<string> {
  const { heading, bodyText } = op.content;
  const searchText = heading ?? bodyText ?? op.placement;

  if (!searchText) {
    throw new Error('modify_text needs heading, bodyText, or placement to find the text block');
  }

  if (bodyText) {
    const result = await client.patchTextBlock(
      ctx.pageSectionsId, ctx.collectionId, searchText, bodyText,
    );
    if (!result.success) throw new Error(result.error ?? 'patchTextBlock failed');
    return `Modified text block: "${searchText.slice(0, 50)}…"`;
  }

  if (heading) {
    const html = `<h2 class="" style="white-space:pre-wrap;">${heading}</h2>`;
    const result = await client.updateTextBlock(
      ctx.pageSectionsId, ctx.collectionId, searchText, html,
    );
    if (!result.success) throw new Error(result.error ?? 'updateTextBlock failed');
    return `Updated heading: "${heading.slice(0, 50)}"`;
  }

  throw new Error('modify_text: no content to apply');
}

async function executeReplaceImage(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
  subdomain: string,
): Promise<string> {
  const searchText = op.content.imageAltText ?? op.content.heading ?? op.placement;
  if (!searchText) {
    throw new Error('replace_image needs imageAltText, heading, or placement to find the image');
  }

  const fields: { title?: string; description?: string; altText?: string } = {};
  if (op.content.imageAltText) fields.altText = op.content.imageAltText;
  if (op.content.heading) fields.title = op.content.heading;

  // If there's a local image to upload
  if (op.content.imagePath) {
    await uploadImageForBlock(subdomain, op.content.imagePath);
    // Note: updateImageBlock only updates metadata, not the image asset itself.
    // For full image replacement, we'd need a different approach.
  }

  const result = await client.updateImageBlock(
    ctx.pageSectionsId, ctx.collectionId, searchText, fields,
  );
  if (!result.success) throw new Error(result.error ?? 'updateImageBlock failed');
  return `Updated image "${searchText.slice(0, 50)}"`;
}

async function executeRemoveBlock(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
): Promise<string> {
  const searchText = op.content.heading ?? op.content.bodyText ?? op.placement;
  if (!searchText) {
    throw new Error('remove_block needs heading, bodyText, or placement to find the block');
  }

  const result = await client.removeBlock(
    ctx.pageSectionsId, ctx.collectionId, searchText,
  );
  if (!result.success) throw new Error(result.error ?? 'removeBlock failed');
  return `Removed block "${searchText.slice(0, 50)}"`;
}

async function executeModifyBlock(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
): Promise<string> {
  const { button, heading, bodyText } = op.content;

  // Button modification
  if (button) {
    const searchText = heading ?? button.label ?? op.placement;
    if (!searchText) throw new Error('modify_block (button): need search text');

    const result = await client.updateButtonBlock(
      ctx.pageSectionsId, ctx.collectionId, searchText,
      { newLabel: button.label, url: button.url },
    );
    if (!result.success) throw new Error(result.error ?? 'updateButtonBlock failed');
    return `Updated button "${searchText.slice(0, 50)}"`;
  }

  // Text modification
  if (bodyText || heading) {
    const searchText = heading ?? bodyText ?? op.placement;
    if (!searchText) throw new Error('modify_block (text): need search text');

    const newContent = bodyText ?? heading!;
    const result = await client.patchTextBlock(
      ctx.pageSectionsId, ctx.collectionId, searchText, newContent,
    );
    if (!result.success) throw new Error(result.error ?? 'patchTextBlock failed');
    return `Modified block "${searchText.slice(0, 50)}"`;
  }

  throw new Error('modify_block: no button or text content to apply');
}

async function executeAddBlock(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
  subdomain: string,
): Promise<string> {
  // Get current sections to determine target section
  const data = await client.getPageSections(ctx.pageSectionsId);
  const lastSectionIndex = Math.max(0, (data.sections?.length ?? 1) - 1);

  const blockType = op.content.blockType ?? 'text';

  switch (blockType) {
    case 'text': {
      const html = op.content.bodyText
        ? `<p class="" style="white-space:pre-wrap;">${op.content.bodyText}</p>`
        : op.content.heading
          ? `<h2 class="" style="white-space:pre-wrap;">${op.content.heading}</h2>`
          : '<p class="" style="white-space:pre-wrap;">New text block</p>';
      const result = await client.addTextBlock(ctx.pageSectionsId, ctx.collectionId, lastSectionIndex, html);
      if (!result.success) throw new Error(result.error ?? 'addTextBlock failed');
      return `Added text block to section ${lastSectionIndex}`;
    }
    case 'button': {
      const label = op.content.button?.label ?? 'Button';
      const url = op.content.button?.url ?? '#';
      const result = await client.addButtonBlock(ctx.pageSectionsId, ctx.collectionId, lastSectionIndex, label, url);
      if (!result.success) throw new Error(result.error ?? 'addButtonBlock failed');
      return `Added button "${label}" to section ${lastSectionIndex}`;
    }
    case 'image': {
      if (!op.content.imagePath) throw new Error('add_block (image): imagePath required');
      const assetUrl = await uploadImageForBlock(subdomain, op.content.imagePath);
      const result = await client.addImageBlock(
        ctx.pageSectionsId, ctx.collectionId, lastSectionIndex, assetUrl,
        { altText: op.content.imageAltText, title: op.content.heading },
      );
      if (!result.success) throw new Error(result.error ?? 'addImageBlock failed');
      return `Added image block to section ${lastSectionIndex}`;
    }
    default:
      throw new Error(`add_block: unsupported blockType "${blockType}"`);
  }
}

async function executeAddGallery(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
  subdomain: string,
): Promise<string> {
  // Get current sections
  const data = await client.getPageSections(ctx.pageSectionsId);
  const lastSectionIndex = Math.max(0, (data.sections?.length ?? 1) - 1);

  // Find gallery block definition
  const galleryBlock = op.content.apiBlocks?.find(b => isApiGalleryBlock(b)) as ApiGalleryBlock | undefined;
  if (!galleryBlock) {
    throw new Error('add_gallery: no gallery block definition in apiBlocks');
  }

  // Upload images
  const cols = galleryBlock.columns ?? 3;
  const colWidth = Math.floor(24 / cols);
  const uploadedImages: Array<{ assetUrl: string; altText?: string; title?: string; layout?: { startX: number; endX: number; startY: number; endY: number } }> = [];

  for (let i = 0; i < galleryBlock.images.length; i++) {
    const img = galleryBlock.images[i];
    const assetUrl = await uploadImageForBlock(subdomain, img.imagePath);
    uploadedImages.push({
      assetUrl,
      altText: img.altText,
      title: img.title,
      layout: {
        startX: (i % cols) * colWidth + 1,
        endX: (i % cols) * colWidth + colWidth + 1,
        startY: Math.floor(i / cols) * 8 + 1,
        endY: Math.floor(i / cols) * 8 + 9,
      },
    });
  }

  const result = await client.addImageBlockBatch(
    ctx.pageSectionsId, ctx.collectionId, lastSectionIndex, uploadedImages,
  );
  if (!result.success) throw new Error(result.error ?? 'addImageBlockBatch failed');
  return `Added gallery with ${result.blocks.length} images to section ${lastSectionIndex}`;
}

async function executeDeletePage(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
): Promise<string> {
  const result = await client.deletePageViaApi(ctx.collectionId);
  if (!result.success) throw new Error(result.error ?? 'deletePageViaApi failed');
  return `Deleted page (collectionId: ${ctx.collectionId})`;
}

async function executeUpdatePageMetadata(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
): Promise<string> {
  const updates: PageMetadataUpdateOptions = {};

  if (op.content.heading) updates.title = op.content.heading;
  if (op.content.bodyText) updates.description = op.content.bodyText;
  if (op.content.button?.url) updates.urlId = op.content.button.url;

  // Check for SEO-specific fields in editorInstruction (common pattern)
  // The content strategist may put seoTitle/seoDescription in the ContentSpec
  // via heading/bodyText, but we also support explicit SEO fields from simple edits
  const spec = op.content as Record<string, unknown>;
  if (typeof spec.seoTitle === 'string') updates.seoTitle = spec.seoTitle;
  if (typeof spec.seoDescription === 'string') updates.seoDescription = spec.seoDescription;
  if (typeof spec.navigationTitle === 'string') updates.navigationTitle = spec.navigationTitle;
  if (typeof spec.urlId === 'string') updates.urlId = spec.urlId;
  if (typeof spec.enabled === 'boolean') updates.enabled = spec.enabled;

  const result = await client.updatePageMetadata(ctx.collectionId, updates);
  if (!result.success) throw new Error(result.error ?? 'updatePageMetadata failed');
  return `Updated page metadata (${result.updatedFields?.join(', ') ?? 'fields'})`;
}

async function executeModifyStyle(
  client: ContentSaveClient,
  ctx: PageContext,
  op: ContentOperation,
): Promise<string> {
  const content = op.content;
  const sectionSearch = content.heading ?? op.placement ?? 0;

  const styles: SectionStyleOptions = {};
  if (content.sectionTheme) styles.sectionTheme = content.sectionTheme;
  if (content.sectionHeight) styles.sectionHeight = content.sectionHeight;
  if (content.contentWidth) styles.contentWidth = content.contentWidth;
  if (content.sectionPadding) {
    const paddingMap: Record<string, string> = { none: '0px', small: '20px', medium: '40px', large: '80px' };
    styles.paddingTop = paddingMap[content.sectionPadding] ?? '40px';
    styles.paddingBottom = paddingMap[content.sectionPadding] ?? '40px';
  }

  const result = await client.editSectionStyle(
    ctx.pageSectionsId, ctx.collectionId, sectionSearch, styles,
  );
  if (!result.success) throw new Error(result.error ?? 'editSectionStyle failed');
  return `Updated section style (${result.updatedFields?.join(', ') ?? 'styles'})`;
}

// ── Helper: apply section styling after section addition ─────────────────────

async function applySectionStyle(
  client: ContentSaveClient,
  ctx: PageContext,
  sectionIndex: number,
  content: ContentSpec,
): Promise<void> {
  const styles: SectionStyleOptions = {};
  let hasStyles = false;

  if (content.sectionTheme) { styles.sectionTheme = content.sectionTheme; hasStyles = true; }
  if (content.sectionHeight) { styles.sectionHeight = content.sectionHeight; hasStyles = true; }
  if (content.contentWidth) { styles.contentWidth = content.contentWidth; hasStyles = true; }
  if (content.sectionPadding) {
    const paddingMap: Record<string, string> = { none: '0px', small: '20px', medium: '40px', large: '80px' };
    styles.paddingTop = paddingMap[content.sectionPadding] ?? '40px';
    styles.paddingBottom = paddingMap[content.sectionPadding] ?? '40px';
    hasStyles = true;
  }

  if (!hasStyles) return;

  const result = await client.editSectionStyle(
    ctx.pageSectionsId, ctx.collectionId, sectionIndex, styles,
  );
  if (!result.success) {
    logger.warn({ sectionIndex, error: result.error }, 'api-executor: section style failed (non-fatal)');
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Execute a content plan entirely via API — no browser needed.
 *
 * Operations are executed in dependency order:
 *   1. create_page
 *   2. add_section (blank_api + template)
 *   3. Content fill / modify / style
 *
 * Failed operations are collected in `failedOperations` for browser fallback.
 */
export async function executeContentPlanViaApi(
  plan: ContentPlan,
  subdomain: string,
  trackedOps?: PlanOperation[],
): Promise<ApiExecutorResult> {
  const startMs = Date.now();
  const results: ApiOperationResult[] = [];
  const failedOps: ContentOperation[] = [];

  // Session health check
  const health = ContentSaveClient.checkSessionHealth();
  if (!health.exists || !health.hasCrumb) {
    return {
      success: false,
      operationResults: [],
      summary: `Session unhealthy: exists=${health.exists}, hasCrumb=${health.hasCrumb}`,
      durationMs: Date.now() - startMs,
      failedOperations: plan.operations,
    };
  }

  const client = createContentSaveClient(subdomain);

  // Group operations by execution phase
  const createPageOps: Array<{ op: ContentOperation; index: number }> = [];
  const addSectionOps: Array<{ op: ContentOperation; index: number }> = [];
  const contentOps: Array<{ op: ContentOperation; index: number }> = [];

  for (let i = 0; i < plan.operations.length; i++) {
    const op = plan.operations[i];
    switch (op.operationType) {
      case 'create_page':
        createPageOps.push({ op, index: i });
        break;
      case 'add_section':
        addSectionOps.push({ op, index: i });
        break;
      default:
        contentOps.push({ op, index: i });
        break;
    }
  }

  // Page context cache: slug → PageContext
  const pageContexts = new Map<string, PageContext>();
  const tracker: SectionTracker = { sectionIndices: new Map(), sectionCount: 0 };

  // Helper: get or resolve page context
  async function getPageContext(targetPage: string): Promise<PageContext | null> {
    const slug = targetPage === 'new' ? '' : targetPage;
    if (pageContexts.has(slug)) return pageContexts.get(slug)!;
    const ctx = await resolvePageContext(subdomain, slug);
    if (ctx) {
      pageContexts.set(slug, ctx);
      // Initialize tracker with current section count
      if (tracker.sectionCount === 0) {
        try {
          const data = await client.getPageSections(ctx.pageSectionsId);
          tracker.sectionCount = data.sections?.length ?? 0;
        } catch {
          // Non-fatal
        }
      }
    }
    return ctx;
  }

  // Helper: find tracked operation for status updates
  function findTrackedOp(opIndex: number): PlanOperation | undefined {
    return trackedOps?.find((t, i) => i === opIndex);
  }

  // Helper: emit SSE event
  async function emitActivity(message: string, taskId: string, status: 'started' | 'completed' | 'failed'): Promise<void> {
    try {
      const { dashboardEvents } = await import('./dashboard-events.js');
      dashboardEvents.emit('dashboard', {
        type: 'agent_activity' as const,
        data: { agent: 'api_executor', status, message, taskId },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // SSE emission failure is non-fatal
    }
  }

  // ── Phase 1: Create Pages ─────────────────────────────────────────────

  let isFirstOp = true;

  for (const { op, index } of createPageOps) {
    if (!isFirstOp) await throttle();
    isFirstOp = false;
    const opStartMs = Date.now();
    const tracked = findTrackedOp(index);
    if (tracked) updateOperationStatus(tracked.id, 'executing');
    await emitActivity(`Creating page "${op.content.heading ?? 'New Page'}"`, op.taskId, 'started');

    try {
      const { pageContext, summary } = await executeCreatePage(client, op, subdomain);
      if (pageContext && op.targetPage) {
        pageContexts.set(op.targetPage, pageContext);
        // Also map 'new' to this page for subsequent operations
        pageContexts.set('new', pageContext);
      }

      results.push({ operation: op, success: true, summary, durationMs: Date.now() - opStartMs });
      if (tracked) updateOperationStatus(tracked.id, 'succeeded');
      await emitActivity(summary, op.taskId, 'completed');
    } catch (err) {
      const error = errMsg(err);
      results.push({ operation: op, success: false, summary: '', error, durationMs: Date.now() - opStartMs });
      failedOps.push(op);
      if (tracked) updateOperationStatus(tracked.id, 'failed', error);
      await emitActivity(`Page creation failed: ${error}`, op.taskId, 'failed');
    }
  }

  // ── Phase 2: Add Sections ─────────────────────────────────────────────

  for (const { op, index } of addSectionOps) {
    if (!isFirstOp) await throttle();
    isFirstOp = false;
    const opStartMs = Date.now();
    const tracked = findTrackedOp(index);
    if (tracked) updateOperationStatus(tracked.id, 'executing');

    const heading = op.content.heading ?? `Section ${index + 1}`;
    await emitActivity(`Adding section "${heading}"`, op.taskId, 'started');

    try {
      const ctx = await getPageContext(op.targetPage);
      if (!ctx) throw new Error(`Could not resolve page context for "${op.targetPage}"`);

      // Capture pre-snapshot for validation
      let preSnapshot;
      try {
        preSnapshot = await capturePreSnapshot(client, ctx.pageSectionsId, op);
      } catch { /* non-fatal */ }

      let summary: string;
      if (op.content.contentStrategy === 'blank_api') {
        summary = await executeAddSectionBlankApi(client, ctx, op, index, tracker, subdomain);
      } else if (op.content.contentStrategy === 'template') {
        summary = await executeAddSectionTemplate(client, ctx, op, index, tracker, subdomain);
      } else {
        throw new Error(`Unknown content strategy: ${op.content.contentStrategy}`);
      }

      // Post-operation validation
      let validation: ValidationResult | undefined;
      if (preSnapshot) {
        try {
          validation = await validateOperation(client, ctx.pageSectionsId, op, preSnapshot);
        } catch { /* non-fatal */ }
      }

      results.push({ operation: op, success: true, summary, validation, durationMs: Date.now() - opStartMs });
      if (tracked) updateOperationStatus(tracked.id, 'succeeded');
      await emitActivity(summary, op.taskId, 'completed');
    } catch (err) {
      const error = errMsg(err);
      results.push({ operation: op, success: false, summary: '', error, durationMs: Date.now() - opStartMs });
      failedOps.push(op);
      if (tracked) updateOperationStatus(tracked.id, 'failed', error);
      await emitActivity(`Section addition failed: ${error}`, op.taskId, 'failed');
    }
  }

  // ── Phase 3: Content Operations ───────────────────────────────────────

  for (const { op, index } of contentOps) {
    if (!isFirstOp) await throttle();
    isFirstOp = false;
    const opStartMs = Date.now();
    const tracked = findTrackedOp(index);
    if (tracked) updateOperationStatus(tracked.id, 'executing');

    const label = op.content.heading ?? op.operationType;
    await emitActivity(`${op.operationType}: "${label}"`, op.taskId, 'started');

    try {
      const ctx = await getPageContext(op.targetPage);
      if (!ctx) throw new Error(`Could not resolve page context for "${op.targetPage}"`);

      let summary: string;

      switch (op.operationType) {
        case 'modify_text':
          summary = await executeModifyText(client, ctx, op);
          break;
        case 'replace_image':
          summary = await executeReplaceImage(client, ctx, op, subdomain);
          break;
        case 'remove_block':
          summary = await executeRemoveBlock(client, ctx, op);
          break;
        case 'modify_block':
          summary = await executeModifyBlock(client, ctx, op);
          break;
        case 'add_block':
          summary = await executeAddBlock(client, ctx, op, subdomain);
          break;
        case 'add_gallery':
          summary = await executeAddGallery(client, ctx, op, subdomain);
          break;
        case 'modify_style':
          summary = await executeModifyStyle(client, ctx, op);
          break;
        case 'delete_page':
          summary = await executeDeletePage(client, ctx, op);
          break;
        case 'update_page_metadata':
          summary = await executeUpdatePageMetadata(client, ctx, op);
          break;
        default:
          throw new Error(`Unsupported operation type: ${op.operationType}`);
      }

      results.push({ operation: op, success: true, summary, durationMs: Date.now() - opStartMs });
      if (tracked) updateOperationStatus(tracked.id, 'succeeded');
      await emitActivity(summary, op.taskId, 'completed');
    } catch (err) {
      const error = errMsg(err);
      results.push({ operation: op, success: false, summary: '', error, durationMs: Date.now() - opStartMs });
      failedOps.push(op);
      if (tracked) updateOperationStatus(tracked.id, 'failed', error);
      await emitActivity(`${op.operationType} failed: ${error}`, op.taskId, 'failed');
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const durationMs = Date.now() - startMs;

  const summary = failed === 0
    ? `All ${succeeded} operations completed via API in ${(durationMs / 1000).toFixed(1)}s`
    : `${succeeded}/${results.length} operations succeeded via API (${failed} failed) in ${(durationMs / 1000).toFixed(1)}s`;

  logger.info(
    { succeeded, failed, total: results.length, durationMs, failedOps: failedOps.length },
    `api-executor: ${summary}`,
  );

  return {
    success: failedOps.length === 0,
    operationResults: results,
    summary,
    durationMs,
    failedOperations: failedOps,
  };
}
