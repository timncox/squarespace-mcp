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

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

// ── Re-export all types from types.ts for backward compatibility ─
export type {
  RichHtmlElement,
  GridCoord,
  BreakpointLayout,
  BlockLayout,
  BlockMoveResult,
  BlockResizeResult,
  BlockRemoveResult,
  BlockRemoveOptions,
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
  AddSectionWithBlocksResult,
  InitialBlock,
  CopyTemplateSectionResult,
  AddGalleryImageResult,
  GalleryItem,
  RemoveGalleryImageResult,
  ReorderGalleryImagesResult,
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
  FormListResult,
  FormCreateResult,
  FormGetResult,
  FormUpdateResult,
  SiteIdentityData,
  SiteIdentityUpdateOptions,
  SiteIdentityResult,
  SocialLinksBlockAddResult,
  SocialLinksBlockUpdateResult,
  MapBlockAddResult,
  MapBlockUpdateResult,
  EmbedBlockAddResult,
  EmbedBlockUpdateResult,
  MenuBlockAddResult,
  MobileVisibilityResult,
  MobileLayoutSetResult,
  MobileMoveResult,
  MobileResizeResult,
  NavigationItem,
  NavigationData,
  NavigationResult,
  SiteSettings,
  SettingsResult,
  CodeInjectionData,
  UpdateNavigationRequest,
  UpdateNavigationItem,
  UpdateNavigationResult,
  WebsiteFontsData,
  WebsiteFontsResult,
  WebsiteColorsData,
  WebsiteColorsResult,
  AdvancedSettingsResult,
  UnitValue,
  FontValue,
  HSLValues,
  PaletteColorValue,
  PaletteColor,
  ColorThemeMapping,
  WebsiteFontsUpdateResult,
  WebsiteColorsUpdateResult,
  FontUpdateResult,
  PaletteColorUpdateResult,
  AdvancedSettingsSaveResult,
  TemplateTweakSettings,
  TemplateTweakSettingsResult,
  TemplateTweakSettingsUpdateResult,
  SocialAccount,
} from './types.js';

import type {
  RichHtmlElement,
  GridCoord,
  BreakpointLayout,
  BlockLayout,
  BlockMoveResult,
  BlockResizeResult,
  BlockRemoveResult,
  BlockRemoveOptions,
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
  AddSectionWithBlocksResult,
  InitialBlock,
  CopyTemplateSectionResult,
  AddGalleryImageResult,
  GalleryItem,
  RemoveGalleryImageResult,
  ReorderGalleryImagesResult,
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
  FormListResult,
  FormCreateResult,
  FormGetResult,
  FormUpdateResult,
  SiteIdentityData,
  SiteIdentityUpdateOptions,
  SiteIdentityResult,
  SocialLinksBlockAddResult,
  SocialLinksBlockUpdateResult,
  MapBlockAddResult,
  MapBlockUpdateResult,
  EmbedBlockAddResult,
  EmbedBlockUpdateResult,
  MenuBlockAddResult,
  MobileVisibilityResult,
  MobileLayoutSetResult,
  MobileMoveResult,
  MobileResizeResult,
  NavigationItem,
  NavigationData,
  NavigationResult,
  SiteSettings,
  SettingsResult,
  CodeInjectionData,
  UpdateNavigationRequest,
  UpdateNavigationItem,
  UpdateNavigationResult,
  WebsiteFontsData,
  WebsiteFontsResult,
  WebsiteColorsData,
  WebsiteColorsResult,
  AdvancedSettingsResult,
  UnitValue,
  FontValue,
  HSLValues,
  PaletteColorValue,
  PaletteColor,
  ColorThemeMapping,
  WebsiteFontsUpdateResult,
  WebsiteColorsUpdateResult,
  FontUpdateResult,
  PaletteColorUpdateResult,
  AdvancedSettingsSaveResult,
  TemplateTweakSettings,
  TemplateTweakSettingsResult,
  TemplateTweakSettingsUpdateResult,
  SocialAccount,
} from './types.js';

// ── Config ──────────────────────────────────────────────────────────────────

export const SESSION_PATH = process.env.SESSION_DIR
  ? join(process.env.SESSION_DIR, 'sqsp-session.json')
  : join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');
