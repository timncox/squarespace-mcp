import { Page } from 'playwright';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';
import { createMediaUploadClient } from '../../services/media-upload.js';
import { createContentSaveClient, ContentSaveClient, type BlockMoveResult, type BlockResizeResult, type BlockRemoveResult, type SectionMoveResult, type ImageBlockUpdateResult, type TextBlockAddResult, type TextPatchResult, type MenuBlockUpdateResult, type SectionStyleResult, type SectionStyleOptions } from '../../services/content-save.js';
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
 * Pure helper: apply formatting transformations to a Squarespace text block's HTML.
 *
 * Processes each block-level element (<p>, <h1>-<h6>) independently:
 * - formatLevel: replaces the element tag (heading1→h1, heading2→h2, etc.)
 * - alignment: adds/replaces text-align in the style attribute
 * - bold: wraps inner content in <strong> (no-ops if already present)
 * - italic: wraps inner content in <em> (no-ops if already present)
 *
 * Returns html unchanged if no opts are provided.
 * Only handles heading1-4 for formatLevel — paragraph variants are not supported
 * (class names vary by site theme). Falls through to UI for those cases.
 */
export function applyFormattingToHtml(
  html: string,
  opts: {
    formatLevel?: 'heading1' | 'heading2' | 'heading3' | 'heading4';
    bold?: boolean;
    italic?: boolean;
    alignment?: 'left' | 'center' | 'right';
  },
): string {
  const { formatLevel, bold, italic, alignment } = opts;

  const tagMap: Record<string, string> = {
    heading1: 'h1', heading2: 'h2', heading3: 'h3', heading4: 'h4',
  };
  const newTag = formatLevel ? tagMap[formatLevel] : undefined;

  // Match each block-level element: opening tag + content + closing tag
  // Non-greedy so multiple elements in a row are processed separately
  return html.replace(
    /<(p|h[1-6])(\s[^>]*)?>[\s\S]*?<\/\1>/gi,
    (match, tag, rawAttrs) => {
      const attrs: string = rawAttrs ?? '';

      // ── 1. Compute the new tag ───────────────────────────────────────
      const finalTag = newTag ?? tag.toLowerCase();

      // ── 2. Compute new style attribute ──────────────────────────────
      // Extract existing style value (always present in SQS HTML)
      const styleMatch = attrs.match(/style="([^"]*)"/i);
      let style = styleMatch ? styleMatch[1] : 'white-space:pre-wrap;';

      if (alignment) {
        // Remove any existing text-align, then append new one
        style = style.replace(/;?\s*text-align:[^;]+/gi, '').replace(/;$/, '');
        style = `${style};text-align:${alignment};`.replace(/^;/, '');
      }

      // Rebuild attrs: keep class, replace style
      const classMatch = attrs.match(/class="([^"]*)"/i);
      const className = classMatch ? classMatch[1] : '';
      const newAttrs = ` class="${className}" style="${style}"`;

      // ── 3. Extract inner content (everything between opening & closing tag) ──
      const innerMatch = match.match(
        /^<(?:p|h[1-6])(?:\s[^>]*)?>([\s\S]*?)<\/(?:p|h[1-6])>$/i,
      );
      let inner = innerMatch ? innerMatch[1] : '';

      // ── 4. Apply italic (inner wrapper) ─────────────────────────────
      if (italic !== undefined) {
        inner = inner.replace(/<em>([\s\S]*?)<\/em>/gi, '$1');
        if (italic) inner = `<em>${inner}</em>`;
      }

      // ── 5. Apply bold (outer wrapper) ───────────────────────────────
      if (bold !== undefined) {
        // Strip existing <strong> wrappers, then re-apply if bold=true
        inner = inner.replace(/<strong>([\s\S]*?)<\/strong>/gi, '$1');
        if (bold) inner = `<strong>${inner}</strong>`;
      }

      return `<${finalTag}${newAttrs}>${inner}</${finalTag}>`;
    },
  );
}

