import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { CollectionInfo, PageMetadata, CollectionItemsResult } from '../content-save.js';

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

// ── Sample data helpers ──────────────────────────────────────────────────

function makeCollectionsResponse(collections: Record<string, unknown>[]) {
  return { collections };
}

function makeSampleCollections(): Record<string, unknown>[] {
  return [
    {
      id: 'coll-home',
      urlId: 'home',
      title: 'Home',
      type: 1,
      itemCount: 0,
      enabled: true,
      ordering: 0,
      navigationTitle: 'Home',
    },
    {
      id: 'coll-about',
      urlId: 'about',
      title: 'About Us',
      type: 1,
      enabled: true,
      ordering: 1,
    },
    {
      id: 'coll-blog',
      urlId: 'blog',
      title: 'Blog',
      type: 2,
      itemCount: 15,
      enabled: true,
      ordering: 2,
      description: 'Our blog',
    },
    {
      id: 'coll-gallery',
      urlId: 'gallery',
      title: 'Gallery',
      type: 7,
      itemCount: 24,
      enabled: true,
      ordering: 3,
    },
    {
      id: 'coll-store',
      urlId: 'store',
      title: 'Shop',
      type: 5,
      enabled: false,
      ordering: 4,
    },
  ];
}

function makeSampleItems(): Record<string, unknown>[] {
  return [
    { id: 'item-1', title: 'First Post', urlId: 'first-post', status: 1, tags: ['news'] },
    { id: 'item-2', title: 'Draft Post', urlId: 'draft-post', status: 0, tags: ['draft'] },
    { id: 'item-3', title: 'Second Post', urlId: 'second-post', status: 1, tags: ['update'] },
  ];
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Collections', () => {
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

  // ── listCollections ──────────────────────────────────────────────────

  describe('listCollections()', () => {
    it('returns parsed CollectionInfo array', async () => {
      const collections = makeSampleCollections();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCollectionsResponse(collections),
      });

      const result = await client.listCollections();
      expect(result).toHaveLength(5);
      expect(result[0]).toMatchObject({
        id: 'coll-home',
        urlId: 'home',
        title: 'Home',
        type: 1,
        typeName: 'page',
      });
    });

    it('maps type numbers to typeName correctly', async () => {
      const collections = makeSampleCollections();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCollectionsResponse(collections),
      });

      const result = await client.listCollections();
      const typeMap: Record<string, string> = {};
      for (const c of result) typeMap[c.urlId] = c.typeName;

      expect(typeMap).toMatchObject({
        home: 'page',
        about: 'page',
        blog: 'blog',
        gallery: 'gallery',
        store: 'store',
      });
    });

    it('handles empty collections', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ collections: [] }),
      });

      const result = await client.listCollections();
      expect(result).toEqual([]);
    });

    it('handles API error gracefully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await client.listCollections();
      expect(result).toEqual([]);
    });

    it('returns itemCount and ordering when present', async () => {
      const collections = makeSampleCollections();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCollectionsResponse(collections),
      });

      const result = await client.listCollections();
      const blog = result.find((c) => c.urlId === 'blog')!;
      expect(blog.itemCount).toBe(15);
      expect(blog.ordering).toBe(2);
      expect(blog.description).toBe('Our blog');

      const about = result.find((c) => c.urlId === 'about')!;
      expect(about.itemCount).toBeUndefined();
      expect(about.description).toBeUndefined();
    });
  });

  // ── getPageMetadata ──────────────────────────────────────────────────

  describe('getPageMetadata()', () => {
    it('finds page by slug', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCollectionsResponse(makeSampleCollections()),
      });

      const result = await client.getPageMetadata('about');
      expect(result).not.toBeNull();
      expect(result!.collectionId).toBe('coll-about');
      expect(result!.title).toBe('About Us');
      expect(result!.typeName).toBe('page');
    });

    it('normalizes home slug variants', async () => {
      const homeSlugs = ['homepage', 'home-page', 'home', 'landing', 'index', 'main', ''];

      for (const slug of homeSlugs) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => makeCollectionsResponse(makeSampleCollections()),
        });

        const result = await client.getPageMetadata(slug);
        expect(result).not.toBeNull();
        expect(result!.collectionId).toBe('coll-home');
      }
    });

    it('returns null when page not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCollectionsResponse(makeSampleCollections()),
      });

      const result = await client.getPageMetadata('nonexistent');
      expect(result).toBeNull();
    });

    it('returns correct typeName', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => makeCollectionsResponse(makeSampleCollections()),
      });

      const result = await client.getPageMetadata('blog');
      expect(result).not.toBeNull();
      expect(result!.typeName).toBe('blog');
      expect(result!.type).toBe(2);
    });

    it('handles API error gracefully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await client.getPageMetadata('about');
      expect(result).toBeNull();
    });
  });

  // ── getCollectionItems ───────────────────────────────────────────────

  describe('getCollectionItems()', () => {
    it('returns items for a collection', async () => {
      const items = makeSampleItems();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items, total: items.length }),
      });

      const result = await client.getCollectionItems('coll-blog');
      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(3);
      expect(result.items![0].title).toBe('First Post');
      expect(result.total).toBe(3);
    });

    it('applies limit/offset params', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [makeSampleItems()[0]], total: 3 }),
      });

      await client.getCollectionItems('coll-blog', { limit: 1, offset: 0 });

      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('limit=1');
      expect(fetchUrl).toContain('offset=0');
    });

    it('filters by published status', async () => {
      const items = makeSampleItems();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items, total: items.length }),
      });

      const result = await client.getCollectionItems('coll-blog', { filter: 'published' });
      expect(result.success).toBe(true);
      // Only items with status === 1
      expect(result.items).toHaveLength(2);
      expect(result.items!.every((i) => (i as Record<string, unknown>).status === 1)).toBe(true);
    });

    it('filters by draft status', async () => {
      const items = makeSampleItems();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items, total: items.length }),
      });

      const result = await client.getCollectionItems('coll-blog', { filter: 'draft' });
      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items![0].title).toBe('Draft Post');
    });

    it('returns error for non-existent collection', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const result = await client.getCollectionItems('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('404');
    });
  });
});