export const FETCH_TIMEOUT_MS = 15_000;

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// Text/HTML block type in Squarespace Fluid Engine
export const BLOCK_TYPE_TEXT = 2;
// Image block type
export const BLOCK_TYPE_IMAGE = 1337;
// Button block type
export const BLOCK_TYPE_BUTTON = 46;
// Menu block type
export const BLOCK_TYPE_MENU = 18;
// Gallery block type
export const BLOCK_TYPE_GALLERY = 8;
// Quote block type — confirmed via live site discovery (Feb 28 2026, test-page grey-yellow-hbxc)
export const BLOCK_TYPE_QUOTE = 31;
// Code HTML block type — same as IMAGE (1337), distinguished by value.wysiwyg.engine === 'code'
export const BLOCK_TYPE_CODE = 1337;
// Identifies a code HTML block within type 1337 blocks (value.wysiwyg.engine)
export const CODE_BLOCK_ENGINE = 'code';
// Line/Divider block type — confirmed via live site discovery (Feb 28 2026, home page grey-yellow-hbxc)
export const BLOCK_TYPE_DIVIDER = 47;
// Video (native) block type — confirmed via live site discovery (Feb 28 2026, home page grey-yellow-hbxc)
export const BLOCK_TYPE_VIDEO = 32;
// Newsletter/email signup block type — confirmed via live site discovery (Feb 28 2026, grey-yellow-hbxc)
export const BLOCK_TYPE_NEWSLETTER = 51;
// Accordion block type — confirmed via live site discovery (Feb 28 2026, grey-yellow-hbxc)
export const BLOCK_TYPE_ACCORDION = 69;
// Marquee (scrolling text) block type — confirmed via live site discovery (Feb 28 2026, grey-yellow-hbxc)
export const BLOCK_TYPE_MARQUEE = 70;
// Discriminator for Form blocks (type 1337 variant with buttonVariant field)
export const FORM_BLOCK_DISCRIMINATOR = 'buttonVariant';
// Social Links block type — confirmed via live site discovery (Feb 28 2026, grey-yellow-hbxc)
export const BLOCK_TYPE_SOCIAL_LINKS = 54;
// Embed block type — confirmed via live site discovery (Feb 28 2026, grey-yellow-hbxc test-page)
export const BLOCK_TYPE_EMBED = 22;

// Button block definitionName for type 1337 (new format)
export const BUTTON_DEFINITION_NAME = 'website.components.button';

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

// ── Content Save Client ─────────────────────────────────────────────────────

export class ContentSaveClient {
  siteSubdomain: string;
  siteCookieHeader: string = '';
  crumbToken: string | null = null;
  sessionAgeHours: number | null = null;
  sessionLoadedAt: Date | null = null;
  websiteIdCache: string | null = null;
  memberAccountIdCache: string | null = null;
  _preWriteCache: Map<string, PageSection[]> = new Map();
  _snapshotSiteId: string | null = null;
  _lastCrumbRefreshMs: number = 0;

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

