import { Page, Request, Response } from 'playwright';
import { writeFile } from 'fs/promises';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CapturedRequest {
  /** ISO timestamp when the request was captured */
  timestamp: string;
  /** HTTP method (GET, POST, PUT, DELETE, PATCH, etc.) */
  method: string;
  /** Full URL of the request */
  url: string;
  /** Parsed URL path (e.g. /api/content/pages/123) */
  path: string;
  /** Query parameters as key-value pairs */
  queryParams: Record<string, string>;
  /** Request headers */
  requestHeaders: Record<string, string>;
  /** Request body (parsed JSON object, or raw string for form-data) */
  requestBody: unknown | null;
  /** HTTP response status code */
  responseStatus: number | null;
  /** Response body (parsed JSON, or raw string if not JSON) */
  responseBody: unknown | null;
  /** Response headers */
  responseHeaders: Record<string, string>;
  /** Resource type as reported by Playwright (xhr, fetch, document, etc.) */
  resourceType: string;
  /** Duration in ms from request to response (null if response not captured) */
  durationMs: number | null;
}

export interface NetworkCaptureOptions {
  /** URL patterns to capture (regex). Defaults to /\/api\// */
  includePatterns?: RegExp[];
  /** URL patterns to exclude (regex). Applied after includePatterns. */
  excludePatterns?: RegExp[];
  /** Whether to capture response bodies. Default: true */
  captureResponseBodies?: boolean;
  /** Max response body size to capture (bytes). Default: 1MB */
  maxResponseBodySize?: number;
}

// ─── Noise Filters ─────────────────────────────────────────────────────────

/** URL patterns to always exclude (analytics, static assets, etc.) */
const DEFAULT_EXCLUDE_PATTERNS: RegExp[] = [
  /\/api\/census/,                // Squarespace analytics/census
  /\/api\/beacon/,                // Tracking beacons
  /\/api\/events/,                // Event tracking
  /\/api\/1\/performance/,        // Performance monitoring
  /\/api\/rollups/,               // Analytics rollups
  /\/universal\/images-cdn\//,    // CDN image fetches
  /\/static\//,                   // Static assets
  /\.js(\?|$)/,                   // JavaScript files
  /\.css(\?|$)/,                  // CSS files
  /\.woff2?(\?|$)/,              // Fonts
  /\.png(\?|$)/,                  // Images
  /\.jpg(\?|$)/,                  // Images
  /\.svg(\?|$)/,                  // SVG
  /\/favicon/,                    // Favicons
  /google-analytics/,             // GA
  /googletagmanager/,             // GTM
  /hotjar/,                       // Hotjar
  /sentry/,                       // Sentry
];

// ─── NetworkCapture Class ──────────────────────────────────────────────────

export class NetworkCapture {
  private page: Page;
  private captures: CapturedRequest[] = [];
  private pendingRequests = new Map<string, { request: Request; startTime: number }>();
  private isCapturing = false;
  private crumbToken: string | null = null;
  private options: Required<NetworkCaptureOptions>;

  private requestHandler: ((request: Request) => void) | null = null;
  private responseHandler: ((response: Response) => void) | null = null;

