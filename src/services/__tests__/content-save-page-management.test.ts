import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageCreateResult, PageDeleteResult, PageMetadataUpdateResult } from '../content-save.js';

// ── Mock session file ─────────────────────────────────────────────────────

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
  origins: [
    {
      origin: 'https://test-site.squarespace.com',
      localStorage: [
        {
          name: 'statsig.cached.evaluations.v2',
          value: JSON.stringify({ data: '{"website_id":"5f7c98d5b6fdce54b4c628af","member_account_id":"6012345678abcdef01234567"}' }),
        },
      ],
    },
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

  // ── createPageViaApi ───────────────────────────────────────────────────

  describe('createPageViaApi()', () => {
    it('creates a page via SaveCollectionSettings and adds to navigation', async () => {
      // 1. SaveCollectionSettings → success
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'new-page-id',
        urlId: 'staff',
        updatedOn: 1700000000000,
        websiteId: 'ws-abc123',
      }));
      // 2. GET /api/navigation → current nav
      mockFetch.mockResolvedValueOnce(jsonResponse({
        mainNavigation: [],
        notLinked: [{ collectionId: 'existing-1', title: 'Old Page' }],
      }));
      // 3. GET /api/commondata/GetSiteLayout → for updateNavigation
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      // 4. GET /api/template/GetTemplate → templateId
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'tmpl-123' }));
      // 5. POST /api/widget/UpdateNavigation → success
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'nav-123' }));

      const result = await client.createPageViaApi('Staff');

      expect(result.success).toBe(true);
      expect(result.pageId).toBe('new-page-id');
      expect(result.urlId).toBe('staff');

      // Verify SaveCollectionSettings was called
      const [createUrl, createOpts] = mockFetch.mock.calls[0];
      expect(createUrl).toContain('/api/commondata/SaveCollectionSettings');
      expect(createOpts.method).toBe('POST');
      const body = JSON.parse(createOpts.body);
      expect(body.collectionData.title).toBe('Staff');
      expect(body.collectionData.collectionType).toBe(10);
      expect(body.collectionData.typeName).toBe('page');
      expect(body.collectionData.websiteId).toBe('5f7c98d5b6fdce54b4c628af');
    });

    it('creates a blog collection with type 1', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'blog-id',
        urlId: 'news',
        updatedOn: 1700000000000,
      }));
      // Navigation calls
      mockFetch.mockResolvedValueOnce(jsonResponse({ mainNavigation: [], notLinked: [] }));
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'tmpl-123' }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'nav-123' }));

      const result = await client.createPageViaApi('News', undefined, { type: 1 });

      expect(result.success).toBe(true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.collectionData.collectionType).toBe(1);
      expect(body.collectionData.typeName).toBe('blog-single-column');
    });

    it('places page in mainNav when specified', async () => {
      // 1. POST /api/commondata/SaveCollectionSettings → page created
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'page-id',
        urlId: 'about',
        updatedOn: 1700000000000,
      }));
      // 2. GET /api/navigation → current nav (from addPageToNavigation)
      mockFetch.mockResolvedValueOnce(jsonResponse({
        mainNavigation: [{ collectionId: 'home', title: 'Home' }],
        notLinked: [],
      }));
      // 3. GET /api/rest/websites/mine → resolveTemplateId (from updateNavigation)
      mockFetch.mockResolvedValueOnce(jsonResponse({ templateId: 'tmpl-123' }));
      // 4. POST /api/widget/UpdateNavigation → success
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'nav-123' }));

      const result = await client.createPageViaApi('About', undefined, { navigation: 'mainNav' });

      expect(result.success).toBe(true);

      // Verify UpdateNavigation was called with mainNav (call index 3)
      const navCall = mockFetch.mock.calls[3];
      const navBody = JSON.parse(navCall[1].body);
      expect(navBody.fieldName).toBe('mainNav');
      // New page should be first, existing should follow
      expect(navBody.navigation.items).toHaveLength(2);
      expect(navBody.navigation.items[0].collectionId).toBe('page-id');
      expect(navBody.navigation.items[1].collectionId).toBe('home');
    });

    it('returns error on 401 (session expired)', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401));

      const result = await client.createPageViaApi('Test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Session expired');
    });

    it('returns error on crumb failure', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ crumbFail: true }));

      const result = await client.createPageViaApi('Test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid or expired session crumb');
    });

    it('returns success even if navigation update fails', async () => {
      // Page creation succeeds
      mockFetch.mockResolvedValueOnce(jsonResponse({
        id: 'page-id',
        urlId: 'test-page',
        updatedOn: 1700000000000,
      }));
      // Navigation fetch fails
      mockFetch.mockResolvedValueOnce(errorResponse(500));

      const result = await client.createPageViaApi('Test');
      // Page was created, so overall success
      expect(result.success).toBe(true);
      expect(result.pageId).toBe('page-id');
    });

    it('never throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.createPageViaApi('Test');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });
  });

  // ── deletePageViaApi ───────────────────────────────────────────────────

  describe('deletePageViaApi()', () => {
    it('returns success when DELETE succeeds', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'coll-123' }));

      const result = await client.deletePageViaApi('coll-123');
      expect(result.success).toBe(true);
      expect(result.collectionId).toBe('coll-123');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = mockFetch.mock.calls[0];
      expect(fetchUrl).toContain('/api/collections/coll-123');
      expect(fetchOpts.method).toBe('DELETE');
    });

    it('returns error when all strategies fail', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404)); // Strategy 1: DELETE fails
      mockFetch.mockResolvedValueOnce(errorResponse(500)); // Strategy 2: RemoveCollection fails
      mockFetch.mockResolvedValueOnce(errorResponse(500)); // Strategy 3: tryHidePageFromNav → getNavigation fails

      const result = await client.deletePageViaApi('coll-123');
      expect(result.success).toBe(false);
      expect(result.collectionId).toBe('coll-123');
      expect(result.error).toContain('All delete strategies failed');
    });

    it('never throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error')); // Strategy 1: DELETE fails
      mockFetch.mockResolvedValueOnce(errorResponse(500)); // Strategy 2: RemoveCollection fails
      mockFetch.mockResolvedValueOnce(errorResponse(500)); // Strategy 3: tryHidePageFromNav fails

      const result = await client.deletePageViaApi('coll-123');
      expect(result.success).toBe(false);
    });

    it('handles empty response body on successful DELETE', async () => {
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