    // Extract websiteId and member_account_id from Statsig localStorage (needed for blog post creation)
    const origins: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }> =
      session.origins ?? [];
    for (const origin of origins) {
      for (const item of origin.localStorage ?? []) {
        if (item.name.startsWith('statsig.cached.evaluations')) {
          try {
            const data = JSON.parse(item.value) as { data?: string };
            const dataStr = typeof data.data === 'string' ? data.data : JSON.stringify(data);
            if (!this.websiteIdCache) {
              const m = dataStr.match(/"website_id":"([a-f0-9]+)"/);
              if (m) this.websiteIdCache = m[1];
            }
            if (!this.memberAccountIdCache) {
              const m = dataStr.match(/"member_account_id":"([a-f0-9]+)"/);
              if (m) this.memberAccountIdCache = m[1];
            }
          } catch {
            // ignore malformed localStorage entries
          }
        }
      }
      if (this.websiteIdCache && this.memberAccountIdCache) break;
    }

    logger.info(
      {
        siteSubdomain: this.siteSubdomain,
        globalCookies: globalCookies.length,
        siteCookies: siteCookies.length,
        hasCrumb: !!this.crumbToken,
        hasWebsiteId: !!this.websiteIdCache,
        hasMemberAccountId: !!this.memberAccountIdCache,
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
   * Re-read session cookies from disk (e.g. after the browser has refreshed them).
   * Resets all cookie state and reloads from the session file.
   */
  reloadSessionCookies(sessionPath?: string): void {
    this.siteCookieHeader = '';
    this.crumbToken = null;
    this.websiteIdCache = null;
    this.memberAccountIdCache = null;
    this.loadSessionCookies(sessionPath);
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
      const baseError = `Failed to fetch page sections: ${response.status} ${response.statusText}. Body: ${body}`;
      throw new Error(this.enhanceWriteError(response.status, body, baseError));
    }

    const data = (await response.json()) as PageSectionsData;
    if (data.sections) {
      this._preWriteCache.set(pageSectionsId, structuredClone(data.sections));
    }
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
    _isRetry = false,
  ): Promise<ContentSaveResult> {
    // Auto-snapshot: save pre-edit state before writing (skip on retry)
    const cachedBefore = _isRetry ? undefined : this._preWriteCache.get(pageSectionsId);
    this._preWriteCache.delete(pageSectionsId);

    if (cachedBefore && this._snapshotSiteId) {
      try {
        const { shouldAutoSnapshot, saveSnapshot, cleanupOldSnapshots } =
          await import('../snapshot.js');
        if (shouldAutoSnapshot(this._snapshotSiteId, pageSectionsId)) {
          saveSnapshot({
            siteId: this._snapshotSiteId,
            pageSectionsId,
            collectionId,
            sections: cachedBefore,
            isAuto: true,
          });
          if (Math.random() < 0.01) cleanupOldSnapshots(7);
        }
      } catch { /* snapshot failure must never block saves */ }
    }

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
      const baseError = `Save failed: ${response.status} ${response.statusText}. Body: ${responseBody}`;
      const error = this.enhanceWriteError(response.status, responseBody, baseError);
      logger.error({ pageSectionsId, status: response.status }, error);
      return { success: false, pageSectionsId, collectionId, sectionsCount: sections.length, error };
    }

    // Check for crumb failure — auto-refresh and retry once
    if (this.isCrumbFailure(responseBody)) {
      if (!_isRetry && await this.handleCrumbFailure(responseBody)) {
        logger.info({ pageSectionsId }, 'Retrying save after crumb refresh');
        return this.savePageSections(pageSectionsId, collectionId, sections, true);
      }
      const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
      const error = `Save rejected: invalid or expired session crumb.${ageInfo} Call sq_login to check session health and re-authenticate.`;
      logger.error({ pageSectionsId }, error);
      return { success: false, pageSectionsId, collectionId, sectionsCount: sections.length, error };
    }
    return { success: true, pageSectionsId, collectionId, sectionsCount: sections.length };
  }

  // ── Infrastructure Methods ──────────────────────────────────────────────

  ensureCookies(): void {
    if (!this.siteCookieHeader) {
      throw new Error('Session cookies not loaded. Call loadSessionCookies() first.');
    }
  }

  /**
   * Update the section's breakpointSettings rows to accommodate a new block.
   * Without this, Squarespace rejects the PUT with 500 when a block's endY
   * exceeds the section's declared row count.
   */
  updateSectionRows(section: PageSection, desktopEndY: number, mobileEndY: number): void {
    const gs = section.fluidEngineContext?.gridSettings?.breakpointSettings;
    if (gs?.desktop) gs.desktop.rows = Math.max(gs.desktop.rows ?? 0, desktopEndY + 1);
    if (gs?.mobile) gs.mobile.rows = Math.max(gs.mobile.rows ?? 0, mobileEndY + 1);
  }

  /**
   * Detect if an HTTP error is likely caused by an expired/invalid session.
   * Squarespace returns 500 "Something went wrong" for many auth failures
   * instead of a proper 401.
   */
  isLikelyAuthError(status: number, body: string): boolean {
    if (status === 401 || status === 403) return true;
    if (status === 500) {
      // Squarespace's generic error pattern for auth failures
      if (body.includes('"cleaned":true') && body.includes('"Something went wrong"')) return true;
      if (body.includes('"Something went wrong."') && body.includes('"errorKey"')) return true;
    }
    return false;
  }

  /**
   * Enhance a write error message with session context when the error
   * looks auth-related. Helps Claude Desktop diagnose stale sessions
   * instead of retrying blindly.
   */
  enhanceWriteError(status: number, body: string, baseError: string): string {
    if (!this.isLikelyAuthError(status, body)) return baseError;
    const ageStr = this.sessionAgeHours !== null
      ? ` Session is ${Math.round(this.sessionAgeHours)}h old (max 24h).`
      : '';
    return `${baseError} — THIS IS LIKELY AN EXPIRED SESSION.${ageStr} Call sq_login to check session health and re-authenticate.`;
  }

  // ── Crumb (CSRF Token) Management ────────────────────────────────────────

  /** Detect if response body indicates a crumb (CSRF) validation failure */
  isCrumbFailure(body: string): boolean {
    return body.includes('"crumbFail":true') || body.includes('Invalid session crumb');
  }

  /** Extract fresh crumb from Squarespace error response (it often includes the new value) */
  extractCrumbFromBody(body: string): string | null {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.crumb === 'string' && parsed.crumb.length > 0) return parsed.crumb;
    } catch {
      const match = body.match(/"crumb"\s*:\s*"([^"]+)"/);
      if (match) return match[1];
    }
    return null;
  }

  /** Update crumb token in memory and cookie header */
  updateCrumb(newCrumb: string): void {
    this.crumbToken = newCrumb;
    if (this.siteCookieHeader.includes('crumb=')) {
      this.siteCookieHeader = this.siteCookieHeader.replace(/crumb=[^;]+/, `crumb=${newCrumb}`);
    } else {
      this.siteCookieHeader += `; crumb=${newCrumb}`;
    }
  }

  /**
   * Refresh the crumb (CSRF token) by fetching an authenticated page.
   * The fresh crumb comes from the Set-Cookie response header.
   * Rate-limited to once per 30 seconds to avoid hammering the server.
   */
  async refreshCrumb(): Promise<boolean> {
    if (Date.now() - this._lastCrumbRefreshMs < 30_000) {
      return !!this.crumbToken;
    }
    this._lastCrumbRefreshMs = Date.now();

    try {
      const url = `https://${this.siteSubdomain}.squarespace.com/config`;
      const response = await fetch(url, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });

      // Check Set-Cookie headers for fresh crumb
      const setCookies = (response.headers as any).getSetCookie?.() ?? [];
      for (const sc of setCookies) {
        const match = sc.match(/^crumb=([^;]+)/);
        if (match) {
          this.updateCrumb(decodeURIComponent(match[1]));
          this.persistCrumbToSession();
          logger.info({ siteSubdomain: this.siteSubdomain }, 'Refreshed crumb from Set-Cookie header');
          return true;
        }
      }

      // Fallback: parse crumb from page HTML/JSON config
      const html = await response.text().catch(() => '');
      const crumbMatch = html.match(/"crumb"\s*:\s*"([^"]+)"/);
      if (crumbMatch) {
        this.updateCrumb(crumbMatch[1]);
        this.persistCrumbToSession();
        logger.info({ siteSubdomain: this.siteSubdomain }, 'Refreshed crumb from page HTML');
        return true;
      }

      logger.warn({ siteSubdomain: this.siteSubdomain }, 'refreshCrumb: no crumb found in response');
      return false;
    } catch (err) {
      logger.warn({ err: errMsg(err) }, 'refreshCrumb: failed to fetch fresh crumb');
      return false;
    }
  }

  /**
   * Handle a crumb failure: extract fresh crumb from error response body,
   * or fall back to fetching a fresh crumb from the site.
   * Returns true if the crumb was successfully refreshed.
   */
  async handleCrumbFailure(responseBody: string): Promise<boolean> {
    const freshCrumb = this.extractCrumbFromBody(responseBody);
    if (freshCrumb) {
      this.updateCrumb(freshCrumb);
      this.persistCrumbToSession();
      logger.info({ siteSubdomain: this.siteSubdomain }, 'Refreshed crumb from error response');
      return true;
    }
    return this.refreshCrumb();
  }

  /**
   * Persist the current crumb to the session file on disk so other clients
   * and future sessions pick up the fresh value.
   */
  persistCrumbToSession(): void {
    try {
      if (!existsSync(SESSION_PATH) || !this.crumbToken) return;
      const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
      const cookies: Array<{ name: string; value: string; domain: string }> = session.cookies ?? [];
      let updated = false;
      for (const c of cookies) {
        if (c.name === 'crumb' && c.domain.includes(this.siteSubdomain)) {
          c.value = this.crumbToken;
          updated = true;
        }
      }
      if (updated) {
        writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), 'utf-8');
      }
    } catch {
      // Persist is best-effort — never block API operations
    }
  }

  /**
   * Fetch a page's HTML using authenticated session cookies.
   * Used by the page ID resolver when the public HTML fetch fails
   * (e.g., password-protected or hidden pages).
   */
  async fetchAuthenticatedPageHtml(slug: string): Promise<string | null> {
    this.ensureCookies();

    const normalizedSlug = this.normalizeSlug(slug);
    const pageUrl = normalizedSlug === '' || normalizedSlug === 'home'
      ? `https://${this.siteSubdomain}.squarespace.com/`
      : `https://${this.siteSubdomain}.squarespace.com/${normalizedSlug}`;

    try {
      const response = await fetch(pageUrl, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });

      if (!response.ok) return null;
      return response.text();
    } catch {
      return null;
    }
  }

  /**
   * Create a content image record for a Fluid Engine image block.
   * Returns the 24-char hex imageId needed for image blocks to render.
   *
   * Uses POST /api/uploads/images/asset-reference to create a content image
   * record that references an existing media library asset. This gives immediate
   * dimensions and processing state (no background processing delay).
   *
   * The assetId (media library UUID) is extracted from the CDN assetUrl if not
   * provided explicitly.
   */
  async createContentImage(
    assetUrl: string,
    _filenameOrUndefined?: string,
    _isRetry = false,
  ): Promise<{ success: boolean; imageId?: string; error?: string }> {
    try {
      this.ensureCookies();

      // Extract assetId (UUID) from CDN URL path:
      // https://images.squarespace-cdn.com/content/{libraryId}/{assetId}/{filename}?...
      const assetId = ContentSaveClient.extractAssetIdFromUrl(assetUrl);
      if (!assetId) {
        return { success: false, error: `Could not extract assetId from URL: ${assetUrl.substring(0, 100)}` };
      }

      // libraryId is the websiteId — try session cache first, then extract from URL
      const libraryId = this.getWebsiteId() ?? ContentSaveClient.extractLibraryIdFromUrl(assetUrl);
      if (!libraryId) {
        return { success: false, error: 'Could not determine websiteId/libraryId for asset-reference' };
      }

      const url = this.buildApiUrl('/api/uploads/images/asset-reference', true);
      const body = new URLSearchParams({ assetId, libraryId, recordType: '2' });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      const responseBody = await response.text().catch(() => '');

      if (!response.ok) {
        if (this.isCrumbFailure(responseBody) && !_isRetry && await this.handleCrumbFailure(responseBody)) {
          logger.info('createContentImage: retrying after crumb refresh');
          return this.createContentImage(assetUrl, undefined, true);
        }
        return { success: false, error: `Asset reference failed: ${response.status}. ${responseBody.substring(0, 200)}` };
      }

      if (this.isCrumbFailure(responseBody)) {
        if (!_isRetry && await this.handleCrumbFailure(responseBody)) {
          logger.info('createContentImage: retrying after crumb refresh (200 with crumb error)');
          return this.createContentImage(assetUrl, undefined, true);
        }
        return { success: false, error: 'Crumb validation failed for asset-reference' };
      }

      const data = JSON.parse(responseBody) as { media?: Array<{ id?: string }> };
      const imageId = data.media?.[0]?.id;
      if (!imageId) {
        return { success: false, error: `Asset reference succeeded but no imageId in response: ${responseBody.substring(0, 200)}` };
      }

      logger.info({ imageId, assetId }, 'Created content image via asset-reference');
      return { success: true, imageId };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Extract the media library asset UUID from a Squarespace CDN URL.
   * URL format: https://images.squarespace-cdn.com/content/{libraryId}/{assetId}/{filename}?...
   */
  static extractAssetIdFromUrl(assetUrl: string): string | null {
    try {
      const url = new URL(assetUrl);
      const parts = url.pathname.split('/');
      // pathname: /content/{libraryId}/{assetId}/{filename}
      // parts[0] = "", parts[1] = "content", parts[2] = libraryId, parts[3] = assetId
      const candidate = parts[3];
      if (candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate)) {
        return candidate;
      }
    } catch { /* not a valid URL */ }
    return null;
  }

  /**
   * Extract the libraryId (websiteId) from a Squarespace CDN URL.
   * URL format: https://images.squarespace-cdn.com/content/{libraryId}/{assetId}/{filename}?...
   */
  static extractLibraryIdFromUrl(assetUrl: string): string | null {
    try {
      const url = new URL(assetUrl);
      const parts = url.pathname.split('/');
      // parts[2] = libraryId (24-char hex)
      const candidate = parts[2];
      if (candidate && /^[a-f0-9]{24}$/.test(candidate)) {
        return candidate;
      }
    } catch { /* not a valid URL */ }
    return null;
  }

  /** Get the websiteId from session cache or return null */
  getWebsiteId(): string | null {
    return this.websiteIdCache;
  }

  buildPutUrl(pageSectionsId: string, collectionId: string): string {
    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    let url = `${siteUrl}/api/page-sections/${pageSectionsId}/collection/${collectionId}`;
    if (this.crumbToken) {
      url += `?crumb=${encodeURIComponent(this.crumbToken)}`;
    }
    return url;
  }

  buildHeaders(): Record<string, string> {
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
  findTextBlock(
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

  /**
   * Search all sections for ANY block type matching the given searchText (case-insensitive).
   * Searches text blocks, buttons, code blocks, form blocks, image blocks,
   * quote blocks, video blocks, newsletter blocks, accordion blocks, marquee blocks,
   * menu blocks, and falls back to block ID prefix match.
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

        // Type 1337 buttons: check definitionName before falling into image/code/form checks
        if (bv.type === BLOCK_TYPE_IMAGE && bv.definitionName === BUTTON_DEFINITION_NAME) {
          const btnText = bv.value?.buttonText ?? '';
          const btnLink = bv.value?.buttonLink ?? '';
          if ((btnText && String(btnText).toLowerCase().includes(needle)) ||
              (btnLink && String(btnLink).toLowerCase().includes(needle))) {
            return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
          }
        }

        // Type 1337: Code HTML blocks, Form blocks, or Image blocks (same outer type, different value structure)
        if (bv.type === BLOCK_TYPE_IMAGE && bv.definitionName !== BUTTON_DEFINITION_NAME) {
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
          const descHtml = (bv.value?.description as any)?.html ?? '';
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

  stripHtml(html: string): string {
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

  normalizeSlug(slug: string): string {
    const lower = slug.toLowerCase().trim();
    const HOME_SLUGS = ['homepage', 'home-page', 'home', 'landing', 'index', 'main', ''];
    if (HOME_SLUGS.includes(lower)) return '';
    return slug.replace(/^\/+/, '');
  }

  /** Build a site-relative API URL with optional crumb token */
  buildApiUrl(path: string, includeCrumb = false): string {
    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    let url = `${siteUrl}${path}`;
    if (includeCrumb && this.crumbToken) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}crumb=${encodeURIComponent(this.crumbToken)}`;
    }
    return url;
  }

  getSessionAge(): { ageHours: number; isStale: boolean; lastRefreshed: Date } | null {
    if (this.sessionAgeHours === null || !this.sessionLoadedAt) return null;
    return {
      ageHours: this.sessionAgeHours,
      isStale: this.sessionAgeHours > 24,
      lastRefreshed: this.sessionLoadedAt,
    };
  }

  // ── Static Methods ──────────────────────────────────────────────────────

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

  /**
   * Generate a random block ID matching Squarespace's format (20 hex chars).
   * Examples from real data: "a7a6278d708bd0f7265c", "b3f4e89a2c1d5067e8f9"
   */
  static generateBlockId(): string {
    return randomBytes(10).toString('hex');
  }

  /** Generate a 24-char hex ID for sections (Squarespace validates 12-byte ObjectID format). */
  static generateSectionId(): string {
    return randomBytes(12).toString('hex');
  }

  /**
   * Check if a block value represents a button block (either type 46 or type 1337 with button definitionName).
   */
  static isButtonBlock(blockValue: { type: number; definitionName?: string }): boolean {
    if (blockValue.type === BLOCK_TYPE_BUTTON) return true;
    if (blockValue.type === BLOCK_TYPE_IMAGE && blockValue.definitionName === BUTTON_DEFINITION_NAME) return true;
    return false;
  }

  /**
   * Get normalized button fields from either type 46 or type 1337 button blocks.
   * Returns null if block is not a button.
   */
  static getButtonFields(
    blockValue: { type: number; definitionName?: string; value?: Record<string, unknown> },
  ): { text: string; url: string; size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean } | null {
    if (!ContentSaveClient.isButtonBlock(blockValue)) return null;
    const v = blockValue.value ?? {};

    if (blockValue.type === BLOCK_TYPE_BUTTON) {
      return { text: v.label as string ?? '', url: v.url as string ?? '' };
    }

    // Type 1337 new button
    const result: { text: string; url: string; size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean } = {
      text: v.buttonText as string ?? '',
      url: v.buttonLink as string ?? '',
    };
    if (v.buttonSize) result.size = v.buttonSize as string;
    if (v.buttonStyle) result.style = v.buttonStyle as string;
    if (v.buttonAlignment) result.alignment = v.buttonAlignment as string;
    if (v.buttonVariant) result.variant = v.buttonVariant as string;
    if (v.newWindow !== undefined) result.newWindow = v.newWindow as boolean;
    return result;
  }

  /**
   * Set button fields on either type 46 or type 1337 button blocks.
   * Only updates fields that are explicitly provided (not undefined).
   */
  static setButtonFields(
    blockValue: { type: number; definitionName?: string; value?: Record<string, unknown> },
    updates: { text?: string; url?: string; size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean },
  ): void {
    if (!blockValue.value) blockValue.value = {};
    const v = blockValue.value;

    if (blockValue.type === BLOCK_TYPE_BUTTON) {
      // Type 46 legacy
      if (updates.text !== undefined) v.label = updates.text;
      if (updates.url !== undefined) v.url = updates.url;
      return;
    }

    // Type 1337 new button
    if (updates.text !== undefined) v.buttonText = updates.text;
    if (updates.url !== undefined) v.buttonLink = updates.url;
    if (updates.size !== undefined) v.buttonSize = updates.size;
    if (updates.style !== undefined) v.buttonStyle = updates.style;
    if (updates.alignment !== undefined) v.buttonAlignment = updates.alignment;
    if (updates.variant !== undefined) v.buttonVariant = updates.variant;
    if (updates.newWindow !== undefined) v.newWindow = updates.newWindow;
  }

  /**
   * Build rich HTML from structured content elements.
   * Produces Squarespace-compatible HTML for text block source/html fields.
   *
   * Always includes `style="white-space:pre-wrap;"` (Squarespace requirement).
   * Consecutive `li` elements are automatically wrapped in `<ul>` containers.
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
  static buildSingleElement(
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
  static escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Block Content Builders (static) ──────────────────────────────────
  // Reusable functions to build GridContent.content for each block type.
  // Used by addSectionWithBlocks() and could replace inline construction
  // in existing addXxxBlock methods in the future.

  static buildTextBlockContent(
    blockId: string,
    html: string,
    formatting?: { tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'p'; alignment?: 'left' | 'center' | 'right'; bold?: boolean; italic?: boolean },
  ): GridContent['content'] {
    // Reuse formatHtml logic — if formatting provided and html has no tags, wrap it
    let formattedHtml = html;
    if (formatting && !html.startsWith('<')) {
      const tag = formatting.tag ?? 'p';
      const styles = ['white-space:pre-wrap'];
      if (formatting.alignment) styles.push(`text-align:${formatting.alignment}`);
      let inner = html;
      if (formatting.italic) inner = `<em>${inner}</em>`;
      if (formatting.bold) inner = `<strong>${inner}</strong>`;
      formattedHtml = `<${tag} style="${styles.join(';')}">${inner}</${tag}>`;
    }
    return {
      value: {
        id: blockId,
        type: 2, // BLOCK_TYPE_TEXT
        value: { engine: 'wysiwyg', source: formattedHtml, html: formattedHtml, textAttributes: [] },
      },
    };
  }

  static buildEmbedBlockContent(blockId: string, html: string): GridContent['content'] {
    return {
      value: {
        id: blockId,
        type: 22, // BLOCK_TYPE_EMBED
        value: html ? { html } : {},
        containerStyles: { backgroundEnabled: false, stretchedToFill: false },
      },
    };
  }

  static buildButtonBlockContent(blockId: string, text: string, url: string): GridContent['content'] {
    return {
      value: {
        id: blockId,
        type: 1337, // BLOCK_TYPE_IMAGE (buttons share this type)
        value: {
          buttonText: text,
          buttonLink: url,
          newWindow: false,
          buttonAlignment: 'center',
          buttonSize: 'medium',
          containerStyles: { stretchedToFill: true },
          transforms: {
            rotation: { value: 0, unit: 'deg' },
            scale: { x: { value: 100, unit: '%' }, y: { value: 100, unit: '%' } },
            opacity: { value: 100, unit: '%' },
            offset: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } },
            origin: { x: { value: 50, unit: '%' }, y: { value: 50, unit: '%' } },
            skew: { x: { value: 0, unit: 'deg' }, y: { value: 0, unit: 'deg' } },
          },
          animations: [],
          breakpointOverrides: {},
        },
        containerStyles: { backgroundEnabled: false, stretchedToFill: false },
        definitionName: 'website.components.button',
      },
    };
  }

  static buildImageBlockContent(blockId: string, assetUrl: string, altText?: string, imageId?: string): GridContent['content'] {
    const blockContent: Record<string, unknown> = {
      id: blockId,
      type: 1337, // BLOCK_TYPE_IMAGE
      value: {
        assetUrl,
        ...(imageId ? { imageId } : {}),
        layout: 'caption-below',
        linkTo: '',
        imageLink: 'image',
        buttonText: '',
        lightbox: false,
        lightboxTheme: 'dark',
        stretch: false,
        description: { source: '', engine: 'wysiwyg', html: '' },
        title: { source: '', engine: 'wysiwyg', html: '' },
        subtitle: { source: '', engine: 'wysiwyg', html: '' },
        designLayout: 'fluid',
        imagePosition: 'center',
        combinationAnimation: 'site-default',
        individualImageAnimation: 'site-default',
        individualTextAnimation: 'site-default',
        imageCropType: 'css_styles',
        borderRadii: {
          topLeft: { unit: 'px', value: 0 },
          topRight: { unit: 'px', value: 0 },
          bottomLeft: { unit: 'px', value: 0 },
          bottomRight: { unit: 'px', value: 0 },
        },
        imageOverlay: { enabled: false, color: { type: 'THEME_COLOR' }, blendMode: 'normal' },
        imageEffect: { type: 'none' },
        containerStyles: { backgroundEnabled: false, stretchedToFill: true },
      },
      definitionName: 'website.components.imageFluid',
    };
    if (altText !== undefined) blockContent.altText = altText;
    return { value: blockContent as GridContent['content']['value'] };
  }

  static buildVideoBlockContent(blockId: string, videoUrl: string, title?: string, description?: string): GridContent['content'] {
    return {
      value: {
        id: blockId,
        type: 32, // BLOCK_TYPE_VIDEO
        value: { url: videoUrl, title, description },
      },
    };
  }

  static buildMapBlockContent(
    blockId: string,
    lat: number,
    lng: number,
    options?: {
      zoom?: number;
      vSize?: number;
      style?: number;
      labels?: boolean;
      terrain?: boolean;
      controls?: boolean;
    },
  ): GridContent['content'] {
    return {
      value: {
        id: blockId,
        type: 1337,
        value: {
          location: {
            mapLat: lat,
            mapLng: lng,
            mapZoom: options?.zoom ?? 14,
          },
          vSize: options?.vSize ?? 12,
          style: options?.style ?? 2,
          labels: options?.labels ?? true,
          terrain: options?.terrain ?? false,
          controls: options?.controls ?? false,
        },
      },
    };
  }

  static readonly TYPE_NAMES: Record<number, string> = {
    1: 'page',
    2: 'blog',
    5: 'store',
    7: 'gallery',
    11: 'folder',
    12: 'index',
  };
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
