import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyLink,
  resolveRelativeUrl,
  validateMailtoLink,
  validateHttpLink,
  validateLinks,
  formatLinkValidation,
  extractAndValidateLinks,
  type LinkValidationSummary,
  type LinkValidationResult,
} from '../link-validator.js';
import type { ExtractedLink } from '../../agents/types.js';

// ── classifyLink ────────────────────────────────────────────────────────────

describe('classifyLink', () => {
  it('classifies https as http', () => {
    expect(classifyLink('https://example.com')).toBe('http');
  });

  it('classifies http as http', () => {
    expect(classifyLink('http://example.com')).toBe('http');
  });

  it('classifies mailto as mailto', () => {
    expect(classifyLink('mailto:user@example.com')).toBe('mailto');
  });

  it('classifies tel as tel', () => {
    expect(classifyLink('tel:+1234567890')).toBe('tel');
  });

  it('classifies /path as relative', () => {
    expect(classifyLink('/about')).toBe('relative');
  });

  it('classifies #id as anchor', () => {
    expect(classifyLink('#section1')).toBe('anchor');
  });

  it('classifies javascript:void as unknown', () => {
    expect(classifyLink('javascript:void(0)')).toBe('unknown');
  });

  it('classifies empty string as unknown', () => {
    expect(classifyLink('')).toBe('unknown');
  });
});

// ── resolveRelativeUrl ──────────────────────────────────────────────────────

describe('resolveRelativeUrl', () => {
  it('resolves /menus against base URL', () => {
    expect(resolveRelativeUrl('/menus', 'https://mysite.squarespace.com')).toBe(
      'https://mysite.squarespace.com/menus',
    );
  });

  it('resolves /about/team against base URL', () => {
    expect(resolveRelativeUrl('/about/team', 'https://mysite.squarespace.com')).toBe(
      'https://mysite.squarespace.com/about/team',
    );
  });
});

// ── validateMailtoLink ──────────────────────────────────────────────────────

describe('validateMailtoLink', () => {
  it('validates a correct email as ok', () => {
    const result = validateMailtoLink('mailto:user@example.com');
    expect(result.status).toBe('ok');
    expect(result.href).toBe('mailto:user@example.com');
  });

  it('rejects an invalid email as invalid_email', () => {
    const result = validateMailtoLink('mailto:not-an-email');
    expect(result.status).toBe('invalid_email');
  });

  it('rejects empty mailto: as invalid_email', () => {
    const result = validateMailtoLink('mailto:');
    expect(result.status).toBe('invalid_email');
  });

  it('validates complex email (user@domain.co.uk) as ok', () => {
    const result = validateMailtoLink('mailto:info@restaurant.co.uk');
    expect(result.status).toBe('ok');
  });

  it('strips query params from mailto link', () => {
    const result = validateMailtoLink('mailto:user@example.com?subject=Hello');
    expect(result.status).toBe('ok');
  });
});

// ── validateHttpLink ────────────────────────────────────────────────────────

describe('validateHttpLink', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns ok for 200 response', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      redirected: false,
      url: 'https://example.com',
    } as Response);

    const result = await validateHttpLink('https://example.com', 'Example');
    expect(result.status).toBe('ok');
    expect(result.statusCode).toBe(200);
    expect(result.text).toBe('Example');
  });

  it('returns broken for 404 response', async () => {
    fetchSpy.mockResolvedValue({
      status: 404,
      redirected: false,
      url: 'https://example.com/missing',
    } as Response);

    const result = await validateHttpLink('https://example.com/missing', 'Missing');
    expect(result.status).toBe('broken');
    expect(result.statusCode).toBe(404);
  });

  it('returns redirect when response.redirected is true', async () => {
    fetchSpy.mockResolvedValue({
      status: 200,
      redirected: true,
      url: 'https://example.com/new-page',
    } as Response);

    const result = await validateHttpLink('https://example.com/old-page', 'Old Page');
    expect(result.status).toBe('redirect');
    expect(result.finalUrl).toBe('https://example.com/new-page');
  });

  it('returns broken on network error', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await validateHttpLink('https://down.example.com', 'Down');
    expect(result.status).toBe('broken');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns timeout on abort', async () => {
    fetchSpy.mockImplementation(() => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    });

    const result = await validateHttpLink('https://slow.example.com', 'Slow', { timeoutMs: 100 });
    expect(result.status).toBe('timeout');
  });

  it('retries with GET on 405 HEAD response', async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      callCount++;
      const method = (init as RequestInit)?.method;
      if (method === 'HEAD') {
        return { status: 405, redirected: false, url: _url as string } as Response;
      }
      // GET request succeeds
      return { status: 200, redirected: false, url: _url as string } as Response;
    });

    const result = await validateHttpLink('https://example.com/api', 'API');
    expect(result.status).toBe('ok');
    expect(result.statusCode).toBe(200);
    expect(callCount).toBe(2); // HEAD + GET
  });

  it('returns broken for 500 response', async () => {
    fetchSpy.mockResolvedValue({
      status: 500,
      redirected: false,
      url: 'https://example.com/error',
    } as Response);

    const result = await validateHttpLink('https://example.com/error', 'Error');
    expect(result.status).toBe('broken');
    expect(result.statusCode).toBe(500);
  });
});

