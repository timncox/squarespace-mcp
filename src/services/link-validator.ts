/**
 * Link Validation — verifies that URLs written to a Squarespace site actually
 * resolve. Catches typos, broken links, and invalid email addresses.
 *
 * Designed to be usable standalone (no dependency on ContentSaveClient).
 * HTTP validation uses native fetch() with HEAD-then-GET fallback.
 */

import { extractLinks } from './design-property-extractor.js';
import type { ExtractedLink } from './design-property-extractor.js';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface LinkValidationOptions {
  /** HTTP request timeout in milliseconds (default 5000) */
  timeoutMs?: number;
  /** Maximum redirects to follow (default 5) */
  maxRedirects?: number;
  /** Site base URL for resolving relative URLs (e.g., "https://mysite.squarespace.com") */
  siteBaseUrl?: string;
  /** Max concurrent HTTP validations (default 5) */
  concurrency?: number;
}

export interface LinkValidationResult {
  href: string;
  text: string;
  status: 'ok' | 'broken' | 'redirect' | 'timeout' | 'skipped' | 'invalid_email';
  statusCode?: number;
  finalUrl?: string;
  redirectCount?: number;
  error?: string;
  durationMs: number;
}

export interface LinkValidationSummary {
  total: number;
  ok: number;
  broken: number;
  redirected: number;
  timedOut: number;
  skipped: number;
  invalidEmails: number;
  results: LinkValidationResult[];
  allPassed: boolean;
}

// ── Link Classification ─────────────────────────────────────────────────────

export type LinkType = 'http' | 'mailto' | 'tel' | 'relative' | 'anchor' | 'unknown';

/**
 * Classify a link href into a type category.
 */
export function classifyLink(href: string): LinkType {
  if (!href || !href.trim()) return 'unknown';

  const trimmed = href.trim();

  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return 'http';
  if (trimmed.startsWith('mailto:')) return 'mailto';
  if (trimmed.startsWith('tel:')) return 'tel';
  if (trimmed.startsWith('/')) return 'relative';
  if (trimmed.startsWith('#')) return 'anchor';

  return 'unknown';
}

// ── URL Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a relative URL against a base URL.
 */
export function resolveRelativeUrl(href: string, siteBaseUrl: string): string {
  return new URL(href, siteBaseUrl).toString();
}

// ── Mailto Validation ───────────────────────────────────────────────────────

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate a mailto: link by checking the email format.
 */
export function validateMailtoLink(href: string): LinkValidationResult {
  const start = Date.now();
  const email = href.replace(/^mailto:/i, '').split('?')[0].trim(); // strip query params like ?subject=

  if (!email || !EMAIL_REGEX.test(email)) {
    return {
      href,
      text: '',
      status: 'invalid_email',
      error: `Invalid email format: "${email}"`,
      durationMs: Date.now() - start,
    };
  }

  return {
    href,
    text: '',
    status: 'ok',
    durationMs: Date.now() - start,
  };
}

// ── HTTP Validation ─────────────────────────────────────────────────────────

/**
 * Validate an HTTP/HTTPS link by making a HEAD request (with GET fallback for 405).
 */
export async function validateHttpLink(
  href: string,
  text: string,
  options?: LinkValidationOptions,
): Promise<LinkValidationResult> {
  const timeoutMs = options?.timeoutMs ?? 5000;
  const start = Date.now();

  const makeResult = (partial: Partial<LinkValidationResult>): LinkValidationResult => ({
    href,
    text,
    status: 'broken',
    durationMs: Date.now() - start,
    ...partial,
  });

  // Try HEAD first, fall back to GET on 405
  for (const method of ['HEAD', 'GET'] as const) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(href, {
        method,
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Squarespace-Helper-LinkValidator/1.0',
        },
      });

      clearTimeout(timer);

      // If HEAD returns 405 Method Not Allowed, retry with GET
      if (method === 'HEAD' && response.status === 405) {
        continue;
      }

      const statusCode = response.status;

      // Check for redirect (fetch follows redirects, so we check response.url)
      if (response.redirected && response.url && response.url !== href) {
        return makeResult({
          status: 'redirect',
          statusCode,
          finalUrl: response.url,
        });
      }

      if (statusCode >= 200 && statusCode < 300) {
        return makeResult({ status: 'ok', statusCode });
      }

      // 4xx/5xx → broken
      return makeResult({
        status: 'broken',
        statusCode,
        error: `HTTP ${statusCode}`,
      });
    } catch (err) {
      clearTimeout(timer);

      // Check if it was an abort (timeout)
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return makeResult({
          status: 'timeout',
          error: `Timed out after ${timeoutMs}ms`,
        });
      }

      // If this was a HEAD attempt, don't retry on network errors (only 405)
      // Network errors on HEAD won't be fixed by GET
      return makeResult({
        status: 'broken',
        error: errMsg(err),
      });
    }
  }

  // Should not reach here, but just in case
  return makeResult({
    status: 'broken',
    error: 'All request methods exhausted',
    durationMs: Date.now() - start,
  });
}

// ── Batch Validation ────────────────────────────────────────────────────────

/**
 * Validate a list of extracted links, dispatching to the appropriate validator
 * based on link type. HTTP validations run in parallel batches.
 */
