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
import { ContentSaveClient, createContentSaveClient, type SectionStyleOptions, type PageMetadataUpdateOptions, type SiteIdentityUpdateOptions } from './content-save.js';
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

const NO_PAGE_ID_TYPES: ReadonlySet<SimpleEditType> = new Set(['footer_edit', 'css_change', 'page_seo', 'site_identity', 'business_hours_update']);

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

// ── New edit type dispatchers ────────────────────────────────────────────────

async function execSectionStyle(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.sectionSearch && params.sectionSearch !== 0) throw new Error('sectionSearch required for section_style');
  if (!params.sectionStyles) throw new Error('sectionStyles required for section_style');

  const styles: SectionStyleOptions = {};
  if (params.sectionStyles.sectionTheme) styles.sectionTheme = params.sectionStyles.sectionTheme;
  if (params.sectionStyles.sectionHeight) styles.sectionHeight = params.sectionStyles.sectionHeight as SectionStyleOptions['sectionHeight'];
  if (params.sectionStyles.contentWidth) styles.contentWidth = params.sectionStyles.contentWidth as SectionStyleOptions['contentWidth'];
  if (params.sectionStyles.backgroundColor) styles.backgroundColor = params.sectionStyles.backgroundColor;

  const result = await client.editSectionStyle(pageSectionsId, collectionId, params.sectionSearch, styles);
  if (!result.success) throw new Error(result.error ?? 'editSectionStyle failed');
  return `Updated section style (${result.updatedFields?.join(', ') ?? 'unknown fields'})`;
}

async function execImageReplace(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
  subdomain: string,
): Promise<string> {
  if (!params.searchText) throw new Error('searchText required for image_replace');
  if (!params.imagePath) throw new Error('imagePath required for image_replace');

  // Step 1: Upload new image to Squarespace media library
  const { MediaUploadClient } = await import('./media-upload.js');
  const uploader = new MediaUploadClient(subdomain);
  const uploadResult = await uploader.uploadImage(params.imagePath, params.imageAltText);
  if (uploadResult.status !== 'success' || !uploadResult.assetUrl) {
    throw new Error(uploadResult.failureReason ?? 'Image upload failed');
  }

  // Step 2: Find the image block and update its assetUrl + metadata via read-modify-write
  const data = await client.getPageSections(pageSectionsId);
  const match = client.findBlock(data.sections, params.searchText);
  if (!match) throw new Error(`No block found matching "${params.searchText}"`);

  const blockValue = match.gridContent.content.value;
  if (!blockValue.value) blockValue.value = {};
  blockValue.value.assetUrl = uploadResult.assetUrl;
  if (params.imageAltText) blockValue.altText = params.imageAltText;

  const saveResult = await client.savePageSections(pageSectionsId, collectionId, data.sections);
  if (!saveResult.success) throw new Error(saveResult.error ?? 'savePageSections failed');
  return `Replaced image "${params.searchText}" with uploaded file`;
}

async function execButtonAdd(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.newButtonLabel) throw new Error('newButtonLabel required for button_add');
  if (!params.newButtonUrl) throw new Error('newButtonUrl required for button_add');

  // Find the last section and add button there
  const data = await client.getPageSections(pageSectionsId);
  const lastIndex = Math.max(0, (data.sections?.length ?? 1) - 1);

  const result = await client.addButtonBlock(
    pageSectionsId, collectionId, lastIndex,
    params.newButtonLabel, params.newButtonUrl,
  );
  if (!result.success) throw new Error(result.error ?? 'addButtonBlock failed');
  return `Added button "${params.newButtonLabel}" → ${params.newButtonUrl}`;
}

async function execSectionReorder(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.sectionSearch && params.sectionSearch !== 0) throw new Error('sectionSearch required for section_reorder');
  if (!params.moveDirection) throw new Error('moveDirection required for section_reorder');

  // moveSection takes searchText as string
  const searchText = String(params.sectionSearch);
  const result = await client.moveSection(pageSectionsId, collectionId, searchText, params.moveDirection);
  if (!result.success) throw new Error(result.error ?? 'moveSection failed');
  return `Moved section "${result.sectionName ?? params.sectionSearch}" ${params.moveDirection}`;
}

async function execBlockMove(
  client: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.searchText) throw new Error('searchText required for block_move');
  if (!params.moveDirection) throw new Error('moveDirection required for block_move');

  const result = await client.moveBlock(
    pageSectionsId, collectionId, params.searchText, params.moveDirection,
    params.moveSteps ?? 1,
  );
  if (!result.success) throw new Error(result.error ?? 'moveBlock failed');
  return `Moved block "${params.searchText}" ${params.moveDirection}`;
}

