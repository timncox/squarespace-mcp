import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, PageSectionsData, BlockLayout, GridContent } from '../content-save.js';

// ── Mock session file ─────────────────────────────────────────────────────

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'SS_ANALYTICS_ID', value: 'analytics456', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
    { name: 'member-session', value: 'member789', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

// ── Mock fs module ────────────────────────────────────────────────────────

// Default: session file is 30 hours old (stale)
const STALE_MTIME = Date.now() - 30 * 60 * 60 * 1000;
// Fresh: session file is 1 hour old
const FRESH_MTIME = Date.now() - 1 * 60 * 60 * 1000;

let mockMtimeMs = STALE_MTIME;

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: mockMtimeMs })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

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
        value: {
          engine: 'wysiwyg',
          source: html,
          html,
          textAttributes: [],
        },
      },
    },
  };
}

function makeSections(...blocks: GridContent[]): PageSection[] {
  return [
    {
      id: 'section-1',
      sectionName: 'FLUID_ENGINE',
      fluidEngineContext: {
        gridContents: blocks,
      },
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

describe('ContentSaveClient — auth error detection', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    mockMtimeMs = STALE_MTIME; // default to stale session
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── savePageSections auth error enhancement ──────────────────────────

  describe('savePageSections — auth error detection', () => {
    it('returns enhanced error when 500 + "Something went wrong" + cleaned:true (stale session)', async () => {
      const sections = makeSections(makeTextBlock('block-1', '<p>Hi</p>'));
      const authErrorBody = JSON.stringify({
        cleaned: true,
        message: 'Something went wrong',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(authErrorBody, { status: 500, statusText: 'Server Error' }));

      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Save failed: 500');
      expect(result.error).toContain('EXPIRED SESSION');
      expect(result.error).toContain('sq_login');
      // Should include session age since we loaded a stale session
      expect(result.error).toContain('30h old');

      fetchSpy.mockRestore();
    });

    it('returns enhanced error when 401 + loginRequired', async () => {
      const sections = makeSections(makeTextBlock('block-1', '<p>Hi</p>'));
      const authBody = JSON.stringify({ loginRequired: true });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(authBody, { status: 401, statusText: 'Unauthorized' }));

      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Save failed: 401');
      expect(result.error).toContain('EXPIRED SESSION');
      expect(result.error).toContain('sq_login');

      fetchSpy.mockRestore();
    });

    it('returns normal error when 500 + non-auth body', async () => {
      const sections = makeSections(makeTextBlock('block-1', '<p>Hi</p>'));
      const normalErrorBody = JSON.stringify({ error: 'Invalid block structure' });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(normalErrorBody, { status: 500, statusText: 'Server Error' }));

      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Save failed: 500');
      // Should NOT contain auth enhancement
      expect(result.error).not.toContain('EXPIRED SESSION');
      expect(result.error).not.toContain('sq_login');

      fetchSpy.mockRestore();
    });

    it('returns enhanced error when 500 + "errorKey" pattern', async () => {
      const sections = makeSections(makeTextBlock('block-1', '<p>Hi</p>'));
      const errorKeyBody = JSON.stringify({
        message: 'Something went wrong.',
        errorKey: 'auth.session.expired',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(errorKeyBody, { status: 500, statusText: 'Server Error' }));

      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(false);
      expect(result.error).toContain('EXPIRED SESSION');
      expect(result.error).toContain('sq_login');

      fetchSpy.mockRestore();
    });

    it('returns enhanced error when 403 Forbidden', async () => {
      const sections = makeSections(makeTextBlock('block-1', '<p>Hi</p>'));

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }));

      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(false);
      expect(result.error).toContain('EXPIRED SESSION');

      fetchSpy.mockRestore();
    });

    it('includes session age in enhanced error when session is loaded', async () => {
      // Use a fresh session to verify the age is reported correctly
      mockMtimeMs = FRESH_MTIME;
      const freshClient = new ContentSaveClient('test-site');
      freshClient.loadSessionCookies('/fake/session.json');

      const sections = makeSections(makeTextBlock('block-1', '<p>Hi</p>'));
      const authBody = JSON.stringify({ loginRequired: true });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(authBody, { status: 401, statusText: 'Unauthorized' }));

      const result = await freshClient.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(false);
      expect(result.error).toContain('1h old');

      fetchSpy.mockRestore();
    });
  });

  // ── getPageSections auth error enhancement ───────────────────────────

  describe('getPageSections — auth error detection', () => {
    it('throws enhanced error when 401', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));

      await expect(client.getPageSections('psid-1')).rejects.toThrow('EXPIRED SESSION');

      fetchSpy.mockRestore();
    });

    it('throws enhanced error when 500 + auth pattern', async () => {
      const authBody = JSON.stringify({
        cleaned: true,
        message: 'Something went wrong',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(authBody, { status: 500, statusText: 'Server Error' }));

      await expect(client.getPageSections('psid-1')).rejects.toThrow('EXPIRED SESSION');

      fetchSpy.mockRestore();
    });

    it('throws normal error when 500 + non-auth body', async () => {
      const normalBody = JSON.stringify({ error: 'Invalid page ID' });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(normalBody, { status: 500, statusText: 'Server Error' }));

      try {
        await client.getPageSections('psid-1');
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('Failed to fetch page sections: 500');
        expect(err.message).not.toContain('EXPIRED SESSION');
      }

      fetchSpy.mockRestore();
    });

    it('throws normal error when 404', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Not Found', { status: 404, statusText: 'Not Found' }));

      try {
        await client.getPageSections('psid-1');
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('404');
        expect(err.message).not.toContain('EXPIRED SESSION');
      }

      fetchSpy.mockRestore();
    });
  });
});
