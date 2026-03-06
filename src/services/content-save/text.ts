import { ContentSaveClient, BLOCK_TYPE_TEXT } from './client.js';
import type {
  TextUpdateResult,
  TextPatchResult,
  TextBlockAddResult,
  FillBlockResult,
  GridContent,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    updateTextBlock(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      newHtml: string,
    ): Promise<TextUpdateResult>;
    patchTextBlock(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      newText: string,
    ): Promise<TextPatchResult>;
    updateTextBlockHtml(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      rawHtml: string,
    ): Promise<TextUpdateResult>;
    patchHtmlSegment(
      html: string,
      searchText: string,
      newText: string,
    ): { html: string; matchedSegment: string } | null;
    addTextBlock(
      pageSectionsId: string,
      collectionId: string,
      sectionIndex: number,
      html: string,
      layout?: {
        columns?: number;
        rowHeight?: number;
        gapRows?: number;
        startX?: number;
        endX?: number;
        startY?: number;
        endY?: number;
      },
      formatting?: {
        tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'p';
        alignment?: 'left' | 'center' | 'right';
        bold?: boolean;
        italic?: boolean;
      },
    ): Promise<TextBlockAddResult>;
    fillLastTextBlockInSection(
      pageSectionsId: string,
      collectionId: string,
      sectionIndex: number,
      newHtml: string,
    ): Promise<FillBlockResult>;
  }
}

// ── Module-scoped helpers (were private instance methods) ────────────────────

function tokenizeHtml(html: string): Array<{ value: string; isTag: boolean }> {
  const tokens: Array<{ value: string; isTag: boolean }> = [];
  const tagRegex = /<[^>]+>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ value: html.substring(lastIndex, match.index), isTag: false });
    }
    tokens.push({ value: match[0], isTag: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < html.length) {
    tokens.push({ value: html.substring(lastIndex), isTag: false });
  }

  return tokens;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function decodedToRawOffset(raw: string, decodedOffset: number): number {
  const entityPattern = /&(?:nbsp|amp|lt|gt|quot|apos|#39);/g;
  let decodedPos = 0;
  let rawPos = 0;

  while (decodedPos < decodedOffset && rawPos < raw.length) {
    entityPattern.lastIndex = rawPos;
    const entityMatch = entityPattern.exec(raw);

    if (entityMatch && entityMatch.index === rawPos) {
      decodedPos++;
      rawPos = entityMatch.index + entityMatch[0].length;
    } else {
      decodedPos++;
      rawPos++;
    }
  }

  return rawPos;
}

function replaceTextInHtml(
  html: string,
  searchText: string,
  newText: string,
  stripHtmlFn: (h: string) => string,
): string | null {
  // If newText is raw HTML, replace the entire segment
  if (newText.trimStart().startsWith('<')) {
    const tagMatch = html.match(/^<(p|h[1-6]|div|li)(\s[^>]*)?>/i);
    if (tagMatch) {
      return newText;
    }
    return newText;
  }

  const tokens = tokenizeHtml(html);
  const needle = searchText.toLowerCase();

  const textParts: Array<{ raw: string; decoded: string; tokenIndex: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].isTag) {
      textParts.push({
        raw: tokens[i].value,
        decoded: decodeEntities(tokens[i].value),
        tokenIndex: i,
      });
    }
  }

  const fullDecodedText = textParts.map(tp => tp.decoded).join('');
  const matchIndex = fullDecodedText.toLowerCase().indexOf(needle);
  if (matchIndex === -1) return null;

  const matchEnd = matchIndex + searchText.length;

  let decodedCharPos = 0;
  for (const tp of textParts) {
    const decodedTokenStart = decodedCharPos;
    const decodedTokenEnd = decodedCharPos + tp.decoded.length;

    if (decodedTokenEnd > matchIndex && decodedTokenStart < matchEnd) {
      const decodedReplaceStart = Math.max(0, matchIndex - decodedTokenStart);
      const decodedReplaceEnd = Math.min(tp.decoded.length, matchEnd - decodedTokenStart);

      const rawReplaceStart = decodedToRawOffset(tp.raw, decodedReplaceStart);
      const rawReplaceEnd = decodedToRawOffset(tp.raw, decodedReplaceEnd);

      const before = tp.raw.substring(0, rawReplaceStart);
      const after = tp.raw.substring(rawReplaceEnd);

      if (decodedTokenStart <= matchIndex) {
        tokens[tp.tokenIndex].value = before + newText + after;
      } else {
        tokens[tp.tokenIndex].value = after;
      }
    }

    decodedCharPos = decodedTokenEnd;
  }

  return tokens.map(t => t.value).join('');
}