// ── validateLinks ───────────────────────────────────────────────────────────

describe('validateLinks', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue({
      status: 200,
      redirected: false,
      url: 'https://example.com',
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('validates mixed link types correctly', async () => {
    const links: ExtractedLink[] = [
      { text: 'Website', href: 'https://example.com' },
      { text: 'Email', href: 'mailto:user@example.com' },
      { text: 'About', href: '/about' },
      { text: 'Top', href: '#top' },
    ];

    const summary = await validateLinks(links, { siteBaseUrl: 'https://site.com' });

    expect(summary.total).toBe(4);
    // https + resolved /about both hit fetch → ok
    expect(summary.ok).toBe(3); // https + mailto + resolved relative
    expect(summary.skipped).toBe(1); // #top anchor
  });

  it('resolves relative URLs when siteBaseUrl is provided', async () => {
    const links: ExtractedLink[] = [
      { text: 'Menus', href: '/menus' },
    ];

    fetchSpy.mockImplementation(async (url) => {
      return {
        status: 200,
        redirected: false,
        url: url as string,
      } as Response;
    });

    const summary = await validateLinks(links, { siteBaseUrl: 'https://restaurant.squarespace.com' });
    expect(summary.ok).toBe(1);
    expect(summary.skipped).toBe(0);

    // Verify fetch was called with the resolved URL
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://restaurant.squarespace.com/menus',
      expect.any(Object),
    );
  });

  it('skips relative URLs when no siteBaseUrl', async () => {
    const links: ExtractedLink[] = [
      { text: 'About', href: '/about' },
    ];

    const summary = await validateLinks(links);
    expect(summary.skipped).toBe(1);
    expect(summary.ok).toBe(0);
  });

  it('handles empty array', async () => {
    const summary = await validateLinks([]);
    expect(summary.total).toBe(0);
    expect(summary.ok).toBe(0);
    expect(summary.allPassed).toBe(true);
  });

  it('allPassed is true when no broken links', async () => {
    const links: ExtractedLink[] = [
      { text: 'Site', href: 'https://example.com' },
      { text: 'Phone', href: 'tel:+1234567890' },
    ];

    const summary = await validateLinks(links);
    expect(summary.allPassed).toBe(true);
  });

  it('allPassed is false when broken link present', async () => {
    fetchSpy.mockResolvedValue({
      status: 404,
      redirected: false,
      url: 'https://example.com/missing',
    } as Response);

    const links: ExtractedLink[] = [
      { text: 'Missing', href: 'https://example.com/missing' },
    ];

    const summary = await validateLinks(links);
    expect(summary.allPassed).toBe(false);
    expect(summary.broken).toBe(1);
  });

  it('allPassed is false when invalid email present', async () => {
    const links: ExtractedLink[] = [
      { text: 'Bad Email', href: 'mailto:not-valid' },
    ];

    const summary = await validateLinks(links);
    expect(summary.allPassed).toBe(false);
    expect(summary.invalidEmails).toBe(1);
  });
});

// ── formatLinkValidation ────────────────────────────────────────────────────

