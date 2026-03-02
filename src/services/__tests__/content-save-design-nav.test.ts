import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { UpdateNavigationItem, WebsiteFontsData, WebsiteColorsData } from '../content-save-types.js';

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
        { name: 'heading-font', fontValue: { fontFamily: 'Montserrat', fontWeight: 700, fontStyle: 'normal', textTransform: 'none', letterSpacing: { value: 0, unit: 'em' }, lineHeight: { value: 1.2, unit: 'em' } } },
        { name: 'body-font', fontValue: { fontFamily: 'Merriweather', fontWeight: 400, fontStyle: 'normal', textTransform: 'none', letterSpacing: { value: 0, unit: 'em' }, lineHeight: { value: 1.5, unit: 'em' } } },
      ],
      masterSizes: [
        { name: 'heading-1-size', value: { value: 2.5, unit: 'rem' } },
        { name: 'normal-text-size', value: { value: 1, unit: 'rem' } },
      ],
      fontMappings: [
        { name: 'site-title-font', fontMapping: 'heading-font', sizeMapping: 'heading-1-size' },
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
    expect(result.data!.masterFonts[0].fontValue.fontFamily).toBe('Montserrat');
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
        { id: 'white', value: { values: { hue: 0, saturation: 0, lightness: 100 }, userFormat: 'hex' } },
        { id: 'accent', value: { values: { hue: 210, saturation: 50, lightness: 40 }, userFormat: 'rgb' } },
      ],
      colorThemes: [
        {
          themeName: 'white',
          mappings: [
            { variableName: 'backgroundColor', paletteColorMapping: { colorName: 'white', alphaModifier: 1 } },
          ],
        },
        {
          themeName: 'dark',
          mappings: [
            { variableName: 'backgroundColor', paletteColorMapping: { colorName: 'accent', alphaModifier: 1 } },
          ],
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
    expect(result.data!.colorThemes[0].themeName).toBe('white');
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

// ── updateWebsiteFonts() ────────────────────────────────────────────────

describe('ContentSaveClient.updateWebsiteFonts()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const sampleFontData: WebsiteFontsData = {
    name: 'omnes',
    baseFontSize: 18,
    masterFonts: [
      { name: 'heading-font', fontValue: { fontFamily: 'Abel', fontWeight: 400, fontStyle: 'normal', textTransform: 'uppercase', letterSpacing: { value: 0, unit: 'em' }, lineHeight: { value: 1.2, unit: 'em' } } },
      { name: 'body-font', fontValue: { fontFamily: 'Lato', fontWeight: 400, fontStyle: 'normal', textTransform: 'none', letterSpacing: { value: 0, unit: 'em' }, lineHeight: { value: 1.5, unit: 'em' } } },
    ],
    masterSizes: [{ name: 'heading-1-size', value: { value: 2.5, unit: 'rem' } }],
    fontMappings: [{ name: 'site-title-font', fontMapping: 'heading-font', sizeMapping: 'heading-1-size' }],
  };

  it('sends PUT /api/website-fonts with full font data', async () => {
    const fetchMock = mockFetch([{ ok: true, status: 204, body: '' }]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updateWebsiteFonts(sampleFontData);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/website-fonts');
    expect(url).toContain('crumb=');
    expect(opts.method).toBe('PUT');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.name).toBe('omnes');
    expect(body.masterFonts).toHaveLength(2);
    expect(body.masterFonts[0].fontValue.fontFamily).toBe('Abel');
  });

  it('returns error on non-200 response', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false, status: 400, statusText: 'Bad Request', body: 'Invalid font data',
    }]));

    const client = makeClient();
    const result = await client.updateWebsiteFonts(sampleFontData);

    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
  });

  it('returns error on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Connection refused'); }));

    const client = makeClient();
    const result = await client.updateWebsiteFonts(sampleFontData);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});

// ── updateWebsiteColors() ───────────────────────────────────────────────

