import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { UpdateNavigationItem } from '../content-save-types.js';

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

// ── updateNavigation() ──────────────────────────────────────────────────

describe('ContentSaveClient.updateNavigation()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls POST /api/widget/UpdateNavigation with correct body', async () => {
    const navItems: UpdateNavigationItem[] = [
      {
        title: 'Home',
        urlId: 'home',
        typeName: 'page',
        collectionId: 'coll-1',
        enabled: true,
        passwordProtected: false,
        collectionType: 10,
        isFolder: false,
        ordering: 0,
        updatedOn: 1700000000000,
        pagePermissionType: 1,
        isDraft: false,
        items: [],
        id: 'nav-1',
      },
    ];

    const fetchMock = mockFetch([
      { ok: true, body: { layout: [] } },                    // GetSiteLayout
      { ok: true, body: { id: 'template-id-123' } },         // GetTemplate
      { ok: true, body: {} },                                 // UpdateNavigation
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updateNavigation('mainNavigation', navItems);

    expect(result.success).toBe(true);

    // Verify the POST body
    const postCall = fetchMock.mock.calls[2];
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.fieldName).toBe('mainNavigation');
    expect(postBody.templateId).toBe('template-id-123');
    expect(postBody.navigation.items).toHaveLength(1);
    expect(postBody.navigation.items[0].title).toBe('Home');
  });

  it('fetches templateId from GetTemplate first', async () => {
    const fetchMock = mockFetch([
      { ok: true, body: { layout: [] } },                    // GetSiteLayout
      { ok: true, body: { templateId: 'tmpl-from-field' } }, // GetTemplate (uses templateId field)
      { ok: true, body: {} },                                 // UpdateNavigation
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updateNavigation('mainNavigation', []);

    expect(result.success).toBe(true);

    // Verify GetTemplate was called
    const templateCall = fetchMock.mock.calls[1];
    expect(templateCall[0]).toContain('/api/template/GetTemplate');

    // Verify templateId was used in the POST body
    const postBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(postBody.templateId).toBe('tmpl-from-field');
  });

  it('returns error when GetSiteLayout fails', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: 'Server error',
    }]));

    const client = makeClient();
    const result = await client.updateNavigation('mainNavigation', []);

    expect(result.success).toBe(false);
    expect(result.error).toContain('GetSiteLayout failed');
    expect(result.error).toContain('500');
  });

  it('returns error when templateId cannot be determined', async () => {
    const fetchMock = mockFetch([
      { ok: true, body: { layout: [] } },        // GetSiteLayout — ok
      { ok: true, body: {} },                     // GetTemplate — ok but no id field
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updateNavigation('mainNavigation', []);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not determine templateId');
  });

  it('returns error when UpdateNavigation returns non-200', async () => {
    const fetchMock = mockFetch([
      { ok: true, body: { layout: [] } },                    // GetSiteLayout
      { ok: true, body: { id: 'template-id-123' } },         // GetTemplate
      { ok: false, status: 400, statusText: 'Bad Request', body: 'Invalid navigation' }, // UpdateNavigation
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updateNavigation('mainNavigation', []);

    expect(result.success).toBe(false);
    expect(result.error).toContain('UpdateNavigation failed');
    expect(result.error).toContain('400');
  });

  it('includes crumb token in URL', async () => {
    const fetchMock = mockFetch([
      { ok: true, body: { layout: [] } },                    // GetSiteLayout
      { ok: true, body: { id: 'template-id-123' } },         // GetTemplate
      { ok: true, body: {} },                                 // UpdateNavigation
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    await client.updateNavigation('mainNavigation', []);

    // The UpdateNavigation POST URL should include the crumb
    const postCall = fetchMock.mock.calls[2];
    expect(postCall[0]).toContain('crumb=');
  });
});

// ── getWebsiteFonts() ───────────────────────────────────────────────────

describe('ContentSaveClient.getWebsiteFonts()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns font data on success', async () => {
    const fontData = {
      name: 'Montserrat + Merriweather',
      baseFontSize: 16,
      masterFonts: [
        { name: 'heading', font: 'Montserrat', weight: '700', style: 'normal' },
        { name: 'body', font: 'Merriweather', weight: '400', style: 'normal' },
      ],
      masterSizes: [
        { name: 'heading', size: '2.5rem' },
        { name: 'body', size: '1rem' },
      ],
      fontMappings: [
        { alias: 'h1', font: 'Montserrat', size: '2.5rem' },
      ],
    };

    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: fontData }]));

    const client = makeClient();
    const result = await client.getWebsiteFonts();

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.name).toBe('Montserrat + Merriweather');
    expect(result.data!.baseFontSize).toBe(16);
    expect(result.data!.masterFonts).toHaveLength(2);
    expect(result.data!.masterFonts[0].font).toBe('Montserrat');
  });

  it('returns error on non-200 response', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      body: 'Access denied',
    }]));

    const client = makeClient();
    const result = await client.getWebsiteFonts();

    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
    expect(result.error).toContain('Forbidden');
  });

  it('returns error on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Network timeout'); }));

    const client = makeClient();
    const result = await client.getWebsiteFonts();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network timeout');
  });
});

// ── getWebsiteColors() ──────────────────────────────────────────────────

describe('ContentSaveClient.getWebsiteColors()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns color data on success', async () => {
    const colorData = {
      palette: [
        { hue: 0, saturation: 0, lightness: 100 },
        { hue: 210, saturation: 50, lightness: 40 },
      ],
      colorThemes: [
        {
          name: 'white',
          values: {
            background: { paletteColorId: 'pal-0', alpha: 1 },
            text: { paletteColorId: 'pal-1', alpha: 1 },
          },
        },
        {
          name: 'dark',
          values: {
            background: { paletteColorId: 'pal-1', alpha: 1 },
            text: { paletteColorId: 'pal-0', alpha: 1 },
          },
        },
      ],
      defaultTheme: 'white',
    };

    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: colorData }]));

    const client = makeClient();
    const result = await client.getWebsiteColors();

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.palette).toHaveLength(2);
    expect(result.data!.colorThemes).toHaveLength(2);
    expect(result.data!.colorThemes[0].name).toBe('white');
    expect(result.data!.defaultTheme).toBe('white');
  });

  it('returns error on non-200 response', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      body: 'Session expired',
    }]));

    const client = makeClient();
    const result = await client.getWebsiteColors();

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).toContain('Unauthorized');
  });
});

// ── getAdvancedSettings() ───────────────────────────────────────────────

describe('ContentSaveClient.getAdvancedSettings()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns settings data on success', async () => {
    const settingsData = {
      urlMappings: [
        { from: '/old-page', to: '/new-page', statusCode: 301 },
      ],
      notFoundPage: '/custom-404',
      sslEnabled: true,
      passwordProtected: false,
    };

    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: settingsData }]));

    const client = makeClient();
    const result = await client.getAdvancedSettings();

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.urlMappings).toBeDefined();
    expect(result.data!.notFoundPage).toBe('/custom-404');
    expect(result.data!.sslEnabled).toBe(true);
  });

  it('returns error on non-200 response', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: 'Something broke',
    }]));

    const client = makeClient();
    const result = await client.getAdvancedSettings();

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
    expect(result.error).toContain('Internal Server Error');
  });

  it('returns error on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('DNS resolution failed'); }));

    const client = makeClient();
    const result = await client.getAdvancedSettings();

    expect(result.success).toBe(false);
    expect(result.error).toContain('DNS resolution failed');
  });
});
