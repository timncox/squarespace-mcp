/**
 * Simple Edit Executor
 *
 * Executes classified simple edits directly via the Content Save API,
 * bypassing the full browser agent pipeline.  Each edit type maps to a
 * specific ContentSaveClient method.  If anything fails the caller falls
 * through to the normal execution path — no catastrophic failure possible.
 *
 * Typical latency: 100-500ms per edit (vs 30-180s via browser agent).
 */

import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import { ContentSaveClient, createContentSaveClient } from './content-save.js';
import { resolvePageIds } from './page-id-resolver.js';
import type { Task } from '../models/task.js';
import type { SimpleEditType, SimpleEditClassification } from './simple-edit-classifier.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type { SimpleEditType, SimpleEditClassification };

export interface SimpleEditResult {
  success: boolean;
  editType: SimpleEditType;
  summary: string;
  error?: string;
  durationMs: number;
}

// ── Slug normalization ───────────────────────────────────────────────────────

const HOME_SLUGS = ['homepage', 'home-page', 'home', 'landing', 'index', 'main', ''];

function normalizeSlug(slug: string): string {
  const lower = slug.toLowerCase().trim();
  if (HOME_SLUGS.includes(lower)) return 'home';
  return slug.replace(/^\/+/, '').toLowerCase();
}

// ── Edit type does NOT need page IDs ─────────────────────────────────────────

const NO_PAGE_ID_TYPES: ReadonlySet<SimpleEditType> = new Set(['footer_edit', 'css_change']);

// ── Dispatch helpers ─────────────────────────────────────────────────────────

async function execTextReplace(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.searchText) throw new Error('searchText required for text_replace');
  if (!params.newContent) throw new Error('newContent required for text_replace');

  const result = await client.patchTextBlock(
    pageSectionsId, collectionId, params.searchText, params.newContent,
  );
  if (!result.success) throw new Error(result.error ?? 'patchTextBlock failed');
  return `Replaced "${params.searchText}" with "${params.newContent}"`;
}

async function execTextAdd(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.newContent) throw new Error('newContent required for text_add');

  // Get sections to find last section index
  const data = await client.getPageSections(pageSectionsId);
  const lastIndex = Math.max(0, (data.sections?.length ?? 1) - 1);

  const html = params.newContent.startsWith('<')
    ? params.newContent
    : `<p class="" style="white-space:pre-wrap;">${params.newContent}</p>`;

  const result = await client.addTextBlock(
    pageSectionsId, collectionId, lastIndex, html,
  );
  if (!result.success) throw new Error(result.error ?? 'addTextBlock failed');
  return `Added text block to section ${lastIndex}`;
}

async function execButtonEdit(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.searchText && !params.buttonLabel) throw new Error('searchText or buttonLabel required for button_edit');
  const label = params.searchText ?? params.buttonLabel!;

  const updates: { newLabel?: string; url?: string } = {};
  if (params.buttonLabel && params.buttonLabel !== label) updates.newLabel = params.buttonLabel;
  if (params.newContent) updates.newLabel = params.newContent;
  if (params.buttonUrl) updates.url = params.buttonUrl;

  if (!updates.newLabel && !updates.url) throw new Error('No button updates provided');

  const result = await client.updateButtonBlock(
    pageSectionsId, collectionId, label, updates,
  );
  if (!result.success) throw new Error(result.error ?? 'updateButtonBlock failed');
  return `Updated button "${label}"`;
}

async function execImageMetadata(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.searchText) throw new Error('searchText required for image_metadata');
  if (!params.imageFields) throw new Error('imageFields required for image_metadata');

  const result = await client.updateImageBlock(
    pageSectionsId, collectionId, params.searchText, params.imageFields,
  );
  if (!result.success) throw new Error(result.error ?? 'updateImageBlock failed');
  return `Updated image metadata for "${params.searchText}"`;
}

async function execBlockRemove(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.searchText) throw new Error('searchText required for block_remove');

  const result = await client.removeBlock(
    pageSectionsId, collectionId, params.searchText,
  );
  if (!result.success) throw new Error(result.error ?? 'removeBlock failed');
  return `Removed block matching "${params.searchText}"`;
}

