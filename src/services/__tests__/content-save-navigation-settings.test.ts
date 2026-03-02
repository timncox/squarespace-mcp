import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })), // 1 hour old
}));

// ── Test helpers ──────────────────────────────────────────────────────────

function makeClient(): ContentSaveClient {
  const client = new ContentSaveClient('test-site');
  client.loadSessionCookies('/fake/session.json');
  return client;
}

function mockFetch(responses: Array<{ ok: boolean; status?: number; statusText?: string; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      statusText: resp.statusText ?? (resp.ok ? 'OK' : 'Internal Server Error'),
      json: async () => resp.body,
      text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)),
    };
  });
}

// ── getNavigation() ──────────────────────────────────────────────────────

describe('ContentSaveClient.getNavigation()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses mainNavigation and notLinked arrays', async () => {
    const rawResponse = {
      mainNavigation: [
        {
          id: 'nav-1',
          title: 'Home',
          urlId: 'home',
          collectionId: 'coll-1',
          collectionType: 10,
          enabled: true,
          draft: false,
          folder: false,
          ordering: 0,
          type: 'page',
        },
        {
          id: 'nav-2',
          navigationTitle: 'Blog',
          urlId: 'blog',
          collectionType: 1,
          enabled: true,
          ordering: 1,
          children: [
            { id: 'nav-2a', title: 'Latest', urlId: 'latest', ordering: 0 },
          ],
        },
      ],
      notLinked: [
        { id: 'nav-3', title: 'Draft Page', urlId: 'draft-page', draft: true },
      ],
    };

    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: rawResponse }]));

    const client = makeClient();
    const result = await client.getNavigation();

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const main = result.data!.mainNavigation;
    expect(main).toHaveLength(2);

    // First item — all fields populated
    expect(main[0].id).toBe('nav-1');
    expect(main[0].title).toBe('Home');
    expect(main[0].urlSlug).toBe('home');
    expect(main[0].collectionId).toBe('coll-1');
    expect(main[0].collectionType).toBe(10);
    expect(main[0].enabled).toBe(true);
    expect(main[0].isDraft).toBe(false);
    expect(main[0].isFolder).toBe(false);
    expect(main[0].ordering).toBe(0);
    expect(main[0].type).toBe('page');

    // Second item — uses navigationTitle fallback, has children
    expect(main[1].title).toBe('Blog');
    expect(main[1].children).toHaveLength(1);
    expect(main[1].children![0].id).toBe('nav-2a');
    expect(main[1].children![0].title).toBe('Latest');

    // Not linked
    const notLinked = result.data!.notLinked;
    expect(notLinked).toHaveLength(1);
    expect(notLinked[0].id).toBe('nav-3');
    expect(notLinked[0].isDraft).toBe(true);
  });

  it('returns empty arrays on empty response', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: {} }]));

    const client = makeClient();
    const result = await client.getNavigation();

    expect(result.success).toBe(true);
    expect(result.data!.mainNavigation).toEqual([]);
    expect(result.data!.notLinked).toEqual([]);
  });

  it('returns error on non-ok response', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      body: 'Access denied',
    }]));

    const client = makeClient();
    const result = await client.getNavigation();

    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
  });

  it('returns error on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network timeout'); }));

    const client = makeClient();
    const result = await client.getNavigation();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network timeout');
  });

  it('handles items with missing optional fields', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: true,
      body: {
        mainNavigation: [{ id: 'min-1', title: 'Minimal' }],
        notLinked: [],
      },
    }]));

    const client = makeClient();
    const result = await client.getNavigation();

    const item = result.data!.mainNavigation[0];
    expect(item.id).toBe('min-1');
    expect(item.title).toBe('Minimal');
    expect(item.urlSlug).toBe('');
    expect(item.collectionId).toBeUndefined();
    expect(item.collectionType).toBeUndefined();
    expect(item.enabled).toBeUndefined();
    expect(item.isDraft).toBeUndefined();
    expect(item.isFolder).toBeUndefined();
    expect(item.ordering).toBeUndefined();
    expect(item.children).toBeUndefined();
  });
});