/**
 * Common API context needed by all try*Api() functions.
 * Extracts subdomain, pageSectionsId, collectionId from the Playwright page.
 * Returns null if any extraction step fails (caller should return null to fall through to UI).
 */
interface ApiContext {
  subdomain: string;
  pageSectionsId: string;
  collectionId: string;
  client: ContentSaveClient;
  slug: string;
}

async function extractApiContext(
  page: Page,
  callerName: string,
): Promise<ApiContext | null> {
  const subdomain = extractSubdomain(page);
  if (!subdomain) {
    logger.debug(`${callerName}: could not extract subdomain from URL`);
    return null;
  }

  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  if (!siteFrame) {
    logger.debug(`${callerName}: no sqs-site-frame found`);
    return null;
  }

  const pageSectionsId = await siteFrame.evaluate(() => {
    const article = document.querySelector('article[data-page-sections]');
    return article?.getAttribute('data-page-sections') ?? null;
  }).catch(() => null);

  if (!pageSectionsId) {
    logger.debug(`${callerName}: could not find data-page-sections attribute`);
    return null;
  }

  const client = createContentSaveClient(subdomain);
  const pageUrl = page.url();
  const slugMatch = pageUrl.match(/squarespace\.com\/config\/pages\/([^/?#]+)/);
  const slug = slugMatch?.[1] ?? '';
  const ids = await client.getPageIds(slug);

  if (!ids) {
    logger.debug({ slug }, `${callerName}: could not get page IDs`);
    return null;
  }

  // Cache page IDs for simple edit fast path
  try {
    const { cachePageIds } = await import('../../services/page-id-resolver.js');
    cachePageIds(subdomain, slug, pageSectionsId, ids.collectionId);
  } catch { /* non-blocking */ }

  return {
    subdomain,
    pageSectionsId,
    collectionId: ids.collectionId,
    client,
    slug,
  };
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
 * Detects substring edits (searchText is a portion of the block's full text) and uses
 * patchTextBlock for surgical replacement, preserving surrounding content.
 *
 * Returns an ActionResult on success, null on failure. Never throws.
 */
export async function tryContentSaveApi(
  page: Page,
  searchText: string,
  newText: string,
): Promise<ActionResult | null> {
  const ctx = await extractApiContext(page, 'tryContentSaveApi');
  if (!ctx) return null;

  try {
    // Determine if this is a substring edit or a full block replacement.
    // First, peek at the block's full text to compare with searchText.
    const sections = await ctx.client.getPageSections(ctx.pageSectionsId);
    const blockMatch = ctx.client.findBlock(sections.sections, searchText);

    if (!blockMatch) {
      logger.debug({ searchText }, 'tryContentSaveApi: no block found matching searchText');
      return null;
    }

    const blockHtml = blockMatch.gridContent.content.value.value?.html
      ?? blockMatch.gridContent.content.value.value?.source ?? '';
    const blockPlainText = blockHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    const searchNormalized = searchText.replace(/\s+/g, ' ').trim();

    // Substring detection: if searchText is significantly shorter than the block's
    // full text, this is a surgical edit — use patchTextBlock instead.
    const isSubstring = blockPlainText.toLowerCase() !== searchNormalized.toLowerCase()
      && blockPlainText.toLowerCase().includes(searchNormalized.toLowerCase());

    if (isSubstring) {
      logger.info(
        { searchText, blockTextLength: blockPlainText.length },
        'Content Save API: detected substring edit — using patchTextBlock',
      );

      const patchResult: TextPatchResult = await ctx.client.patchTextBlock(
        ctx.pageSectionsId,
        ctx.collectionId,
        searchText,
        newText,
      );

      if (patchResult.success) {
        logger.info(
          { blockId: patchResult.blockId, searchText, newTextLength: newText.length },
          'Content Save API: text block patched (surgical edit)',
        );
        return {
          success: true,
          message: `editTextBlock: Surgically patched text via Content Save API (block ${patchResult.blockId}). Replaced "${searchText}" with "${newText.substring(0, 60)}". Surrounding content preserved. Reload the page to see the change.`,
        };
      }

      logger.warn({ error: patchResult.error, searchText }, 'Content Save API: patch failed, falling back');
      return null;
    }

    // Full block replacement — use existing updateTextBlock
    // Wrap newText in <p> tags if it's plain text (no HTML tags)
    const newHtml = newText.includes('<') ? newText : `<p>${newText}</p>`;

    const result = await ctx.client.updateTextBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
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
  const ctx = await extractApiContext(page, 'tryBlockMoveApi');
  if (!ctx) return null;

  try {
    const result: BlockMoveResult = await ctx.client.moveBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
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
  const ctx = await extractApiContext(page, 'tryBlockResizeApi');
  if (!ctx) return null;

  try {
    const result: BlockResizeResult = await ctx.client.resizeBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
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
  const ctx = await extractApiContext(page, 'tryBlockRemoveApi');
  if (!ctx) return null;

  try {
    const result: BlockRemoveResult = await ctx.client.removeBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
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
  const ctx = await extractApiContext(page, 'trySectionMoveApi');
  if (!ctx) return null;

  try {
    const result: SectionMoveResult = await ctx.client.moveSection(
      ctx.pageSectionsId,
      ctx.collectionId,
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
  const ctx = await extractApiContext(page, 'tryImageBlockUpdateApi');
  if (!ctx) return null;

  try {
    const result: ImageBlockUpdateResult = await ctx.client.updateImageBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
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
  const ctx = await extractApiContext(page, 'tryAddTextBlockApi');
  if (!ctx) return null;

  try {
    const result: TextBlockAddResult = await ctx.client.addTextBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
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

/**
 * Attempt to update a menu block via the Content Save API (no UI).
 * Reads the current menu, optionally merges with new content, and writes back.
 *
 * @param page        Playwright page
 * @param searchText  Text to find the menu block (tab/section/item title)
 * @param newContent  New menu content (plain text format)
 * @param merge       If true, structurally merge updates into existing menu.
 *                    If false, parse newContent as a full replacement.
 * @returns ActionResult on success, null on failure. Never throws.
 */
export async function tryMenuBlockApi(
  page: Page,
  searchText: string,
  newContent: string,
  merge?: boolean,
): Promise<ActionResult | null> {
  const ctx = await extractApiContext(page, 'tryMenuBlockApi');
  if (!ctx) return null;

  try {
    // Read current menu
    const currentMenu = await ctx.client.getMenuBlock(ctx.pageSectionsId, searchText);
    if (!currentMenu.success || !currentMenu.menus) {
      logger.debug({ searchText, error: currentMenu.error }, 'tryMenuBlockApi: menu block not found');
      return null;
    }

    // Dynamic imports to avoid circular deps
    const { parseMenuText } = await import('../../services/menu-parser.js');

    let newMenus;
    if (merge) {
      // Structured merge: parse updates, merge with current
      const parsed = parseMenuText(newContent);
      if (parsed.length === 0) {
        // Prose input (e.g. "set Bash Burger price to $30") — can't merge structurally.
        // Fall back to UI path where the LLM merger handles prose.
        logger.info('tryMenuBlockApi: newContent did not parse into menu tabs — falling back to LLM merge');
        return null;
      }
      const { mergeMenuFromText } = await import('../../services/menu-merger.js');
      newMenus = mergeMenuFromText(currentMenu.menus, newContent);
    } else {
      // Full replacement: parse newContent as the complete menu
      newMenus = parseMenuText(newContent);
    }

    // Write back
    const result: MenuBlockUpdateResult = await ctx.client.updateMenuBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
      searchText,
      newMenus,
    );

    if (result.success) {
      const modeStr = merge ? 'merged' : 'replaced';
      logger.info(
        { blockId: result.blockId, mode: modeStr, oldTabs: result.oldTabCount, newTabs: result.newTabCount },
        'Menu Block API: update succeeded',
      );
      return {
        success: true,
        message: `editMenuBlock: Updated menu via Content Save API (${modeStr}, block ${result.blockId}). Tabs: ${result.oldTabCount}→${result.newTabCount}, Items: ${result.oldItemCount}→${result.newItemCount}. Reload the page to see the change.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Menu Block API: update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Menu Block API failed');
    return null;
  }
}

/**
 * Attempt to update a button block via the Content Save API (no UI).
 * Returns ActionResult on success/definitive failure, null to fall through to UI.
 * Never throws.
 */
export async function tryButtonBlockApi(
  page: Page,
  searchText: string,
  updates: { newLabel?: string; url?: string },
): Promise<ActionResult | null> {
  const ctx = await extractApiContext(page, 'tryButtonBlockApi');
  if (!ctx) return null;

  try {
    const result = await ctx.client.updateButtonBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
      searchText,
      updates,
    );

    if (result.success) {
      logger.info(
        { blockId: result.blockId, searchText, newLabel: updates.newLabel, newUrl: updates.url },
        'Content Save API: button block updated successfully',
      );
      return {
        success: true,
        message: `editButtonBlock: Updated button via Content Save API (block ${result.blockId}). Label: "${result.newLabel}", URL: "${result.newUrl}". Reload the page to see the change.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Content Save API: button update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'tryButtonBlockApi: failed');
    return null;
  }
}

/**
 * Attempt to update a quote block via the Content Save API (no UI).
 * Returns ActionResult on success/definitive failure, null to fall through to UI.
 * Never throws.
 */
export async function tryQuoteBlockApi(
  page: Page,
  searchText: string,
  updates: { quoteText?: string; attribution?: string },
): Promise<ActionResult | null> {
  const ctx = await extractApiContext(page, 'tryQuoteBlockApi');
  if (!ctx) return null;

  try {
    const result = await ctx.client.updateQuoteBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
      searchText,
      updates,
    );

    if (result.success) {
      logger.info(
        { blockId: result.blockId, searchText, newQuote: updates.quoteText?.substring(0, 80) },
        'Content Save API: quote block updated successfully',
      );
      return {
        success: true,
        message: `editQuoteBlock: Updated quote via Content Save API (block ${result.blockId}). Reload the page to see the change.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Content Save API: quote update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'tryQuoteBlockApi: failed');
    return null;
  }
}

/**
 * Attempt to update a code block via the Content Save API (no UI).
 * Returns ActionResult on success/definitive failure, null to fall through to UI.
 * Never throws.
 */
export async function tryCodeBlockApi(
  page: Page,
  searchText: string,
  updates: { code?: string; language?: string },
): Promise<ActionResult | null> {
  const ctx = await extractApiContext(page, 'tryCodeBlockApi');
  if (!ctx) return null;

  try {
    const result = await ctx.client.updateCodeBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
      searchText,
      updates,
    );

    if (result.success) {
      logger.info(
        { blockId: result.blockId, searchText, codeLength: updates.code?.length, language: updates.language },
        'Content Save API: code block updated successfully',
      );
      return {
        success: true,
        message: `editCodeBlock: Updated code block via Content Save API (block ${result.blockId}). Reload the page to see the change.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Content Save API: code update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'tryCodeBlockApi: failed');
    return null;
  }
}

/**
 * Attempt to format a text block via the Content Save API (no UI).
 *
 * Supported via API: heading1-4 (tag replacement), bold, italic, alignment.
 * Unsupported via API (returns null to fall through): paragraph1-3, monospace,
 * fontSize (class names theme-dependent; no clean API mapping).
 *
 * Returns ActionResult on success, null on failure. Never throws.
 */
export async function tryFormatTextBlockApi(
  page: Page,
  action: {
    searchText: string;
    formatLevel?: 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'paragraph1' | 'paragraph2' | 'paragraph3' | 'monospace';
    bold?: boolean;
    italic?: boolean;
    alignment?: 'left' | 'center' | 'right';
    fontSize?: 'increase' | 'decrease';
  },
): Promise<ActionResult | null> {
  const { searchText, formatLevel, bold, italic, alignment, fontSize } = action;

  // fontSize has no clean API mapping — skip entirely
  if (fontSize) return null;
  // paragraph1-3 and monospace have theme-dependent class names — skip
  if (formatLevel && !['heading1', 'heading2', 'heading3', 'heading4'].includes(formatLevel)) {
    return null;
  }
  // Nothing API-eligible
  if (!formatLevel && bold === undefined && italic === undefined && !alignment) {
    return null;
  }

  const ctx = await extractApiContext(page, 'tryFormatTextBlockApi');
  if (!ctx) return null;

  try {
    // GET current sections → find the block
    const data = await ctx.client.getPageSections(ctx.pageSectionsId);
    const blockMatch = ctx.client.findBlock(data.sections, searchText);
    if (!blockMatch) {
      logger.debug({ searchText }, 'tryFormatTextBlockApi: block not found');
      return null;
    }

    // Read current HTML
    const currentHtml: string =
      blockMatch.gridContent.content.value.value?.html ??
      blockMatch.gridContent.content.value.value?.source ?? '';

    if (!currentHtml) {
      logger.debug({ searchText }, 'tryFormatTextBlockApi: block has no HTML content');
      return null;
    }

    // Apply formatting transformations
    const newHtml = applyFormattingToHtml(currentHtml, {
      formatLevel: formatLevel as 'heading1' | 'heading2' | 'heading3' | 'heading4' | undefined,
      bold,
      italic,
      alignment,
    });

    if (newHtml === currentHtml) {
      // Nothing changed — return success so the UI path isn't attempted unnecessarily
      return {
        success: true,
        message: `formatTextBlock: No changes needed — block "${searchText}" already has the requested formatting.`,
      };
    }

    // Write back via updateTextBlockHtml (bypasses formatHtml() wrapper — we built the HTML ourselves)
    const result = await ctx.client.updateTextBlockHtml(
      ctx.pageSectionsId,
      ctx.collectionId,
      searchText,
      newHtml,
    );

    if (result.success) {
      const parts: string[] = [];
      if (formatLevel) parts.push(`format → ${formatLevel}`);
      if (bold) parts.push('bold');
      if (italic) parts.push('italic');
      if (alignment) parts.push(`align → ${alignment}`);
      logger.info(
        { blockId: result.blockId, searchText, formatLevel, bold, italic, alignment },
        'Format Text Block API: formatting applied successfully',
      );
      return {
        success: true,
        message: `formatTextBlock: Applied ${parts.join(', ')} to block "${searchText}" via Content Save API (block ${result.blockId}). Reload the page to see the change in the editor.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Format Text Block API: update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'tryFormatTextBlockApi: failed');
    return null;
  }
}

/**
 * Attempt to edit section style via the Content Save API (no UI).
 * Replaces the 15-20 step browser agent UI automation with a single read-modify-write.
 * Returns an ActionResult on success, null on failure. Never throws.
 */
export async function trySectionStyleApi(
  page: Page,
  searchText: string,
  styles: SectionStyleOptions,
): Promise<ActionResult | null> {
  const ctx = await extractApiContext(page, 'trySectionStyleApi');
  if (!ctx) return null;

  try {
    const result: SectionStyleResult = await ctx.client.editSectionStyle(
      ctx.pageSectionsId,
      ctx.collectionId,
      searchText,
      styles,
    );

    if (result.success) {
      const fieldsStr = result.updatedFields?.join(', ') ?? 'unknown';
      logger.info(
        { sectionId: result.sectionId, sectionIndex: result.sectionIndex, updatedFields: result.updatedFields },
        'Section Style API: section style updated successfully',
      );
      return {
        success: true,
        message: `editSectionStyle: Updated section style via Content Save API (section ${result.sectionId}, index ${result.sectionIndex}). Updated: ${fieldsStr}. Reload the page to see the change in the editor.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Section Style API: update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Section Style API failed');
    return null;
  }
}
