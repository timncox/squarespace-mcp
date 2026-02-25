import { Page } from 'playwright';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';
import { createMediaUploadClient } from '../../services/media-upload.js';
import { createContentSaveClient, ContentSaveClient, type BlockMoveResult, type BlockResizeResult, type BlockRemoveResult, type SectionMoveResult, type ImageBlockUpdateResult, type TextBlockAddResult } from '../../services/content-save.js';
import type { ActionResult } from './types.js';

/**
 * Validate that an image file exists before attempting upload.
 * Returns an ActionResult with a clear error if the file is missing.
 */
export function validateFileExists(filePath: string, actionName: string): ActionResult | null {
  if (!existsSync(filePath)) {
    return {
      success: false,
      message: `${actionName}: File not found at "${filePath}". Ensure the file was downloaded to storage/uploads/ before attempting upload.`,
    };
  }
  return null;
}

/**
 * Check if the Fluid Engine section editor is active.
 * Squarespace renders "Add Block" buttons with visibility:hidden on non-selected
 * sections, so getByRole is the only reliable way to detect the visible one.
 */
export async function isFluidEngineActive(page: Page, timeoutMs = 2000): Promise<boolean> {
  return page.getByRole('button', { name: /add block/i }).first()
    .isVisible({ timeout: timeoutMs }).catch(() => false);
}

/**
 * Try to click a Squarespace editor button by accessible name using getByRole,
 * falling back to CSS selectors. Returns true if clicked.
 */
export async function clickEditorButton(page: Page, name: RegExp, cssFallbacks: string[], timeoutMs = 3000): Promise<boolean> {
  // Primary: getByRole (pierces Squarespace's visibility:hidden pattern)
  try {
    const btn = page.getByRole('button', { name });
    if (await btn.first().isVisible({ timeout: timeoutMs }).catch(() => false)) {
      await btn.first().click({ timeout: timeoutMs });
      return true;
    }
  } catch { /* fallback */ }
  // CSS fallbacks
  for (const sel of cssFallbacks) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click({ timeout: timeoutMs });
        return true;
      }
    } catch { /* next */ }
  }
  return false;
}

/**
 * Extract the Squarespace subdomain from the current page URL.
 * Returns null if the URL is not a *.squarespace.com domain.
 */
export function extractSubdomain(page: Page): string | null {
  const match = page.url().match(/https?:\/\/([a-z0-9-]+)\.squarespace\.com/i);
  return match?.[1] ?? null;
}

/**
 * Attempt to upload an image via the Squarespace media API (no UI).
 * Returns the asset URL on success, null on failure. Never throws.
 */
export async function tryMediaApiUpload(
  page: Page,
  imagePath: string,
): Promise<string | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryMediaApiUpload: could not extract subdomain from URL');
    return null;
  }
  try {
    const client = createMediaUploadClient(subdomain);
    const result = await client.uploadImage(imagePath);
    if (result.status === 'success') {
      logger.info({ assetUrl: result.assetUrl, assetId: result.assetId }, 'Media API upload succeeded');
      return result.assetUrl ?? 'uploaded';
    }
    logger.warn({ reason: result.failureReason }, 'Media API upload returned failure status');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Media API upload failed');
    return null;
  }
}

/**
 * Attempt to update a text block via the Content Save API (no UI).
 * Uses the read-modify-write pattern: GET sections → find block → PUT modified sections.
 *
 * Requires pageSectionsId and collectionId, which are extracted from the page DOM
 * and the ?format=json-pretty endpoint respectively.
 *
 * Returns an ActionResult on success, null on failure. Never throws.
 */
