/**
 * Squarespace Media Upload Service
 *
 * Uploads images directly via media-api.squarespace.com, bypassing Playwright
 * UI automation entirely. This is far more reliable than the setInputFiles()
 * approach used by the browser agent's replaceImage/addImageBlock actions.
 *
 * Auth: Uses Squarespace editor session cookies (extracted from saved session).
 * Flow: authorize → upload (multipart) → poll status → get asset URL
 *
 * Discovered Feb 2026 via network interception with service workers blocked.
 */

import { readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { basename, extname, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

// ── Path normalization ───────────────────────────────────────────────────────

/**
 * Regex matching all Unicode whitespace characters that are NOT a regular
 * ASCII space (U+0020). macOS Screenshot filenames and copy-pasted paths
 * frequently contain U+00A0 (non-breaking space) instead of regular spaces.
 */
const UNICODE_WHITESPACE_RE =
  /[\u00a0\u1680\u2000-\u200a\u2007\u202f\u205f\u3000\ufeff]/g;

/**
 * Resolve a local file path, handling macOS Unicode whitespace quirks.
 *
 * Strategy:
 * 1. Try the path exactly as given.
 * 2. NFC-normalize + replace all Unicode whitespace → regular space.
 * 3. The reverse: replace regular spaces → U+00A0 (macOS screenshot default).
 *
 * Returns the first variant that exists on disk, or the NFC-normalized path
 * (so the caller gets a clear ENOENT with a clean path).
 */
export function resolveFilePath(filePath: string): string {
  // 1. Try as-is
  if (existsSync(filePath)) return filePath;

  // 2. NFC + Unicode whitespace → regular space
  const normalized = filePath.normalize('NFC').replace(UNICODE_WHITESPACE_RE, ' ');
  if (normalized !== filePath && existsSync(normalized)) return normalized;

  // 3. Regular spaces → non-breaking space (U+00A0) — macOS screenshot names
  const withNbsp = normalized.replace(/ /g, '\u00a0');
  if (withNbsp !== normalized && existsSync(withNbsp)) return withNbsp;

  // None matched — return the cleaned-up path for a clear error message
  return normalized;
}

// ── Config ──────────────────────────────────────────────────────────────────

const MEDIA_API_BASE = 'https://media-api.squarespace.com';
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 120_000; // 2 minutes
const SESSION_PATH = process.env.SESSION_DIR
  ? join(process.env.SESSION_DIR, 'sqsp-session.json')
  : join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const ACCEPTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface MediaUploadResult {
  jobId: string;
  assetId?: string;
  assetUrl?: string;
  libraryId: string;
  status: 'success' | 'failed';
  failureReason?: string;
  success?: boolean;
  error?: string;
}

export interface BatchUploadResult {
  originalPath: string;
  success: boolean;
  assetUrl?: string;
  assetId?: string;
  jobId?: string;
  error?: string;
}

export interface MediaLibraryUsage {
  IMAGE: { count: number; limits: { count: number } };
  VIDEO: { count: number; durationSeconds: number; limits: { durationSeconds: number; count: number } };
  FILE: { count: number; bytes: number; limits: Record<string, unknown> };
  AUDIO: { count: number; durationSeconds: number; limits: { durationSeconds: number; count: number } };
  ATTACHMENT: { count: number; limits: { count: number } };
}

interface UploadResponse {
  jobId: string;
  checkStatusAfterMs: number;
}

interface JobStatusEntry {
  id: string;
  libraryId: string;
  status: number;
  isActive: boolean;
  isSuccess: boolean;
  failureReasonCode?: string;
  shouldRetry: boolean;
  // Squarespace returns asset info in two different shapes:
  // Newer format: top-level assetId + assetRecord
  assetId?: string;
  assetRecord?: {
    assetType: string;
    logicalPath?: string;
    assetUrl?: string;
    stringMetaData?: Record<string, string>;
  };
  // Older format: nested asset object
  asset?: {
    id: string;
    contentType: string;
    originalName: string;
    url?: string;
    mediaFocalPoint?: { x: number; y: number };
  };
}

interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

// ── Media Upload Client ─────────────────────────────────────────────────────

export class MediaUploadClient {
  private siteSubdomain: string;
  private libraryId: string;
  /** All cookies for site-specific requests (e.g. fetching JWT from the site) */
  private siteCookieHeader: string = '';
  /** Only .squarespace.com global cookies for cross-domain media-api requests */
  private globalCookieHeader: string = '';
  private authorized: boolean = false;
  private sessionAgeHours: number | null = null;
  private sessionLoadedAt: Date | null = null;

  /**
   * @param siteSubdomain e.g. "grey-yellow-hbxc" or "tim-cox"
   * @param libraryId The media library ID (site ID). If not provided, will be
   *                  auto-discovered from the JWT during authorize().
   */
  constructor(siteSubdomain: string, libraryId?: string) {
    this.siteSubdomain = siteSubdomain;
    this.libraryId = libraryId ?? '';
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

    // Separate global (.squarespace.com) cookies from site-specific ones.
    // media-api.squarespace.com only receives .squarespace.com cookies (browser behavior).
    // The site's internal API receives both global + site-specific cookies.
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

    // Global cookie header for media-api.squarespace.com
    this.globalCookieHeader = globalCookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    // Full cookie header for site-specific requests (global + site-specific)
    const allCookies = [...globalCookies, ...siteCookies];
    // Deduplicate by name (prefer site-specific over global)
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

    logger.info(
      {
        siteSubdomain: this.siteSubdomain,
        globalCookies: globalCookies.length,
        siteCookies: siteCookies.length,
      },
      'Loaded session cookies for media upload',
    );

    // Track session file age for staleness detection
    const stats = statSync(path);
    const ageMs = Date.now() - stats.mtimeMs;
    this.sessionAgeHours = ageMs / (1000 * 60 * 60);
    this.sessionLoadedAt = new Date(stats.mtimeMs);
    if (this.sessionAgeHours > 24) {
      logger.warn(
        { ageHours: Math.round(this.sessionAgeHours), lastModified: this.sessionLoadedAt.toISOString() },
        'Session cookies are older than 24 hours — media uploads may fail',
      );
    }
  }

  /**
   * Authorize with the media API. Two-step process:
   * 1. Fetch a JWT from the site's internal API (/api/media/auth/v1/library/authorization)
   * 2. POST that JWT to media-api.squarespace.com/user/authorize
   */
  async authorize(): Promise<void> {
    if (!this.siteCookieHeader) {
      throw new Error('Session cookies not loaded. Call loadSessionCookies() first.');
    }

    logger.info({ siteSubdomain: this.siteSubdomain }, 'Authorizing with media API');

    // Step 1: Get JWT from the site's internal API
    const jwt = await this.fetchMediaJWT();

    // Step 2: Authorize with media-api using the JWT
    // media-api.squarespace.com only gets global .squarespace.com cookies (browser behavior)
    const response = await fetch(`${MEDIA_API_BASE}/user/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Cookie: this.globalCookieHeader,
        Origin: `https://${this.siteSubdomain}.squarespace.com`,
        Referer: `https://${this.siteSubdomain}.squarespace.com/`,
        'User-Agent': USER_AGENT,
      },
      body: jwt,
    });

    if (response.status !== 204 && response.status !== 200) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Media API authorization failed: ${response.status} ${response.statusText}. Body: ${body}`,
      );
    }

    // Capture any set-cookie headers for subsequent requests
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      const newCookies = setCookies
        .map((sc) => sc.split(';')[0])
        .join('; ');
      this.globalCookieHeader = `${this.globalCookieHeader}; ${newCookies}`;
    }

    this.authorized = true;
    logger.info('Media API authorized successfully');
  }

  /**
   * Fetch the media library JWT from the site's internal API.
   * This JWT contains the libraryIdToRole mapping and memberAccountId.
   */
  private async fetchMediaJWT(): Promise<string> {
    // First we need the crumb token from the session cookies
    const crumb = this.extractCrumbFromCookies();

    const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
    const authUrl = `${siteUrl}/api/media/auth/v1/library/authorization`;

    logger.info({ authUrl }, 'Fetching media JWT from site');

    const response = await fetch(authUrl, {
      method: 'GET',
      headers: {
        Cookie: this.siteCookieHeader,
        Origin: siteUrl,
        Referer: `${siteUrl}/`,
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Failed to fetch media JWT: ${response.status} ${response.statusText}. Body: ${body}`,
      );
    }

    // The endpoint returns either raw JWT or JSON { "token": "eyJ..." }
    const rawBody = await response.text();
    let jwt: string;
    try {
      const parsed = JSON.parse(rawBody);
      jwt = parsed.token ?? rawBody;
    } catch {
      jwt = rawBody;
    }

    if (!jwt || jwt.length < 50) {
      throw new Error(`Invalid media JWT received (length: ${jwt?.length})`);
    }

    // Parse JWT to extract libraryId if we don't have one
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
      logger.info(
        {
          expireAt: payload.expireAt,
          memberAccountId: payload.memberAccountId,
          libraryCount: payload.libraryIdToRole?.length,
        },
        'Media JWT parsed',
      );

      // Auto-discover libraryId if not set
      if (!this.libraryId && payload.libraryIdToRole?.length > 0) {
        const firstEntry = payload.libraryIdToRole[0];
        this.libraryId = Object.keys(firstEntry)[0];
        logger.info({ libraryId: this.libraryId }, 'Auto-discovered libraryId from JWT');
      }
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Could not parse media JWT payload (non-fatal)');
    }

    return jwt;
  }

  /**
   * Extract the crumb token from the loaded cookies.
   */
  private extractCrumbFromCookies(): string | null {
    // Parse cookie header to find crumb
    const cookies = this.siteCookieHeader.split('; ');
    for (const c of cookies) {
      const [name, ...valueParts] = c.split('=');
      if (name === 'crumb') {
        return valueParts.join('=');
      }
    }
    return null;
  }

  /**
   * Get the media library usage for this site.
   */
  async getLibraryUsage(): Promise<MediaLibraryUsage> {
    await this.ensureAuthorized();

    const response = await this.mediaRequest(
      'GET',
      `/user/libraries/${this.libraryId}/usage`,
    );

    return response as MediaLibraryUsage;
  }

  /**
   * Upload an image file to the Squarespace media library.
   * Returns the upload result with asset URL on success.
   *
   * @param filePath Absolute path to the image file
   * @param altText Optional alt text for the image
   */
  async uploadImage(filePath: string, altText?: string): Promise<MediaUploadResult> {
    await this.ensureAuthorized();

    // Resolve macOS Unicode whitespace quirks (e.g. non-breaking spaces in Screenshot filenames)
    filePath = resolveFilePath(filePath);

    // Validate file
    const ext = extname(filePath).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported image type: ${ext}. Accepted: ${[...ACCEPTED_EXTENSIONS].join(', ')}`);
    }

    const stat = statSync(filePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 20MB)`);
    }
    if (stat.size === 0) {
      throw new Error('Image file is empty');
    }

    const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';
    const fileName = basename(filePath);
    const fileBytes = readFileSync(filePath);

    logger.info(
      { filePath, fileName, sizeBytes: stat.size, mimeType, libraryId: this.libraryId },
      'Uploading image to Squarespace media library',
    );

    // Build multipart form data
    const blob = new Blob([fileBytes], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, fileName);

    // Upload — media-api.squarespace.com gets global cookies only
    const uploadResponse = await fetch(`${MEDIA_API_BASE}/uploads/image`, {
      method: 'POST',
      headers: {
        Cookie: this.globalCookieHeader,
        Origin: `https://${this.siteSubdomain}.squarespace.com`,
        Referer: `https://${this.siteSubdomain}.squarespace.com/`,
        'x-library-id': this.libraryId,
        'x-sqsp-source': 'web upload',
        'User-Agent': USER_AGENT,
      },
      body: formData,
    });

    if (uploadResponse.status !== 202 && uploadResponse.status !== 200) {
      const body = await uploadResponse.text().catch(() => '');
      throw new Error(
        `Image upload failed: ${uploadResponse.status} ${uploadResponse.statusText}. Body: ${body}`,
      );
    }

    const uploadResult = (await uploadResponse.json()) as UploadResponse;
    logger.info(
      { jobId: uploadResult.jobId, checkStatusAfterMs: uploadResult.checkStatusAfterMs },
      'Image upload accepted, polling for completion',
    );

    // Poll for completion
    return this.pollUploadStatus(uploadResult.jobId);
  }

  /**
   * Download an image from a URL and upload it to the Squarespace media library.
   * Supports http/https URLs. Downloads to a temp file, uploads, then cleans up.
   *
   * @param url The image URL to download and upload
   * @param altText Optional alt text for the image
   */
  async uploadImageFromUrl(url: string, altText?: string): Promise<MediaUploadResult> {
    // Infer extension from URL path (strip query string)
    const urlPath = new URL(url).pathname;
    let ext = extname(urlPath).toLowerCase();
    if (!ext || !ACCEPTED_EXTENSIONS.has(ext)) {
      ext = '.jpg'; // default — Squarespace infers from content anyway
    }

    logger.info({ url, inferredExt: ext }, 'Downloading image from URL for upload');

    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Failed to download image from ${url}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    // Override extension from content-type if we got a valid image type
    const ctExtMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
    };
    for (const [ct, ctExt] of Object.entries(ctExtMap)) {
      if (contentType.includes(ct)) {
        ext = ctExt;
        break;
      }
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('Downloaded image is empty');
    }
    if (buffer.length > MAX_IMAGE_SIZE) {
      throw new Error(`Downloaded image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max 20MB)`);
    }

    // Write to temp file (use OS temp dir — process.cwd() may be / in Claude Desktop)
    const tmpDir = tmpdir();
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, `url-download-${randomUUID()}${ext}`);
    writeFileSync(tmpFile, buffer);

    try {
      return await this.uploadImage(tmpFile, altText);
    } finally {
      // Clean up temp file
      try {
        const { unlinkSync } = await import('fs');
        unlinkSync(tmpFile);
      } catch { /* ignore cleanup errors */ }
    }
  }

  /**
   * Upload multiple images in parallel with concurrency limiting.
   * Returns results in the same order as the input array.
   * Handles partial failures — some may succeed while others fail.
   *
   * @param filePaths Array of absolute paths to image files
   * @param concurrency Max parallel uploads (default 3)
   */
  async uploadImages(
    filePaths: string[],
    concurrency = 3,
  ): Promise<BatchUploadResult[]> {
    if (filePaths.length === 0) return [];

    await this.ensureAuthorized();

    logger.info(
      { count: filePaths.length, concurrency, libraryId: this.libraryId },
      'Starting batch image upload',
    );

    // Pre-allocate results array to preserve order
    const results: BatchUploadResult[] = new Array(filePaths.length);
    let nextIndex = 0;

    // Promise pool pattern — run up to `concurrency` uploads at once
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(concurrency, filePaths.length); w++) {
      workers.push(
        (async () => {
          while (true) {
            const idx = nextIndex++;
            if (idx >= filePaths.length) break;

            const filePath = filePaths[idx];
            try {
              const uploadResult = await this.uploadImage(filePath);
              results[idx] = {
                originalPath: filePath,
                success: uploadResult.status === 'success',
                assetUrl: uploadResult.assetUrl,
                assetId: uploadResult.assetId,
                jobId: uploadResult.jobId,
                error: uploadResult.failureReason,
              };
            } catch (err) {
              results[idx] = {
                originalPath: filePath,
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        })(),
      );
    }

    await Promise.all(workers);

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    logger.info(
      { total: filePaths.length, succeeded, failed },
      'Batch image upload completed',
    );

    return results;
  }

  // ── Private Methods ──────────────────────────────────────────────────────

  private async ensureAuthorized(): Promise<void> {
    if (!this.authorized) {
      await this.authorize();
    }
  }

  private async pollUploadStatus(jobId: string): Promise<MediaUploadResult> {
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const statusUrl = `${MEDIA_API_BASE}/jobs/image/status?job-list=${encodeURIComponent(jobId)}`;
      const response = await fetch(statusUrl, {
        headers: {
          Cookie: this.globalCookieHeader,
          Origin: `https://${this.siteSubdomain}.squarespace.com`,
          Referer: `https://${this.siteSubdomain}.squarespace.com/`,
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        },
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, jobId },
          'Upload status check failed, will retry',
        );
        continue;
      }

      const statuses = (await response.json()) as JobStatusEntry[];
      const job = statuses[0];

      if (!job) {
        logger.warn({ jobId }, 'No status entry returned for job, will retry');
        continue;
      }

      logger.debug(
        { jobId, status: job.status, isActive: job.isActive, isSuccess: job.isSuccess, assetId: job.assetId, assetRecord: job.assetRecord, asset: job.asset },
        'Upload status poll',
      );

      // Job still processing
      if (job.isActive) {
        continue;
      }

      // Job completed
      if (job.isSuccess) {
        logger.info({ rawJob: JSON.stringify(job) }, 'Upload job completed — raw response');
        // Squarespace returns asset info in two formats:
        // 1. Newer: top-level `assetId` + `assetRecord` with `assetUrl`
        // 2. Older: nested `asset: { id, url }` object
        const assetId = job.assetId ?? job.asset?.id;
        const assetUrl = job.assetRecord?.assetUrl ?? job.asset?.url;

        const result: MediaUploadResult = {
          jobId,
          libraryId: this.libraryId,
          status: 'success',
          assetId,
          assetUrl,
        };
        logger.info(
          { jobId, libraryId: this.libraryId, assetId, assetUrl },
          'Image upload completed successfully',
        );
        return result;
      }

      // Job failed
      const result: MediaUploadResult = {
        jobId,
        libraryId: this.libraryId,
        status: 'failed',
        failureReason: job.failureReasonCode ?? 'Unknown failure',
      };

      if (job.shouldRetry) {
        logger.warn(result, 'Image upload failed but retry suggested');
      } else {
        logger.error(result, 'Image upload failed permanently');
      }

      return result;
    }

    // Timed out
    return {
      jobId,
      libraryId: this.libraryId,
      status: 'failed',
      failureReason: `Timed out after ${POLL_TIMEOUT_MS}ms`,
    };
  }

  /**
   * Generic JSON request to the media API.
   */
  private async mediaRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${MEDIA_API_BASE}${path}`;

    const headers: Record<string, string> = {
      Cookie: this.globalCookieHeader,
      Origin: `https://${this.siteSubdomain}.squarespace.com`,
      Referer: `https://${this.siteSubdomain}.squarespace.com/`,
      Accept: 'application/json, text/plain, */*',
      'User-Agent': USER_AGENT,
      'x-library-id': this.libraryId,
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Media API error: ${response.status} ${response.statusText} on ${method} ${path}. Body: ${errorBody}`);
    }

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a ready-to-use MediaUploadClient for a given site.
 *
 * @param siteSubdomain e.g. "grey-yellow-hbxc"
 * @param libraryId Optional media library ID. Auto-discovered from JWT if not provided.
 * @param sessionPath Optional custom path to the session JSON file.
 */
export function createMediaUploadClient(
  siteSubdomain: string,
  libraryId?: string,
  sessionPath?: string,
): MediaUploadClient {
  const client = new MediaUploadClient(siteSubdomain, libraryId);
  client.loadSessionCookies(sessionPath);
  return client;
}
