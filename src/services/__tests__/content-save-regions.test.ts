import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ContentSaveClient,
  setRegionBasedPage,
  __clearRegionBasedPages,
} from '../content-save.js';
import type { PageSection } from '../content-save.js';

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

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const SUB = 'test-site';
const PSID = 'ps-1';
const COLL = 'coll-1';

/** A minimal section carrying editable content under `marker`. */
function section(id: string, marker: string): PageSection & { marker: string } {
  return { id, sectionName: 'FLUID_ENGINE', marker } as unknown as PageSection & { marker: string };
}

/** The regions document the modernized API serves, wrapping one section. */
function regionsDoc(marker: string) {
  return {
    regions: [
      {
        id: 'region-1',
        type: 'USER_PRIMARY',
        ownerId: COLL,
        sections: [{ ...section(PSID, marker), regionId: 'region-1', parentSectionId: null }],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, statusText: 'OK', text: async () => JSON.stringify(body), json: async () => body };
}

describe('ContentSaveClient — modernized (region-based) pages', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    vi.clearAllMocks();
    __clearRegionBasedPages();
    client = new ContentSaveClient(SUB);
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    __clearRegionBasedPages();
  });

  it('reads a flagged page from the regions document (fresh), not the legacy API', async () => {
    setRegionBasedPage(SUB, PSID, { collectionId: COLL, isRegionBased: true });
    mockFetch.mockResolvedValueOnce(jsonResponse(regionsDoc('FRESH')));

    const data = await client.getPageSections(PSID);

    // Hit the regions endpoint, not /api/page-sections/{psid}
    const url = String(mockFetch.mock.calls[0][0]);
    expect(url).toContain(`/api/pages/by-collection-id/${COLL}`);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(data.id).toBe(PSID);
    expect(data.sections).toHaveLength(1);
    expect((data.sections[0] as unknown as { marker: string }).marker).toBe('FRESH');
  });

  it('writes a flagged page back to the regions document, grafting edited content by id', async () => {
    setRegionBasedPage(SUB, PSID, { collectionId: COLL, isRegionBased: true });
    // savePageSectionsViaRegions re-fetches the doc, then PUTs it back.
    mockFetch
      .mockResolvedValueOnce(jsonResponse(regionsDoc('OLD'))) // GET regions doc
      .mockResolvedValueOnce(jsonResponse({}, 200)); // PUT

    const result = await client.savePageSections(PSID, COLL, [section(PSID, 'EDITED')]);

    expect(result.success).toBe(true);
    const putCall = mockFetch.mock.calls[1];
    expect(String(putCall[0])).toContain(`/api/pages/by-collection-id/${COLL}`);
    expect(putCall[1].method).toBe('PUT');
    const sentDoc = JSON.parse(putCall[1].body);
    const sentSection = sentDoc.regions[0].sections[0];
    expect(sentSection.marker).toBe('EDITED'); // our edit is applied
    expect(sentSection.regionId).toBe('region-1'); // region wrapper preserved
    expect(sentSection.parentSectionId).toBe(null);
  });

  it('refuses (does not revert) when an un-flagged page returns the standalone-400', async () => {
    // No flag set → the legacy PUT is attempted and 400s.
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        { message: 'Standalone-page section updates are not supported via this endpoint (collectionId=coll-1).' },
        400,
      ),
    );

    const result = await client.savePageSections(PSID, COLL, [section(PSID, 'EDITED')]);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/modernized content model/i);
    // Only the one legacy PUT — no write to the regions doc with stale content.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The page is now flagged so the next read uses the regions doc.
    mockFetch.mockResolvedValueOnce(jsonResponse(regionsDoc('FRESH')));
    const data = await client.getPageSections(PSID);
    expect(String(mockFetch.mock.calls[1][0])).toContain(`/api/pages/by-collection-id/${COLL}`);
    expect((data.sections[0] as unknown as { marker: string }).marker).toBe('FRESH');
  });
});