describe('ContentSaveClient.updateWebsiteColors()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const sampleColorData: WebsiteColorsData = {
    palette: [
      { id: 'white', value: { values: { hue: 0, saturation: 0, lightness: 100 }, userFormat: 'hex' } },
      { id: 'accent', value: { values: { hue: 210, saturation: 50, lightness: 40 }, userFormat: 'hex' } },
    ],
    colorThemes: [
      { themeName: 'white', mappings: [{ variableName: 'backgroundColor', paletteColorMapping: { colorName: 'white', alphaModifier: 1 } }] },
    ],
    defaultTheme: 'white',
  };

  it('sends PUT /api/website-colors with full color data and returns updated data', async () => {
    const responseData = { ...sampleColorData };
    const fetchMock = mockFetch([{ ok: true, body: responseData }]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updateWebsiteColors(sampleColorData);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/website-colors');
    expect(url).toContain('crumb=');
    expect(opts.method).toBe('PUT');

    const body = JSON.parse(opts.body);
    expect(body.palette).toHaveLength(2);
    expect(body.palette[0].id).toBe('white');
  });

  it('returns error on non-200 response', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false, status: 401, statusText: 'Unauthorized', body: 'Session expired',
    }]));

    const client = makeClient();
    const result = await client.updateWebsiteColors(sampleColorData);

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });
});

// ── updateFont() (convenience helper) ───────────────────────────────────

describe('ContentSaveClient.updateFont()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads current fonts, merges updates, and PUTs back', async () => {
    const fontData: WebsiteFontsData = {
      name: 'omnes',
      baseFontSize: 18,
      masterFonts: [
        { name: 'heading-font', fontValue: { fontFamily: 'Abel', fontWeight: 400, fontStyle: 'normal' } },
        { name: 'body-font', fontValue: { fontFamily: 'Lato', fontWeight: 400, fontStyle: 'normal' } },
      ],
      masterSizes: [],
      fontMappings: [],
    };

    const fetchMock = mockFetch([
      { ok: true, body: fontData },   // GET /api/website-fonts
      { ok: true, status: 204, body: '' },  // PUT /api/website-fonts
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updateFont('heading-font', { fontFamily: 'Playfair Display' });

    expect(result.success).toBe(true);
    expect(result.fontName).toBe('heading-font');
    expect(result.updatedFields).toContain('fontFamily');

    // Verify the PUT body has the updated font
    const putBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(putBody.masterFonts[0].fontValue.fontFamily).toBe('Playfair Display');
    // body-font should be unchanged
    expect(putBody.masterFonts[1].fontValue.fontFamily).toBe('Lato');
  });

  it('returns error when font name not found', async () => {
    const fontData: WebsiteFontsData = {
      name: 'omnes',
      masterFonts: [{ name: 'heading-font', fontValue: { fontFamily: 'Abel' } }],
      masterSizes: [],
      fontMappings: [],
    };

    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: fontData }]));

    const client = makeClient();
    const result = await client.updateFont('nonexistent-font', { fontFamily: 'Arial' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent-font');
    expect(result.error).toContain('heading-font');
  });

  it('returns error when no fields to update', async () => {
    const fontData: WebsiteFontsData = {
      name: 'omnes',
      masterFonts: [{ name: 'heading-font', fontValue: { fontFamily: 'Abel' } }],
      masterSizes: [],
      fontMappings: [],
    };

    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: fontData }]));

    const client = makeClient();
    const result = await client.updateFont('heading-font', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('No fields to update');
  });
});

// ── updatePaletteColor() (convenience helper) ───────────────────────────

describe('ContentSaveClient.updatePaletteColor()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads current colors, updates palette entry, and PUTs back', async () => {
    const colorData: WebsiteColorsData = {
      palette: [
        { id: 'accent', value: { values: { hue: 210, saturation: 50, lightness: 40 }, userFormat: 'hex' } },
        { id: 'white', value: { values: { hue: 0, saturation: 0, lightness: 100 }, userFormat: 'hex' } },
      ],
      colorThemes: [],
    };

    const fetchMock = mockFetch([
      { ok: true, body: colorData },          // GET /api/website-colors
      { ok: true, body: colorData },           // PUT /api/website-colors (returns updated)
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.updatePaletteColor('accent', { hue: 180, saturation: 60, lightness: 45 });

    expect(result.success).toBe(true);
    expect(result.colorId).toBe('accent');
    expect(result.oldValues).toEqual({ hue: 210, saturation: 50, lightness: 40 });
    expect(result.newValues).toEqual({ hue: 180, saturation: 60, lightness: 45 });

    // Verify the PUT body has the updated color
    const putBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(putBody.palette[0].value.values.hue).toBe(180);
    // white should be unchanged
    expect(putBody.palette[1].value.values.lightness).toBe(100);
  });

  it('returns error when color ID not found', async () => {
    const colorData: WebsiteColorsData = {
      palette: [{ id: 'accent', value: { values: { hue: 210, saturation: 50, lightness: 40 } } }],
      colorThemes: [],
    };

    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: colorData }]));

    const client = makeClient();
    const result = await client.updatePaletteColor('nonexistent', { hue: 0, saturation: 0, lightness: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('nonexistent');
    expect(result.error).toContain('accent');
  });
});

