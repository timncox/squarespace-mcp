import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock database ────────────────────────────────────────────────────────────

const mockGet = vi.fn();
const mockRun = vi.fn();
const mockPrepare = vi.fn(() => ({ get: mockGet, run: mockRun }));

vi.mock('../../db/database.js', () => ({
  getDb: vi.fn(() => ({ prepare: mockPrepare })),
}));

// ── Mock content-save ────────────────────────────────────────────────────────

const mockGetPageIds = vi.fn();
const mockLoadSessionCookies = vi.fn();

vi.mock('../content-save.js', () => ({
  createContentSaveClient: vi.fn(() => ({
    getPageIds: mockGetPageIds,
    loadSessionCookies: mockLoadSessionCookies,
  })),
}));

// ── Mock browser-manager ─────────────────────────────────────────────────────

const mockGetAttribute = vi.fn();
const mockGoto = vi.fn();

vi.mock('../../automation/browser-manager.js', () => ({
  getBrowserManager: vi.fn(() => ({
    getPage: vi.fn(async () => ({
      goto: mockGoto,
      getAttribute: mockGetAttribute,
    })),
  })),
}));

// ── Mock global fetch ────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Import after mocks ───────────────────────────────────────────────────────

import { resolvePageIds, cachePageIds } from '../page-id-resolver.js';

describe('page-id-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('cachePageIds', () => {
    it('inserts into the database', () => {
      cachePageIds('my-site', 'about', 'ps-123', 'col-456');

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE'),
      );
      expect(mockRun).toHaveBeenCalledWith('my-site', 'about', 'ps-123', 'col-456');
    });

    it('normalizes homepage slugs', () => {
      cachePageIds('my-site', 'homepage', 'ps-123', 'col-456');

      expect(mockRun).toHaveBeenCalledWith('my-site', 'home', 'ps-123', 'col-456');
    });

    it('normalizes home-page slug', () => {
      cachePageIds('my-site', 'home-page', 'ps-123', 'col-456');

      expect(mockRun).toHaveBeenCalledWith('my-site', 'home', 'ps-123', 'col-456');
    });

    it('normalizes landing slug', () => {
      cachePageIds('my-site', 'landing', 'ps-123', 'col-456');

      expect(mockRun).toHaveBeenCalledWith('my-site', 'home', 'ps-123', 'col-456');
    });
  });

  describe('resolvePageIds', () => {
    it('returns cached result when fresh', async () => {
      mockGet.mockReturnValue({
        page_sections_id: 'ps-cached',
        collection_id: 'col-cached',
        cached_at: new Date().toISOString(),
      });

      const result = await resolvePageIds('my-site', 'about');

      expect(result).toEqual({
        pageSectionsId: 'ps-cached',
        collectionId: 'col-cached',
      });
      // Should NOT have called fetch or getPageIds
      expect(mockGetPageIds).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('skips stale cache (>30 days)', async () => {
      const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      mockGet.mockReturnValue({
        page_sections_id: 'ps-old',
        collection_id: 'col-old',
        cached_at: staleDate,
      });

      // Set up resolution chain
      mockGetPageIds.mockResolvedValue({ collectionId: 'col-fresh' });
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '<article data-page-sections="ps-fresh">content</article>',
      });

      const result = await resolvePageIds('my-site', 'about');

      expect(result).toEqual({
        pageSectionsId: 'ps-fresh',
        collectionId: 'col-fresh',
      });
      expect(mockGetPageIds).toHaveBeenCalled();
    });

    it('resolves via API + HTML fetch on cache miss', async () => {
      mockGet.mockReturnValue(undefined); // no cache

      mockGetPageIds.mockResolvedValue({ collectionId: 'col-api' });
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '<html><article data-page-sections="ps-html">content</article></html>',
      });

      const result = await resolvePageIds('my-site', 'services');

      expect(result).toEqual({
        pageSectionsId: 'ps-html',
        collectionId: 'col-api',
      });
      // Should cache the result
      expect(mockRun).toHaveBeenCalledWith('my-site', 'services', 'ps-html', 'col-api');
    });

    it('falls back to browser when HTML fetch fails', async () => {
      mockGet.mockReturnValue(undefined);

      mockGetPageIds.mockResolvedValue({ collectionId: 'col-api' });
      mockFetch.mockResolvedValue({ ok: false });
      mockGetAttribute.mockResolvedValue('ps-browser');

      const result = await resolvePageIds('my-site', 'contact');

      expect(result).toEqual({
        pageSectionsId: 'ps-browser',
        collectionId: 'col-api',
      });
      expect(mockGetAttribute).toHaveBeenCalled();
    });

    it('returns null when collectionId cannot be resolved', async () => {
      mockGet.mockReturnValue(undefined);
      mockGetPageIds.mockResolvedValue(null);

      const result = await resolvePageIds('my-site', 'nonexistent');

      expect(result).toBeNull();
    });

    it('returns null when pageSectionsId cannot be resolved anywhere', async () => {
      mockGet.mockReturnValue(undefined);

      mockGetPageIds.mockResolvedValue({ collectionId: 'col-api' });
      mockFetch.mockResolvedValue({ ok: false });
      mockGetAttribute.mockResolvedValue(null);

      const result = await resolvePageIds('my-site', 'weird-page');

      expect(result).toBeNull();
    });

    it('normalizes homepage slug variants', async () => {
      mockGet.mockReturnValue({
        page_sections_id: 'ps-home',
        collection_id: 'col-home',
        cached_at: new Date().toISOString(),
      });

      const result = await resolvePageIds('my-site', 'homepage');

      expect(result).toEqual({
        pageSectionsId: 'ps-home',
        collectionId: 'col-home',
      });
      // Verify it queried with normalized slug
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockGet).toHaveBeenCalledWith('my-site', 'home');
    });

    it('handles getPageIds throwing an error gracefully', async () => {
      mockGet.mockReturnValue(undefined);
      mockGetPageIds.mockRejectedValue(new Error('Session expired'));

      const result = await resolvePageIds('my-site', 'about');

      expect(result).toBeNull();
    });

    it('handles HTML fetch returning no data-page-sections', async () => {
      mockGet.mockReturnValue(undefined);

      mockGetPageIds.mockResolvedValue({ collectionId: 'col-api' });
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '<html><body>No sections attribute here</body></html>',
      });
      mockGetAttribute.mockResolvedValue('ps-browser-fallback');

      const result = await resolvePageIds('my-site', 'blog');

      expect(result).toEqual({
        pageSectionsId: 'ps-browser-fallback',
        collectionId: 'col-api',
      });
    });
  });
});