export async function tryContentSaveApi(
  page: Page,
  searchText: string,
  newText: string,
): Promise<ActionResult | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryContentSaveApi: could not extract subdomain from URL');
    return null;
  }

  try {
    // Extract pageSectionsId from the editor DOM (data-page-sections attribute)
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) {
      logger.debug('tryContentSaveApi: no sqs-site-frame found');
      return null;
    }

    const pageSectionsId = await siteFrame.evaluate(() => {
      const article = document.querySelector('article[data-page-sections]');
      return article?.getAttribute('data-page-sections') ?? null;
    }).catch(() => null);

    if (!pageSectionsId) {
      logger.debug('tryContentSaveApi: could not find data-page-sections attribute');
      return null;
    }

    // Get collectionId from ?format=json-pretty
    const client = createContentSaveClient(subdomain);
    const pageUrl = page.url();
    const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
    const slug = slugMatch?.[1] ?? '';
    const ids = await client.getPageIds(slug);

    if (!ids) {
      logger.debug({ slug }, 'tryContentSaveApi: could not get page IDs');
      return null;
    }

    // Wrap newText in <p> tags if it's plain text (no HTML tags)
    const newHtml = newText.includes('<') ? newText : `<p>${newText}</p>`;

    const result = await client.updateTextBlock(
      pageSectionsId,
      ids.collectionId,
      searchText,
      newHtml,
    );

    if (result.success) {
      logger.info(
        { blockId: result.blockId, searchText, newTextLength: newText.length },
        'Content Save API: text block updated successfully',
      );
      return {
        success: true,
        message: `editTextBlock: Updated text via Content Save API (block ${result.blockId}). Old: "${result.oldText}". Reload the page to see the change in the editor.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Content Save API: update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Content Save API failed');
    return null;
  }
}

/**
 * Attempt to move a block via the Content Save API (no UI).
 * Same pattern as tryContentSaveApi: extract IDs from DOM, call API, return result or null.
 * Never throws.
 */
export async function tryBlockMoveApi(
  page: Page,
  searchText: string,
  direction: 'up' | 'down' | 'left' | 'right',
): Promise<ActionResult | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryBlockMoveApi: could not extract subdomain from URL');
    return null;
  }

  try {
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) {
      logger.debug('tryBlockMoveApi: no sqs-site-frame found');
      return null;
    }

    const pageSectionsId = await siteFrame.evaluate(() => {
      const article = document.querySelector('article[data-page-sections]');
      return article?.getAttribute('data-page-sections') ?? null;
    }).catch(() => null);

    if (!pageSectionsId) {
      logger.debug('tryBlockMoveApi: could not find data-page-sections attribute');
      return null;
    }

    const client = createContentSaveClient(subdomain);
    const pageUrl = page.url();
    const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
    const slug = slugMatch?.[1] ?? '';
    const ids = await client.getPageIds(slug);

    if (!ids) {
      logger.debug({ slug }, 'tryBlockMoveApi: could not get page IDs');
      return null;
    }

    const result: BlockMoveResult = await client.moveBlock(
      pageSectionsId,
      ids.collectionId,
      searchText,
      direction,
    );

    if (result.success) {
      const pos = result.newPosition?.desktop;
      const posStr = pos ? ` New position: (${pos.start.x},${pos.start.y})→(${pos.end.x},${pos.end.y}).` : '';
      const clampStr = result.clamped ? ' (clamped to grid boundary)' : '';
      logger.info(
        { blockId: result.blockId, direction, newPosition: result.newPosition },
        'Block Move API: block moved successfully',
      );
      return {
        success: true,
        message: `moveBlockInSection: Moved block "${searchText}" ${direction} via Content Save API (block ${result.blockId}).${posStr}${clampStr} Reload the page to see the change in the editor.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Block Move API: move failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Block Move API failed');
    return null;
  }
}

/**
 * Attempt to resize a block via the Content Save API (no UI).
 * Same pattern as tryBlockMoveApi. Never throws.
 */
