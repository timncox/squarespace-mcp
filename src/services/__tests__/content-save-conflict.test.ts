import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent, PageSectionsData, BlockLayout } from '../content-save.js';

// ── Mock session file ─────────────────────────────────────────────────────

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
    { name: 'member-session', value: 'member789', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

// ── Sample data helpers ──────────────────────────────────────────────────

const STUB_LAYOUT: BlockLayout = {
  mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 } },
  desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 3 } },
};

function makeTextBlock(blockId: string, html: string): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 2,
        value: { engine: 'wysiwyg', source: html, html, textAttributes: [] },
      },
    },
  };
}

function makeSections(...blocks: GridContent[]): PageSection[] {
  return [
    {
      id: 'section-1',
      sectionName: 'FLUID_ENGINE',
      fluidEngineContext: { gridContents: blocks },
    },
  ];
}

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return {
    id: 'page-sections-id-1',
    websiteId: 'website-id-1',
    collectionId: 'collection-id-1',
    sections,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Optimistic locking (conflict detection)', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('computeSectionsHash', () => {
    it('returns a consistent MD5 hex string for the same sections', () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
      const hash1 = ContentSaveClient.computeSectionsHash(sections);
      const hash2 = ContentSaveClient.computeSectionsHash(sections);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{32}$/);
    });

    it('returns different hashes for different sections', () => {
      const sections1 = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
      const sections2 = makeSections(makeTextBlock('b1', '<p>World</p>'));
      const hash1 = ContentSaveClient.computeSectionsHash(sections1);
      const hash2 = ContentSaveClient.computeSectionsHash(sections2);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('getPageSections stores hash in cache', () => {
    it('stores the sections hash on successful fetch', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
      const data = makePageSectionsData(sections);

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      await client.getPageSections('psid-1');

      const expectedHash = ContentSaveClient.computeSectionsHash(sections);
      expect(client._sectionsHashCache.get('psid-1')).toBe(expectedHash);
    });
  });

  describe('savePageSections conflict detection', () => {
    it('succeeds when no concurrent modification occurred', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // GET for getPageSections
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        // GET for conflict check in savePageSections (same data = no conflict)
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        // PUT for save
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      // Read first to populate hash cache
      await client.getPageSections('psid-1');
      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(true);
      // Conflict check GET + PUT = 2 calls after initial GET
      expect(fetchSpy.mock.calls).toHaveLength(3);
    });

    it('returns CONFLICT error when page was modified by another session', async () => {
      const originalSections = makeSections(makeTextBlock('b1', '<p>Original</p>'));
      const modifiedSections = makeSections(makeTextBlock('b1', '<p>Modified by someone else</p>'));
      const originalData = makePageSectionsData(originalSections);
      const modifiedData = makePageSectionsData(modifiedSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // GET for getPageSections (original)
        .mockResolvedValueOnce(new Response(JSON.stringify(originalData), { status: 200 }))
        // GET for conflict check (modified — different hash!)
        .mockResolvedValueOnce(new Response(JSON.stringify(modifiedData), { status: 200 }));

      // Read the original page
      await client.getPageSections('psid-1');

      // Try to save — should detect conflict
      const result = await client.savePageSections('psid-1', 'cid-1', originalSections);

      expect(result.success).toBe(false);
      expect(result.error).toContain('CONFLICT');
      expect(result.error).toContain('modified by another session');
      // Should NOT have made a PUT request
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('proceeds when conflict check fetch fails (does not block save)', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // GET for getPageSections
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        // GET for conflict check — network error
        .mockRejectedValueOnce(new Error('Network timeout'))
        // PUT for save — should proceed despite conflict check failure
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.getPageSections('psid-1');
      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(true);
      expect(fetchSpy.mock.calls).toHaveLength(3);
    });

    it('clears hash cache after successful save', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
      const data = makePageSectionsData(sections);

      vi.spyOn(globalThis, 'fetch')
        // GET for getPageSections
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        // GET for conflict check
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        // PUT for save
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.getPageSections('psid-1');
      expect(client._sectionsHashCache.has('psid-1')).toBe(true);

      await client.savePageSections('psid-1', 'cid-1', sections);
      expect(client._sectionsHashCache.has('psid-1')).toBe(false);
    });

    it('clears hash cache after conflict detection', async () => {
      const originalSections = makeSections(makeTextBlock('b1', '<p>Original</p>'));
      const modifiedSections = makeSections(makeTextBlock('b1', '<p>Modified</p>'));
      const originalData = makePageSectionsData(originalSections);
      const modifiedData = makePageSectionsData(modifiedSections);

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(originalData), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(modifiedData), { status: 200 }));

      await client.getPageSections('psid-1');
      expect(client._sectionsHashCache.has('psid-1')).toBe(true);

      await client.savePageSections('psid-1', 'cid-1', originalSections);
      expect(client._sectionsHashCache.has('psid-1')).toBe(false);
    });

    it('skips conflict check when no hash is cached (e.g., save without prior GET)', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // Only the PUT — no conflict check GET because no hash was cached
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(true);
      // Only 1 call (the PUT), no conflict check
      expect(fetchSpy.mock.calls).toHaveLength(1);
    });

    it('proceeds when conflict check returns HTTP error (non-ok response)', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // GET for getPageSections
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        // GET for conflict check — server error (will throw in _fetchPageSectionsRaw)
        .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
        // PUT for save — should proceed
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.getPageSections('psid-1');
      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(true);
      expect(fetchSpy.mock.calls).toHaveLength(3);
    });
  });
});