// ── getSettings() ────────────────────────────────────────────────────────

describe('ContentSaveClient.getSettings()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns site settings on success', async () => {
    const settingsData = {
      siteTitle: 'My Site',
      siteDescription: 'A test site',
      businessName: 'Test Corp',
      contactEmail: 'test@example.com',
      contactPhoneNumber: '555-0100',
      commentsEnabled: true,
      isCookieBannerEnabled: false,
      seoHidden: false,
    };

    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: settingsData }]));

    const client = makeClient();
    const result = await client.getSettings();

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.siteTitle).toBe('My Site');
    expect(result.data!.businessName).toBe('Test Corp');
    expect(result.data!.commentsEnabled).toBe(true);
  });

  it('returns error on non-ok response', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      body: 'Session expired',
    }]));

    const client = makeClient();
    const result = await client.getSettings();

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns error on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('DNS lookup failed'); }));

    const client = makeClient();
    const result = await client.getSettings();

    expect(result.success).toBe(false);
    expect(result.error).toContain('DNS lookup failed');
  });
});

// ── updateSettings() ─────────────────────────────────────────────────────

describe('ContentSaveClient.updateSettings()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('merges fields and PUTs back', async () => {
    const currentSettings = {
      siteTitle: 'Old Title',
      siteDescription: 'Old description',
      businessName: 'Old Corp',
      contactEmail: 'old@example.com',
    };

    const fetchMock = mockFetch([
      { ok: true, body: currentSettings },  // GET
      { ok: true, body: {} },                // PUT
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updateSettings({
      siteTitle: 'New Title',
      businessName: 'New Corp',
    });

    expect(result.success).toBe(true);
    expect(result.updatedFields).toEqual(['siteTitle', 'businessName']);

    // Verify the PUT body contains merged data
    const putCall = fetchMock.mock.calls[1];
    const putBody = JSON.parse(putCall[1].body);
    expect(putBody.siteTitle).toBe('New Title');
    expect(putBody.businessName).toBe('New Corp');
    expect(putBody.siteDescription).toBe('Old description');  // Preserved
    expect(putBody.contactEmail).toBe('old@example.com');      // Preserved
  });

  it('appends crumb token to PUT URL', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: { siteTitle: 'Old' } },
      { ok: true, body: {} },
    ]));

    const client = makeClient();
    await client.updateSettings({ siteTitle: 'New' });

    const putCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(putCall[0]).toContain('crumb=');
  });

  it('returns error when no fields provided', async () => {
    const client = makeClient();
    const result = await client.updateSettings({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('No fields to update');
  });

  it('filters out undefined fields', async () => {
    const fetchMock = mockFetch([
      { ok: true, body: { siteTitle: 'Old', contactEmail: 'old@test.com' } },
      { ok: true, body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updateSettings({
      siteTitle: 'New',
      contactEmail: undefined,
    });

    expect(result.success).toBe(true);
    expect(result.updatedFields).toEqual(['siteTitle']);

    const putBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(putBody.siteTitle).toBe('New');
    expect(putBody.contactEmail).toBe('old@test.com');  // Unchanged
  });

  it('returns error when GET fails', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: 'Server error',
    }]));

    const client = makeClient();
    const result = await client.updateSettings({ siteTitle: 'New' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('GET /api/settings failed');
  });

  it('returns error when PUT fails', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: { siteTitle: 'Old' } },
      { ok: false, status: 400, statusText: 'Bad Request', body: 'Invalid field' },
    ]));

    const client = makeClient();
    const result = await client.updateSettings({ siteTitle: 'New' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('PUT /api/settings failed');
  });

  it('returns error on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Connection refused'); }));

    const client = makeClient();
    const result = await client.updateSettings({ siteTitle: 'New' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});
