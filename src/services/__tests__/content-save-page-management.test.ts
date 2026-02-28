import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageDeleteResult, PageMetadataUpdateResult } from '../content-save.js';

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

describe('ContentSaveClient — Page Management APIs', () => {
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

  // ── deletePageViaApi ───────────────────────────────────────────────────

  describe('deletePageViaApi()', () => {
    it('returns success when DELETE succeeds', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'coll-123' }));

      const result = await client.deletePageViaApi('coll-123');
      expect(result.success).toBe(true);
      expect(result.collectionId).toBe('coll-123');
      expect(result.error).toBeUndefined();

      // Should have called DELETE
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toContain('/api/collections/coll-123');
      expect(fetchUrl).toContain('crumb=');
      expect(fetchOpts.method).toBe('DELETE');
    });

    it('returns error on 401 (session expired)', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401));

      const result = await client.deletePageViaApi('coll-123');
      expect(result.success).toBe(false);
      expect(result.collectionId).toBe('coll-123');
      expect(result.error).toContain('Session expired');
    });

    it('returns error on crumb failure', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ crumbFail: true }, 200),
      );

      const result = await client.deletePageViaApi('coll-123');
      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid or expired session crumb');
    });

    it('returns error on 404 (page not found)', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404));

      const result = await client.deletePageViaApi('nonexistent');
      expect(result.success).toBe(false);
      expect(result.collectionId).toBe('nonexistent');
      expect(result.error).toContain('404');
    });

    it('never throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.deletePageViaApi('coll-123');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('handles empty response body on successful DELETE', async () => {
      // Some DELETE endpoints return empty body
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
        text: async () => '',
      });

      const result = await client.deletePageViaApi('coll-123');
      expect(result.success).toBe(true);
      expect(result.collectionId).toBe('coll-123');
    });
  });

  // ── updatePageMetadata ─────────────────────────────────────────────────

  describe('updatePageMetadata()', () => {
    it('returns success with all fields updated', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'coll-123', title: 'New Title', urlId: 'new-slug' }),
      );

      const result = await client.updatePageMetadata('coll-123', {
        title: 'New Title',
        urlId: 'new-slug',
        description: 'New description',
        seoTitle: 'SEO Title',
        seoDescription: 'SEO Description',
        navigationTitle: 'Nav Title',
        enabled: true,
      });

      expect(result.success).toBe(true);
      expect(result.collectionId).toBe('coll-123');
      expect(result.updatedFields).toEqual([
        'title', 'urlId', 'description', 'seoTitle', 'seoDescription', 'navigationTitle', 'enabled',
      ]);

      // Verify PUT was sent with correct body
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toContain('/api/collections/coll-123');
      expect(fetchUrl).toContain('crumb=');
      expect(fetchOpts.method).toBe('PUT');

      const sentBody = JSON.parse(fetchOpts.body as string);
      expect(sentBody.title).toBe('New Title');
      expect(sentBody.urlId).toBe('new-slug');
      expect(sentBody.description).toBe('New description');
      expect(sentBody.seoTitle).toBe('SEO Title');
      expect(sentBody.seoDescription).toBe('SEO Description');
      expect(sentBody.navigationTitle).toBe('Nav Title');
      expect(sentBody.enabled).toBe(true);
    });

    it('handles partial updates (only title)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'coll-123', title: 'Updated Title' }),
      );

      const result = await client.updatePageMetadata('coll-123', {
        title: 'Updated Title',
      });

      expect(result.success).toBe(true);
      expect(result.updatedFields).toEqual(['title']);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(sentBody.title).toBe('Updated Title');
      expect(sentBody.urlId).toBeUndefined();
      expect(sentBody.description).toBeUndefined();
    });

    it('handles partial updates (only SEO fields)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'coll-123' }),
      );

      const result = await client.updatePageMetadata('coll-123', {
        seoTitle: 'Best Restaurant in NYC',
        seoDescription: 'Fine dining in Manhattan since 1985',
      });

      expect(result.success).toBe(true);
      expect(result.updatedFields).toEqual(['seoTitle', 'seoDescription']);
    });

    it('returns error when no fields provided', async () => {
      const result = await client.updatePageMetadata('coll-123', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('No fields provided');
      expect(result.updatedFields).toEqual([]);
      // Should NOT have called fetch
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns error on 401 (session expired)', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401));

      const result = await client.updatePageMetadata('coll-123', {
        title: 'New Title',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session expired');
      expect(result.updatedFields).toEqual([]);
    });

    it('returns error on crumb failure', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ crumbFail: true }, 200),
      );

      const result = await client.updatePageMetadata('coll-123', {
        title: 'New Title',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid or expired session crumb');
    });

    it('returns error on server error (500)', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500));

      const result = await client.updatePageMetadata('coll-123', {
        title: 'New Title',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });

    it('never throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.updatePageMetadata('coll-123', {
        title: 'New Title',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });

    it('handles enabled: false (disable page)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'coll-123', enabled: false }),
      );

      const result = await client.updatePageMetadata('coll-123', {
        enabled: false,
      });

      expect(result.success).toBe(true);
      expect(result.updatedFields).toEqual(['enabled']);

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(sentBody.enabled).toBe(false);
    });
  });
});