async function execPageSeo(
  client: ContentSaveClient,
  params: SimpleEditClassification['params'],
  slug: string,
): Promise<string> {
  // Resolve the collectionId for this page
  const metadata = await client.getPageMetadata(slug);
  if (!metadata) throw new Error(`Could not find page "${slug}"`);

  const updates: PageMetadataUpdateOptions = {};
  const updatedFields: string[] = [];

  if (params.seoTitle) { updates.seoTitle = params.seoTitle; updatedFields.push('seoTitle'); }
  if (params.seoDescription) { updates.seoDescription = params.seoDescription; updatedFields.push('seoDescription'); }
  if (params.navigationTitle) { updates.navigationTitle = params.navigationTitle; updatedFields.push('navigationTitle'); }
  if (params.urlId) { updates.urlId = params.urlId; updatedFields.push('urlId'); }
  if (params.enabled != null) { updates.enabled = params.enabled; updatedFields.push('enabled'); }
  // Also support newContent as a title update
  if (params.newContent && !params.seoTitle) { updates.title = params.newContent; updatedFields.push('title'); }

  if (updatedFields.length === 0) throw new Error('No SEO fields provided for update');

  const result = await client.updatePageMetadata(metadata.collectionId, updates);
  if (!result.success) throw new Error(result.error ?? 'updatePageMetadata failed');
  return `Updated page SEO (${result.updatedFields?.join(', ') ?? updatedFields.join(', ')})`;
}

async function execBlogPostCreate(
  client: ContentSaveClient,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.postTitle) throw new Error('postTitle required for blog_post_create');
  const result = await client.createBlogPost(collectionId, params.postTitle, {
    body: params.postBody,
    excerpt: params.postExcerpt,
    tags: params.postTags,
    categories: params.postCategories,
    draft: params.postDraft ?? true,
  });
  if (!result.success) throw new Error(result.error ?? 'createBlogPost failed');
  if (!result.endpointAvailable) throw new Error('Blog post API not available on this site');
  const status = (params.postDraft ?? true) ? 'draft' : 'published';
  return `Created ${status} blog post "${params.postTitle}"`;
}

async function execBlogPostUpdate(
  client: ContentSaveClient,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.postSearchTitle) throw new Error('postSearchTitle required for blog_post_update');
  const existing = await client.findBlogPostByTitle(collectionId, params.postSearchTitle);
  if (!existing) throw new Error(`Blog post "${params.postSearchTitle}" not found`);
  const result = await client.updateBlogPost(collectionId, existing.id, {
    title: params.postTitle,
    body: params.postBody,
    excerpt: params.postExcerpt,
    tags: params.postTags,
    categories: params.postCategories,
    draft: params.postDraft,
  });
  if (!result.success) throw new Error(result.error ?? 'updateBlogPost failed');
  return `Updated blog post "${existing.title}": ${result.updatedFields.join(', ')}`;
}

async function execSiteIdentity(
  client: ContentSaveClient,
  params: SimpleEditClassification['params'],
): Promise<string> {
  const updates: SiteIdentityUpdateOptions = {};

  if (params.businessName !== undefined) updates.businessName = params.businessName;
  if (params.businessAddress !== undefined) updates.address = params.businessAddress;
  if (params.businessPhone !== undefined) updates.phone = params.businessPhone;
  if (params.businessEmail !== undefined) updates.email = params.businessEmail;

  if (Object.keys(updates).length === 0) throw new Error('No site identity fields to update');

  const result = await client.updateSiteIdentity(updates);
  if (!result.success) throw new Error(result.error ?? 'updateSiteIdentity failed');
  return `Updated site identity: ${result.updatedFields?.join(', ')}`;
}

async function execBusinessHoursUpdate(
  client: ContentSaveClient,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.businessHours || Object.keys(params.businessHours).length === 0) {
    throw new Error('businessHours required for business_hours_update');
  }

  const settingsResult = await client.getSettings();
  if (!settingsResult.success || !settingsResult.data) {
    throw new Error(settingsResult.error ?? 'getSettings failed');
  }

  const currentHours = (settingsResult.data.businessHours ?? {}) as Record<string, unknown>;
  const merged = { ...currentHours, ...params.businessHours };

  const updateResult = await client.updateSettings({ businessHours: merged } as any);
  if (!updateResult.success) throw new Error(updateResult.error ?? 'updateSettings failed');

  const days = Object.keys(params.businessHours).join(', ');
  return `Updated business hours for: ${days}`;
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
      case 'section_style':
        summary = await execSectionStyle(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'image_replace':
        summary = await execImageReplace(client, pageSectionsId, collectionId, classification.params, subdomain);
        break;
      case 'button_add':
        summary = await execButtonAdd(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'section_reorder':
        summary = await execSectionReorder(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'block_move':
        summary = await execBlockMove(client, pageSectionsId, collectionId, classification.params);
        break;
      case 'page_seo':
        summary = await execPageSeo(client, classification.params, slug);
        break;
      case 'blog_post_create':
        summary = await execBlogPostCreate(client, collectionId, classification.params);
        break;
      case 'blog_post_update':
        summary = await execBlogPostUpdate(client, collectionId, classification.params);
        break;
      case 'site_identity':
        summary = await execSiteIdentity(client, classification.params);
        break;
      case 'business_hours_update':
        summary = await execBusinessHoursUpdate(client, classification.params);
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
