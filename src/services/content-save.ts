/**
 * Squarespace Content Save Service
 *
 * Saves page content directly via the internal REST API, bypassing Playwright
 * UI automation entirely. This is far faster and more reliable than the
 * browser agent's editTextBlock action for simple text changes.
 *
 * Auth: Uses Squarespace editor session cookies (extracted from saved session).
 * Flow: load cookies → get crumb → GET current sections → modify → PUT sections
 *
 * Endpoints:
 *   GET  /api/page-sections/{pageSectionsId}                              → read sections
 *   PUT  /api/page-sections/{pageSectionsId}/collection/{collectionId}    → save sections
 *   GET  /api/commondata/GetCollections/                                  → list collections (for IDs)
 *
 * Discovered Feb 2026 via network interception of Squarespace editor save (Cmd+S).
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

// ── Re-export all types from content-save-types.ts for backward compatibility ─
export type {
  RichHtmlElement,
  GridCoord,
  BreakpointLayout,
  BlockLayout,
  BlockMoveResult,
  BlockResizeResult,
  BlockRemoveResult,
  SectionMoveResult,
  ImageBlockUpdateResult,
  FooterTextUpdateResult,
  HeaderFooterConfig,
  TextBlockAddResult,
  ButtonBlockAddResult,
  ImageBlockAddResult,
  ImageBlockBatchResult,
  ButtonBlockUpdateResult,
  FillBlockResult,
  GridContent,
  GridSettings,
  PageSection,
  PageSectionsData,
  ContentSaveResult,
  MenuBlockUpdateResult,
  TextUpdateResult,
  TextPatchResult,
  GallerySettings,
  GallerySettingsUpdateResult,
  AddBlankSectionResult,
  CopyTemplateSectionResult,
  AddGalleryImageResult,
  GalleryItem,
  SectionCatalogEntry,
  SectionCatalogResponse,
  SectionStyleOptions,
  SectionStyleResult,
  SectionDuplicateResult,
  SectionReorderResult,
  BlockDuplicateResult,
  CollectionInfo,
  PageMetadata,
  CollectionItem,
  CollectionItemsOptions,
  CollectionItemsResult,
  PageCreateResult,
  BlogPostCreateResult,
  BlogPostUpdateOptions,
  BlogPostUpdateResult,
  PageDeleteResult,
  PageMetadataUpdateOptions,
  PageMetadataUpdateResult,
  QuoteBlockAddResult,
  QuoteBlockUpdateResult,
  CodeBlockAddResult,
  CodeBlockUpdateResult,
  DividerBlockAddResult,
  VideoBlockAddResult,
  VideoBlockUpdateResult,
  NewsletterBlockAddResult,
  NewsletterBlockUpdateResult,
  AccordionBlockAddResult,
  AccordionBlockUpdateResult,
  MarqueeBlockAddResult,
  MarqueeBlockUpdateResult,
  FormBlockAddResult,
  FormBlockUpdateResult,
} from './content-save-types.js';

import type {
  RichHtmlElement,
  GridCoord,
  BreakpointLayout,
  BlockLayout,
  BlockMoveResult,
  BlockResizeResult,
  BlockRemoveResult,
  SectionMoveResult,
  ImageBlockUpdateResult,
  FooterTextUpdateResult,
  HeaderFooterConfig,
  TextBlockAddResult,
  ButtonBlockAddResult,
  ImageBlockAddResult,
  ImageBlockBatchResult,
  ButtonBlockUpdateResult,
  FillBlockResult,
  GridContent,
  GridSettings,
  PageSection,
  PageSectionsData,
  ContentSaveResult,
  MenuBlockUpdateResult,
  TextUpdateResult,
  TextPatchResult,
  GallerySettings,
  GallerySettingsUpdateResult,
  AddBlankSectionResult,
  CopyTemplateSectionResult,
  AddGalleryImageResult,
  GalleryItem,
  SectionCatalogEntry,
  SectionCatalogResponse,
  SectionStyleOptions,
  SectionStyleResult,
  SectionDuplicateResult,
  SectionReorderResult,
  BlockDuplicateResult,
  CollectionInfo,
  PageMetadata,
  CollectionItem,
  CollectionItemsOptions,
  CollectionItemsResult,
  PageCreateResult,
  BlogPostCreateResult,
  BlogPostUpdateOptions,
  BlogPostUpdateResult,
  PageDeleteResult,
  PageMetadataUpdateOptions,
  PageMetadataUpdateResult,
  QuoteBlockAddResult,
  QuoteBlockUpdateResult,
  CodeBlockAddResult,
  CodeBlockUpdateResult,
  DividerBlockAddResult,
  VideoBlockAddResult,
  VideoBlockUpdateResult,
  NewsletterBlockAddResult,
  NewsletterBlockUpdateResult,
  AccordionBlockAddResult,
  AccordionBlockUpdateResult,
  MarqueeBlockAddResult,
  MarqueeBlockUpdateResult,
  FormBlockAddResult,
  FormBlockUpdateResult,
} from './content-save-types.js';

// ── Config ──────────────────────────────────────────────────────────────────

const SESSION_PATH = join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');
const FETCH_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// Text/HTML block type in Squarespace Fluid Engine
const BLOCK_TYPE_TEXT = 2;
// Image block type
const BLOCK_TYPE_IMAGE = 1337;
// Button block type
const BLOCK_TYPE_BUTTON = 46;
// Menu block type
const BLOCK_TYPE_MENU = 18;
// Gallery block type
const BLOCK_TYPE_GALLERY = 8;
// Quote block type — confirmed via live site discovery (Feb 28 2026, test-page grey-yellow-hbxc)
const BLOCK_TYPE_QUOTE = 31;
// Code HTML block type — same as IMAGE (1337), distinguished by value.wysiwyg.engine === 'code'
const BLOCK_TYPE_CODE = 1337;
// Identifies a code HTML block within type 1337 blocks (value.wysiwyg.engine)
const CODE_BLOCK_ENGINE = 'code';
// Line/Divider block type — confirmed via live site discovery (Feb 28 2026, home page grey-yellow-hbxc)
const BLOCK_TYPE_DIVIDER = 47;
// Video (native) block type — confirmed via live site discovery (Feb 28 2026, home page grey-yellow-hbxc)
const BLOCK_TYPE_VIDEO = 32;
// Newsletter/email signup block type — confirmed via live site discovery (Feb 28 2026, grey-yellow-hbxc)
const BLOCK_TYPE_NEWSLETTER = 51;
// Accordion block type — confirmed via live site discovery (Feb 28 2026, grey-yellow-hbxc)
const BLOCK_TYPE_ACCORDION = 69;
// Marquee (scrolling text) block type — confirmed via live site discovery (Feb 28 2026, grey-yellow-hbxc)
const BLOCK_TYPE_MARQUEE = 70;
// Discriminator for Form blocks (type 1337 variant with buttonVariant field)
const FORM_BLOCK_DISCRIMINATOR = 'buttonVariant';

interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

// ── Content Save Client ─────────────────────────────────────────────────────

export class ContentSaveClient {
  private siteSubdomain: string;
  private siteCookieHeader: string = '';
  private crumbToken: string | null = null;
  private sessionAgeHours: number | null = null;
  private sessionLoadedAt: Date | null = null;

  constructor(siteSubdomain: string) {
    this.siteSubdomain = siteSubdomain;
  }

  /**
   * Load cookies from the saved Playwright session and build the cookie header.
   * Must be called before any API requests.
   */
  loadSessionCookies(sessionPath?: string): void {
    const path = sessionPath ?? SESSION_PATH;
    if (!existsSync(path)) {
      throw new Error(`Session file not found: ${path}. Run a browser session first to save login cookies.`);
    }

    const session = JSON.parse(readFileSync(path, 'utf-8'));
    const cookies: SessionCookie[] = session.cookies ?? [];

    const globalCookies: SessionCookie[] = [];
    const siteCookies: SessionCookie[] = [];

    for (const c of cookies) {
      const domain = c.domain.replace(/^\./, '');
      if (domain === 'squarespace.com') {
        globalCookies.push(c);
      } else if (
        domain === `${this.siteSubdomain}.squarespace.com` ||
        domain === `.${this.siteSubdomain}.squarespace.com` ||
        domain === 'account.squarespace.com'
      ) {
        siteCookies.push(c);
      }
    }

    // Build full cookie header (global + site-specific, deduplicated)
    const allCookies = [...globalCookies, ...siteCookies];
    const byName = new Map<string, SessionCookie>();
    for (const c of allCookies) {
      const existing = byName.get(c.name);
      if (!existing || c.domain.includes(this.siteSubdomain)) {
        byName.set(c.name, c);
      }
    }
    this.siteCookieHeader = Array.from(byName.values())
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    // Extract crumb token from site-specific cookies (must be from the site subdomain,
    // NOT from account.squarespace.com which has its own crumb)
    for (const c of siteCookies) {
      if (c.name === 'crumb' && c.domain.includes(this.siteSubdomain)) {
        this.crumbToken = c.value;
        break;
      }
    }

    logger.info(
      {
        siteSubdomain: this.siteSubdomain,
        globalCookies: globalCookies.length,
        siteCookies: siteCookies.length,
        hasCrumb: !!this.crumbToken,
      },
      'Loaded session cookies for content save',
    );

    // Track session file age for staleness detection
    const stats = statSync(path);
    const ageMs = Date.now() - stats.mtimeMs;
    this.sessionAgeHours = ageMs / (1000 * 60 * 60);
    this.sessionLoadedAt = new Date(stats.mtimeMs);
    if (this.sessionAgeHours > 24) {
      logger.warn(
        { ageHours: Math.round(this.sessionAgeHours), lastModified: this.sessionLoadedAt.toISOString() },
        'Session cookies are older than 24 hours — API calls may fail',
      );
    }
  }

  /**
   * Get the current page sections data.
   * Uses GET /api/page-sections/{pageSectionsId} (no collection suffix needed).
   */
  async getPageSections(pageSectionsId: string): Promise<PageSectionsData> {
    this.ensureCookies();

    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    const url = `${siteUrl}/api/page-sections/${pageSectionsId}`;
    logger.info({ pageSectionsId }, 'Fetching page sections');

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Failed to fetch page sections: ${response.status} ${response.statusText}. Body: ${body}`,
      );
    }

    const data = (await response.json()) as PageSectionsData;
    logger.info(
      { pageSectionsId, sectionsCount: data.sections?.length ?? 0 },
      'Page sections fetched',
    );
    return data;
  }

  /**
   * Save page sections data (full replacement).
   * Uses PUT /api/page-sections/{pageSectionsId}/collection/{collectionId}.
   */
  async savePageSections(
    pageSectionsId: string,
    collectionId: string,
    sections: PageSection[],
  ): Promise<ContentSaveResult> {
    this.ensureCookies();

    const url = this.buildPutUrl(pageSectionsId, collectionId);
    const body = JSON.stringify({ sections });

    logger.info(
      { pageSectionsId, collectionId, sectionsCount: sections.length, bodySize: body.length },
      'Saving page sections',
    );

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    // Squarespace returns 200 even for crumb failures — check response body
    const responseBody = await response.text().catch(() => '');

    if (!response.ok) {
      const error = `Save failed: ${response.status} ${response.statusText}. Body: ${responseBody}`;
      logger.error({ pageSectionsId, status: response.status }, error);
      return { success: false, pageSectionsId, collectionId, sectionsCount: sections.length, error };
    }

    // Check for crumb failure (Squarespace returns 200 with error in body)
    if (responseBody.includes('"crumbFail":true') || responseBody.includes('Invalid session crumb')) {
      const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
      const error = `Save rejected: invalid or expired session crumb.${ageInfo} Run a browser session to refresh cookies.`;
      logger.error({ pageSectionsId }, error);
      return { success: false, pageSectionsId, collectionId, sectionsCount: sections.length, error };
    }
    return { success: true, pageSectionsId, collectionId, sectionsCount: sections.length };
  }

  /**
   * Update a text block's content by searching for text and replacing it.
   *
   * Uses read-modify-write pattern:
   * 1. GET current sections
   * 2. Find the text block containing searchText
   * 3. Replace the block's HTML content with newHtml
   * 4. PUT the modified sections back
   *
   * @param pageSectionsId  The page sections ID (from data-page-sections attribute or getPageIds)
   * @param collectionId    The collection ID (from getPageIds or GetCollections API)
   * @param searchText      Text to search for (plain text, matched against stripped HTML)
   * @param newHtml         New HTML content for the block. Will be wrapped in Squarespace's
   *                        format: `<p class="" style="white-space:pre-wrap;">text</p>`
   */
  async updateTextBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    newHtml: string,
  ): Promise<TextUpdateResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the block with matching text
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

      // Step 3: Replace the block's HTML content
      // Wrap in Squarespace's standard format if it's plain text
      const formattedHtml = this.formatHtml(newHtml);
      if (blockValue.value) {
        blockValue.value.html = formattedHtml;
        blockValue.value.source = formattedHtml;
      }

      // Step 4: PUT the modified sections
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
  }

  /**
   * Surgical text patch: replace a substring within a text block's HTML,
   * preserving all surrounding content (other paragraphs, links, formatting).
   *
   * Strategy:
   * 1. GET sections → findTextBlock containing searchText
   * 2. Split the block's HTML into block-level segments (<p>, <h1>-<h6>, <div>, <li>)
   * 3. Find which segment contains the searchText (via stripped-text matching)
   * 4. Replace just the text content within that segment
   * 5. Reassemble and PUT
   *
   * If newText starts with '<', it's inserted as raw HTML replacing the matched segment.
   * Otherwise the text within the matched tag is replaced, preserving the tag + attributes.
   */
  async patchTextBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    newText: string,
  ): Promise<TextPatchResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the block containing the search text
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

      // Step 3: Split HTML into block-level segments and find the one containing searchText
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

      // Step 4: Write the patched HTML back
      if (blockValue.value) {
        blockValue.value.html = patched.html;
        blockValue.value.source = patched.html;
      }

      // Step 5: PUT the modified sections
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
  }

  /**
   * Replace a text block's entire HTML with pre-formatted content.
   *
   * Unlike `updateTextBlock()` which runs the input through `formatHtml()`,
   * this method sets the source/html directly — useful when the caller has
   * already built rich HTML via `buildRichHtml()`.
   *
   * Same read-modify-write flow as `updateTextBlock()`.
   */
  async updateTextBlockHtml(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    rawHtml: string,
  ): Promise<TextUpdateResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the block with matching text
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

      // Step 3: Replace the block's HTML content directly (no formatHtml)
      if (blockValue.value) {
        blockValue.value.html = rawHtml;
        blockValue.value.source = rawHtml;
      }

      // Step 4: PUT the modified sections
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
  }

  /**
   * Patch a substring within HTML by splitting into block-level segments,
   * finding the segment containing searchText, and replacing within it.
   *
   * Returns null if searchText is not found in any segment.
   */
  patchHtmlSegment(
    html: string,
    searchText: string,
    newText: string,
  ): { html: string; matchedSegment: string } | null {
    // Split HTML into block-level segments, keeping the tags intact.
    // We match opening tag + content + closing tag for block-level elements.
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

    // If no block-level segments found, treat the entire HTML as one segment
    if (segments.length === 0) {
      const stripped = this.stripHtml(html);
      if (!stripped.toLowerCase().includes(searchText.toLowerCase())) {
        return null;
      }
      // Replace within the whole HTML
      const patched = this.replaceTextInHtml(html, searchText, newText);
      return patched ? { html: patched, matchedSegment: html } : null;
    }

    // Find which segment contains the searchText (via stripped text matching)
    const needle = searchText.toLowerCase();
    for (const seg of segments) {
      const strippedSeg = this.stripHtml(seg.fullMatch);
      if (strippedSeg.toLowerCase().includes(needle)) {
        // Found the segment — replace the text within it
        const patchedSegment = this.replaceTextInHtml(seg.fullMatch, searchText, newText);
        if (!patchedSegment) continue;

        // Reassemble: everything before + patched segment + everything after
        const patchedHtml = html.substring(0, seg.start) + patchedSegment + html.substring(seg.end);
        return { html: patchedHtml, matchedSegment: seg.fullMatch };
      }
    }

    // Fallback: searchText may span outside block-level tags (e.g., raw text nodes)
    const stripped = this.stripHtml(html);
    if (stripped.toLowerCase().includes(needle)) {
      const patched = this.replaceTextInHtml(html, searchText, newText);
      return patched ? { html: patched, matchedSegment: html } : null;
    }

    return null;
  }

  /**
   * Replace searchText within an HTML fragment, preserving tags and attributes.
   *
   * If newText starts with '<', it replaces the entire matched segment (raw HTML insertion).
   * Otherwise, performs a text-level replacement within the HTML, preserving all tags.
   */
  private replaceTextInHtml(
    html: string,
    searchText: string,
    newText: string,
  ): string | null {
    // If newText is raw HTML, replace the entire segment
    if (newText.trimStart().startsWith('<')) {
      // Extract the tag from the original segment to check if we should preserve structure
      const tagMatch = html.match(/^<(p|h[1-6]|div|li)(\s[^>]*)?>/i);
      if (tagMatch) {
        // Replacing with raw HTML — insert directly
        return newText;
      }
      return newText;
    }

    // Text-level replacement: walk through the HTML, find text nodes that match,
    // and replace just the text content while preserving all HTML tags.
    //
    // Strategy: split HTML into tag and text tokens, find which text tokens
    // contain the searchText (possibly spanning multiple text tokens),
    // and replace just the matching portion.
    //
    // We decode HTML entities in text tokens for matching purposes, but track
    // character positions in the raw (encoded) text for accurate replacement.
    const tokens = this.tokenizeHtml(html);
    const needle = searchText.toLowerCase();

    // Build a "text-only" view with position mapping back to tokens.
    // We track both the raw text (with entities) and decoded text (for matching).
    const textParts: Array<{ raw: string; decoded: string; tokenIndex: number }> = [];
    for (let i = 0; i < tokens.length; i++) {
      if (!tokens[i].isTag) {
        textParts.push({
          raw: tokens[i].value,
          decoded: this.decodeEntities(tokens[i].value),
          tokenIndex: i,
        });
      }
    }

    // Concatenate decoded text parts and find the searchText in the decoded string
    const fullDecodedText = textParts.map(tp => tp.decoded).join('');
    const matchIndex = fullDecodedText.toLowerCase().indexOf(needle);
    if (matchIndex === -1) return null;

    const matchEnd = matchIndex + searchText.length;

    // Map the match back to the individual text tokens using decoded positions,
    // but replace in the raw token values.
    // We need to map decoded positions to raw positions within each token.
    let decodedCharPos = 0;
    for (const tp of textParts) {
      const decodedTokenStart = decodedCharPos;
      const decodedTokenEnd = decodedCharPos + tp.decoded.length;

      if (decodedTokenEnd > matchIndex && decodedTokenStart < matchEnd) {
        // This text token overlaps with the match (in decoded space)
        const decodedReplaceStart = Math.max(0, matchIndex - decodedTokenStart);
        const decodedReplaceEnd = Math.min(tp.decoded.length, matchEnd - decodedTokenStart);

        // Map decoded positions to raw positions
        const rawReplaceStart = this.decodedToRawOffset(tp.raw, decodedReplaceStart);
        const rawReplaceEnd = this.decodedToRawOffset(tp.raw, decodedReplaceEnd);

        const before = tp.raw.substring(0, rawReplaceStart);
        const after = tp.raw.substring(rawReplaceEnd);

        // Only insert newText in the first overlapping token
        if (decodedTokenStart <= matchIndex) {
          tokens[tp.tokenIndex].value = before + newText + after;
        } else {
          // Subsequent overlapping tokens: remove the matched portion
          tokens[tp.tokenIndex].value = after;
        }
      }

      decodedCharPos = decodedTokenEnd;
    }

    return tokens.map(t => t.value).join('');
  }

  /**
   * Tokenize HTML into alternating tag and text tokens.
   * Tags include their < and > delimiters; text is everything between tags.
   */
  private tokenizeHtml(html: string): Array<{ value: string; isTag: boolean }> {
    const tokens: Array<{ value: string; isTag: boolean }> = [];
    const tagRegex = /<[^>]+>/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(html)) !== null) {
      // Text before this tag
      if (match.index > lastIndex) {
        tokens.push({ value: html.substring(lastIndex, match.index), isTag: false });
      }
      // The tag itself
      tokens.push({ value: match[0], isTag: true });
      lastIndex = match.index + match[0].length;
    }

    // Trailing text after the last tag
    if (lastIndex < html.length) {
      tokens.push({ value: html.substring(lastIndex), isTag: false });
    }

    return tokens;
  }

  /**
   * Decode common HTML entities in a text string.
   * Same entities as stripHtml but without tag removal (for text tokens).
   */
  private decodeEntities(text: string): string {
    return text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
  }

  /**
   * Map a character offset in decoded text back to the corresponding offset
   * in the raw (entity-encoded) text.
   *
   * Walks through the raw text, decoding entities as encountered, counting
   * decoded characters until the target offset is reached, then returns
   * the corresponding raw position.
   */
  private decodedToRawOffset(raw: string, decodedOffset: number): number {
    const entityPattern = /&(?:nbsp|amp|lt|gt|quot|apos|#39);/g;
    let decodedPos = 0;
    let rawPos = 0;

    while (decodedPos < decodedOffset && rawPos < raw.length) {
      // Check if current position starts an entity
      entityPattern.lastIndex = rawPos;
      const entityMatch = entityPattern.exec(raw);

      if (entityMatch && entityMatch.index === rawPos) {
        // Entity at current position — counts as 1 decoded char
        decodedPos++;
        rawPos = entityMatch.index + entityMatch[0].length;
      } else {
        // Regular character
        decodedPos++;
        rawPos++;
      }
    }

    return rawPos;
  }

  /**
   * Get page/collection IDs using the authenticated GetCollections API.
   * Returns pageSectionsId and collectionId for a given page slug.
   *
   * Also tries the GetCollections endpoint since ?format=json-pretty
   * returns 401 on private/trial sites.
   */
  async getPageIds(slug: string): Promise<{
    collectionId: string;
    pageSectionsId?: string;
  } | null> {
    this.ensureCookies();

    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    const normalizedSlug = this.normalizeSlug(slug);

    try {
      const response = await fetch(`${siteUrl}/api/commondata/GetCollections/`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as Record<string, unknown>;
      const collections = (data.collections ?? data) as Record<string, unknown>[] | Record<string, unknown>;

      // Collections may be an array or keyed object
      const collList = Array.isArray(collections)
        ? collections
        : Object.values(collections);

      for (const c of collList) {
        const coll = c as Record<string, unknown>;
        const urlId = String(coll.urlId ?? '').toLowerCase();
        const targetSlug = normalizedSlug || 'home';

        if (urlId === targetSlug) {
          return {
            collectionId: String(coll.id),
            // pageSectionsId is not directly in GetCollections — caller should extract from DOM
          };
        }
      }

      return null;
    } catch (err) {
      logger.warn({ error: errMsg(err), slug }, 'Failed to get page IDs');
      return null;
    }
  }

  /**
   * Find any block by text across all block types.
   * - Text blocks (type 2): match stripped HTML
   * - Image blocks (type 1337): match title/description/subtitle HTML
   * - Any block with value.text or value.label: match those
   * - Fallback: match block ID prefix
   *
   * Returns the match plus the section's gridSettings (needed for boundary clamping).
   */
  findBlock(
    sections: PageSection[],
    searchText: string,
  ): {
    section: PageSection;
    gridContent: GridContent;
    sectionIndex: number;
    blockIndex: number;
    gridSettings?: GridSettings;
  } | null {
    const needle = searchText.toLowerCase();

    for (let si = 0; si < sections.length; si++) {
      const section = sections[si];
      const ctx = section.fluidEngineContext;
      if (!ctx?.gridContents) continue;

      for (let bi = 0; bi < ctx.gridContents.length; bi++) {
        const gc = ctx.gridContents[bi];
        const bv = gc.content?.value;
        if (!bv) continue;

        // Text blocks (type 2): match stripped HTML
        if (bv.type === BLOCK_TYPE_TEXT) {
          const html = bv.value?.html ?? bv.value?.source ?? '';
          if (html && this.stripHtml(html).toLowerCase().includes(needle)) {
            return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
          }
        }

        // Type 1337: Code HTML blocks, Form blocks, or Image blocks (same outer type, different value structure)
        if (bv.type === BLOCK_TYPE_IMAGE) {
          if (bv.value?.wysiwyg?.engine === CODE_BLOCK_ENGINE) {
            // Code HTML block: match on html content
            const html = bv.value?.html ?? '';
            if (html && html.toLowerCase().includes(needle)) {
              return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
            }
          } else if (bv.value?.[FORM_BLOCK_DISCRIMINATOR] !== undefined) {
            // Form block: match by formId
            if (bv.value?.formId && String(bv.value.formId).toLowerCase().includes(needle))
              return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
          } else {
            // Image block: match title/description/subtitle
            const fields = [bv.value?.title, bv.value?.description, bv.value?.subtitle].filter(Boolean);
            for (const field of fields) {
              if (this.stripHtml(String(field)).toLowerCase().includes(needle)) {
                return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
              }
            }
          }
        }

        // Quote blocks (type 31): match quote text and source (attribution)
        if (bv.type === BLOCK_TYPE_QUOTE) {
          const quoteText = bv.value?.quote ?? '';
          const source = bv.value?.source ?? '';
          if ((quoteText && quoteText.toLowerCase().includes(needle)) ||
              (source && source.toLowerCase().includes(needle))) {
            return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
          }
        }

        // Video blocks (type 32): match url, title, description
        if (bv.type === BLOCK_TYPE_VIDEO) {
          const fields = [bv.value?.url, bv.value?.title, bv.value?.description].filter(Boolean);
          for (const field of fields) {
            if (String(field).toLowerCase().includes(needle)) {
              return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
            }
          }
        }

        // Newsletter blocks (type 51): match description.html, title, submitButtonText
        if (bv.type === BLOCK_TYPE_NEWSLETTER) {
          const descHtml = bv.value?.description?.html ?? '';
          const fields = [descHtml, bv.value?.title, bv.value?.submitButtonText].filter(Boolean);
          for (const field of fields) {
            if (this.stripHtml(String(field)).toLowerCase().includes(needle))
              return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
          }
        }

        // Accordion blocks (type 69): match accordionItems[].title and .description
        if (bv.type === BLOCK_TYPE_ACCORDION) {
          for (const item of (bv.value?.accordionItems ?? [])) {
            if ((item.title && String(item.title).toLowerCase().includes(needle)) ||
                (item.description && String(item.description).toLowerCase().includes(needle)))
              return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
          }
        }

        // Marquee blocks (type 70): match marqueeItems[].text
        if (bv.type === BLOCK_TYPE_MARQUEE) {
          for (const item of (bv.value?.marqueeItems ?? [])) {
            if (item.text && String(item.text).toLowerCase().includes(needle))
              return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
          }
        }

        // Menu blocks (type 18): match raw text, tab titles, section titles, item titles
        if (bv.type === BLOCK_TYPE_MENU) {
          const menuVal = bv.value;
          // Search raw text field
          if (menuVal?.raw && String(menuVal.raw).toLowerCase().includes(needle)) {
            return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
          }
          // Search structured menus
          if (menuVal?.menus && Array.isArray(menuVal.menus)) {
            for (const tab of menuVal.menus) {
              if (tab.title?.toLowerCase().includes(needle)) {
                return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
              }
              for (const sec of tab.sections || []) {
                if (sec.title?.toLowerCase().includes(needle)) {
                  return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
                }
                for (const item of sec.items || []) {
                  if (item.title?.toLowerCase().includes(needle)) {
                    return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
                  }
                }
              }
            }
          }
        }

        // Any block with value.text or value.label
        if (bv.value?.text && String(bv.value.text).toLowerCase().includes(needle)) {
          return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
        }
        if (bv.value?.label && String(bv.value.label).toLowerCase().includes(needle)) {
          return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
        }

        // Fallback: match block ID prefix
        if (bv.id.toLowerCase().startsWith(needle)) {
          return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
        }
      }
    }

    return null;
  }

  /**
   * Move a block within its section by shifting desktop grid coordinates.
   * Read-modify-write: GET → findBlock → shift → clamp → PUT.
   *
   * Desktop only — mobile auto-reflows.
   * Default step = block's own width (left/right) or height (up/down).
   */
  async moveBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    direction: 'up' | 'down' | 'left' | 'right',
    gridSteps?: number,
  ): Promise<BlockMoveResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the block
      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent, gridSettings } = match;
      const layout = gridContent.layout;
      if (!layout?.desktop) {
        return { success: false, error: `Block "${searchText}" has no desktop layout` };
      }

      const desktop = layout.desktop;
      const blockId = gridContent.content.value.id;
      const maxColumns = gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      // Save old position
      const oldPosition = {
        desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
      };

      // Calculate block dimensions
      const blockWidth = desktop.end.x - desktop.start.x;
      const blockHeight = desktop.end.y - desktop.start.y;

      // Default step = block's own dimension in the movement direction
      const step = gridSteps ?? (direction === 'left' || direction === 'right' ? blockWidth : blockHeight);

      // Step 3: Shift coordinates
      switch (direction) {
        case 'left':
          desktop.start.x -= step;
          desktop.end.x -= step;
          break;
        case 'right':
          desktop.start.x += step;
          desktop.end.x += step;
          break;
        case 'up':
          desktop.start.y -= step;
          desktop.end.y -= step;
          break;
        case 'down':
          desktop.start.y += step;
          desktop.end.y += step;
          break;
      }

      // Step 4: Clamp to boundaries
      let clamped = false;

      // X boundaries: [1, maxColumns]
      if (desktop.start.x < 1) {
        const shift = 1 - desktop.start.x;
        desktop.start.x += shift;
        desktop.end.x += shift;
        clamped = true;
      }
      if (desktop.end.x > maxColumns + 1) {
        const shift = desktop.end.x - (maxColumns + 1);
        desktop.start.x -= shift;
        desktop.end.x -= shift;
        clamped = true;
      }

      // Y boundary: >= 0 (no upper limit on rows)
      if (desktop.start.y < 0) {
        const shift = -desktop.start.y;
        desktop.start.y += shift;
        desktop.end.y += shift;
        clamped = true;
      }

      const newPosition = {
        desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
      };

      logger.info(
        { blockId, direction, step, clamped, oldPosition, newPosition },
        'Moving block via Content Save API',
      );

      // Step 5: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, direction, oldPosition, newPosition, clamped };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Swap two blocks' positions by exchanging their full layout objects.
   * Single GET + PUT.
   */
  async swapBlocks(
    pageSectionsId: string,
    collectionId: string,
    searchText1: string,
    searchText2: string,
  ): Promise<BlockMoveResult> {
    try {
      const data = await this.getPageSections(pageSectionsId);

      const match1 = this.findBlock(data.sections, searchText1);
      if (!match1) {
        return { success: false, error: `No block found matching "${searchText1}"` };
      }

      const match2 = this.findBlock(data.sections, searchText2);
      if (!match2) {
        return { success: false, error: `No block found matching "${searchText2}"` };
      }

      // Swap entire layout objects (desktop + mobile + zIndex)
      const tempLayout = match1.gridContent.layout;
      match1.gridContent.layout = match2.gridContent.layout;
      match2.gridContent.layout = tempLayout;

      const blockId1 = match1.gridContent.content.value.id;
      const blockId2 = match2.gridContent.content.value.id;

      logger.info({ blockId1, blockId2 }, 'Swapping block positions via Content Save API');

      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        blockId: `${blockId1}<->${blockId2}`,
        direction: 'swap',
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Resize a block by adjusting its desktop grid end coordinates.
   * Read-modify-write: GET → findBlock → adjust end.x/end.y → clamp → PUT.
   *
   * Width: "smaller" shrinks by 2 cols, "larger" grows by 2, "full" spans all columns.
   * Height: "shorter" shrinks by 1 row, "taller" grows by 1 row.
   * Minimum size: 1 col wide, 1 row tall.
   * Desktop only — mobile auto-reflows.
   */
  async resizeBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    width?: 'smaller' | 'larger' | 'full',
    height?: 'shorter' | 'taller',
  ): Promise<BlockResizeResult> {
    if (!width && !height) {
      return { success: false, error: 'Must provide at least width or height' };
    }

    try {
      const data = await this.getPageSections(pageSectionsId);

      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent, gridSettings } = match;
      const layout = gridContent.layout;
      if (!layout?.desktop) {
        return { success: false, error: `Block "${searchText}" has no desktop layout` };
      }

      const desktop = layout.desktop;
      const blockId = gridContent.content.value.id;
      const maxColumns = gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      const oldWidth = desktop.end.x - desktop.start.x;
      const oldHeight = desktop.end.y - desktop.start.y;
      const oldSize = {
        width: oldWidth, height: oldHeight,
        desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
      };

      let clamped = false;

      // Adjust width
      if (width === 'full') {
        desktop.start.x = 1;
        desktop.end.x = maxColumns + 1;
      } else if (width === 'larger') {
        desktop.end.x += 2;
      } else if (width === 'smaller') {
        desktop.end.x -= 2;
      }

      // Adjust height
      if (height === 'taller') {
        desktop.end.y += 1;
      } else if (height === 'shorter') {
        desktop.end.y -= 1;
      }

      // Enforce minimum size: 1 col wide, 1 row tall
      if (desktop.end.x <= desktop.start.x) {
        desktop.end.x = desktop.start.x + 1;
        clamped = true;
      }
      if (desktop.end.y <= desktop.start.y) {
        desktop.end.y = desktop.start.y + 1;
        clamped = true;
      }

      // Clamp right edge to grid boundary
      if (desktop.end.x > maxColumns + 1) {
        desktop.end.x = maxColumns + 1;
        clamped = true;
      }

      const newWidth = desktop.end.x - desktop.start.x;
      const newHeight = desktop.end.y - desktop.start.y;
      const newSize = {
        width: newWidth, height: newHeight,
        desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
      };

      logger.info(
        { blockId, width, height, clamped, oldSize: { w: oldWidth, h: oldHeight }, newSize: { w: newWidth, h: newHeight } },
        'Resizing block via Content Save API',
      );

      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, oldSize, newSize, clamped };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Set a block's desktop position to exact grid coordinates.
   * Read-modify-write: GET → findBlock → set start/end → clamp → PUT.
   *
   * Clamping: start.x < 1 shifts the whole block right; end.x > maxColumns+1 shifts it left;
   * start.y < 0 shifts it down. Returns error if width or height is zero/negative.
   * Desktop only — mobile auto-reflows.
   */
  async setBlockPosition(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    position: { start: GridCoord; end: GridCoord },
  ): Promise<BlockMoveResult> {
    const { start, end } = position;

    if (end.x <= start.x) {
      return { success: false, error: 'Invalid position: end.x must be greater than start.x (width must be > 0)' };
    }
    if (end.y <= start.y) {
      return { success: false, error: 'Invalid position: end.y must be greater than start.y (height must be > 0)' };
    }

    try {
      const data = await this.getPageSections(pageSectionsId);

      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent, gridSettings } = match;
      const layout = gridContent.layout;
      if (!layout?.desktop) {
        return { success: false, error: `Block "${searchText}" has no desktop layout` };
      }

      const desktop = layout.desktop;
      const blockId = gridContent.content.value.id;
      const maxColumns = gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      const oldPosition = {
        desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
      };

      // Apply requested position
      desktop.start = { ...start };
      desktop.end = { ...end };

      let clamped = false;
      const blockWidth = desktop.end.x - desktop.start.x;
      const blockHeight = desktop.end.y - desktop.start.y;

      // Clamp X: shift entire block if it goes out of bounds
      if (desktop.start.x < 1) {
        const shift = 1 - desktop.start.x;
        desktop.start.x += shift;
        desktop.end.x += shift;
        clamped = true;
      }
      if (desktop.end.x > maxColumns + 1) {
        const shift = desktop.end.x - (maxColumns + 1);
        desktop.start.x -= shift;
        desktop.end.x -= shift;
        clamped = true;
      }

      // Clamp Y: shift block down if top goes negative
      if (desktop.start.y < 0) {
        const shift = -desktop.start.y;
        desktop.start.y += shift;
        desktop.end.y += shift;
        clamped = true;
      }

      const newPosition = {
        desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
      };

      logger.info(
        { blockId, position, clamped, oldPosition, newPosition },
        'Setting block position via Content Save API',
      );

      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, oldPosition, newPosition, clamped };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Set a block's desktop size to exact column width and/or row height.
   * Keeps start position fixed — only adjusts end.x and/or end.y.
   * Read-modify-write: GET → findBlock → set end → clamp → PUT.
   *
   * Omit width or height to leave that dimension unchanged.
   * end.x is clamped to maxColumns+1 if width would exceed the grid.
   * Desktop only — mobile auto-reflows.
   */
  async setBlockSize(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    size: { width?: number; height?: number },
  ): Promise<BlockResizeResult> {
    const { width, height } = size;

    if (width === undefined && height === undefined) {
      return { success: false, error: 'Must provide at least width or height' };
    }
    if (width !== undefined && width <= 0) {
      return { success: false, error: 'Invalid size: width must be > 0' };
    }
    if (height !== undefined && height <= 0) {
      return { success: false, error: 'Invalid size: height must be > 0' };
    }

    try {
      const data = await this.getPageSections(pageSectionsId);

      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent, gridSettings } = match;
      const layout = gridContent.layout;
      if (!layout?.desktop) {
        return { success: false, error: `Block "${searchText}" has no desktop layout` };
      }

      const desktop = layout.desktop;
      const blockId = gridContent.content.value.id;
      const maxColumns = gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      const oldWidth = desktop.end.x - desktop.start.x;
      const oldHeight = desktop.end.y - desktop.start.y;
      const oldSize = {
        width: oldWidth, height: oldHeight,
        desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
      };

      if (width !== undefined) desktop.end.x = desktop.start.x + width;
      if (height !== undefined) desktop.end.y = desktop.start.y + height;

      let clamped = false;
      if (desktop.end.x > maxColumns + 1) {
        desktop.end.x = maxColumns + 1;
        clamped = true;
      }

      const newWidth = desktop.end.x - desktop.start.x;
      const newHeight = desktop.end.y - desktop.start.y;
      const newSize = {
        width: newWidth, height: newHeight,
        desktop: { start: { ...desktop.start }, end: { ...desktop.end } },
      };

      logger.info(
        { blockId, size, clamped, oldSize: { w: oldWidth, h: oldHeight }, newSize: { w: newWidth, h: newHeight } },
        'Setting block size via Content Save API',
      );

      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, oldSize, newSize, clamped };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Remove a block from its section by searching for text and splicing it out.
   * Read-modify-write: GET → findBlock → splice from gridContents → PUT.
   */
  async removeBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
  ): Promise<BlockRemoveResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the block
      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { section, blockIndex } = match;
      const blockId = match.gridContent.content.value.id;
      const blockType = match.gridContent.content.value.type;
      const sectionId = section.id;

      logger.info(
        { blockId, blockType, sectionId, blockIndex, searchText },
        'Removing block via Content Save API',
      );

      // Step 3: Splice the block out of gridContents
      section.fluidEngineContext!.gridContents.splice(blockIndex, 1);

      // Step 4: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, blockType, sectionId };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Update metadata fields on an image block (title, description, subtitle, altText, linkTo).
   * Read-modify-write: GET → findBlock → verify type 1337 → update fields → PUT.
   *
   * Only updates fields that are provided — does not null out omitted fields.
   * title/description/subtitle/linkTo are stored on content.value.value.*
   * altText is stored on content.value.altText (block level).
   */
  async updateImageBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    fields: { title?: string; description?: string; subtitle?: string; altText?: string; linkTo?: string },
  ): Promise<ImageBlockUpdateResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the block
      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent } = match;
      const blockValue = gridContent.content.value;

      // Step 3: Verify block type is image (1337)
      if (blockValue.type !== BLOCK_TYPE_IMAGE) {
        return {
          success: false,
          error: `Block "${searchText}" is type ${blockValue.type}, not an image block (expected ${BLOCK_TYPE_IMAGE})`,
        };
      }

      const blockId = blockValue.id;
      const updatedFields: string[] = [];

      // Ensure value sub-object exists
      if (!blockValue.value) {
        blockValue.value = {};
      }

      // Step 4: Update provided fields
      if (fields.title !== undefined) {
        blockValue.value.title = fields.title;
        updatedFields.push('title');
      }
      if (fields.description !== undefined) {
        blockValue.value.description = fields.description;
        updatedFields.push('description');
      }
      if (fields.subtitle !== undefined) {
        blockValue.value.subtitle = fields.subtitle;
        updatedFields.push('subtitle');
      }
      if (fields.altText !== undefined) {
        // altText is stored at the block level (content.value.altText)
        blockValue.altText = fields.altText;
        updatedFields.push('altText');
      }
      if (fields.linkTo !== undefined) {
        blockValue.value.linkTo = fields.linkTo;
        updatedFields.push('linkTo');
      }

      if (updatedFields.length === 0) {
        return { success: false, error: 'No fields provided to update' };
      }

      logger.info(
        { blockId, updatedFields, searchText },
        'Updating image block via Content Save API',
      );

      // Step 5: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, updatedFields };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Move a section up or down on the page by reordering the sections array.
   * Read-modify-write: GET → find section by text → splice/insert → PUT.
   *
   * Uses `findBlock()` to locate which section contains the searchText,
   * then reorders the section in the `data.sections` array.
   * If the section is already at the boundary (first moving up, last moving down),
   * returns success with oldIndex === newIndex.
   */
  async moveSection(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    direction: 'up' | 'down',
  ): Promise<SectionMoveResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      if (!sections || sections.length === 0) {
        return { success: false, error: 'Page has no sections' };
      }

      // Step 2: Find the section containing the searchText via findBlock()
      const match = this.findBlock(sections, searchText);
      if (!match) {
        return { success: false, error: `No section found containing text "${searchText}"` };
      }

      const sectionIndex = match.sectionIndex;
      const section = sections[sectionIndex];
      const sectionId = section.id;
      const sectionName = section.sectionName;

      // Step 3: Check boundary conditions
      if (sections.length === 1) {
        return {
          success: true,
          sectionId,
          sectionName,
          oldIndex: 0,
          newIndex: 0,
          error: 'Only one section on page — nothing to reorder',
        };
      }

      if (direction === 'up' && sectionIndex === 0) {
        return {
          success: true,
          sectionId,
          sectionName,
          oldIndex: 0,
          newIndex: 0,
        };
      }

      if (direction === 'down' && sectionIndex === sections.length - 1) {
        return {
          success: true,
          sectionId,
          sectionName,
          oldIndex: sectionIndex,
          newIndex: sectionIndex,
        };
      }

      // Step 4: Splice out and reinsert at new position
      const newIndex = direction === 'up' ? sectionIndex - 1 : sectionIndex + 1;
      sections.splice(sectionIndex, 1);
      sections.splice(newIndex, 0, section);

      logger.info(
        { sectionId, sectionName, direction, oldIndex: sectionIndex, newIndex },
        'Moving section via Content Save API',
      );

      // Step 5: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        sectionId,
        sectionName,
        oldIndex: sectionIndex,
        newIndex,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Footer API Methods ─────────────────────────────────────────────────

  /**
   * GET the site header/footer configuration.
   * Counterpart to the existing saveHeaderFooter() PUT method.
   *
   * The response typically contains the full header+footer config, including
   * footer.pageSectionsId which can be used with getPageSections() to fetch
   * the actual footer section/block data.
   *
   * Endpoint: GET /api/site-header-footer
   */
  async getHeaderFooter(): Promise<{ success: boolean; config?: HeaderFooterConfig; error?: string }> {
    this.ensureCookies();

    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    const url = `${siteUrl}/api/site-header-footer`;

    logger.info({ siteSubdomain: this.siteSubdomain }, 'Fetching site header/footer config');

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          success: false,
          error: `${response.status} ${response.statusText}: ${body}`,
        };
      }

      const data = (await response.json()) as HeaderFooterConfig;
      logger.info(
        {
          hasFooter: !!data.footer,
          hasHeader: !!data.header,
          footerPageSectionsId: data.footer?.pageSectionsId,
          topLevelKeys: Object.keys(data),
        },
        'Site header/footer config fetched',
      );

      return { success: true, config: data };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Get the footer's page sections data.
   *
   * The footer stores its sections using the same page-sections format as
   * regular pages. This method:
   * 1. GETs /api/site-header-footer to find the footer's pageSectionsId
   * 2. GETs /api/page-sections/{footerPageSectionsId} to fetch the actual data
   *
   * Returns the same PageSection[] format as getPageSections() so existing
   * block-finding and text-updating logic can be reused.
   */
  async getFooterSections(): Promise<{
    success: boolean;
    sections?: PageSection[];
    pageSectionsId?: string;
    collectionId?: string;
    error?: string;
  }> {
    try {
      // Step 1: Get footer config to find pageSectionsId
      const configResult = await this.getHeaderFooter();
      if (!configResult.success || !configResult.config) {
        return { success: false, error: configResult.error ?? 'Failed to get header/footer config' };
      }

      const config = configResult.config;

      // The footer's pageSectionsId may be at:
      // - config.footer.pageSectionsId (most likely)
      // - config.footerPageSectionsId (alternate)
      // - config.footer.id (alternate)
      const footerPsId =
        config.footer?.pageSectionsId ??
        (config as Record<string, unknown>).footerPageSectionsId as string | undefined ??
        config.footer?.id as string | undefined;

      if (!footerPsId || typeof footerPsId !== 'string') {
        // If no pageSectionsId found, the footer config itself might contain
        // sections directly (some Squarespace versions embed them)
        const embeddedSections = config.footer?.sections as PageSection[] | undefined;
        if (embeddedSections && Array.isArray(embeddedSections)) {
          logger.info(
            { sectionsCount: embeddedSections.length },
            'Found embedded footer sections in header-footer config',
          );
          return { success: true, sections: embeddedSections };
        }

        return {
          success: false,
          error: 'Footer pageSectionsId not found in header-footer config. ' +
            `Available keys: ${JSON.stringify(Object.keys(config))}` +
            (config.footer ? `, footer keys: ${JSON.stringify(Object.keys(config.footer))}` : ''),
        };
      }

      logger.info({ footerPsId }, 'Found footer pageSectionsId — fetching sections');

      // Step 2: Fetch the actual footer sections using the page-sections API
      const data = await this.getPageSections(footerPsId);

      // Try to extract collectionId from the response
      const collectionId = data.collectionId ?? (data as Record<string, unknown>).websiteId as string | undefined;

      return {
        success: true,
        sections: data.sections,
        pageSectionsId: footerPsId,
        collectionId: collectionId ?? undefined,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Update a text block within the footer (full replacement).
   *
   * Combines getFooterSections() + findTextBlock() + savePageSections()
   * to do a complete read-modify-write on the footer content.
   *
   * @param searchText  Text to search for in the footer (case-insensitive)
   * @param newText     New text/HTML for the block (plain text auto-wrapped in <p>)
   */
  async updateFooterTextBlock(
    searchText: string,
    newText: string,
  ): Promise<FooterTextUpdateResult> {
    try {
      // Step 1: Get footer sections + IDs
      const footerResult = await this.getFooterSections();
      if (!footerResult.success || !footerResult.sections) {
        return { success: false, error: footerResult.error ?? 'Failed to get footer sections' };
      }

      const { sections, pageSectionsId, collectionId } = footerResult;

      // Step 2: Find the text block
      const match = this.findTextBlock(sections, searchText);
      if (!match) {
        return {
          success: false,
          error: `No text block found in the footer containing "${searchText}"`,
        };
      }

      const { gridContent, sectionIndex, blockIndex } = match;
      const blockValue = gridContent.content.value;
      const oldHtml = blockValue.value?.html ?? '';
      const blockId = blockValue.id;

      logger.info(
        { blockId, sectionIndex, blockIndex, searchText },
        'Found footer text block, updating content',
      );

      // Step 3: Replace the HTML
      const newHtml = newText.includes('<') ? newText : `<p class="" style="white-space:pre-wrap;">${newText}</p>`;
      if (blockValue.value) {
        blockValue.value.html = newHtml;
        blockValue.value.source = newHtml;
      }

      // Step 4: Save
      if (!pageSectionsId) {
        // Embedded footer path: sections live inside the header-footer config.
        // Must re-fetch config, update footer.sections in-place, and PUT it back.
        const configResult = await this.getHeaderFooter();
        if (!configResult.success || !configResult.config) {
          return { success: false, error: configResult.error ?? 'Failed to get header-footer config for save' };
        }
        const config = configResult.config as Record<string, unknown>;
        if (config.footer && typeof config.footer === 'object') {
          (config.footer as Record<string, unknown>).sections = sections;
        }
        const saveResult = await this.saveHeaderFooter(config);
        if (!saveResult.success) {
          return { success: false, error: saveResult.error };
        }
        return { success: true, blockId, oldText: this.stripHtml(oldHtml), newHtml };
      }

      // Regular path: save via page-sections API
      // We need collectionId for the save endpoint.
      let saveCollectionId = collectionId;
      if (!saveCollectionId) {
        // For footer, the collectionId might not be needed — try using the websiteId
        // or fall back to getting it from the GetCollections API
        const configResult = await this.getHeaderFooter();
        if (configResult.config) {
          saveCollectionId = (configResult.config as Record<string, unknown>).websiteId as string | undefined;
        }
      }

      if (!saveCollectionId) {
        // Last resort: use a dummy collection ID — some Squarespace endpoints
        // accept the pageSectionsId as collectionId for footer saves
        saveCollectionId = pageSectionsId;
      }

      const saveResult = await this.savePageSections(pageSectionsId, saveCollectionId, sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        blockId,
        oldText: this.stripHtml(oldHtml),
        newHtml,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Surgical find-and-replace within a footer text block.
   *
   * Unlike updateFooterTextBlock (which replaces the entire block),
   * this method finds a substring within the block's HTML and replaces
   * only that portion, preserving all other content.
   *
   * @param searchText  Text to find inside a footer block (case-insensitive)
   * @param newText     Replacement text for the matched portion
   */
  async patchFooterTextBlock(
    searchText: string,
    newText: string,
  ): Promise<FooterTextUpdateResult> {
    try {
      // Step 1: Get footer sections + IDs
      const footerResult = await this.getFooterSections();
      if (!footerResult.success || !footerResult.sections) {
        return { success: false, error: footerResult.error ?? 'Failed to get footer sections' };
      }

      const { sections, pageSectionsId, collectionId } = footerResult;

      // Step 2: Find the text block containing the search text
      const match = this.findTextBlock(sections, searchText);
      if (!match) {
        return {
          success: false,
          error: `No text block found in the footer containing "${searchText}"`,
        };
      }

      const { gridContent, sectionIndex, blockIndex } = match;
      const blockValue = gridContent.content.value;
      const oldHtml = blockValue.value?.html ?? '';
      const blockId = blockValue.id;

      // Step 3: Do a surgical replacement in the HTML
      // Find the searchText in the stripped HTML to confirm it exists
      const strippedOld = this.stripHtml(oldHtml).toLowerCase();
      const needle = searchText.toLowerCase();
      if (!strippedOld.includes(needle)) {
        return {
          success: false,
          error: `Text "${searchText}" found in block ${blockId} metadata but not in stripped HTML`,
        };
      }

      // Replace in the raw HTML — try exact match first, then case-insensitive
      let patchedHtml = oldHtml;
      if (patchedHtml.includes(searchText)) {
        patchedHtml = patchedHtml.replace(searchText, newText);
      } else {
        // Case-insensitive replacement in HTML (careful to preserve tags)
        const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        patchedHtml = patchedHtml.replace(regex, newText);
      }

      if (patchedHtml === oldHtml) {
        return {
          success: false,
          error: `Could not replace "${searchText}" in HTML of block ${blockId}. The text may span HTML tags.`,
        };
      }

      logger.info(
        { blockId, sectionIndex, blockIndex, searchText, newText },
        'Patching footer text block (surgical replacement)',
      );

      if (blockValue.value) {
        blockValue.value.html = patchedHtml;
        blockValue.value.source = patchedHtml;
      }

      // Step 4: Save
      if (!pageSectionsId) {
        // Embedded footer path: sections live inside the header-footer config.
        // Must re-fetch config, update footer.sections in-place, and PUT it back.
        const configResult = await this.getHeaderFooter();
        if (!configResult.success || !configResult.config) {
          return { success: false, error: configResult.error ?? 'Failed to get header-footer config for save' };
        }
        const config = configResult.config as Record<string, unknown>;
        if (config.footer && typeof config.footer === 'object') {
          (config.footer as Record<string, unknown>).sections = sections;
        }
        const saveResult = await this.saveHeaderFooter(config);
        if (!saveResult.success) {
          return { success: false, error: saveResult.error };
        }
        return { success: true, blockId, oldText: this.stripHtml(oldHtml), newHtml: patchedHtml };
      }

      // Regular path: save via page-sections API
      let saveCollectionId = collectionId;
      if (!saveCollectionId) {
        const configResult = await this.getHeaderFooter();
        if (configResult.config) {
          saveCollectionId = (configResult.config as Record<string, unknown>).websiteId as string | undefined;
        }
      }
      if (!saveCollectionId) {
        saveCollectionId = pageSectionsId;
      }

      const saveResult = await this.savePageSections(pageSectionsId, saveCollectionId, sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        blockId,
        oldText: this.stripHtml(oldHtml),
        newHtml: patchedHtml,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Save header/footer configuration.
   */
  async saveHeaderFooter(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
    this.ensureCookies();

    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    let url = `${siteUrl}/api/site-header-footer`;
    if (this.crumbToken) {
      url += `?crumb=${encodeURIComponent(this.crumbToken)}`;
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `${response.status} ${response.statusText}: ${body}` };
    }

    return { success: true };
  }

  // ── Custom CSS ─────────────────────────────────────────────────────────

  /**
   * Get the current site-wide custom CSS.
   * Uses GET /api/template/GetTemplateCustomCss (discovered via network capture).
   * Returns the CSS string, or empty string if none is set.
   */
  async getCustomCSS(): Promise<{ success: boolean; css: string; error?: string }> {
    this.ensureCookies();

    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    const url = `${siteUrl}/api/template/GetTemplateCustomCss`;

    logger.info({ siteSubdomain: this.siteSubdomain }, 'Fetching custom CSS');

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { success: false, css: '', error: `${response.status} ${response.statusText}: ${body}` };
      }

      const data = await response.json() as Record<string, unknown>;
      // Response may be { customCss: "..." } or just the CSS string
      const css = typeof data === 'string'
        ? data
        : typeof data.customCss === 'string'
          ? data.customCss
          : '';

      logger.info({ cssLength: css.length }, 'Custom CSS fetched');
      return { success: true, css };
    } catch (err) {
      return { success: false, css: '', error: errMsg(err) };
    }
  }

  /**
   * Save site-wide custom CSS.
   * Uses POST /api/template/SaveTemplateCustomCss?crumb=... (paired with GetTemplateCustomCss).
   *
   * TODO: The exact request body format needs live verification. Expected format
   * based on Squarespace naming conventions: { customCss: "..." }.
   * If this returns errors, run `npx tsx scripts/discover-api.ts --action editCSS`
   * to capture the actual endpoint and body structure.
   */
  async saveCustomCSS(css: string): Promise<{ success: boolean; error?: string }> {
    this.ensureCookies();

    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    let url = `${siteUrl}/api/template/SaveTemplateCustomCss`;
    if (this.crumbToken) {
      url += `?crumb=${encodeURIComponent(this.crumbToken)}`;
    }

    logger.info({ siteSubdomain: this.siteSubdomain, cssLength: css.length }, 'Saving custom CSS');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ customCss: css }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      const responseBody = await response.text().catch(() => '');

      if (!response.ok) {
        const error = `CSS save failed: ${response.status} ${response.statusText}. Body: ${responseBody}`;
        logger.error({ status: response.status }, error);
        return { success: false, error };
      }

      // Check for crumb failure
      if (responseBody.includes('"crumbFail":true') || responseBody.includes('Invalid session crumb')) {
        const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
        const error = `CSS save rejected: invalid or expired session crumb.${ageInfo} Run a browser session to refresh cookies.`;
        logger.error(error);
        return { success: false, error };
      }

      logger.info({ cssLength: css.length }, 'Custom CSS saved successfully');
      return { success: true };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Get the age of the loaded session cookies.
   * Returns null if cookies haven't been loaded yet.
   */
  getSessionAge(): { ageHours: number; isStale: boolean; lastRefreshed: Date } | null {
    if (this.sessionAgeHours === null || !this.sessionLoadedAt) return null;
    return {
      ageHours: this.sessionAgeHours,
      isStale: this.sessionAgeHours > 24,
      lastRefreshed: this.sessionLoadedAt,
    };
  }

  /**
   * Check session file health without creating a full client instance.
   * Useful for pre-flight checks before attempting API operations.
   */
  static checkSessionHealth(sessionPath?: string): { exists: boolean; ageHours: number; isStale: boolean; hasCrumb: boolean } {
    const path = sessionPath ?? SESSION_PATH;
    if (!existsSync(path)) {
      return { exists: false, ageHours: -1, isStale: true, hasCrumb: false };
    }
    const stats = statSync(path);
    const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
    try {
      const session = JSON.parse(readFileSync(path, 'utf-8'));
      const cookies = session.cookies ?? [];
      const hasCrumb = cookies.some((c: { name: string }) => c.name === 'crumb');
      return { exists: true, ageHours, isStale: ageHours > 24, hasCrumb };
    } catch {
      return { exists: true, ageHours, isStale: ageHours > 24, hasCrumb: false };
    }
  }

  // ── Add Text Block ───────────────────────────────────────────────────────

  /**
   * Generate a random block ID matching Squarespace's format (20 hex chars).
   * Examples from real data: "a7a6278d708bd0f7265c", "b3f4e89a2c1d5067e8f9"
   */
  static generateBlockId(): string {
    return randomBytes(10).toString('hex');
  }

  /**
   * Build rich HTML from structured content elements.
   * Produces Squarespace-compatible HTML for text block source/html fields.
   *
   * Always includes `style="white-space:pre-wrap;"` (Squarespace requirement).
   * Consecutive `li` elements are automatically wrapped in `<ul>` containers.
   *
   * @example
   * ContentSaveClient.buildRichHtml([
   *   { text: 'About Us', tag: 'h2', style: { 'text-align': 'center' } },
   *   { text: 'We are a family restaurant.', tag: 'p' },
   *   { text: 'Visit our menu', tag: 'p', link: { href: '/menus' }, bold: true },
   * ])
   */
  static buildRichHtml(elements: RichHtmlElement[]): string {
    if (!elements || elements.length === 0) return '';

    const parts: string[] = [];
    let i = 0;

    while (i < elements.length) {
      const el = elements[i];
      const tag = el.tag ?? 'p';

      // Group consecutive li elements into a <ul>
      if (tag === 'li') {
        const liItems: string[] = [];
        while (i < elements.length && (elements[i].tag ?? 'p') === 'li') {
          liItems.push(ContentSaveClient.buildSingleElement(elements[i], 'li'));
          i++;
        }
        parts.push(`<ul>${liItems.join('')}</ul>`);
      } else {
        parts.push(ContentSaveClient.buildSingleElement(el, tag));
        i++;
      }
    }

    return parts.join('');
  }

  /**
   * Build a single HTML element with Squarespace-compatible attributes.
   * @internal
   */
  private static buildSingleElement(
    el: RichHtmlElement,
    tag: string,
  ): string {
    // Escape HTML special characters in text content
    const escapedText = ContentSaveClient.escapeHtml(el.text);

    // Build inner content with formatting wrappers
    let inner = escapedText;

    // Apply link wrapping (innermost)
    if (el.link) {
      const target = el.link.target ? ` target="${el.link.target}"` : '';
      inner = `<a href="${el.link.href}"${target}>${inner}</a>`;
    }

    // Apply italic wrapping
    if (el.italic) {
      inner = `<em>${inner}</em>`;
    }

    // Apply bold wrapping (outermost inline)
    if (el.bold) {
      inner = `<strong>${inner}</strong>`;
    }

    // Build style attribute — always include white-space:pre-wrap
    const styleProps: Record<string, string> = { 'white-space': 'pre-wrap' };
    if (el.style) {
      Object.assign(styleProps, el.style);
    }
    const styleStr = Object.entries(styleProps)
      .map(([k, v]) => `${k}:${v}`)
      .join(';');

    // Build class attribute
    const classStr = el.className ?? '';

    return `<${tag} class="${classStr}" style="${styleStr};">${inner}</${tag}>`;
  }

  /**
   * Escape HTML special characters in text content.
   * @internal
   */
  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Add a new text block to a section via the Content Save API.
   * Read-modify-write: GET sections → find section by index → create block → push to gridContents → PUT.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param sectionIndex    0-based section index on the page
   * @param html            HTML content for the text block
   * @param layout          Optional layout override (defaults to full-width below existing blocks)
   */
  async addTextBlock(
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
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Step 2: Validate section index
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
      }

      const section = sections[sectionIndex];
      if (!section.fluidEngineContext) {
        return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
      }

      const gridContents = section.fluidEngineContext.gridContents;
      const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
      // Squarespace validates ALL blocks on PUT, so any block missing these fields will cause a 400 error.
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

      // Step 3: Calculate position
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
        // Explicit X coordinates: use them with boundary clamping
        startX = Math.max(1, layout.startX);
        endX = Math.min(maxColumns + 1, layout.endX);
      } else {
        // Auto X: full width or custom column count
        const cols = layout?.columns ?? maxColumns;
        startX = 1;
        endX = Math.min(startX + cols, maxColumns + 1);
      }

      if (layout?.startY != null && layout?.endY != null) {
        // Explicit Y coordinates: use them with boundary clamping
        startY = Math.max(0, layout.startY);
        endY = layout.endY;
      } else {
        // Auto Y: stack below existing blocks
        startY = maxY + gapRows;
        endY = startY + rowHeight;
      }

      // Step 4: Generate block ID and create GridContent
      const blockId = ContentSaveClient.generateBlockId();
      const formattedHtml = this.formatHtml(html, formatting);

      // zIndex: stack above existing blocks (each new block gets a higher z)
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

      // Step 5: Push to gridContents
      gridContents.push(newBlock);

      logger.info(
        { blockId, sectionIndex, sectionId: section.id, position: { startX, startY, endX, endY } },
        'Adding text block via Content Save API',
      );

      // Step 6: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, sectionId: section.id, sectionIndex };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Button Block Operations ────────────────────────────────────────────

  /**
   * Add a button block to a section via Content Save API.
   * Same grid positioning logic as addTextBlock().
   *
   * Default button size: 7 columns wide (x: 1–8), 2 rows tall.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param sectionIndex    0-based section index on the page
   * @param label           Button display text
   * @param url             Button link URL
   * @param layout          Optional layout overrides (same as addTextBlock)
   */
  async addButtonBlock(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    label: string,
    url: string,
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    },
  ): Promise<ButtonBlockAddResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Step 2: Validate section index
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
      }

      const section = sections[sectionIndex];
      if (!section.fluidEngineContext) {
        return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
      }

      const gridContents = section.fluidEngineContext.gridContents;
      const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

      // Step 3: Calculate position
      let maxY = 0;
      let maxMobileY = 0;
      for (const gc of gridContents) {
        const endYVal = gc.layout?.desktop?.end?.y ?? 0;
        const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
        if (endYVal > maxY) maxY = endYVal;
        if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
      }

      // Default button: 7 columns wide, 2 rows tall
      const rowHeight = layout?.rowHeight ?? 2;
      const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

      let startX: number;
      let endX: number;
      let startY: number;
      let endY: number;

      if (layout?.startX != null && layout?.endX != null) {
        startX = Math.max(1, layout.startX);
        endX = Math.min(maxColumns + 1, layout.endX);
      } else {
        const cols = layout?.columns ?? 7;
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

      // Step 4: Generate block ID and create GridContent
      const blockId = ContentSaveClient.generateBlockId();

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
            type: BLOCK_TYPE_BUTTON,
            value: { label, url },
          },
        },
      };

      // Step 5: Push to gridContents
      gridContents.push(newBlock);

      logger.info(
        { blockId, sectionIndex, sectionId: section.id, label, url, position: { startX, startY, endX, endY } },
        'Adding button block via Content Save API',
      );

      // Step 6: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, sectionId: section.id, sectionIndex };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Update a button block's label and/or URL.
   * Uses findBlock() which matches on `value.label`.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param searchText      Text to find the button by (matches label)
   * @param updates         Fields to update: newLabel and/or url
   */
  async updateButtonBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    updates: { newLabel?: string; url?: string },
  ): Promise<ButtonBlockUpdateResult> {
    if (!updates.newLabel && !updates.url) {
      return { success: false, error: 'Must provide at least newLabel or url to update' };
    }

    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the button block
      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent } = match;
      const blockValue = gridContent.content.value;

      // Step 3: Verify block type is button (46)
      if (blockValue.type !== BLOCK_TYPE_BUTTON) {
        return {
          success: false,
          error: `Block "${searchText}" is type ${blockValue.type}, not a button block (expected ${BLOCK_TYPE_BUTTON})`,
        };
      }

      const blockId = blockValue.id;
      const oldLabel = blockValue.value?.label as string | undefined;
      const oldUrl = blockValue.value?.url as string | undefined;

      // Ensure value sub-object exists
      if (!blockValue.value) {
        blockValue.value = {};
      }

      // Step 4: Update provided fields
      if (updates.newLabel !== undefined) {
        blockValue.value.label = updates.newLabel;
      }
      if (updates.url !== undefined) {
        blockValue.value.url = updates.url;
      }

      logger.info(
        { blockId, searchText, oldLabel, newLabel: updates.newLabel, oldUrl, newUrl: updates.url },
        'Updating button block via Content Save API',
      );

      // Step 5: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        blockId,
        oldLabel,
        newLabel: updates.newLabel ?? oldLabel,
        oldUrl,
        newUrl: updates.url ?? oldUrl,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Image Block Operations ────────────────────────────────────────────

  /**
   * Add an image block to a section via Content Save API.
   * Same grid positioning logic as addTextBlock/addButtonBlock.
   *
   * Default image size: 12 columns wide, 8 rows tall.
   *
   * The `assetUrl` is stored at `content.value.value.assetUrl` — this is the
   * URL returned by MediaUploadClient after uploading an image to Squarespace's
   * media library. The block also stores optional metadata (altText, title,
   * description, subtitle, linkTo) following the same structure as updateImageBlock.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param sectionIndex    0-based section index on the page
   * @param assetUrl        Image asset URL (from MediaUploadClient upload)
   * @param options         Optional metadata and layout overrides
   */
  async addImageBlock(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    assetUrl: string,
    options?: {
      altText?: string;
      title?: string;
      description?: string;
      subtitle?: string;
      linkTo?: string;
      layout?: {
        columns?: number;
        rowHeight?: number;
        gapRows?: number;
        startX?: number;
        endX?: number;
        startY?: number;
        endY?: number;
      };
    },
  ): Promise<ImageBlockAddResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Step 2: Validate section index
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
      }

      const section = sections[sectionIndex];
      if (!section.fluidEngineContext) {
        return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
      }

      const gridContents = section.fluidEngineContext.gridContents;
      const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;
      const layout = options?.layout;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

      // Step 3: Calculate position
      let maxY = 0;
      let maxMobileY = 0;
      for (const gc of gridContents) {
        const endYVal = gc.layout?.desktop?.end?.y ?? 0;
        const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
        if (endYVal > maxY) maxY = endYVal;
        if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
      }

      // Default image: 12 columns wide, 8 rows tall
      const rowHeight = layout?.rowHeight ?? 8;
      const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

      let startX: number;
      let endX: number;
      let startY: number;
      let endY: number;

      if (layout?.startX != null && layout?.endX != null) {
        startX = Math.max(1, layout.startX);
        endX = Math.min(maxColumns + 1, layout.endX);
      } else {
        const cols = layout?.columns ?? 12;
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

      // Step 4: Generate block ID and create GridContent
      const blockId = ContentSaveClient.generateBlockId();

      const maxZ = gridContents.reduce((max, gc) => {
        const dz = gc.layout?.desktop?.zIndex ?? 0;
        const mz = gc.layout?.mobile?.zIndex ?? 0;
        return Math.max(max, dz, mz);
      }, 0);
      const zIndex = maxZ + 1;

      const imageValue: Record<string, unknown> = {
        assetUrl,
        layout: 'caption-below',
        linkTo: options?.linkTo ?? '',
      };
      if (options?.title !== undefined) imageValue.title = options.title;
      if (options?.description !== undefined) imageValue.description = options.description;
      if (options?.subtitle !== undefined) imageValue.subtitle = options.subtitle;

      const blockContent: Record<string, unknown> = {
        id: blockId,
        type: BLOCK_TYPE_IMAGE,
        value: imageValue,
      };
      if (options?.altText !== undefined) blockContent.altText = options.altText;

      const newBlock: GridContent = {
        layout: {
          mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
          desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
        },
        content: {
          value: blockContent as GridContent['content']['value'],
        },
      };

      // Step 5: Push to gridContents
      gridContents.push(newBlock);

      logger.info(
        { blockId, sectionIndex, sectionId: section.id, assetUrl, position: { startX, startY, endX, endY } },
        'Adding image block via Content Save API',
      );

      // Step 6: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, sectionId: section.id, sectionIndex };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Batch-add multiple image blocks to a section in a single GET+PUT cycle.
   * More efficient than calling addImageBlock() N times (N GETs + N PUTs → 1 GET + 1 PUT).
   *
   * Images are stacked vertically by default, each below the previous one.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param sectionIndex    0-based section index on the page
   * @param images          Array of image specs to add
   */
  async addImageBlockBatch(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    images: Array<{
      assetUrl: string;
      altText?: string;
      title?: string;
      layout?: {
        columns?: number;
        rowHeight?: number;
        gapRows?: number;
        startX?: number;
        endX?: number;
        startY?: number;
        endY?: number;
      };
    }>,
  ): Promise<ImageBlockBatchResult> {
    if (images.length === 0) {
      return { success: false, blocks: [], error: 'No images provided' };
    }

    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Step 2: Validate section index
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return { success: false, blocks: [], error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
      }

      const section = sections[sectionIndex];
      if (!section.fluidEngineContext) {
        return { success: false, blocks: [], error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
      }

      const gridContents = section.fluidEngineContext.gridContents;
      const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

      // Track max Y across all existing blocks
      let maxY = 0;
      let maxMobileY = 0;
      for (const gc of gridContents) {
        const endYVal = gc.layout?.desktop?.end?.y ?? 0;
        const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
        if (endYVal > maxY) maxY = endYVal;
        if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
      }

      let maxZ = gridContents.reduce((max, gc) => {
        const dz = gc.layout?.desktop?.zIndex ?? 0;
        const mz = gc.layout?.mobile?.zIndex ?? 0;
        return Math.max(max, dz, mz);
      }, 0);

      const addedBlocks: Array<{ blockId: string; assetUrl: string }> = [];

      // Step 3: Create and push each image block
      for (let idx = 0; idx < images.length; idx++) {
        const img = images[idx];
        const layout = img.layout;

        const rowHeight = layout?.rowHeight ?? 8;
        const gapRows = layout?.gapRows ?? ((gridContents.length > addedBlocks.length ? addedBlocks.length > 0 : false) || gridContents.length > 0 ? 2 : 0);
        const effectiveGap = (idx === 0 && gridContents.length - addedBlocks.length === 0) ? 0 : gapRows;

        let startX: number;
        let endX: number;
        let startY: number;
        let endY: number;

        if (layout?.startX != null && layout?.endX != null) {
          startX = Math.max(1, layout.startX);
          endX = Math.min(maxColumns + 1, layout.endX);
        } else {
          const cols = layout?.columns ?? 12;
          startX = 1;
          endX = Math.min(startX + cols, maxColumns + 1);
        }

        if (layout?.startY != null && layout?.endY != null) {
          startY = Math.max(0, layout.startY);
          endY = layout.endY;
        } else {
          startY = maxY + effectiveGap;
          endY = startY + rowHeight;
        }

        const blockId = ContentSaveClient.generateBlockId();
        maxZ += 1;

        const newBlock: GridContent = {
          layout: {
            mobile: { start: { x: 1, y: maxMobileY + effectiveGap }, end: { x: 9, y: maxMobileY + effectiveGap + rowHeight }, visible: true, verticalAlignment: 'top', zIndex: maxZ },
            desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex: maxZ },
          },
          content: {
            value: {
              id: blockId,
              type: BLOCK_TYPE_IMAGE,
              value: {
                assetUrl: img.assetUrl,
                layout: 'caption-below',
                linkTo: '',
                ...(img.title !== undefined ? { title: img.title } : {}),
              },
              ...(img.altText !== undefined ? { altText: img.altText } : {}),
            } as GridContent['content']['value'],
          },
        };

        gridContents.push(newBlock);
        addedBlocks.push({ blockId, assetUrl: img.assetUrl });

        // Update running maxY for next block
        maxY = endY;
        maxMobileY = maxMobileY + effectiveGap + rowHeight;
      }

      logger.info(
        { sectionIndex, sectionId: section.id, imageCount: images.length, blockIds: addedBlocks.map(b => b.blockId) },
        'Batch-adding image blocks via Content Save API',
      );

      // Step 4: PUT the modified sections (single write for all blocks)
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, blocks: [], error: saveResult.error };
      }

      return { success: true, blocks: addedBlocks, sectionId: section.id, sectionIndex };
    } catch (err) {
      return { success: false, blocks: [], error: errMsg(err) };
    }
  }

  // ── Divider Block Operations ────────────────────────────────────────────

  /**
   * Add a divider/spacer block to a section via Content Save API.
   * Dividers are structural blocks with no editable content.
   *
   * Default layout: 24 cols wide (full width), 1 row tall (thin divider).
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param sectionIndex    0-based section index on the page
   * @param layout          Optional layout overrides
   */
  async addDividerBlock(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    },
  ): Promise<DividerBlockAddResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Step 2: Validate section index
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
      }

      const section = sections[sectionIndex];
      if (!section.fluidEngineContext) {
        return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
      }

      const gridContents = section.fluidEngineContext.gridContents;
      const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

      // Step 3: Calculate position
      let maxY = 0;
      let maxMobileY = 0;
      for (const gc of gridContents) {
        const endYVal = gc.layout?.desktop?.end?.y ?? 0;
        const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
        if (endYVal > maxY) maxY = endYVal;
        if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
      }

      // Default divider: full width (24 cols), 1 row tall
      const rowHeight = layout?.rowHeight ?? 1;
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

      // Step 4: Generate block ID and create GridContent
      const blockId = ContentSaveClient.generateBlockId();

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
            type: BLOCK_TYPE_DIVIDER,
            value: {},
          },
        },
      };

      // Step 5: Push to gridContents
      gridContents.push(newBlock);

      logger.info(
        { blockId, sectionIndex, sectionId: section.id, position: { startX, startY, endX, endY } },
        'Adding divider block via Content Save API',
      );

      // Step 6: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, sectionId: section.id, sectionIndex };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Video Block Operations ────────────────────────────────────────────

  /**
   * Add a video embed block to a section via Content Save API.
   *
   * Default layout: 24 cols wide (full width), 8 rows tall.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param sectionIndex    0-based section index on the page
   * @param videoUrl        The video URL (YouTube, Vimeo, etc.)
   * @param options         Optional title, description, and layout overrides
   */
  async addVideoBlock(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    videoUrl: string,
    options?: {
      title?: string;
      description?: string;
      layout?: {
        columns?: number;
        rowHeight?: number;
        gapRows?: number;
        startX?: number;
        endX?: number;
        startY?: number;
        endY?: number;
      };
    },
  ): Promise<VideoBlockAddResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Step 2: Validate section index
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
      }

      const section = sections[sectionIndex];
      if (!section.fluidEngineContext) {
        return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
      }

      const gridContents = section.fluidEngineContext.gridContents;
      const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

      // Step 3: Calculate position
      let maxY = 0;
      let maxMobileY = 0;
      for (const gc of gridContents) {
        const endYVal = gc.layout?.desktop?.end?.y ?? 0;
        const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
        if (endYVal > maxY) maxY = endYVal;
        if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
      }

      const layout = options?.layout;

      // Default video block: full width (24 cols), 8 rows tall
      const rowHeight = layout?.rowHeight ?? 8;
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

      // Step 4: Generate block ID and create GridContent
      const blockId = ContentSaveClient.generateBlockId();

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
            type: BLOCK_TYPE_VIDEO,
            value: {
              url: videoUrl,
              title: options?.title,
              description: options?.description,
            },
          },
        },
      };

      // Step 5: Push to gridContents
      gridContents.push(newBlock);

      logger.info(
        { blockId, sectionIndex, sectionId: section.id, videoUrl, position: { startX, startY, endX, endY } },
        'Adding video block via Content Save API',
      );

      // Step 6: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, sectionId: section.id, sectionIndex };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Update a video block's URL, title, and/or description.
   * Uses findBlock() to locate the video block by search text.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param searchText      Text to find the video block by (matches url, title, or description)
   * @param updates         Fields to update: url, title, description
   */
  async updateVideoBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    updates: { url?: string; title?: string; description?: string },
  ): Promise<VideoBlockUpdateResult> {
    if (!updates.url && !updates.title && !updates.description) {
      return { success: false, error: 'Must provide at least url, title, or description to update' };
    }

    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the video block
      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent } = match;
      const blockValue = gridContent.content.value;

      // Step 3: Verify block type is video (50)
      if (blockValue.type !== BLOCK_TYPE_VIDEO) {
        return {
          success: false,
          error: `Block "${searchText}" is type ${blockValue.type}, not a video block (expected ${BLOCK_TYPE_VIDEO})`,
        };
      }

      const blockId = blockValue.id;
      const updatedFields: string[] = [];

      // Ensure value sub-object exists
      if (!blockValue.value) {
        blockValue.value = {};
      }

      // Step 4: Update provided fields
      if (updates.url !== undefined) {
        blockValue.value.url = updates.url;
        updatedFields.push('url');
      }
      if (updates.title !== undefined) {
        blockValue.value.title = updates.title;
        updatedFields.push('title');
      }
      if (updates.description !== undefined) {
        blockValue.value.description = updates.description;
        updatedFields.push('description');
      }

      logger.info(
        { blockId, updatedFields, searchText },
        'Updating video block via Content Save API',
      );

      // Step 5: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, updatedFields };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Quote Block Operations ────────────────────────────────────────────

  /**
   * Add a quote block to a section via Content Save API.
   * Same grid positioning logic as addTextBlock/addButtonBlock.
   *
   * Default quote size: full width (24 columns), 3 rows tall.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param sectionIndex    0-based section index on the page
   * @param quoteText       The quote text (HTML)
   * @param attribution     Optional attribution/source text
   * @param layout          Optional layout overrides (same as addTextBlock)
   */
  async addQuoteBlock(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    quoteText: string,
    attribution?: string,
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    },
  ): Promise<QuoteBlockAddResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Step 2: Validate section index
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
      }

      const section = sections[sectionIndex];
      if (!section.fluidEngineContext) {
        return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
      }

      const gridContents = section.fluidEngineContext.gridContents;
      const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

      // Step 3: Calculate position
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

      // Step 4: Generate block ID and create GridContent
      const blockId = ContentSaveClient.generateBlockId();

      const maxZ = gridContents.reduce((max, gc) => {
        const dz = gc.layout?.desktop?.zIndex ?? 0;
        const mz = gc.layout?.mobile?.zIndex ?? 0;
        return Math.max(max, dz, mz);
      }, 0);
      const zIndex = maxZ + 1;

      const quoteValue: Record<string, unknown> = {
        quote: quoteText,
        blockAnimation: 'site-default',
        vSize: null,
        hSize: null,
        schemaName: null,
        aspectRatio: null,
        floatDir: null,
      };
      if (attribution !== undefined) {
        quoteValue.source = attribution;
      }

      const newBlock: GridContent = {
        layout: {
          mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
          desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
        },
        content: {
          value: {
            id: blockId,
            type: BLOCK_TYPE_QUOTE,
            value: quoteValue,
          },
        },
      };

      // Step 5: Push to gridContents
      gridContents.push(newBlock);

      logger.info(
        { blockId, sectionIndex, sectionId: section.id, quoteText: quoteText.substring(0, 100), attribution, position: { startX, startY, endX, endY } },
        'Adding quote block via Content Save API',
      );

      // Step 6: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, sectionId: section.id, sectionIndex };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Update a quote block's text and/or attribution.
   * Uses findBlock() which matches on value.html and value.source for type 44 blocks.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param searchText      Text to find the quote by (matches html or source/attribution)
   * @param updates         Fields to update: quoteText and/or attribution
   */
  async updateQuoteBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    updates: { quoteText?: string; attribution?: string },
  ): Promise<QuoteBlockUpdateResult> {
    if (!updates.quoteText && updates.attribution === undefined) {
      return { success: false, error: 'Must provide at least quoteText or attribution to update' };
    }

    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the quote block
      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent } = match;
      const blockValue = gridContent.content.value;

      // Step 3: Verify block type is quote (31)
      if (blockValue.type !== BLOCK_TYPE_QUOTE) {
        return {
          success: false,
          error: `Block "${searchText}" is type ${blockValue.type}, not a quote block (expected ${BLOCK_TYPE_QUOTE})`,
        };
      }

      const blockId = blockValue.id;
      const oldQuote = blockValue.value?.quote as string | undefined;

      // Ensure value sub-object exists
      if (!blockValue.value) {
        blockValue.value = {};
      }

      // Step 4: Update provided fields
      if (updates.quoteText !== undefined) {
        blockValue.value.quote = updates.quoteText;
      }
      if (updates.attribution !== undefined) {
        blockValue.value.source = updates.attribution;
      }

      logger.info(
        { blockId, searchText, oldQuote: oldQuote?.substring(0, 100), newQuote: updates.quoteText?.substring(0, 100), attribution: updates.attribution },
        'Updating quote block via Content Save API',
      );

      // Step 5: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        blockId,
        oldQuote,
        newQuote: updates.quoteText ?? oldQuote,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Code Block Operations ─────────────────────────────────────────────

  /**
   * Add a code block to a section via Content Save API.
   * Same grid positioning logic as addTextBlock/addButtonBlock.
   *
   * Default code block size: full width (24 columns), 3 rows tall.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param sectionIndex    0-based section index on the page
   * @param code            The code content
   * @param language        Optional language identifier (defaults to 'plain')
   * @param layout          Optional layout overrides (same as addTextBlock)
   */
  async addCodeBlock(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    code: string,
    language?: string,
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    },
  ): Promise<CodeBlockAddResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Step 2: Validate section index
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
      }

      const section = sections[sectionIndex];
      if (!section.fluidEngineContext) {
        return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
      }

      const gridContents = section.fluidEngineContext.gridContents;
      const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

      // Step 3: Calculate position
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

      // Step 4: Generate block ID and create GridContent
      const blockId = ContentSaveClient.generateBlockId();

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
            type: BLOCK_TYPE_CODE,
            value: { wysiwyg: { engine: CODE_BLOCK_ENGINE, mode: language ?? 'htmlmixed', isSource: false, source: code }, html: code },
          },
        },
      };

      // Step 5: Push to gridContents
      gridContents.push(newBlock);

      logger.info(
        { blockId, sectionIndex, sectionId: section.id, language: language ?? 'plain', codeLength: code.length, position: { startX, startY, endX, endY } },
        'Adding code block via Content Save API',
      );

      // Step 6: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, sectionId: section.id, sectionIndex };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Update a code block's content and/or language.
   * Uses findBlock() which matches on value.html for type 23 blocks.
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param searchText      Text to find the code block by (matches code content)
   * @param updates         Fields to update: code and/or language
   */
  async updateCodeBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    updates: { code?: string; language?: string },
  ): Promise<CodeBlockUpdateResult> {
    if (!updates.code && !updates.language) {
      return { success: false, error: 'Must provide at least code or language to update' };
    }

    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the code block
      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent } = match;
      const blockValue = gridContent.content.value;

      // Step 3: Verify block type is code (type 1337 with wysiwyg.engine === 'code')
      if (blockValue.type !== BLOCK_TYPE_CODE || blockValue.value?.wysiwyg?.engine !== CODE_BLOCK_ENGINE) {
        return {
          success: false,
          error: `Block "${searchText}" is type ${blockValue.type}, not a code block (expected ${BLOCK_TYPE_CODE} with wysiwyg.engine='${CODE_BLOCK_ENGINE}')`,
        };
      }

      const blockId = blockValue.id;

      // Ensure value sub-object exists
      if (!blockValue.value) {
        blockValue.value = {};
      }

      // Step 4: Update provided fields
      if (updates.code !== undefined) {
        blockValue.value.html = updates.code;
        if (blockValue.value.wysiwyg) {
          blockValue.value.wysiwyg.source = updates.code;
        }
      }
      if (updates.language !== undefined) {
        if (blockValue.value.wysiwyg) {
          blockValue.value.wysiwyg.mode = updates.language;
        }
      }

      logger.info(
        { blockId, searchText, language: updates.language, codeLength: updates.code?.length },
        'Updating code block via Content Save API',
      );

      // Step 5: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Fill Placeholder Block ──────────────────────────────────────────────

  /**
   * Find the last short/empty text block in a section and replace its content.
   * Used as a fallback when addTextBlock() fails — the UI creates a block with
   * a server-assigned ID, then this method fills its placeholder content via API.
   *
   * "Short" = stripped text content < 50 chars (default Squarespace placeholder).
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param sectionIndex    0-based section index on the page
   * @param newHtml         HTML content to fill the block with
   */
  async fillLastTextBlockInSection(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    newHtml: string,
  ): Promise<FillBlockResult> {
    try {
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Bounds check
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

      // Scan from last block to first, looking for a short/empty text block (type 2)
      let textBlockCount = 0;
      for (let i = gridContents.length - 1; i >= 0; i--) {
        const gc = gridContents[i];
        if (gc.content?.value?.type !== BLOCK_TYPE_TEXT) continue;

        textBlockCount++;
        const rawHtml = gc.content.value.value?.html ?? gc.content.value.value?.source ?? '';
        const blockText = this.stripHtml(rawHtml);

        // Only replace if the block has short content (placeholder) or is empty
        if (blockText.length < 50) {
          const formattedHtml = this.formatHtml(newHtml);

          // Ensure the value sub-object exists
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

      // No matching block found — provide diagnostic info
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
  }

  // ── Menu Block Methods ─────────────────────────────────────────────────

  /**
   * Find a menu block (type 18) in sections by searching text.
   * Returns the block value with menus/raw/menuStyle/currencySymbol, or null.
   */
  findMenuBlock(
    sections: PageSection[],
    searchText: string,
  ): {
    section: PageSection;
    gridContent: GridContent;
    sectionIndex: number;
    blockIndex: number;
    menuValue: any;  // { menus, raw, menuStyle, currencySymbol, ... }
  } | null {
    const found = this.findBlock(sections, searchText);
    if (!found) return null;

    const bv = found.gridContent.content.value;
    if (bv.type !== BLOCK_TYPE_MENU) return null;

    return {
      ...found,
      menuValue: bv.value,
    };
  }

  /**
   * Read the current state of a menu block from a page.
   * Returns the menus array, menuStyle, currencySymbol, and blockId.
   */
  async getMenuBlock(
    pageSectionsId: string,
    searchText: string,
  ): Promise<{
    success: boolean;
    menus?: any[];
    menuStyle?: number;
    currencySymbol?: string;
    blockId?: string;
    raw?: string;
    error?: string;
  }> {
    try {
      const data = await this.getPageSections(pageSectionsId);
      const found = this.findMenuBlock(data.sections, searchText);
      if (!found) {
        return { success: false, error: `Menu block not found for searchText "${searchText}"` };
      }
      const mv = found.menuValue;
      return {
        success: true,
        menus: mv.menus || [],
        menuStyle: mv.menuStyle,
        currencySymbol: mv.currencySymbol,
        blockId: found.gridContent.content.value.id,
        raw: mv.raw,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Update a menu block's menus array via read-modify-write.
   * Preserves menuStyle, currencySymbol, and any other unknown fields.
   * Regenerates the `raw` field using serializeMenu().
   *
   * @param pageSectionsId  The page sections ID
   * @param collectionId    The collection ID
   * @param searchText      Text to find the menu block
   * @param newMenus        The new menus array (MenuTab[])
   * @param options         Optional: { preserveRaw?: boolean } - if true, don't regenerate raw field
   */
  async updateMenuBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    newMenus: any[],
    options?: { preserveRaw?: boolean },
  ): Promise<MenuBlockUpdateResult> {
    try {
      const data = await this.getPageSections(pageSectionsId);
      const found = this.findMenuBlock(data.sections, searchText);
      if (!found) {
        return { success: false, error: `Menu block not found for searchText "${searchText}"` };
      }

      const bv = found.gridContent.content.value;
      const oldMenus = found.menuValue.menus || [];
      const oldItemCount = oldMenus.reduce((sum: number, tab: any) =>
        sum + (tab.sections || []).reduce((s: number, sec: any) => s + (sec.items || []).length, 0), 0);
      const newItemCount = newMenus.reduce((sum: number, tab: any) =>
        sum + (tab.sections || []).reduce((s: number, sec: any) => s + (sec.items || []).length, 0), 0);

      // Update menus, preserve everything else (spread preserves unknown fields)
      bv.value = {
        ...bv.value,
        menus: newMenus,
      };

      // Regenerate raw field unless told to preserve it
      if (!options?.preserveRaw) {
        const { serializeMenu } = await import('./menu-parser.js');
        bv.value.raw = serializeMenu(newMenus);
      }

      // Save
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error || 'Save failed' };
      }

      return {
        success: true,
        blockId: bv.id,
        sectionId: found.section.id,
        oldTabCount: oldMenus.length,
        newTabCount: newMenus.length,
        oldItemCount,
        newItemCount,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Collection & Page Management ────────────────────────────────────────

  /** Type number → human-readable name mapping for Squarespace collections */
  private static readonly TYPE_NAMES: Record<number, string> = {
    1: 'page',
    2: 'blog',
    5: 'store',
    7: 'gallery',
    11: 'folder',
    12: 'index',
  };

  /**
   * List all collections (pages, blogs, galleries, etc.) for the site.
   * Uses the same GetCollections endpoint as getPageIds but returns full metadata.
   */
  async listCollections(): Promise<CollectionInfo[]> {
    this.ensureCookies();

    try {
      const url = this.buildApiUrl('/api/commondata/GetCollections/');
      const response = await fetch(url, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'listCollections: API returned error');
        return [];
      }

      const data = (await response.json()) as Record<string, unknown>;
      const collections = (data.collections ?? data) as Record<string, unknown>[] | Record<string, unknown>;
      const collList = Array.isArray(collections)
        ? collections
        : Object.values(collections);

      return collList.map((c) => {
        const coll = c as Record<string, unknown>;
        const typeNum = Number(coll.type ?? 0);
        return {
          id: String(coll.id ?? ''),
          urlId: String(coll.urlId ?? ''),
          title: String(coll.title ?? ''),
          type: typeNum,
          typeName: ContentSaveClient.TYPE_NAMES[typeNum] ?? 'unknown',
          ...(coll.itemCount != null ? { itemCount: Number(coll.itemCount) } : {}),
          ...(coll.enabled != null ? { enabled: Boolean(coll.enabled) } : {}),
          ...(coll.ordering != null ? { ordering: Number(coll.ordering) } : {}),
          ...(coll.navigationTitle != null ? { navigationTitle: String(coll.navigationTitle) } : {}),
          ...(coll.description != null ? { description: String(coll.description) } : {}),
        };
      });
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'listCollections: failed');
      return [];
    }
  }

  /**
   * Get metadata for a specific page by slug.
   * Wraps listCollections() with slug normalization and filtering.
   */
  async getPageMetadata(slug: string): Promise<PageMetadata | null> {
    const normalizedSlug = this.normalizeSlug(slug);
    const targetSlug = normalizedSlug || 'home';

    try {
      const collections = await this.listCollections();

      for (const coll of collections) {
        if (coll.urlId.toLowerCase() === targetSlug.toLowerCase()) {
          return {
            collectionId: coll.id,
            urlId: coll.urlId,
            title: coll.title,
            type: coll.type,
            typeName: coll.typeName,
            ...(coll.enabled != null ? { enabled: coll.enabled } : {}),
            ...(coll.navigationTitle != null ? { navigationTitle: coll.navigationTitle } : {}),
          };
        }
      }

      return null;
    } catch (err) {
      logger.warn({ error: errMsg(err), slug }, 'getPageMetadata: failed');
      return null;
    }
  }

  /**
   * Get items (blog posts, gallery items, etc.) from a collection.
   * Uses the content-collections endpoint.
   */
  async getCollectionItems(
    collectionId: string,
    options?: CollectionItemsOptions,
  ): Promise<CollectionItemsResult> {
    this.ensureCookies();

    try {
      const params = new URLSearchParams();
      if (options?.limit != null) params.set('limit', String(options.limit));
      if (options?.offset != null) params.set('offset', String(options.offset));

      const qs = params.toString();
      const path = `/api/content-collections/${collectionId}/content-items${qs ? `?${qs}` : ''}`;
      const url = this.buildApiUrl(path);

      const response = await fetch(url, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        return { success: false, error: `API returned ${response.status}` };
      }

      const data = (await response.json()) as Record<string, unknown>;
      let items = (Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : []) as CollectionItem[];

      // Apply status filter if requested
      if (options?.filter === 'published') {
        items = items.filter((item) => (item as Record<string, unknown>).status === 1);
      } else if (options?.filter === 'draft') {
        items = items.filter((item) => (item as Record<string, unknown>).status === 0);
      }

      return {
        success: true,
        items,
        total: typeof data.total === 'number' ? data.total : items.length,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * SPECULATIVE: Attempt to create a page via API.
   * Tries multiple endpoint candidates — returns endpointAvailable: false if none work (404/405).
   * Never throws.
   */
  async createPageViaApi(
    title: string,
    slug?: string,
    options?: { type?: number },
  ): Promise<PageCreateResult> {
    this.ensureCookies();

    const body = JSON.stringify({
      title,
      ...(slug ? { urlId: slug } : {}),
      ...(options?.type != null ? { type: options.type } : {}),
    });

    const endpoints = [
      '/api/content/add/page',
      '/api/pages',
      '/api/collections',
    ];

    // For collections endpoint, always include type: 1 (page)
    const bodiesForEndpoint: Record<string, string> = {
      '/api/collections': JSON.stringify({
        title,
        ...(slug ? { urlId: slug } : {}),
        type: options?.type ?? 1,
      }),
    };

    for (const endpoint of endpoints) {
      try {
        const url = this.buildApiUrl(endpoint, true);
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            ...this.buildHeaders(),
            'Content-Type': 'application/json',
          },
          body: bodiesForEndpoint[endpoint] ?? body,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        // 404/405 means this endpoint doesn't exist — try next
        if (response.status === 404 || response.status === 405) {
          logger.debug({ endpoint, status: response.status }, 'createPageViaApi: endpoint not available, trying next');
          continue;
        }

        // 401 means session expired — don't try other endpoints
        if (response.status === 401) {
          return {
            success: false,
            endpointAvailable: true,
            error: 'Session expired — re-authenticate via browser to refresh cookies',
          };
        }

        // Other errors (500, etc.) — endpoint exists but failed
        if (!response.ok) {
          return {
            success: false,
            endpointAvailable: true,
            error: `${endpoint} returned ${response.status}`,
          };
        }

        const data = (await response.json()) as Record<string, unknown>;

        // Check for crumb failure
        if (data.crumbFail || (typeof data.error === 'string' && String(data.error).includes('Invalid session crumb'))) {
          const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
          return {
            success: false,
            endpointAvailable: true,
            error: `createPageViaApi rejected: invalid or expired session crumb.${ageInfo} Run a browser session to refresh cookies.`,
          };
        }

        logger.info({ endpoint, pageId: data.id, urlId: data.urlId }, 'createPageViaApi: page created');

        return {
          success: true,
          endpointAvailable: true,
          pageId: data.id ? String(data.id) : undefined,
          urlId: data.urlId ? String(data.urlId) : undefined,
        };
      } catch (err) {
        // Network/timeout error — endpoint might exist, just unreachable
        return {
          success: false,
          endpointAvailable: true,
          error: errMsg(err),
        };
      }
    }

    // All endpoints returned 404/405
    return {
      success: false,
      endpointAvailable: false,
      error: 'No page creation endpoint found',
    };
  }

  /**
   * SPECULATIVE: Attempt to create a blog post via API.
   * Uses the content-collections endpoint. Returns endpointAvailable: false on 404/405.
   * Never throws.
   */
  async createBlogPost(
    collectionId: string,
    title: string,
    options?: {
      body?: string;
      slug?: string;
      tags?: string[];
      categories?: string[];
      excerpt?: string;
      draft?: boolean;
    },
  ): Promise<BlogPostCreateResult> {
    this.ensureCookies();

    try {
      const path = `/api/content-collections/${collectionId}/content-items`;
      const url = this.buildApiUrl(path, true);

      const postBody = JSON.stringify({
        title,
        ...(options?.body != null ? { body: options.body } : {}),
        ...(options?.slug ? { urlId: options.slug } : {}),
        ...(options?.tags ? { tags: options.tags } : {}),
        ...(options?.categories ? { categories: options.categories } : {}),
        ...(options?.excerpt != null ? { excerpt: options.excerpt } : {}),
        draft: options?.draft ?? true,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
        },
        body: postBody,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status === 404 || response.status === 405) {
        return {
          success: false,
          endpointAvailable: false,
          error: `Endpoint returned ${response.status}`,
        };
      }

      if (!response.ok) {
        return {
          success: false,
          endpointAvailable: true,
          error: `API returned ${response.status}`,
        };
      }

      const data = (await response.json()) as Record<string, unknown>;
      logger.info({ collectionId, itemId: data.id, urlId: data.urlId }, 'createBlogPost: post created');

      return {
        success: true,
        endpointAvailable: true,
        itemId: data.id ? String(data.id) : undefined,
        urlId: data.urlId ? String(data.urlId) : undefined,
      };
    } catch (err) {
      return {
        success: false,
        endpointAvailable: true,
        error: errMsg(err),
      };
    }
  }

  /**
   * Update an existing blog post by item ID.
   * PUT /api/content-collections/{collectionId}/content-items/{itemId}
   * Never throws.
   */
  async updateBlogPost(
    collectionId: string,
    itemId: string,
    updates: BlogPostUpdateOptions,
  ): Promise<BlogPostUpdateResult> {
    this.ensureCookies();

    try {
      const body: Record<string, unknown> = {};
      const updatedFields: string[] = [];

      if (updates.title != null) { body.title = updates.title; updatedFields.push('title'); }
      if (updates.body != null) { body.body = updates.body; updatedFields.push('body'); }
      if (updates.excerpt != null) { body.excerpt = updates.excerpt; updatedFields.push('excerpt'); }
      if (updates.tags != null) { body.tags = updates.tags; updatedFields.push('tags'); }
      if (updates.categories != null) { body.categories = updates.categories; updatedFields.push('categories'); }
      if (updates.urlId != null) { body.urlId = updates.urlId; updatedFields.push('urlId'); }
      if (updates.draft != null) { body.draft = updates.draft; updatedFields.push('draft'); }

      if (updatedFields.length === 0) {
        return { success: false, itemId, updatedFields: [], error: 'No fields provided to update' };
      }

      const path = `/api/content-collections/${collectionId}/content-items/${itemId}`;
      const url = this.buildApiUrl(path, true);

      const response = await fetch(url, {
        method: 'PUT',
        headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status === 401) {
        return { success: false, itemId, updatedFields: [], error: 'Session expired' };
      }
      if (response.status === 404) {
        return { success: false, itemId, updatedFields: [], error: 'Blog post not found' };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { success: false, itemId, updatedFields: [], error: `HTTP ${response.status}: ${text}` };
      }

      const data = (await response.json()) as Record<string, unknown>;
      if (data.crumbFail || (typeof data.error === 'string' && data.error.includes('Invalid session crumb'))) {
        return { success: false, itemId, updatedFields: [], error: 'Session crumb invalid — re-authenticate' };
      }

      logger.info({ collectionId, itemId, updatedFields }, 'updateBlogPost: post updated');
      return { success: true, itemId, updatedFields };
    } catch (err) {
      return { success: false, itemId, updatedFields: [], error: errMsg(err) };
    }
  }

  /**
   * Find a blog post by partial title match (case-insensitive).
   * Returns the first matching CollectionItem, or null.
   * Never throws.
   */
  async findBlogPostByTitle(
    collectionId: string,
    searchTitle: string,
  ): Promise<CollectionItem | null> {
    try {
      const result = await this.getCollectionItems(collectionId);
      if (!result.success || !result.items) return null;
      const lower = searchTitle.toLowerCase().trim();
      return result.items.find((item) => item.title?.toLowerCase().includes(lower)) ?? null;
    } catch (err) {
      logger.warn({ error: errMsg(err), collectionId, searchTitle }, 'findBlogPostByTitle: failed');
      return null;
    }
  }

  // ── Page Delete / Update ────────────────────────────────────────────────

  /**
   * Delete a page (collection) via API.
   * DELETE /api/collections/{collectionId} with crumb token.
   * Never throws.
   */
  async deletePageViaApi(collectionId: string): Promise<PageDeleteResult> {
    this.ensureCookies();

    try {
      const path = `/api/collections/${collectionId}`;
      const url = this.buildApiUrl(path, true);

      const response = await fetch(url, {
        method: 'DELETE',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status === 401) {
        return {
          success: false,
          collectionId,
          error: 'Session expired — re-authenticate via browser to refresh cookies',
        };
      }

      if (!response.ok) {
        return {
          success: false,
          collectionId,
          error: `API returned ${response.status}`,
        };
      }

      // Check for crumb failure in response body
      let data: Record<string, unknown> = {};
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        // Some DELETE endpoints return empty body on success — that's fine
      }

      if (data.crumbFail || (typeof data.error === 'string' && String(data.error).includes('Invalid session crumb'))) {
        const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
        return {
          success: false,
          collectionId,
          error: `deletePageViaApi rejected: invalid or expired session crumb.${ageInfo} Run a browser session to refresh cookies.`,
        };
      }

      logger.info({ collectionId }, 'deletePageViaApi: page deleted');

      return {
        success: true,
        collectionId,
      };
    } catch (err) {
      return {
        success: false,
        collectionId,
        error: errMsg(err),
      };
    }
  }

  /**
   * Update page metadata (title, slug, description, SEO fields, visibility).
   * PUT /api/collections/{collectionId} with crumb token.
   * Never throws.
   */
  async updatePageMetadata(
    collectionId: string,
    updates: PageMetadataUpdateOptions,
  ): Promise<PageMetadataUpdateResult> {
    this.ensureCookies();

    try {
      const path = `/api/collections/${collectionId}`;
      const url = this.buildApiUrl(path, true);

      const body: Record<string, unknown> = {};
      const updatedFields: string[] = [];

      if (updates.title != null) { body.title = updates.title; updatedFields.push('title'); }
      if (updates.urlId != null) { body.urlId = updates.urlId; updatedFields.push('urlId'); }
      if (updates.description != null) { body.description = updates.description; updatedFields.push('description'); }
      if (updates.seoTitle != null) { body.seoTitle = updates.seoTitle; updatedFields.push('seoTitle'); }
      if (updates.seoDescription != null) { body.seoDescription = updates.seoDescription; updatedFields.push('seoDescription'); }
      if (updates.navigationTitle != null) { body.navigationTitle = updates.navigationTitle; updatedFields.push('navigationTitle'); }
      if (updates.enabled != null) { body.enabled = updates.enabled; updatedFields.push('enabled'); }

      if (updatedFields.length === 0) {
        return {
          success: false,
          collectionId,
          updatedFields: [],
          error: 'No fields provided for update',
        };
      }

      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status === 401) {
        return {
          success: false,
          collectionId,
          updatedFields: [],
          error: 'Session expired — re-authenticate via browser to refresh cookies',
        };
      }

      if (!response.ok) {
        return {
          success: false,
          collectionId,
          updatedFields: [],
          error: `API returned ${response.status}`,
        };
      }

      const data = (await response.json()) as Record<string, unknown>;

      if (data.crumbFail || (typeof data.error === 'string' && String(data.error).includes('Invalid session crumb'))) {
        const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
        return {
          success: false,
          collectionId,
          updatedFields: [],
          error: `updatePageMetadata rejected: invalid or expired session crumb.${ageInfo} Run a browser session to refresh cookies.`,
        };
      }

      logger.info({ collectionId, updatedFields }, 'updatePageMetadata: metadata updated');

      return {
        success: true,
        collectionId,
        updatedFields,
      };
    } catch (err) {
      return {
        success: false,
        collectionId,
        updatedFields: [],
        error: errMsg(err),
      };
    }
  }

  // ── Section Style / Duplicate / Reorder ──────────────────────────────────

  /**
   * Edit a section's style properties (theme, background, height, padding, etc.).
   * Read-modify-write: GET → find section → update properties → PUT.
   *
   * @param sectionSearch - section index (number) or text content to search for (string)
   */
  async editSectionStyle(
    pageSectionsId: string,
    collectionId: string,
    sectionSearch: number | string,
    styles: SectionStyleOptions,
  ): Promise<SectionStyleResult> {
    try {
      this.ensureCookies();

      // Validate that at least one style property was provided
      const styleKeys = Object.keys(styles).filter(
        (k) => styles[k as keyof SectionStyleOptions] !== undefined,
      );
      if (styleKeys.length === 0) {
        return { success: false, error: 'No style properties provided' };
      }

      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      if (!sections || sections.length === 0) {
        return { success: false, error: 'Page has no sections' };
      }

      // Step 2: Find the target section
      let sectionIndex: number;
      if (typeof sectionSearch === 'number') {
        if (sectionSearch < 0 || sectionSearch >= sections.length) {
          return {
            success: false,
            error: `Section index ${sectionSearch} out of range (0-${sections.length - 1})`,
          };
        }
        sectionIndex = sectionSearch;
      } else {
        const match = this.findBlock(sections, sectionSearch);
        if (!match) {
          return { success: false, error: `No section found containing text "${sectionSearch}"` };
        }
        sectionIndex = match.sectionIndex;
      }

      const section = sections[sectionIndex];
      const updatedFields: string[] = [];

      // Step 3: Apply style properties
      if (styles.sectionTheme !== undefined) {
        (section as Record<string, unknown>).sectionTheme = styles.sectionTheme;
        updatedFields.push('sectionTheme');
      }
      if (styles.backgroundColor !== undefined) {
        (section as Record<string, unknown>).backgroundColor = styles.backgroundColor;
        updatedFields.push('backgroundColor');
      }
      if (styles.sectionHeight !== undefined) {
        (section as Record<string, unknown>).sectionHeight = styles.sectionHeight;
        updatedFields.push('sectionHeight');
      }
      if (styles.paddingTop !== undefined) {
        (section as Record<string, unknown>).paddingTop = styles.paddingTop;
        updatedFields.push('paddingTop');
      }
      if (styles.paddingBottom !== undefined) {
        (section as Record<string, unknown>).paddingBottom = styles.paddingBottom;
        updatedFields.push('paddingBottom');
      }
      if (styles.blockSpacing !== undefined) {
        (section as Record<string, unknown>).blockSpacing = styles.blockSpacing;
        updatedFields.push('blockSpacing');
      }
      if (styles.contentWidth !== undefined) {
        (section as Record<string, unknown>).contentWidth = styles.contentWidth;
        updatedFields.push('contentWidth');
      }
      if (styles.verticalAlignment !== undefined) {
        (section as Record<string, unknown>).verticalAlignment = styles.verticalAlignment;
        updatedFields.push('verticalAlignment');
      }

      logger.info(
        { sectionId: section.id, sectionIndex, updatedFields },
        'Editing section style via Content Save API',
      );

      // Step 4: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        sectionId: section.id,
        sectionIndex,
        updatedFields,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Duplicate a section (deep clone with regenerated IDs).
   * The clone is inserted immediately after the original.
   *
   * @param sectionSearch - section index (number) or text content to search for (string)
   */
  async duplicateSection(
    pageSectionsId: string,
    collectionId: string,
    sectionSearch: number | string,
  ): Promise<SectionDuplicateResult> {
    try {
      this.ensureCookies();

      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      if (!sections || sections.length === 0) {
        return { success: false, error: 'Page has no sections' };
      }

      // Step 2: Find the target section
      let sectionIndex: number;
      if (typeof sectionSearch === 'number') {
        if (sectionSearch < 0 || sectionSearch >= sections.length) {
          return {
            success: false,
            error: `Section index ${sectionSearch} out of range (0-${sections.length - 1})`,
          };
        }
        sectionIndex = sectionSearch;
      } else {
        const match = this.findBlock(sections, sectionSearch);
        if (!match) {
          return { success: false, error: `No section found containing text "${sectionSearch}"` };
        }
        sectionIndex = match.sectionIndex;
      }

      const originalSection = sections[sectionIndex];

      // Step 3: Deep clone the section
      const cloned: PageSection = JSON.parse(JSON.stringify(originalSection));

      // Step 4: Generate new section ID
      const newSectionId = ContentSaveClient.generateBlockId();
      cloned.id = newSectionId;

      // Step 5: Regenerate fluidEngineContext.id if present
      if (cloned.fluidEngineContext) {
        (cloned.fluidEngineContext as Record<string, unknown>).id = ContentSaveClient.generateBlockId();

        // Step 6: Regenerate ALL block IDs in the cloned section
        const gridContents = cloned.fluidEngineContext.gridContents;
        if (gridContents) {
          for (const gc of gridContents) {
            if (gc.content?.value?.id) {
              gc.content.value.id = ContentSaveClient.generateBlockId();
            }
          }
        }
      }

      // Step 7: Insert clone after original
      const newIndex = sectionIndex + 1;
      sections.splice(newIndex, 0, cloned);

      logger.info(
        { originalSectionId: originalSection.id, newSectionId, newIndex, totalSections: sections.length },
        'Duplicating section via Content Save API',
      );

      // Step 8: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        originalSectionId: originalSection.id,
        newSectionId,
        newSectionIndex: newIndex,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Reorder sections on a page by specifying the desired order as an array of current indices.
   * e.g., [2, 0, 1] means "section at index 2 goes first, then 0, then 1".
   */
  async reorderSections(
    pageSectionsId: string,
    collectionId: string,
    newOrder: number[],
  ): Promise<SectionReorderResult> {
    try {
      this.ensureCookies();

      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      if (!sections || sections.length === 0) {
        return { success: false, error: 'Page has no sections' };
      }

      // Step 2: Validate newOrder
      if (newOrder.length !== sections.length) {
        return {
          success: false,
          error: `newOrder length (${newOrder.length}) does not match sections count (${sections.length})`,
        };
      }

      // Check for duplicates and out-of-range
      const seen = new Set<number>();
      for (const idx of newOrder) {
        if (idx < 0 || idx >= sections.length) {
          return { success: false, error: `Index ${idx} out of range (0-${sections.length - 1})` };
        }
        if (seen.has(idx)) {
          return { success: false, error: `Duplicate index ${idx} in newOrder` };
        }
        seen.add(idx);
      }

      // Step 3: Rearrange sections
      const reordered = newOrder.map((idx) => sections[idx]);
      data.sections = reordered;

      logger.info(
        { newOrder, sectionsCount: sections.length },
        'Reordering sections via Content Save API',
      );

      // Step 4: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, reordered);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        newOrder,
        sectionsCount: sections.length,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Duplicate a block within its section (deep clone with new ID, positioned below original).
   * Backfills verticalAlignment and zIndex on all existing blocks before adding.
   */
  async duplicateBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
  ): Promise<BlockDuplicateResult> {
    try {
      this.ensureCookies();

      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the block
      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { section, gridContent, sectionIndex } = match;
      const gridContents = section.fluidEngineContext?.gridContents;
      if (!gridContents) {
        return { success: false, error: 'Section has no gridContents' };
      }

      const originalBlockId = gridContent.content.value.id;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
      // Squarespace validates ALL blocks on PUT, so any block missing these fields will cause a 400 error.
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

      // Step 3: Deep clone the block
      const cloned: GridContent = JSON.parse(JSON.stringify(gridContent));

      // Step 4: Generate new block ID
      const newBlockId = ContentSaveClient.generateBlockId();
      cloned.content.value.id = newBlockId;

      // Step 5: Position below original (same X, Y = original end Y + 2 gap rows)
      const GAP_ROWS = 2;
      if (cloned.layout?.desktop && gridContent.layout?.desktop) {
        const origDesktop = gridContent.layout.desktop;
        const height = origDesktop.end.y - origDesktop.start.y;
        const newStartY = origDesktop.end.y + GAP_ROWS;
        cloned.layout.desktop.start = { x: origDesktop.start.x, y: newStartY };
        cloned.layout.desktop.end = { x: origDesktop.end.x, y: newStartY + height };
        cloned.layout.desktop.zIndex = gridContents.length;
      }
      if (cloned.layout?.mobile && gridContent.layout?.mobile) {
        const origMobile = gridContent.layout.mobile;
        const height = origMobile.end.y - origMobile.start.y;
        const newStartY = origMobile.end.y + GAP_ROWS;
        cloned.layout.mobile.start = { x: origMobile.start.x, y: newStartY };
        cloned.layout.mobile.end = { x: origMobile.end.x, y: newStartY + height };
        cloned.layout.mobile.zIndex = gridContents.length;
      }

      // Step 6: Push to section
      gridContents.push(cloned);

      logger.info(
        { originalBlockId, newBlockId, sectionId: section.id, sectionIndex },
        'Duplicating block via Content Save API',
      );

      // Step 7: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        originalBlockId,
        newBlockId,
        sectionId: section.id,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Private Methods ──────────────────────────────────────────────────────

  private ensureCookies(): void {
    if (!this.siteCookieHeader) {
      throw new Error('Session cookies not loaded. Call loadSessionCookies() first.');
    }
  }

  private buildPutUrl(pageSectionsId: string, collectionId: string): string {
    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    let url = `${siteUrl}/api/page-sections/${pageSectionsId}/collection/${collectionId}`;
    if (this.crumbToken) {
      url += `?crumb=${encodeURIComponent(this.crumbToken)}`;
    }
    return url;
  }

  private buildHeaders(): Record<string, string> {
    return {
      Cookie: this.siteCookieHeader,
      Origin: `https://${this.siteSubdomain}.squarespace.com`,
      Referer: `https://${this.siteSubdomain}.squarespace.com/`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
    };
  }

  /**
   * Search all sections for a text/HTML block (type 2) whose stripped
   * HTML value contains the given searchText (case-insensitive).
   */
  private findTextBlock(
    sections: PageSection[],
    searchText: string,
  ): {
    section: PageSection;
    gridContent: GridContent;
    sectionIndex: number;
    blockIndex: number;
  } | null {
    const needle = searchText.toLowerCase();

    for (let si = 0; si < sections.length; si++) {
      const section = sections[si];
      const gridContents = section.fluidEngineContext?.gridContents;
      if (!gridContents) continue;

      for (let bi = 0; bi < gridContents.length; bi++) {
        const gc = gridContents[bi];
        const blockValue = gc.content?.value;
        if (!blockValue || blockValue.type !== BLOCK_TYPE_TEXT) continue;

        const html = blockValue.value?.html;
        if (!html) continue;

        const plainText = this.stripHtml(html).toLowerCase();
        if (plainText.includes(needle)) {
          return { section, gridContent: gc, sectionIndex: si, blockIndex: bi };
        }
      }
    }

    return null;
  }

  /** Formatting options for text block HTML generation */
  static readonly FormattingDefaults = {
    tag: 'p' as const,
    alignment: undefined as 'left' | 'center' | 'right' | undefined,
    bold: false,
    italic: false,
    className: undefined as string | undefined,
  };

  /**
   * Format HTML for Squarespace text blocks.
   * If the input already contains HTML tags (starts with `<`), pass it through unchanged.
   * Otherwise, wrap plain text in the appropriate tag with optional formatting.
   *
   * @param input     The text or HTML content
   * @param formatting  Optional formatting options (tag, alignment, bold, italic, className)
   */
  formatHtml(input: string, formatting?: {
    tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'p';
    alignment?: 'left' | 'center' | 'right';
    bold?: boolean;
    italic?: boolean;
    className?: string;
  }): string {
    // If input is already HTML, pass through without re-wrapping
    if (input.trimStart().startsWith('<')) return input;

    // Build the tag and style attributes
    const tag = formatting?.tag ?? 'p';
    const className = formatting?.className ?? '';

    const styles: string[] = ['white-space:pre-wrap'];
    if (formatting?.alignment) {
      styles.push(`text-align:${formatting.alignment}`);
    }
    const styleAttr = styles.join(';');

    // Wrap text content with inline formatting tags
    // Apply italic first (inner), then bold (outer) so <strong><em>text</em></strong>
    let textContent = input;
    if (formatting?.italic) {
      textContent = `<em>${textContent}</em>`;
    }
    if (formatting?.bold) {
      textContent = `<strong>${textContent}</strong>`;
    }

    return `<${tag} class="${className}" style="${styleAttr};">${textContent}</${tag}>`;
  }

  private stripHtml(html: string): string {
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

  private normalizeSlug(slug: string): string {
    const lower = slug.toLowerCase().trim();
    const HOME_SLUGS = ['homepage', 'home-page', 'home', 'landing', 'index', 'main', ''];
    if (HOME_SLUGS.includes(lower)) return '';
    return slug.replace(/^\/+/, '');
  }

  /** Build a site-relative API URL with optional crumb token */
  private buildApiUrl(path: string, includeCrumb = false): string {
    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    let url = `${siteUrl}${path}`;
    if (includeCrumb && this.crumbToken) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}crumb=${encodeURIComponent(this.crumbToken)}`;
    }
    return url;
  }

  // ── Gallery Settings ───────────────────────────────────────────────────────

  /**
   * Update gallery block display settings (type 8 block).
   *
   * Uses read-modify-write: GET sections → find gallery block → update settings → PUT.
   * Gallery blocks are type 8 and store settings like thumbnails-per-row,
   * aspect-ratio, design, padding, lightbox directly in content.value.value.
   *
   * @param pageSectionsId  Page sections ID
   * @param collectionId    Collection ID
   * @param searchText      Gallery collection ID or block ID prefix to find the gallery block
   * @param settings        Gallery settings to update (partial — only provided fields are changed)
   */
  async updateGallerySettings(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    settings: GallerySettings,
  ): Promise<GallerySettingsUpdateResult> {
    try {
      this.ensureCookies();

      const data = await this.getPageSections(pageSectionsId);

      // Find gallery block (type 8) — search by collectionId or block ID prefix
      let found: { gridContent: GridContent; sectionIndex: number; blockIndex: number } | null = null;
      const needle = searchText.toLowerCase();

      for (let si = 0; si < data.sections.length; si++) {
        const section = data.sections[si];
        const gridContents = section.fluidEngineContext?.gridContents;
        if (!gridContents) continue;

        for (let bi = 0; bi < gridContents.length; bi++) {
          const gc = gridContents[bi];
          const bv = gc.content?.value;
          if (!bv || bv.type !== BLOCK_TYPE_GALLERY) continue;

          // Match by collectionId, transientGalleryId, or block ID prefix
          const val = bv.value ?? {};
          if (
            val.collectionId === searchText ||
            val.transientGalleryId === searchText ||
            bv.id.toLowerCase().startsWith(needle)
          ) {
            found = { gridContent: gc, sectionIndex: si, blockIndex: bi };
            break;
          }
        }
        if (found) break;
      }

      // Fallback: if only one gallery block exists, use it
      if (!found) {
        for (let si = 0; si < data.sections.length; si++) {
          const section = data.sections[si];
          const gridContents = section.fluidEngineContext?.gridContents;
          if (!gridContents) continue;
          for (let bi = 0; bi < gridContents.length; bi++) {
            const gc = gridContents[bi];
            if (gc.content?.value?.type === BLOCK_TYPE_GALLERY) {
              found = { gridContent: gc, sectionIndex: si, blockIndex: bi };
              break;
            }
          }
          if (found) break;
        }
      }

      if (!found) {
        return { success: false, error: `No gallery block found matching: ${searchText}` };
      }

      const blockValue = found.gridContent.content.value;
      if (!blockValue.value) blockValue.value = {};

      const updatedFields: string[] = [];
      for (const [key, value] of Object.entries(settings)) {
        if (value !== undefined) {
          (blockValue.value as Record<string, unknown>)[key] = value;
          updatedFields.push(key);
        }
      }

      logger.info(
        { blockId: blockValue.id, updatedFields },
        'Updating gallery settings',
      );

      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId: blockValue.id, updatedFields };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Find a gallery block (type 8) in sections and return its collection ID.
   */
  findGalleryBlock(
    sections: PageSection[],
    searchText?: string,
  ): { gridContent: GridContent; sectionIndex: number; blockIndex: number; galleryCollectionId: string } | null {
    for (let si = 0; si < sections.length; si++) {
      const section = sections[si];
      const gridContents = section.fluidEngineContext?.gridContents;
      if (!gridContents) continue;

      for (let bi = 0; bi < gridContents.length; bi++) {
        const gc = gridContents[bi];
        const bv = gc.content?.value;
        if (!bv || bv.type !== BLOCK_TYPE_GALLERY) continue;

        const val = bv.value ?? {};
        const galleryCollectionId = (val.collectionId ?? val.transientGalleryId ?? '') as string;

        if (!searchText) {
          return { gridContent: gc, sectionIndex: si, blockIndex: bi, galleryCollectionId };
        }

        const needle = searchText.toLowerCase();
        if (
          galleryCollectionId === searchText ||
          bv.id.toLowerCase().startsWith(needle)
        ) {
          return { gridContent: gc, sectionIndex: si, blockIndex: bi, galleryCollectionId };
        }
      }
    }
    return null;
  }

  // ── Blank Section (API) ────────────────────────────────────────────────────

  /**
   * Add a blank Fluid Engine section via API.
   *
   * Discovered from captured traffic:
   *   1. GET /api/catalog-preview/blankFluidEngineSection — get blank section template
   *   2. POST /api/content/add/fluidEngineSection?sectionId=... — add to page
   *
   * This replaces the UI automation path for adding blank sections.
   */
  async addBlankSection(
    pageSectionsId: string,
    collectionId: string,
  ): Promise<AddBlankSectionResult> {
    try {
      this.ensureCookies();

      // GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Construct a minimal blank Fluid Engine section locally.
      // The catalog-preview endpoint returns HTML (not JSON), so we build
      // the section structure ourselves and append it via the proven PUT path.
      const newSectionId = ContentSaveClient.generateBlockId();
      const blankSection: PageSection = {
        id: newSectionId,
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: {
          id: ContentSaveClient.generateBlockId(),
          gridContents: [],
          gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
        },
      };

      const updatedSections = [...data.sections, blankSection];

      logger.info({ pageSectionsId, newSectionId, totalSections: updatedSections.length }, 'Adding blank section via PUT');

      const saveResult = await this.savePageSections(pageSectionsId, collectionId, updatedSections);

      if (!saveResult.success) {
        return { success: false, error: saveResult.error ?? 'savePageSections failed' };
      }

      logger.info({ newSectionId }, 'Blank section added via API');
      return { success: true, sectionId: newSectionId };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Template Section Copy (API) ────────────────────────────────────────────

  /**
   * Copy a template section from Squarespace's section catalog into the current site.
   *
   * Discovered from captured traffic:
   *   POST /api/content/copy/section?sourceWebsiteId=...&sourceCollectionId=...&sourceSectionId=...
   *
   * Template source IDs come from GET /api/section-catalog/sections?engine=FLUID.
   * This replaces the UI template picker entirely.
   */
  async copyTemplateSection(
    sourceWebsiteId: string,
    sourceCollectionId: string,
    sourceSectionId: string,
  ): Promise<CopyTemplateSectionResult> {
    try {
      this.ensureCookies();

      const path = `/api/content/copy/section?sourceWebsiteId=${encodeURIComponent(sourceWebsiteId)}&sourceCollectionId=${encodeURIComponent(sourceCollectionId)}&sourceSectionId=${encodeURIComponent(sourceSectionId)}`;
      const url = this.buildApiUrl(path, true);

      logger.info(
        { sourceWebsiteId, sourceCollectionId, sourceSectionId },
        'Copying template section via API',
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([]),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { success: false, error: `Failed to copy template section: ${response.status}. ${body}` };
      }

      const data = await response.json().catch(() => ({})) as Record<string, unknown>;

      // Handle crumb refresh if needed
      if (data.crumbFail) {
        return { success: false, error: `Crumb validation failed. ${data.error || ''}` };
      }

      const sectionId = data.id as string | undefined;

      logger.info({ sectionId }, 'Template section copied via API');
      return { success: true, sectionId, sectionData: data };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Get the section catalog — all available template sections.
   *
   * Endpoint: GET /api/section-catalog/sections?engine=FLUID
   *
   * Returns the template entries with sourceWebsiteId, sourceCollectionId,
   * sourceSectionId that can be used with copyTemplateSection().
   */
  async getSectionCatalog(): Promise<SectionCatalogResponse> {
    try {
      this.ensureCookies();

      const url = this.buildApiUrl('/api/section-catalog/sections?engine=FLUID');
      logger.info('Fetching section catalog');

      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status === 401) {
        return { success: false, error: 'Session expired — re-authenticate via browser to refresh cookies' };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { success: false, error: `Failed to fetch section catalog: ${response.status}. ${body}` };
      }

      const data = await response.json() as Record<string, unknown>;

      // Check for crumb failure
      if (data.crumbFail || (typeof data.error === 'string' && String(data.error).includes('Invalid session crumb'))) {
        const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
        return { success: false, error: `getSectionCatalog rejected: invalid or expired session crumb.${ageInfo}` };
      }

      // Response is an object keyed by category: { "CONTACT": [...], "MENUS": [...], ... }
      // Each value is an array of SectionCatalogEntry objects
      const catalog: Record<string, SectionCatalogEntry[]> = {};
      const allSections: SectionCatalogEntry[] = [];
      const categories: string[] = [];

      for (const [category, entries] of Object.entries(data)) {
        if (Array.isArray(entries)) {
          categories.push(category);
          const typed = entries as SectionCatalogEntry[];
          catalog[category] = typed;
          allSections.push(...typed);
        }
      }

      logger.info(
        { categories: categories.length, totalSections: allSections.length },
        'Section catalog fetched',
      );
      return { success: true, catalog, sections: allSections, categories };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  // ── Section Verification ────────────────────────────────────────────────────

  /**
   * Verify that a section was successfully added by re-fetching page sections
   * and comparing the section count.
   *
   * @param pageSectionsId  The page sections ID
   * @param expectedCount   The expected section count after addition
   * @returns The actual section count and whether it matches
   */
  async verifySectionAdded(
    pageSectionsId: string,
    expectedCount: number,
  ): Promise<{ verified: boolean; actualCount: number; sections: PageSection[] }> {
    try {
      const data = await this.getPageSections(pageSectionsId);
      const actualCount = data.sections?.length ?? 0;
      const verified = actualCount >= expectedCount;
      if (!verified) {
        logger.warn(
          { pageSectionsId, expectedCount, actualCount },
          'verifySectionAdded: section count mismatch — section may not have persisted',
        );
      }
      return { verified, actualCount, sections: data.sections ?? [] };
    } catch (err) {
      logger.warn({ pageSectionsId, error: errMsg(err) }, 'verifySectionAdded: failed to re-fetch sections');
      return { verified: false, actualCount: -1, sections: [] };
    }
  }

  // ── Gallery Image Management ───────────────────────────────────────────────

  /**
   * Get items in a gallery collection.
   *
   * Endpoint: GET /api/content-collections/{collectionId}/content-items?crumb=...&limit=250
   */
  async getGalleryItems(
    galleryCollectionId: string,
  ): Promise<{ success: boolean; items?: GalleryItem[]; hasMore?: boolean; error?: string }> {
    try {
      this.ensureCookies();

      const path = `/api/content-collections/${encodeURIComponent(galleryCollectionId)}/content-items?limit=250`;
      const url = this.buildApiUrl(path, true);

      logger.info({ galleryCollectionId }, 'Fetching gallery items');

      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { success: false, error: `Failed to fetch gallery items: ${response.status}. ${body}` };
      }

      const data = await response.json() as Record<string, unknown>;

      // Response shape: { results: [...], hasPreviousPage: bool, hasNextPage: bool }
      const items = Array.isArray(data)
        ? data
        : Array.isArray(data.results)
          ? data.results
          : [];

      const hasMore = data.hasNextPage === true;

      logger.info(
        { galleryCollectionId, count: items.length, hasMore },
        'Gallery items fetched',
      );
      return { success: true, items: items as GalleryItem[], hasMore };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Get the number of items in a gallery collection.
   *
   * Endpoint: GET /api/content-collections/{collectionId}/item-count?crumb=...
   */
  async getGalleryItemCount(
    galleryCollectionId: string,
  ): Promise<{ success: boolean; count?: number; error?: string }> {
    try {
      this.ensureCookies();

      const path = `/api/content-collections/${encodeURIComponent(galleryCollectionId)}/item-count`;
      const url = this.buildApiUrl(path, true);

      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { success: false, error: `Failed to fetch gallery item count: ${response.status}. ${body}` };
      }

      const data = await response.json();
      const count = typeof data === 'number' ? data : (data as Record<string, unknown>).count as number;

      return { success: true, count };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Add an image to a gallery collection.
   *
   * Discovered from captured traffic:
   *   POST /api/galleries/{collectionId}/images?crumb=...
   *
   * The image must already be uploaded (via media upload API).
   * Pass the asset ID from a completed upload job.
   *
   * @param galleryCollectionId  The gallery collection ID (from gallery block's collectionId)
   * @param assetId              The uploaded image asset ID (from media upload job)
   * @param metadata             Optional title/description for the gallery image
   */
  async addGalleryImage(
    galleryCollectionId: string,
    assetId: string,
    metadata?: { title?: string; description?: string },
  ): Promise<AddGalleryImageResult> {
    try {
      this.ensureCookies();

      const path = `/api/galleries/${encodeURIComponent(galleryCollectionId)}/images`;
      const url = this.buildApiUrl(path, true);

      const body: Record<string, unknown> = { assetId };
      if (metadata?.title) body.title = metadata.title;
      if (metadata?.description) body.description = metadata.description;

      logger.info(
        { galleryCollectionId, assetId, hasTitle: !!metadata?.title },
        'Adding image to gallery',
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const respBody = await response.text().catch(() => '');
        return { success: false, error: `Failed to add gallery image: ${response.status}. ${respBody}` };
      }

      const data = await response.json().catch(() => ({}));
      const itemId = (data as Record<string, unknown>).id as string | undefined;

      logger.info({ galleryCollectionId, itemId }, 'Gallery image added');
      return { success: true, itemId };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Upload an image to a gallery using the /api/uploads/images endpoint.
   *
   * Discovered from captured traffic:
   *   POST /api/uploads/images → returns job ID
   *   GET /api/rest/jobs/?id=... → poll until done
   *   Then add to gallery via addGalleryImage()
   *
   * @param imageUrl  URL of the image to upload (can be a CDN URL or data URL)
   */
  async uploadImageToSite(
    imageUrl: string,
  ): Promise<{ success: boolean; assetId?: string; contentItemId?: string; error?: string }> {
    try {
      this.ensureCookies();

      const url = this.buildApiUrl('/api/uploads/images', true);

      logger.info({ imageUrl: imageUrl.substring(0, 100) }, 'Uploading image to site');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: imageUrl }),
        signal: AbortSignal.timeout(30_000), // Longer timeout for uploads
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { success: false, error: `Image upload failed: ${response.status}. ${body}` };
      }

      const data = await response.json() as Record<string, unknown>;

      // Poll the job if we got a job ID
      const jobId = data.id as string | undefined;
      if (jobId) {
        const jobResult = await this.pollJob(jobId);
        if (!jobResult.success) {
          return { success: false, error: jobResult.error };
        }
        return {
          success: true,
          assetId: jobResult.assetId,
          contentItemId: jobResult.contentItemId,
        };
      }

      return {
        success: true,
        assetId: data.assetId as string | undefined,
        contentItemId: data.contentItemId as string | undefined,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Poll a Squarespace job until it completes.
   * Used for image uploads and other async operations.
   */
  private async pollJob(
    jobId: string,
    maxAttempts = 15,
    intervalMs = 2000,
  ): Promise<{ success: boolean; assetId?: string; contentItemId?: string; error?: string }> {
    const url = this.buildApiUrl(`/api/rest/jobs/?id=${encodeURIComponent(jobId)}`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));

      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) continue;

      const data = await response.json() as Record<string, unknown>;
      const status = data.status as string | undefined;

      if (status === 'COMPLETED' || status === 'completed') {
        return {
          success: true,
          assetId: data.assetId as string | undefined,
          contentItemId: data.contentItemId as string | undefined,
        };
      }

      if (status === 'FAILED' || status === 'failed') {
        return { success: false, error: `Job ${jobId} failed: ${JSON.stringify(data)}` };
      }

      logger.debug({ jobId, attempt, status }, 'Polling job...');
    }

    return { success: false, error: `Job ${jobId} timed out after ${maxAttempts} attempts` };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a ready-to-use ContentSaveClient for a given site.
 *
 * @param siteSubdomain e.g. "grey-yellow-hbxc"
 * @param sessionPath Optional custom path to the session JSON file.
 */
export function createContentSaveClient(
  siteSubdomain: string,
  sessionPath?: string,
): ContentSaveClient {
  const client = new ContentSaveClient(siteSubdomain);
  client.loadSessionCookies(sessionPath);
  return client;
}
