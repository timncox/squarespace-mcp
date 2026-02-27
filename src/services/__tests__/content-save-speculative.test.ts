import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageCreateResult, BlogPostCreateResult } from '../content-save.js';

// ── Mock session file ─────────────────────────────────────────────────────

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({ error: `Error ${status}` }),
    text: async () => `Error ${status}`,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Speculative APIs', () => {
  let client: ContentSaveClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── createPageViaApi ─────────────────────────────────────────────────

  describe('createPageViaApi()', () => {
    it('returns success when first endpoint works', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'page-123', urlId: 'new-page' }),
      );

      const result = await client.createPageViaApi('New Page', 'new-page');
      expect(result.success).toBe(true);
      expect(result.endpointAvailable).toBe(true);
      expect(result.pageId).toBe('page-123');
      expect(result.urlId).toBe('new-page');

      // Should have only called once (first endpoint worked)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('/api/content/add/page');
    });

    it('tries fallback endpoints when first returns 404', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(404))  // /api/content/add/page
        .mockResolvedValueOnce(                       // /api/pages
          jsonResponse({ id: 'page-456', urlId: 'fallback-page' }),
        );

      const result = await client.createPageViaApi('Fallback Page', 'fallback-page');
      expect(result.success).toBe(true);
      expect(result.endpointAvailable).toBe(true);
      expect(result.pageId).toBe('page-456');

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns endpointAvailable: false when all return 404', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(404))  // /api/content/add/page
        .mockResolvedValueOnce(errorResponse(405))  // /api/pages
        .mockResolvedValueOnce(errorResponse(404)); // /api/collections

      const result = await client.createPageViaApi('No Endpoint', 'no-endpoint');
      expect(result.success).toBe(false);
      expect(result.endpointAvailable).toBe(false);
      expect(result.error).toContain('No page creation endpoint found');
    });

    it('returns endpointAvailable: true with error on 401', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401));

      const result = await client.createPageViaApi('Unauthorized', 'unauth');
      expect(result.success).toBe(false);
      expect(result.endpointAvailable).toBe(true);
      expect(result.error).toContain('401');
    });

    it('never throws on any error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.createPageViaApi('Error Page', 'error');
      expect(result.success).toBe(false);
      expect(result.endpointAvailable).toBe(true);
      expect(result.error).toContain('Network error');
    });
  });

  // ── createBlogPost ───────────────────────────────────────────────────

  describe('createBlogPost()', () => {
    it('returns success when endpoint works', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'post-123', urlId: 'my-post' }),
      );

      const result = await client.createBlogPost('coll-blog', 'My Post');
      expect(result.success).toBe(true);
      expect(result.endpointAvailable).toBe(true);
      expect(result.itemId).toBe('post-123');
      expect(result.urlId).toBe('my-post');
    });

    it('sends correct body with title, body, tags', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'post-456', urlId: 'tagged-post' }),
      );

      await client.createBlogPost('coll-blog', 'Tagged Post', {
        body: '<p>Hello world</p>',
        tags: ['news', 'update'],
        categories: ['general'],
        excerpt: 'A summary',
        slug: 'tagged-post',
      });

      const fetchCall = mockFetch.mock.calls[0];
      const sentBody = JSON.parse(fetchCall[1].body as string);
      expect(sentBody.title).toBe('Tagged Post');
      expect(sentBody.body).toBe('<p>Hello world</p>');
      expect(sentBody.tags).toEqual(['news', 'update']);
      expect(sentBody.categories).toEqual(['general']);
      expect(sentBody.excerpt).toBe('A summary');
      expect(sentBody.urlId).toBe('tagged-post');
    });

    it('returns endpointAvailable: false on 404', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404));

      const result = await client.createBlogPost('coll-blog', 'Not Found');
      expect(result.success).toBe(false);
      expect(result.endpointAvailable).toBe(false);
    });

    it('handles draft flag', async () => {
      // Default: draft = true
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'post-draft', urlId: 'draft-post' }),
      );
      await client.createBlogPost('coll-blog', 'Draft Post');
      let sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(sentBody.draft).toBe(true);

      // Explicit: draft = false
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'post-pub', urlId: 'pub-post' }),
      );
      await client.createBlogPost('coll-blog', 'Published Post', { draft: false });
      sentBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
      expect(sentBody.draft).toBe(false);
    });

    it('never throws on any error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.createBlogPost('coll-blog', 'Error Post');
      expect(result.success).toBe(false);
      expect(result.endpointAvailable).toBe(true);
      expect(result.error).toContain('Connection refused');
    });
  });
});