export async function tryBlockResizeApi(
  page: Page,
  searchText: string,
  width?: 'smaller' | 'larger' | 'full',
  height?: 'shorter' | 'taller',
): Promise<ActionResult | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryBlockResizeApi: could not extract subdomain from URL');
    return null;
  }

  try {
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) {
      logger.debug('tryBlockResizeApi: no sqs-site-frame found');
      return null;
    }

    const pageSectionsId = await siteFrame.evaluate(() => {
      const article = document.querySelector('article[data-page-sections]');
      return article?.getAttribute('data-page-sections') ?? null;
    }).catch(() => null);

    if (!pageSectionsId) {
      logger.debug('tryBlockResizeApi: could not find data-page-sections attribute');
      return null;
    }

    const client = createContentSaveClient(subdomain);
    const pageUrl = page.url();
    const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
    const slug = slugMatch?.[1] ?? '';
    const ids = await client.getPageIds(slug);

    if (!ids) {
      logger.debug({ slug }, 'tryBlockResizeApi: could not get page IDs');
      return null;
    }

    const result: BlockResizeResult = await client.resizeBlock(
      pageSectionsId,
      ids.collectionId,
      searchText,
      width,
      height,
    );

    if (result.success) {
      const changes: string[] = [];
      if (width) changes.push(`width → ${width} (${result.oldSize?.width}→${result.newSize?.width} cols)`);
      if (height) changes.push(`height → ${height} (${result.oldSize?.height}→${result.newSize?.height} rows)`);
      const clampStr = result.clamped ? ' (clamped to grid boundary)' : '';
      logger.info(
        { blockId: result.blockId, width, height, newSize: result.newSize },
        'Block Resize API: block resized successfully',
      );
      return {
        success: true,
        message: `resizeBlock: Resized block "${searchText}" via Content Save API (block ${result.blockId}). ${changes.join(', ')}.${clampStr} Reload the page to see the change in the editor.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Block Resize API: resize failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Block Resize API failed');
    return null;
  }
}

/**
 * Attempt to remove a block via the Content Save API (no UI).
 * Same pattern as tryBlockMoveApi. Never throws.
 */
export async function tryBlockRemoveApi(
  page: Page,
  searchText: string,
): Promise<ActionResult | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryBlockRemoveApi: could not extract subdomain from URL');
    return null;
  }

  try {
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) {
      logger.debug('tryBlockRemoveApi: no sqs-site-frame found');
      return null;
    }

    const pageSectionsId = await siteFrame.evaluate(() => {
      const article = document.querySelector('article[data-page-sections]');
      return article?.getAttribute('data-page-sections') ?? null;
    }).catch(() => null);

    if (!pageSectionsId) {
      logger.debug('tryBlockRemoveApi: could not find data-page-sections attribute');
      return null;
    }

    const client = createContentSaveClient(subdomain);
    const pageUrl = page.url();
    const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
    const slug = slugMatch?.[1] ?? '';
    const ids = await client.getPageIds(slug);

    if (!ids) {
      logger.debug({ slug }, 'tryBlockRemoveApi: could not get page IDs');
      return null;
    }

    const result: BlockRemoveResult = await client.removeBlock(
      pageSectionsId,
      ids.collectionId,
      searchText,
    );

    if (result.success) {
      logger.info(
        { blockId: result.blockId, blockType: result.blockType, sectionId: result.sectionId },
        'Block Remove API: block removed successfully',
      );
      return {
        success: true,
        message: `removeBlock: Removed block "${searchText}" via Content Save API (block ${result.blockId}, type ${result.blockType}). Reload the page to see the change.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Block Remove API: remove failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Block Remove API failed');
    return null;
  }
}

/**
 * Attempt to move a section up/down via the Content Save API (no UI).
 * Same pattern as tryBlockMoveApi. Never throws.
 */