// ── Prototype methods ───────────────────────────────────────────────────────

ContentSaveClient.prototype.updateTextBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  newHtml: string,
): Promise<TextUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findTextBlock(data.sections, searchText);
    if (!match) {
      return {
        success: false,
        error: `No text block found containing "${searchText}"`,
      };
    }

    const { gridContent, sectionIndex, blockIndex } = match;
    const blockValue = gridContent.content.value;
    const oldHtml = blockValue.value?.html ?? '';
    const blockId = blockValue.id;

    logger.info(
      {
        blockId,
        sectionIndex,
        blockIndex,
        oldHtmlLength: oldHtml.length,
        newHtmlLength: newHtml.length,
      },
      'Found text block, updating content',
    );

    const formattedHtml = this.formatHtml(newHtml);
    if (blockValue.value) {
      blockValue.value.html = formattedHtml;
      blockValue.value.source = formattedHtml;
    }

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);

    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      blockId,
      oldText: this.stripHtml(oldHtml),
      newHtml: formattedHtml,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.patchTextBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  newText: string,
): Promise<TextPatchResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findTextBlock(data.sections, searchText);
    if (!match) {
      return {
        success: false,
        error: `No text block found containing "${searchText}"`,
      };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;
    const blockId = blockValue.id;
    const html = blockValue.value?.html ?? blockValue.value?.source ?? '';

    if (!html) {
      return {
        success: false,
        error: `Text block ${blockId} has no HTML content`,
      };
    }

    const patched = this.patchHtmlSegment(html, searchText, newText);

    if (!patched) {
      return {
        success: false,
        error: `Could not locate "${searchText}" within any HTML segment of block ${blockId}`,
      };
    }

    logger.info(
      {
        blockId,
        searchText,
        newTextLength: newText.length,
        originalHtmlLength: html.length,
        patchedHtmlLength: patched.html.length,
      },
      'Patching text block (surgical replacement)',
    );

    if (blockValue.value) {
      blockValue.value.html = patched.html;
      blockValue.value.source = patched.html;
    }

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);

    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      blockId,
      patchedSegment: patched.matchedSegment,
      oldText: this.stripHtml(html),
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateTextBlockHtml = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  rawHtml: string,
): Promise<TextUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);

    const match = this.findTextBlock(data.sections, searchText);
    if (!match) {
      return {
        success: false,
        error: `No text block found containing "${searchText}"`,
      };
    }

    const { gridContent, sectionIndex, blockIndex } = match;
    const blockValue = gridContent.content.value;
    const oldHtml = blockValue.value?.html ?? '';
    const blockId = blockValue.id;

    logger.info(
      {
        blockId,
        sectionIndex,
        blockIndex,
        oldHtmlLength: oldHtml.length,
        newHtmlLength: rawHtml.length,
      },
      'Found text block, updating content (raw HTML mode)',
    );

    if (blockValue.value) {
      blockValue.value.html = rawHtml;
      blockValue.value.source = rawHtml;
    }

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);

    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      blockId,
      oldText: this.stripHtml(oldHtml),
      newHtml: rawHtml,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.patchHtmlSegment = function (
  this: ContentSaveClient,
  html: string,
  searchText: string,
  newText: string,
): { html: string; matchedSegment: string } | null {
  const blockTagPattern = /<(p|h[1-6]|div|li)(\s[^>]*)?>[\s\S]*?<\/\1>/gi;
  const segments: Array<{ fullMatch: string; start: number; end: number }> = [];

  let segMatch: RegExpExecArray | null;
  while ((segMatch = blockTagPattern.exec(html)) !== null) {
    segments.push({
      fullMatch: segMatch[0],
      start: segMatch.index,
      end: segMatch.index + segMatch[0].length,
    });
  }

  if (segments.length === 0) {
    const stripped = this.stripHtml(html);
    if (!stripped.toLowerCase().includes(searchText.toLowerCase())) {
      return null;
    }
    const patched = replaceTextInHtml(html, searchText, newText, this.stripHtml.bind(this));
    return patched ? { html: patched, matchedSegment: html } : null;
  }

  const needle = searchText.toLowerCase();
  for (const seg of segments) {
    const strippedSeg = this.stripHtml(seg.fullMatch);
    if (strippedSeg.toLowerCase().includes(needle)) {
      const patchedSegment = replaceTextInHtml(seg.fullMatch, searchText, newText, this.stripHtml.bind(this));
      if (!patchedSegment) continue;

      const patchedHtml = html.substring(0, seg.start) + patchedSegment + html.substring(seg.end);
      return { html: patchedHtml, matchedSegment: seg.fullMatch };
    }
  }

  const stripped = this.stripHtml(html);
  if (stripped.toLowerCase().includes(needle)) {
    const patched = replaceTextInHtml(html, searchText, newText, this.stripHtml.bind(this));
    return patched ? { html: patched, matchedSegment: html } : null;
  }

  return null;
};

