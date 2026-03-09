import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';

// Mock session file
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

function makeClient(): ContentSaveClient {
  const client = new ContentSaveClient('test-site');
  client.loadSessionCookies('/fake/session.json');
  (client as any)._checkForConflict = async () => null;
  return client;
}

function mockFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      json: async () => resp.body,
      text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)),
    };
  });
}

// Helper: minimal page sections data with divider
function makeSections(divider?: Record<string, unknown>) {
  return {
    sections: [
      {
        id: 'sec-0',
        sectionName: 'FLUID_ENGINE',
        divider: divider ?? { enabled: false },
        styles: { sectionTheme: 'light' },
        fluidEngineContext: { id: 'fe-0', gridSettings: {}, gridContents: [] },
      },
      {
        id: 'sec-1',
        sectionName: 'FLUID_ENGINE',
        divider: { enabled: false },
        styles: { sectionTheme: 'dark' },
        fluidEngineContext: { id: 'fe-1', gridSettings: {}, gridContents: [] },
      },
    ],
  };
}

describe('ContentSaveClient — Section Divider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── updateSectionDivider ──────────────────────────────────────────────────

  describe('updateSectionDivider()', () => {
    it('enables a divider with type and default settings', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections() },   // GET page sections
        { ok: true, body: { sections: [] } }, // PUT save
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 0, {
        enabled: true,
        type: 'jagged',
      });

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('sec-0');

      // Verify the PUT body has the divider set
      const putCall = fetchMock.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      expect(putBody.sections[0].divider.enabled).toBe(true);
      expect(putBody.sections[0].divider.type).toBe('jagged');
    });

    it('merges partial updates onto existing divider', async () => {
      const existingDivider = {
        enabled: true,
        type: 'scalloped',
        width: { value: 100, unit: 'vw' },
        height: { value: 6, unit: 'vw' },
        isFlipX: false,
        isFlipY: false,
      };
      const fetchMock = mockFetch([
        { ok: true, body: makeSections(existingDivider) },
        { ok: true, body: { sections: [] } },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 0, {
        type: 'wavy',
        isFlipY: true,
      });

      expect(result.success).toBe(true);

      const putBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      const divider = putBody.sections[0].divider;
      // Changed fields
      expect(divider.type).toBe('wavy');
      expect(divider.isFlipY).toBe(true);
      // Preserved fields
      expect(divider.enabled).toBe(true);
      expect(divider.width).toEqual({ value: 100, unit: 'vw' });
      expect(divider.isFlipX).toBe(false);
    });

    it('returns error for out-of-bounds sectionIndex', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections() },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 5, {
        enabled: true,
        type: 'jagged',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of bounds');
    });

    it('returns error when GET fails', async () => {
      const fetchMock = mockFetch([
        { ok: false, status: 500, body: 'Server error' },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 0, {
        enabled: true,
        type: 'pointed',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns error when PUT fails', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections() },
        { ok: false, status: 400, body: 'Bad request' },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 0, {
        enabled: true,
        type: 'rounded',
      });

      expect(result.success).toBe(false);
    });
  });

  // ── removeSectionDivider ──────────────────────────────────────────────────

  describe('removeSectionDivider()', () => {
    it('disables an existing divider', async () => {
      const existingDivider = {
        enabled: true,
        type: 'jagged',
        width: { value: 100, unit: 'vw' },
        height: { value: 6, unit: 'vw' },
      };
      const fetchMock = mockFetch([
        { ok: true, body: makeSections(existingDivider) },
        { ok: true, body: { sections: [] } },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.removeSectionDivider('ps-1', 'col-1', 0);

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('sec-0');

      const putBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(putBody.sections[0].divider.enabled).toBe(false);
    });

    it('succeeds even if divider was already disabled', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections({ enabled: false }) },
        { ok: true, body: { sections: [] } },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.removeSectionDivider('ps-1', 'col-1', 0);

      expect(result.success).toBe(true);
    });

    it('returns error for out-of-bounds sectionIndex', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections() },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.removeSectionDivider('ps-1', 'col-1', 99);

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of bounds');
    });
  });
});