export async function validateLinks(
  links: ExtractedLink[],
  options?: LinkValidationOptions,
): Promise<LinkValidationSummary> {
  const concurrency = options?.concurrency ?? 5;
  const results: LinkValidationResult[] = [];

  // Classify and separate links by type
  const httpLinks: Array<{ link: ExtractedLink; resolvedHref: string }> = [];

  for (const link of links) {
    const type = classifyLink(link.href);

    switch (type) {
      case 'http':
        httpLinks.push({ link, resolvedHref: link.href });
        break;

      case 'mailto': {
        const mailResult = validateMailtoLink(link.href);
        mailResult.text = link.text;
        results.push(mailResult);
        break;
      }

      case 'relative': {
        if (options?.siteBaseUrl) {
          try {
            const resolved = resolveRelativeUrl(link.href, options.siteBaseUrl);
            httpLinks.push({ link, resolvedHref: resolved });
          } catch {
            results.push({
              href: link.href,
              text: link.text,
              status: 'skipped',
              error: 'Failed to resolve relative URL',
              durationMs: 0,
            });
          }
        } else {
          results.push({
            href: link.href,
            text: link.text,
            status: 'skipped',
            error: 'No siteBaseUrl provided for relative URL',
            durationMs: 0,
          });
        }
        break;
      }

      case 'tel':
      case 'anchor':
      case 'unknown':
        results.push({
          href: link.href,
          text: link.text,
          status: 'skipped',
          error: `${type} link`,
          durationMs: 0,
        });
        break;
    }
  }

  // Run HTTP validations in parallel batches
  for (let i = 0; i < httpLinks.length; i += concurrency) {
    const batch = httpLinks.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(({ link, resolvedHref }) =>
        validateHttpLink(resolvedHref, link.text, options),
      ),
    );
    results.push(...batchResults);
  }

  // Aggregate summary
  const summary: LinkValidationSummary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    broken: results.filter((r) => r.status === 'broken').length,
    redirected: results.filter((r) => r.status === 'redirect').length,
    timedOut: results.filter((r) => r.status === 'timeout').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    invalidEmails: results.filter((r) => r.status === 'invalid_email').length,
    results,
    allPassed: results.every((r) => r.status !== 'broken' && r.status !== 'invalid_email'),
  };

  return summary;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format a link validation summary as a human-readable string for the
 * supervisor prompt or dashboard display.
 */
export function formatLinkValidation(summary: LinkValidationSummary): string {
  const lines: string[] = ['## Link Validation', ''];

  for (const r of summary.results) {
    const textLabel = r.text ? `"${r.text}"` : '(no text)';

    switch (r.status) {
      case 'ok':
        lines.push(`[OK] ${textLabel} -> ${r.href} -> ${r.statusCode ?? 'ok'}`);
        break;
      case 'broken':
        lines.push(`[BROKEN] ${textLabel} -> ${r.href} -> ${r.statusCode ?? r.error ?? 'error'}`);
        break;
      case 'redirect':
        lines.push(`[REDIRECT] ${textLabel} -> ${r.href} -> ${r.statusCode ?? 301} -> ${r.finalUrl}`);
        break;
      case 'timeout':
        lines.push(`[TIMEOUT] ${textLabel} -> ${r.href} -> timed out (${r.error ?? 'timeout'})`);
        break;
      case 'skipped':
        lines.push(`[SKIPPED] ${textLabel} -> ${r.href} (${r.error ?? 'skipped'})`);
        break;
      case 'invalid_email':
        lines.push(`[INVALID EMAIL] ${textLabel} -> ${r.href} (${r.error ?? 'invalid'})`);
        break;
    }
  }

  lines.push('');
  lines.push(
    `Summary: ${summary.total} links, ${summary.ok} ok, ${summary.broken} broken, ` +
      `${summary.redirected} redirected, ${summary.timedOut} timed out, ` +
      `${summary.skipped} skipped, ${summary.invalidEmails} invalid emails`,
  );

  return lines.join('\n');
}

// ── Section-Level Extraction + Validation ───────────────────────────────────

/**
 * Extract all links from page sections data (text blocks, button blocks,
 * image blocks) and validate them.
 *
 * This walks the Squarespace sections JSON structure to find:
 * - Links in text block HTML (<a> tags)
 * - Button block URLs (value.url or value.linkTo)
 * - Image block link destinations (value.linkTo)
 *
 * Deduplicates by href before validation.
 */
export async function extractAndValidateLinks(
  sections: unknown[],
  options?: LinkValidationOptions,
): Promise<LinkValidationSummary> {
  const allLinks: ExtractedLink[] = [];
  const seenHrefs = new Set<string>();

  function addLink(link: ExtractedLink): void {
    if (!link.href || seenHrefs.has(link.href)) return;
    seenHrefs.add(link.href);
    allLinks.push(link);
  }

  for (const section of sections) {
    const sec = section as {
      fluidEngineContext?: {
        gridContents?: Array<{
          content?: {
            value?: {
              type?: number;
              value?: Record<string, unknown>;
            };
          };
        }>;
      };
    };

    const contents = sec?.fluidEngineContext?.gridContents ?? [];

    for (const gc of contents) {
      const bv = gc.content?.value;
      if (!bv) continue;

      // Text blocks (type 2): extract <a> tags from HTML
      if (bv.type === 2) {
        const html = (bv.value?.html ?? bv.value?.source ?? '') as string;
        if (html) {
          const extracted = extractLinks(html);
          for (const link of extracted) {
            addLink(link);
          }
        }
      }

      // Button blocks (type 55 or blocks with value.url/value.linkTo and value.label)
      const val = bv.value;
      if (val) {
        // Button URL
        if (typeof val.url === 'string' && val.url) {
          addLink({
            text: (val.label as string) ?? (val.text as string) ?? '',
            href: val.url as string,
          });
        }

        // Image or button linkTo
        if (typeof val.linkTo === 'string' && val.linkTo) {
          addLink({
            text: (val.title as string) ?? (val.altText as string) ?? '',
            href: val.linkTo as string,
          });
        }
      }
    }
  }

  logger.info(
    { linkCount: allLinks.length, sectionCount: sections.length },
    'link-validator: extracted links from sections',
  );

  return validateLinks(allLinks, options);
}