async function execMenuUpdate(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.searchText) throw new Error('searchText required for menu_update');
  if (!params.menuItems) throw new Error('menuItems required for menu_update');

  const { mergeMenuFromText } = await import('./menu-merger.js');

  const menuResult = await client.getMenuBlock(pageSectionsId, params.searchText);
  if (!menuResult.success || !menuResult.menus) throw new Error(menuResult.error ?? 'getMenuBlock failed');

  const mergedMenus = mergeMenuFromText(menuResult.menus, params.menuItems);

  const updateResult = await client.updateMenuBlock(
    pageSectionsId, collectionId, params.searchText, mergedMenus,
  );
  if (!updateResult.success) throw new Error(updateResult.error ?? 'updateMenuBlock failed');
  return `Updated menu matching "${params.searchText}"`;
}

async function execFooterEdit(
  client: ContentSaveClient,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.searchText) throw new Error('searchText required for footer_edit');
  if (!params.newContent) throw new Error('newContent required for footer_edit');

  const result = await client.patchFooterTextBlock(params.searchText, params.newContent);
  if (!result.success) throw new Error(result.error ?? 'patchFooterTextBlock failed');
  return `Updated footer text: replaced "${params.searchText}" with "${params.newContent}"`;
}

async function execCssChange(
  client: ContentSaveClient,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.cssContent) throw new Error('cssContent required for css_change');

  if (params.cssMode === 'append') {
    const current = await client.getCustomCSS();
    if (!current.success) throw new Error(current.error ?? 'getCustomCSS failed');
    const combined = current.css ? `${current.css}\n\n${params.cssContent}` : params.cssContent;
    const saveResult = await client.saveCustomCSS(combined);
    if (!saveResult.success) throw new Error(saveResult.error ?? 'saveCustomCSS failed');
    return 'Appended custom CSS';
  }

  const saveResult = await client.saveCustomCSS(params.cssContent);
  if (!saveResult.success) throw new Error(saveResult.error ?? 'saveCustomCSS failed');
  return 'Replaced custom CSS';
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function executeSimpleEdit(
  task: Task,
  classification: SimpleEditClassification,
): Promise<SimpleEditResult> {
  const startMs = Date.now();
  const editType = classification.editType!;

  try {
    // Step 1: Session health check
    const health = ContentSaveClient.checkSessionHealth();
    if (!health.exists || !health.hasCrumb) {
      return {
        success: false,
        editType,
        summary: '',
        error: `Session unhealthy: exists=${health.exists}, hasCrumb=${health.hasCrumb}`,
        durationMs: Date.now() - startMs,
      };
    }

    // Step 2: Determine subdomain + slug
    const subdomain = task.siteId;
    const slug = normalizeSlug(task.targetPage ?? 'home');

    // Step 3: Create client
    const client = createContentSaveClient(subdomain);

    // Step 4: Resolve page IDs (skip for footer/css)
    let pageSectionsId = '';
    let collectionId = '';

    if (!NO_PAGE_ID_TYPES.has(editType)) {
      const ids = await resolvePageIds(subdomain, slug);
      if (!ids) {
        return {
          success: false,
          editType,
          summary: '',
          error: `Could not resolve page IDs for ${subdomain}/${slug}`,
          durationMs: Date.now() - startMs,
        };
      }
      pageSectionsId = ids.pageSectionsId;
      collectionId = ids.collectionId;
    }

    // Step 5: Dispatch
    let summary: string;

    switch (editType) {
      case 'text_replace':
        summary = await execTextReplace(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'text_add':
        summary = await execTextAdd(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'button_edit':
        summary = await execButtonEdit(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'image_metadata':
        summary = await execImageMetadata(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'block_remove':
        summary = await execBlockRemove(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'menu_update':
        summary = await execMenuUpdate(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'footer_edit':
        summary = await execFooterEdit(client, classification.params);
        break;
      case 'css_change':
        summary = await execCssChange(client, classification.params);
        break;
      default:
        throw new Error(`Unknown edit type: ${editType}`);
    }

    const durationMs = Date.now() - startMs;
    logger.info({ editType, durationMs, subdomain, slug }, 'Simple edit succeeded');

    return { success: true, editType, summary, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    logger.warn({ error: errMsg(err), editType, durationMs }, 'Simple edit failed');

    return {
      success: false,
      editType,
      summary: '',
      error: errMsg(err),
      durationMs,
    };
  }
}