describe('formatLinkValidation', () => {
  it('formats ok/broken/redirect correctly', () => {
    const summary: LinkValidationSummary = {
      total: 3,
      ok: 1,
      broken: 1,
      redirected: 1,
      timedOut: 0,
      skipped: 0,
      invalidEmails: 0,
      results: [
        { href: 'https://example.com', text: 'Example', status: 'ok', statusCode: 200, durationMs: 100 },
        { href: 'https://example.com/missing', text: 'Missing', status: 'broken', statusCode: 404, durationMs: 150 },
        { href: 'https://old.com', text: 'Old', status: 'redirect', statusCode: 301, finalUrl: 'https://new.com', durationMs: 200 },
      ],
      allPassed: false,
    };

    const output = formatLinkValidation(summary);
    expect(output).toContain('[OK] "Example"');
    expect(output).toContain('[BROKEN] "Missing"');
    expect(output).toContain('[REDIRECT] "Old"');
    expect(output).toContain('https://new.com');
  });

  it('includes summary line', () => {
    const summary: LinkValidationSummary = {
      total: 2,
      ok: 2,
      broken: 0,
      redirected: 0,
      timedOut: 0,
      skipped: 0,
      invalidEmails: 0,
      results: [
        { href: 'https://a.com', text: 'A', status: 'ok', statusCode: 200, durationMs: 50 },
        { href: 'https://b.com', text: 'B', status: 'ok', statusCode: 200, durationMs: 60 },
      ],
      allPassed: true,
    };

    const output = formatLinkValidation(summary);
    expect(output).toContain('Summary: 2 links, 2 ok, 0 broken');
  });

  it('handles empty summary', () => {
    const summary: LinkValidationSummary = {
      total: 0,
      ok: 0,
      broken: 0,
      redirected: 0,
      timedOut: 0,
      skipped: 0,
      invalidEmails: 0,
      results: [],
      allPassed: true,
    };

    const output = formatLinkValidation(summary);
    expect(output).toContain('## Link Validation');
    expect(output).toContain('Summary: 0 links');
  });
});

// ── extractAndValidateLinks ─────────────────────────────────────────────────

describe('extractAndValidateLinks', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue({
      status: 200,
      redirected: false,
      url: 'https://example.com',
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('extracts links from text block HTML', async () => {
    const sections = [
      {
        id: 'sec-1',
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: {
          gridContents: [
            {
              content: {
                value: {
                  type: 2,
                  value: {
                    html: '<p>Visit <a href="https://example.com">our site</a></p>',
                  },
                },
              },
            },
          ],
        },
      },
    ];

    const summary = await extractAndValidateLinks(sections);
    expect(summary.total).toBe(1);
    expect(summary.results[0].href).toBe('https://example.com');
    expect(summary.results[0].text).toBe('our site');
  });

  it('extracts button URLs', async () => {
    const sections = [
      {
        id: 'sec-1',
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: {
          gridContents: [
            {
              content: {
                value: {
                  type: 55,
                  value: {
                    label: 'Book Now',
                    url: 'https://booking.example.com',
                  },
                },
              },
            },
          ],
        },
      },
    ];

    const summary = await extractAndValidateLinks(sections);
    expect(summary.total).toBe(1);
    expect(summary.results[0].href).toBe('https://booking.example.com');
  });

  it('deduplicates links by href', async () => {
    const sections = [
      {
        id: 'sec-1',
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: {
          gridContents: [
            {
              content: {
                value: {
                  type: 2,
                  value: {
                    html: '<p><a href="https://example.com">Link 1</a> and <a href="https://example.com">Link 2</a></p>',
                  },
                },
              },
            },
          ],
        },
      },
    ];

    const summary = await extractAndValidateLinks(sections);
    // Same href should be deduplicated
    expect(summary.total).toBe(1);
  });

  it('extracts image linkTo URLs', async () => {
    const sections = [
      {
        id: 'sec-1',
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: {
          gridContents: [
            {
              content: {
                value: {
                  type: 1337,
                  value: {
                    title: 'Hero Image',
                    altText: 'Hero',
                    linkTo: 'https://linked-page.example.com',
                  },
                },
              },
            },
          ],
        },
      },
    ];

    const summary = await extractAndValidateLinks(sections);
    expect(summary.total).toBe(1);
    expect(summary.results[0].href).toBe('https://linked-page.example.com');
  });

  it('handles sections with no links', async () => {
    const sections = [
      {
        id: 'sec-1',
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: {
          gridContents: [
            {
              content: {
                value: {
                  type: 2,
                  value: {
                    html: '<p>No links here</p>',
                  },
                },
              },
            },
          ],
        },
      },
    ];

    const summary = await extractAndValidateLinks(sections);
    expect(summary.total).toBe(0);
    expect(summary.allPassed).toBe(true);
  });
});