  constructor(page: Page, options?: NetworkCaptureOptions) {
    this.page = page;
    this.options = {
      includePatterns: options?.includePatterns ?? [/\/api\//],
      excludePatterns: options?.excludePatterns ?? [],
      captureResponseBodies: options?.captureResponseBodies ?? true,
      maxResponseBodySize: options?.maxResponseBodySize ?? 1_048_576, // 1MB
    };
  }

  /**
   * Start capturing network requests.
   * Automatically extracts the crumb token from cookies.
   */
  async start(): Promise<void> {
    if (this.isCapturing) {
      logger.warn('NetworkCapture already running — ignoring start()');
      return;
    }

    // Extract crumb token from cookies
    await this.extractCrumb();

    this.requestHandler = (request: Request) => this.onRequest(request);
    this.responseHandler = (response: Response) => this.onResponse(response);

    this.page.on('request', this.requestHandler);
    this.page.on('response', this.responseHandler);
    this.isCapturing = true;

    logger.info(
      { crumbFound: !!this.crumbToken, includePatterns: this.options.includePatterns.length },
      'Network capture started',
    );
  }

  /** Stop capturing network requests. */
  stop(): void {
    if (!this.isCapturing) return;

    if (this.requestHandler) {
      this.page.removeListener('request', this.requestHandler);
    }
    if (this.responseHandler) {
      this.page.removeListener('response', this.responseHandler);
    }

    this.requestHandler = null;
    this.responseHandler = null;
    this.isCapturing = false;
    this.pendingRequests.clear();

    logger.info({ capturedCount: this.captures.length }, 'Network capture stopped');
  }

  /** Get all captured requests. */
  getCapturedRequests(): CapturedRequest[] {
    return [...this.captures];
  }

  /** Get the extracted crumb token (null if not found). */
  getCrumbToken(): string | null {
    return this.crumbToken;
  }

  /** Clear all captured requests. */
  clear(): void {
    this.captures = [];
    this.pendingRequests.clear();
  }

  /** Save captured requests to a JSON file. */
  async saveToFile(path: string): Promise<void> {
    const output = {
      capturedAt: new Date().toISOString(),
      crumbToken: this.crumbToken,
      totalRequests: this.captures.length,
      requests: this.captures,
    };
    await writeFile(path, JSON.stringify(output, null, 2), 'utf-8');
    logger.info({ path, requestCount: this.captures.length }, 'Network capture saved to file');
  }

  // ─── Private Methods ───────────────────────────────────────────────────

  /** Extract the crumb token from Squarespace cookies. */
  private async extractCrumb(): Promise<void> {
    try {
      const cookies = await this.page.context().cookies();
      const crumbCookie = cookies.find((c) => c.name === 'crumb');
      if (crumbCookie) {
        this.crumbToken = crumbCookie.value;
        logger.info({ crumb: this.crumbToken.substring(0, 8) + '...' }, 'Extracted crumb token from cookies');
      } else {
        // Fallback: try to extract from page meta tag or global JS variable
        const crumbFromPage = await this.page.evaluate(() => {
          // Squarespace stores crumb in Static.SQUARESPACE_CONTEXT.crumb
          const win = window as unknown as Record<string, unknown>;
          const staticCtx = win.Static as Record<string, unknown> | undefined;
          if (staticCtx?.SQUARESPACE_CONTEXT) {
            const ctx = staticCtx.SQUARESPACE_CONTEXT as Record<string, unknown>;
            return (ctx.crumb as string) ?? null;
          }
          return null;
        }).catch(() => null);

        if (crumbFromPage) {
          this.crumbToken = crumbFromPage;
          logger.info({ crumb: crumbFromPage.substring(0, 8) + '...' }, 'Extracted crumb token from page context');
        } else {
          logger.warn('Could not find crumb token in cookies or page context');
        }
      }
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Failed to extract crumb token');
    }
  }

  /** Check if a URL should be captured based on include/exclude patterns. */
  private shouldCapture(url: string): boolean {
    // Must match at least one include pattern
    const included = this.options.includePatterns.some((p) => p.test(url));
    if (!included) return false;

    // Must not match any exclude pattern (defaults + user-specified)
    const allExcludes = [...DEFAULT_EXCLUDE_PATTERNS, ...this.options.excludePatterns];
    const excluded = allExcludes.some((p) => p.test(url));
    return !excluded;
  }

  /** Handle an outgoing request. */
  private onRequest(request: Request): void {
    const url = request.url();
    if (!this.shouldCapture(url)) return;

    this.pendingRequests.set(url + request.method(), {
      request,
      startTime: Date.now(),
    });
  }

  /** Handle a received response. */
  private async onResponse(response: Response): Promise<void> {
    const request = response.request();
    const url = request.url();
    const key = url + request.method();

    if (!this.shouldCapture(url)) return;

    const pending = this.pendingRequests.get(key);
    const startTime = pending?.startTime ?? Date.now();
    this.pendingRequests.delete(key);

    try {
      const parsedUrl = new URL(url);
      const queryParams: Record<string, string> = {};
      parsedUrl.searchParams.forEach((value, name) => {
        queryParams[name] = value;
      });

      // Parse request body
      let requestBody: unknown | null = null;
      const postData = request.postData();
      if (postData) {
        try {
          requestBody = JSON.parse(postData);
        } catch {
          requestBody = postData; // Keep as raw string if not JSON
        }
      }

      // Parse response body
      let responseBody: unknown | null = null;
      if (this.options.captureResponseBodies) {
        try {
          const body = await response.body();
          if (body.length <= this.options.maxResponseBodySize) {
            const text = body.toString('utf-8');
            try {
              responseBody = JSON.parse(text);
            } catch {
              responseBody = text;
            }
          } else {
            responseBody = `[body too large: ${body.length} bytes]`;
          }
        } catch {
          // Response body may not be available (e.g., redirects)
          responseBody = null;
        }
      }

      const captured: CapturedRequest = {
        timestamp: new Date().toISOString(),
        method: request.method(),
        url,
        path: parsedUrl.pathname,
        queryParams,
        requestHeaders: request.headers(),
        requestBody,
        responseStatus: response.status(),
        responseBody,
        responseHeaders: response.headers(),
        resourceType: request.resourceType(),
        durationMs: Date.now() - startTime,
      };

      this.captures.push(captured);

      logger.debug(
        { method: captured.method, path: captured.path, status: captured.responseStatus },
        'Captured API request',
      );
    } catch (err) {
      logger.warn({ url, error: errMsg(err) }, 'Failed to capture response details');
    }
  }
}
