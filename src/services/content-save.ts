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

// ── Config ──────────────────────────────────────────────────────────────────

const SESSION_PATH = join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');
const FETCH_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// Text/HTML block type in Squarespace Fluid Engine
const BLOCK_TYPE_TEXT = 2;
// Image block type
const BLOCK_TYPE_IMAGE = 1337;

// ── Types ───────────────────────────────────────────────────────────────────

/** Grid coordinate (column/row position) */
export interface GridCoord { x: number; y: number }

/** Layout for a single breakpoint (mobile or desktop) */
export interface BreakpointLayout {
  start: GridCoord; end: GridCoord;
  verticalAlignment?: string; visible?: boolean; zIndex?: number;
  stickyScroll?: { enabled: boolean; position?: string; offset?: { unit: string; value: number } };
}

/** Full block layout across breakpoints */
export interface BlockLayout { mobile: BreakpointLayout; desktop: BreakpointLayout }

/** Result of a block move operation */
export interface BlockMoveResult {
  success: boolean; blockId?: string; direction?: string;
  oldPosition?: { desktop: { start: GridCoord; end: GridCoord } };
  newPosition?: { desktop: { start: GridCoord; end: GridCoord } };
  clamped?: boolean; error?: string;
}

/** Result of a block resize operation */
export interface BlockResizeResult {
  success: boolean; blockId?: string;
  oldSize?: { width: number; height: number; desktop: { start: GridCoord; end: GridCoord } };
  newSize?: { width: number; height: number; desktop: { start: GridCoord; end: GridCoord } };
  clamped?: boolean; error?: string;
}

/** Result of a block remove operation */
export interface BlockRemoveResult {
  success: boolean;
  blockId?: string;
  blockType?: number;
  sectionId?: string;
  error?: string;
}

/** Result of a section move operation */
export interface SectionMoveResult {
  success: boolean;
  sectionId?: string;
  sectionName?: string;
  oldIndex?: number;
  newIndex?: number;
  error?: string;
}

/** Result of an image block update operation */
export interface ImageBlockUpdateResult {
  success: boolean;
  blockId?: string;
  updatedFields?: string[];
  error?: string;
}

/** Result of adding a text block to a section */
export interface TextBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of filling a placeholder text block in a section */
export interface FillBlockResult {
  success: boolean;
  blockId?: string;
  error?: string;
}

/**
 * A Fluid Engine grid content item (block within a section).
 *
 * Real structure from GET /api/page-sections:
 * ```json
 * {
 *   "layout": { "mobile": {...}, "desktop": {...} },
 *   "content": {
 *     "value": {
 *       "id": "a7a6278d708bd0f7265c",
 *       "type": 2,
 *       "value": {
 *         "engine": "wysiwyg",
 *         "source": "<p>text</p>",
 *         "html": "<p>text</p>",
 *         "textAttributes": []
 *       },
 *       "containerStyles": {...}
 *     }
 *   }
 * }
 * ```
 */
export interface GridContent {
  layout?: BlockLayout;
  content: {
    value: {
      id: string;
      type: number; // 2 = text/html, 1337 = image, etc.
      value?: {
        engine?: string;
        source?: string;
        html?: string;
        textAttributes?: unknown[];
        text?: string;
        label?: string;
        title?: string;
        description?: string;
        subtitle?: string;
        [key: string]: unknown;
      };
      containerStyles?: unknown;
      [key: string]: unknown;
    };
  };
  [key: string]: unknown;
}

/** Grid settings within a section's fluidEngineContext */
export interface GridSettings {
  breakpointSettings?: {
    desktop?: { columns?: number };
    mobile?: { columns?: number };
  };
}

/** A section in the page-sections data */
export interface PageSection {
  id: string;
  sectionName: string;
  fluidEngineContext?: {
    gridContents: GridContent[];
    gridSettings?: GridSettings;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** The full page-sections payload (sent and received on PUT) */
export interface PageSectionsData {
  id?: string;
  websiteId?: string;
  collectionId?: string;
  sections: PageSection[];
  updatedOn?: number;
  [key: string]: unknown;
}

/** Result of a content save operation */
export interface ContentSaveResult {
  success: boolean;
  pageSectionsId: string;
  collectionId: string;
  sectionsCount: number;
  error?: string;
}

/** Result of a text block update */
export interface TextUpdateResult {
  success: boolean;
  blockId?: string;
  oldText?: string;
  newHtml?: string;
  error?: string;
}

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

        // Image blocks (type 1337): match title/description/subtitle
        if (bv.type === BLOCK_TYPE_IMAGE) {
          const fields = [bv.value?.title, bv.value?.description, bv.value?.subtitle].filter(Boolean);
          for (const field of fields) {
            if (this.stripHtml(String(field)).toLowerCase().includes(needle)) {
              return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
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
    layout?: { columns?: number },
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

      // Step 3: Calculate position (below existing blocks)
      let maxY = 0;
      let maxMobileY = 0;
      for (const gc of gridContents) {
        const endY = gc.layout?.desktop?.end?.y ?? 0;
        const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
        if (endY > maxY) maxY = endY;
        if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
      }

      // Default layout: full width, 3 rows tall, below existing content
      const cols = layout?.columns ?? maxColumns;
      const startX = 1;
      const endX = Math.min(startX + cols, maxColumns + 1);
      const startY = maxY;
      const endY = startY + 3; // default 3 rows

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
          mobile: { start: { x: 1, y: maxMobileY }, end: { x: 9, y: maxMobileY + 3 }, visible: true, verticalAlignment: 'top', zIndex },
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