// ── getTemplateTweakSettings() ──────────────────────────────────────────

describe('ContentSaveClient.getTemplateTweakSettings()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns tweak settings on success', async () => {
    const tweakData = {
      'tweak-blog-side-by-side-image-aspect-ratio': '1:1 Square',
      'paragraphSmallColor': '#000000',
      'tweak-blog-item-show-date': 'true',
    };

    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: tweakData }]));

    const client = makeClient();
    const result = await client.getTemplateTweakSettings();

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!['paragraphSmallColor']).toBe('#000000');
    expect(Object.keys(result.data!)).toHaveLength(3);
  });

  it('fetches from GetTemplateTweakSettings?version=3', async () => {
    const fetchMock = mockFetch([{ ok: true, body: {} }]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    await client.getTemplateTweakSettings();

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/template/GetTemplateTweakSettings');
    expect(url).toContain('version=3');
    // GET should NOT have crumb
    expect(url).not.toContain('crumb=');
  });

  it('returns error on non-200 response', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false, status: 500, statusText: 'Internal Server Error', body: 'Error',
    }]));

    const client = makeClient();
    const result = await client.getTemplateTweakSettings();

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });
});

// ── setTemplateTweakSettings() ──────────────────────────────────────────

describe('ContentSaveClient.setTemplateTweakSettings()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads current tweaks, merges updates, and POSTs as URL-encoded', async () => {
    const currentTweaks = {
      'tweak-blog-item-show-date': 'true',
      'paragraphSmallColor': '#000000',
    };

    const fetchMock = mockFetch([
      { ok: true, body: currentTweaks },    // GET current tweaks
      { ok: true, body: '' },                // POST SetTemplateTweakSettings
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.setTemplateTweakSettings({
      'paragraphSmallColor': '#FF0000',
      'newTweak': 'added',
    });

    expect(result.success).toBe(true);

    // Verify POST URL has crumb
    const [postUrl, postOpts] = fetchMock.mock.calls[1];
    expect(postUrl).toContain('/api/template/SetTemplateTweakSettings');
    expect(postUrl).toContain('crumb=');
    expect(postOpts.method).toBe('POST');
    expect(postOpts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    // Verify merged body
    const bodyStr = postOpts.body as string;
    expect(bodyStr.startsWith('tweakJson=')).toBe(true);
    const decoded = JSON.parse(decodeURIComponent(bodyStr.replace('tweakJson=', '')));
    expect(decoded['tweak-blog-item-show-date']).toBe('true');  // preserved
    expect(decoded['paragraphSmallColor']).toBe('#FF0000');       // updated
    expect(decoded['newTweak']).toBe('added');                   // added
  });

  it('returns error when GET fails', async () => {
    vi.stubGlobal('fetch', mockFetch([{
      ok: false, status: 403, statusText: 'Forbidden', body: 'Access denied',
    }]));

    const client = makeClient();
    const result = await client.setTemplateTweakSettings({ 'key': 'value' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('403');
  });

  it('returns error when POST fails', async () => {
    const fetchMock = mockFetch([
      { ok: true, body: { 'existing': 'value' } },  // GET
      { ok: false, status: 400, statusText: 'Bad Request', body: 'Invalid tweaks' },  // POST
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const client = makeClient();
    const result = await client.setTemplateTweakSettings({ 'key': 'value' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('400');
  });
});