ContentSaveClient.prototype.addTextBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  html: string,
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
  formatting?: {
    tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'p';
    alignment?: 'left' | 'center' | 'right';
    bold?: boolean;
    italic?: boolean;
  },
): Promise<TextBlockAddResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Backfill verticalAlignment and zIndex on existing blocks
    for (let i = 0; i < gridContents.length; i++) {
      const gc = gridContents[i];
      if (gc.layout?.desktop) {
        if (gc.layout.desktop.verticalAlignment == null) gc.layout.desktop.verticalAlignment = 'top';
        if (gc.layout.desktop.zIndex == null) gc.layout.desktop.zIndex = i;
      }
      if (gc.layout?.mobile) {
        if (gc.layout.mobile.verticalAlignment == null) gc.layout.mobile.verticalAlignment = 'top';
        if (gc.layout.mobile.zIndex == null) gc.layout.mobile.zIndex = i;
      }
    }

    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    const rowHeight = layout?.rowHeight ?? 3;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    const blockId = ContentSaveClient.generateBlockId();
    const formattedHtml = this.formatHtml(html, formatting);

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_TEXT,
          value: {
            engine: 'wysiwyg',
            source: formattedHtml,
            html: formattedHtml,
            textAttributes: [],
          },
        },
      },
    };

    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, position: { startX, startY, endX, endY } },
      'Adding text block via Content Save API',
    );

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.fillLastTextBlockInSection = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  newHtml: string,
): Promise<FillBlockResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return {
        success: false,
        error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})`,
      };
    }

    const section = sections[sectionIndex];
    if (!section?.fluidEngineContext?.gridContents) {
      return { success: false, error: `Section ${sectionIndex} (${section?.id ?? 'unknown'}) has no gridContents` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    if (gridContents.length === 0) {
      return { success: false, error: `Section ${sectionIndex} (${section.id}) has no blocks` };
    }

    let textBlockCount = 0;
    for (let i = gridContents.length - 1; i >= 0; i--) {
      const gc = gridContents[i];
      if (gc.content?.value?.type !== BLOCK_TYPE_TEXT) continue;

      textBlockCount++;
      const rawHtml = gc.content.value.value?.html ?? gc.content.value.value?.source ?? '';
      const blockText = this.stripHtml(rawHtml);

      if (blockText.length < 50) {
        const formattedHtml = this.formatHtml(newHtml);

        if (!gc.content.value.value) {
          gc.content.value.value = { engine: 'wysiwyg', source: '', html: '', textAttributes: [] };
        }
        gc.content.value.value.html = formattedHtml;
        gc.content.value.value.source = formattedHtml;

        const blockId = gc.content.value.id;

        logger.info(
          { blockId, sectionIndex, blockIndex: i, oldTextLength: blockText.length },
          'fillLastTextBlockInSection: filling placeholder block',
        );

        const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
        return saveResult.success
          ? { success: true, blockId }
          : { success: false, error: saveResult.error };
      }
    }

    const blockTypes = gridContents.map(gc => gc.content?.value?.type);
    logger.warn(
      { sectionIndex, sectionId: section.id, totalBlocks: gridContents.length, textBlockCount, blockTypes },
      'fillLastTextBlockInSection: no short/empty text block found',
    );

    if (textBlockCount === 0) {
      return {
        success: false,
        error: `Section ${sectionIndex} has ${gridContents.length} block(s) but none are text blocks (types: ${[...new Set(blockTypes)].join(', ')})`,
      };
    }

    return {
      success: false,
      error: `Section ${sectionIndex} has ${textBlockCount} text block(s) but all have content longer than 50 chars`,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
