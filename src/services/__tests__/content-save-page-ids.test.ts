import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';

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

// ── Tests ────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Page ID resolution', () => {
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

  // ── getPageSectionsIdByCollectionId ──────────────────────────────────

  describe('getPageSectionsIdByCollectionId()', () => {
    it('returns the id of the entry matching the collectionId', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 'ps-other', collectionId: 'coll-other', sections: [] },
          { id: 'ps-target', collectionId: 'coll-target', sections: [] },
        ],
      });

      const result = await client.getPageSectionsIdByCollectionId('coll-target');
      expect(result).toBe('ps-target');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/page-sections/by-collection-ids?collectionIds=coll-target'),
        expect.any(Object),
      );
    });

    it('returns null when no entry matches', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'ps-other', collectionId: 'coll-other', sections: [] }],
      });

      const result = await client.getPageSectionsIdByCollectionId('coll-missing');
      expect(result).toBeNull();
    });

    it('returns null on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const result = await client.getPageSectionsIdByCollectionId('coll-target');
      expect(result).toBeNull();
    });

    it('returns null on non-array response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'unexpected shape' }),
      });

      const result = await client.getPageSectionsIdByCollectionId('coll-target');
      expect(result).toBeNull();
    });

    it('returns null when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network down'));

      const result = await client.getPageSectionsIdByCollectionId('coll-target');
      expect(result).toBeNull();
    });
  });

  // ── getPageIds fallback chain ────────────────────────────────────────

  describe('getPageIds() by-collection-ids fallback', () => {
    const COLLECTIONS = {
      collections: [{ id: 'coll-menu', urlId: 'chicago-menu', title: 'Chicago Menu', type: 10 }],
    };

    it('falls back to by-collection-ids when GetCollectionSettings has no pageSectionsId', async () => {
      mockFetch
        // GetCollections
        .mockResolvedValueOnce({ ok: true, json: async () => COLLECTIONS })
        // GetCollectionSettings — modern shape: no mainContent/pageSectionsId/pageId
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'coll-menu', urlId: 'chicago-menu', title: 'Chicago Menu' }),
        })
        // by-collection-ids
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ id: 'ps-menu', collectionId: 'coll-menu', sections: [] }],
        });

      const result = await client.getPageIds('chicago-menu');
      expect(result).toEqual({ collectionId: 'coll-menu', pageSectionsId: 'ps-menu' });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('does not call by-collection-ids when GetCollectionSettings provides the id', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => COLLECTIONS })
        // Legacy shape: mainContent present
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'coll-menu', mainContent: 'ps-legacy' }),
        });

      const result = await client.getPageIds('chicago-menu');
      expect(result).toEqual({ collectionId: 'coll-menu', pageSectionsId: 'ps-legacy' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns collectionId with undefined pageSectionsId when every source fails', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => COLLECTIONS })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await client.getPageIds('chicago-menu');
      expect(result).toEqual({ collectionId: 'coll-menu', pageSectionsId: undefined });
    });
  });
});