export async function trySectionMoveApi(
  page: Page,
  searchText: string,
  direction: 'up' | 'down',
): Promise<ActionResult | null> {
  const label = direction === 'up' ? 'moveSectionUp' : 'moveSectionDown';
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('trySectionMoveApi: could not extract subdomain from URL');
    return null;
  }

  try {
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) {
      logger.debug('trySectionMoveApi: no sqs-site-frame found');
      return null;
    }

    const pageSectionsId = await siteFrame.evaluate(() => {
      const article = document.querySelector('article[data-page-sections]');
      return article?.getAttribute('data-page-sections') ?? null;
    }).catch(() => null);

    if (!pageSectionsId) {
      logger.debug('trySectionMoveApi: could not find data-page-sections attribute');
      return null;
    }

    const client = createContentSaveClient(subdomain);
    const pageUrl = page.url();
    const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
    const slug = slugMatch?.[1] ?? '';
    const ids = await client.getPageIds(slug);

    if (!ids) {
      logger.debug({ slug }, 'trySectionMoveApi: could not get page IDs');
      return null;
    }

    const result: SectionMoveResult = await client.moveSection(
      pageSectionsId,
      ids.collectionId,
      searchText,
      direction,
    );

    if (result.success) {
      const moved = result.oldIndex !== result.newIndex;
      const moveStr = moved
        ? `index ${result.oldIndex}→${result.newIndex}`
        : `already at ${direction === 'up' ? 'top' : 'bottom'} (index ${result.oldIndex})`;
      logger.info(
        { sectionId: result.sectionId, sectionName: result.sectionName, direction, oldIndex: result.oldIndex, newIndex: result.newIndex },
        'Section Move API: section moved successfully',
      );
      return {
        success: true,
        message: `${label}: Moved section "${searchText}" ${direction} via Content Save API (section ${result.sectionId}, ${moveStr}). Reload the page to see the change.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Section Move API: move failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Section Move API failed');
    return null;
  }
}

/**
 * Attempt to update an image block's metadata via the Content Save API (no UI).
 * Same pattern as tryBlockMoveApi. Never throws.
 */
export async function tryImageBlockUpdateApi(
  page: Page,
  searchText: string,
  fields: { title?: string; description?: string; subtitle?: string; altText?: string; linkTo?: string },
): Promise<ActionResult | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryImageBlockUpdateApi: could not extract subdomain from URL');
    return null;
  }

  try {
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) {
      logger.debug('tryImageBlockUpdateApi: no sqs-site-frame found');
      return null;
    }

    const pageSectionsId = await siteFrame.evaluate(() => {
      const article = document.querySelector('article[data-page-sections]');
      return article?.getAttribute('data-page-sections') ?? null;
    }).catch(() => null);

    if (!pageSectionsId) {
      logger.debug('tryImageBlockUpdateApi: could not find data-page-sections attribute');
      return null;
    }

    const client = createContentSaveClient(subdomain);
    const pageUrl = page.url();
    const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
    const slug = slugMatch?.[1] ?? '';
    const ids = await client.getPageIds(slug);

    if (!ids) {
      logger.debug({ slug }, 'tryImageBlockUpdateApi: could not get page IDs');
      return null;
    }

    const result: ImageBlockUpdateResult = await client.updateImageBlock(
      pageSectionsId,
      ids.collectionId,
      searchText,
      fields,
    );

    if (result.success) {
      logger.info(
        { blockId: result.blockId, updatedFields: result.updatedFields },
        'Image Block Update API: block updated successfully',
      );
      return {
        success: true,
        message: `updateImageBlock: Updated image block "${searchText}" via Content Save API (block ${result.blockId}). Updated fields: ${result.updatedFields?.join(', ')}. Reload the page to see the change.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Image Block Update API: update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Image Block Update API failed');
    return null;
  }
}

/**
 * Attempt to add a text block to a section via the Content Save API (no UI).
 * Uses the same pattern as tryContentSaveApi: extract IDs from DOM, call API, return result or null.
 * Never throws.
 */
export async function tryAddTextBlockApi(
  page: Page,
  sectionIndex: number,
  html: string,
  layout?: { columns?: number },
): Promise<ActionResult | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryAddTextBlockApi: could not extract subdomain from URL');
    return null;
  }

  try {
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) {
      logger.debug('tryAddTextBlockApi: no sqs-site-frame found');
      return null;
    }

    const pageSectionsId = await siteFrame.evaluate(() => {
      const article = document.querySelector('article[data-page-sections]');
      return article?.getAttribute('data-page-sections') ?? null;
    }).catch(() => null);

    if (!pageSectionsId) {
      logger.debug('tryAddTextBlockApi: could not find data-page-sections attribute');
      return null;
    }

    const client = createContentSaveClient(subdomain);
    const pageUrl = page.url();
    const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
    const slug = slugMatch?.[1] ?? '';
    const ids = await client.getPageIds(slug);

    if (!ids) {
      logger.debug({ slug }, 'tryAddTextBlockApi: could not get page IDs');
      return null;
    }

    const result: TextBlockAddResult = await client.addTextBlock(
      pageSectionsId,
      ids.collectionId,
      sectionIndex,
      html,
      layout,
    );

    if (result.success) {
      logger.info(
        { blockId: result.blockId, sectionId: result.sectionId, sectionIndex: result.sectionIndex },
        'Add Text Block API: block added successfully',
      );
      return {
        success: true,
        message: `addTextBlock: Added text block via Content Save API (block ${result.blockId}, section ${result.sectionId} at index ${result.sectionIndex}). Reload the page to see the change in the editor.`,
      };
    }

    logger.warn({ error: result.error, sectionIndex }, 'Add Text Block API: add failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Add Text Block API failed');
    return null;
  }
}

/**
 * Attempt to save custom CSS via the Content Save API (no UI).
 * Supports both 'replace' (full replacement) and 'append' (read current + append).
 * Returns an ActionResult on success, null on failure. Never throws.
 */
export async function tryCustomCssApi(
  page: Page,
  css: string,
  mode: 'append' | 'replace',
): Promise<ActionResult | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryCustomCssApi: could not extract subdomain from URL');
    return null;
  }

  try {
    const client = createContentSaveClient(subdomain);

    let finalCss = css;
    if (mode === 'append') {
      // Read current CSS first and append
      const current = await client.getCustomCSS();
      if (!current.success) {
        logger.warn({ error: current.error }, 'tryCustomCssApi: could not read current CSS for append');
        return null;
      }
      finalCss = current.css ? current.css + '\n' + css : css;
    }

    const result = await client.saveCustomCSS(finalCss);

    if (result.success) {
      logger.info(
        { mode, cssLength: finalCss.length },
        'Custom CSS API: saved successfully',
      );
      return {
        success: true,
        message: `editCustomCSS: ${mode === 'replace' ? 'Replaced' : 'Appended'} ${css.length} characters of CSS via Content Save API. Reload to see the change.`,
      };
    }

    logger.warn({ error: result.error }, 'Custom CSS API: save failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Custom CSS API failed');
    return null;
  }
}

/**
 * Attempt to update a text block in the site FOOTER via the Content Save API.
 *
 * The footer uses a separate data store from page sections — the normal
 * `tryContentSaveApi` (which reads pageSectionsId from the page DOM) cannot
 * find footer blocks. This helper uses `getFooterSections()` which reads the
 * footer's pageSectionsId from `/api/site-header-footer`.
 *
 * Returns an ActionResult on success, null on failure. Never throws.
 *
 * @param page        Playwright page (used only to extract the subdomain)
 * @param searchText  Text to find in the footer (case-insensitive)
 * @param newText     Replacement text (plain text or HTML)
 * @param surgical    If true, does a substring replacement (patchFooterTextBlock)
 *                    instead of a full block replacement (updateFooterTextBlock)
 */
export async function tryFooterContentSaveApi(
  page: Page,
  searchText: string,
  newText: string,
  surgical: boolean = true,
): Promise<ActionResult | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug('tryFooterContentSaveApi: could not extract subdomain from URL');
    return null;
  }

  try {
    const client = createContentSaveClient(subdomain);

    // Use surgical (patch) by default — preserves other content in the block.
    // Fall back to full replacement if surgical fails.
    const result = surgical
      ? await client.patchFooterTextBlock(searchText, newText)
      : await client.updateFooterTextBlock(searchText, newText);

    if (result.success) {
      const mode = surgical ? 'patched' : 'replaced';
      logger.info(
        { blockId: result.blockId, searchText, mode },
        `Footer Content Save API: text block ${mode} successfully`,
      );
      return {
        success: true,
        message: `editTextBlock: Updated footer text via Content Save API (block ${result.blockId}, ${mode}). Old: "${result.oldText}". Reload the page to see the change in the editor.`,
      };
    }

    // If surgical failed, try full replacement as fallback
    if (surgical) {
      logger.info({ error: result.error }, 'Footer patch failed — trying full replacement');
      const fullResult = await client.updateFooterTextBlock(searchText, newText);
      if (fullResult.success) {
        logger.info(
          { blockId: fullResult.blockId, searchText },
          'Footer Content Save API: text block replaced (fallback from patch)',
        );
        return {
          success: true,
          message: `editTextBlock: Updated footer text via Content Save API (block ${fullResult.blockId}, full replacement). Old: "${fullResult.oldText}". Reload the page to see the change in the editor.`,
        };
      }
    }

    logger.warn({ error: result.error, searchText }, 'Footer Content Save API: update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Footer Content Save API failed');
    return null;
  }
}
