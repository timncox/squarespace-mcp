import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { WebsiteFontsData, WebsiteColorsData } from '../content-save.js';

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

// ── Realistic fixture data (from actual GET responses) ──────────────────

const FONTS_FIXTURE: WebsiteFontsData = {
  name: 'libre-baskerville',
  baseFontSize: 16,
  masterFonts: [
    {
      name: 'heading-font',
      fontValue: {
        fontFamily: 'Libre Baskerville',
        fontStyle: 'normal',
        fontWeight: 400,
        textTransform: 'none',
        letterSpacing: { value: -0.02, unit: 'em' },
        lineHeight: { value: 1.2, unit: 'em' },
      },
    },
    {
      name: 'body-font',
      fontValue: {
        fontFamily: 'Almarai',
        fontStyle: 'normal',
        fontWeight: 400,
        textTransform: 'none',
        letterSpacing: { value: 0, unit: 'em' },
        lineHeight: { value: 1.5, unit: 'em' },
      },
    },
    {
      name: 'meta-font',
      fontValue: {
        fontFamily: 'Almarai',
        fontStyle: 'normal',
        fontWeight: 400,
        textTransform: 'none',
        letterSpacing: { value: 0, unit: 'em' },
        lineHeight: { value: 1.5, unit: 'em' },
      },
    },
  ],
  masterSizes: [
    { name: 'heading-1-size', value: { value: 4, unit: 'rem' } },
    { name: 'heading-2-size', value: { value: 2.8, unit: 'rem' } },
    { name: 'heading-3-size', value: { value: 2.2, unit: 'rem' } },
    { name: 'normal-text-size', value: { value: 1, unit: 'rem' } },
  ],
  fontMappings: [
    { name: 'site-title-font', fontMapping: 'heading-font', sizeMapping: 'normal-text-size' },
    { name: 'site-navigation-font', fontMapping: 'body-font', sizeMapping: 'normal-text-size' },
  ],
};

const COLORS_FIXTURE: WebsiteColorsData = {
  palette: [
    { id: 'white', value: { values: { hue: 0, saturation: 0, lightness: 100 }, userFormat: 'hex' } },
    { id: 'black', value: { values: { hue: 0, saturation: 0, lightness: 0 }, userFormat: 'hex' } },
    { id: 'safeLightAccent', value: { values: { hue: 32.82, saturation: 54.93, lightness: 58.24 }, userFormat: 'hex' } },
    { id: 'safeDarkAccent', value: { values: { hue: 32.82, saturation: 54.93, lightness: 58.24 }, userFormat: 'hex' } },
    { id: 'accent', value: { values: { hue: 32.82, saturation: 54.93, lightness: 58.24 }, userFormat: 'rgb' } },
    { id: 'lightAccent', value: { values: { hue: 0, saturation: 0, lightness: 98.04 }, userFormat: 'rgb' } },
    { id: 'darkAccent', value: { values: { hue: 32, saturation: 31.25, lightness: 18.82 }, userFormat: 'rgb' } },
  ],
  colorThemes: [
    {
      themeName: 'white',
      mappings: [
        { variableName: 'heading-color', paletteColorMapping: { colorName: 'black', alphaModifier: 1 } },
        { variableName: 'body-color', paletteColorMapping: { colorName: 'black', alphaModifier: 1 } },
        { variableName: 'accent-color', paletteColorMapping: { colorName: 'accent', alphaModifier: 1 } },
      ],
    },
    {
      themeName: 'dark',
      mappings: [
        { variableName: 'heading-color', paletteColorMapping: { colorName: 'white', alphaModifier: 1 } },
        { variableName: 'body-color', paletteColorMapping: { colorName: 'white', alphaModifier: 1 } },
        { variableName: 'accent-color', paletteColorMapping: { colorName: 'accent', alphaModifier: 1 } },
      ],
    },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Design Write Methods', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── updateWebsiteFonts ───────────────────────────────────────────────

  describe('updateWebsiteFonts', () => {
    it('PUTs to /api/website-fonts with full data', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const result = await client.updateWebsiteFonts(FONTS_FIXTURE);

      expect(result.success).toBe(true);

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/website-fonts');
      expect(options.method).toBe('PUT');

      const body = JSON.parse(options.body as string);
      expect(body.name).toBe('libre-baskerville');
      expect(body.masterFonts).toHaveLength(3);

      fetchSpy.mockRestore();
    });

    it('returns success on 204 response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const result = await client.updateWebsiteFonts(FONTS_FIXTURE);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      fetchSpy.mockRestore();
    });

    it('sends correct Content-Type and cookie headers', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.updateWebsiteFonts(FONTS_FIXTURE);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Cookie']).toContain('SS_SESSION_ID=sess123');

      fetchSpy.mockRestore();
    });

    it('includes crumb in URL', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.updateWebsiteFonts(FONTS_FIXTURE);

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('crumb=crumb-token-abc');

      fetchSpy.mockRestore();
    });

    it('handles error responses', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

      const result = await client.updateWebsiteFonts(FONTS_FIXTURE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');

      fetchSpy.mockRestore();
    });

    it('handles network errors gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Network timeout'));

      const result = await client.updateWebsiteFonts(FONTS_FIXTURE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');

      fetchSpy.mockRestore();
    });
  });

  // ── updateFont convenience helper ─────────────────────────────────────

  describe('updateFont', () => {
    it('GETs current fonts, modifies target font, PUTs back', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(FONTS_FIXTURE), { status: 200 }))  // GET
        .mockResolvedValueOnce(new Response(null, { status: 204 }));                             // PUT

      const result = await client.updateFont('heading-font', { fontFamily: 'Playfair Display' });

      expect(result.success).toBe(true);

      // Verify GET was called first
      const [getUrl, getOpts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(getUrl).toContain('/api/website-fonts');
      expect(getOpts.method).toBeUndefined(); // GET is the default

      // Verify PUT was called with modified data
      const [putUrl, putOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(putUrl).toContain('/api/website-fonts');
      expect(putOpts.method).toBe('PUT');

      const putBody = JSON.parse(putOpts.body as string);
      const headingFont = putBody.masterFonts.find((f: any) => f.name === 'heading-font');
      expect(headingFont.fontValue.fontFamily).toBe('Playfair Display');

      fetchSpy.mockRestore();
    });

    it('preserves other masterFonts entries when updating one', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(FONTS_FIXTURE), { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.updateFont('heading-font', { fontFamily: 'Georgia' });

      const [, putOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOpts.body as string);

      // Body font should be unchanged
      const bodyFont = putBody.masterFonts.find((f: any) => f.name === 'body-font');
      expect(bodyFont.fontValue.fontFamily).toBe('Almarai');

      // Meta font should be unchanged
      const metaFont = putBody.masterFonts.find((f: any) => f.name === 'meta-font');
      expect(metaFont.fontValue.fontFamily).toBe('Almarai');

      // All 3 fonts should still be present
      expect(putBody.masterFonts).toHaveLength(3);

      fetchSpy.mockRestore();
    });

    it('returns error if font name not found in masterFonts array', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(FONTS_FIXTURE), { status: 200 }));

      const result = await client.updateFont('nonexistent-font', { fontFamily: 'Arial' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');

      // Should NOT have made a PUT call
      expect(fetchSpy.mock.calls).toHaveLength(1);

      fetchSpy.mockRestore();
    });

    it('merges partial updates without overwriting other properties', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(FONTS_FIXTURE), { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      // Only update fontWeight — fontFamily should remain
      await client.updateFont('heading-font', { fontWeight: 700 });

      const [, putOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOpts.body as string);
      const headingFont = putBody.masterFonts.find((f: any) => f.name === 'heading-font');

      expect(headingFont.fontValue.fontWeight).toBe(700);
      expect(headingFont.fontValue.fontFamily).toBe('Libre Baskerville'); // preserved

      fetchSpy.mockRestore();
    });

    it('handles GET failure', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      const result = await client.updateFont('heading-font', { fontFamily: 'Arial' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      fetchSpy.mockRestore();
    });
  });

  // ── updateWebsiteColors ──────────────────────────────────────────────

  describe('updateWebsiteColors', () => {
    it('PUTs to /api/website-colors with full data', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateWebsiteColors(COLORS_FIXTURE);

      expect(result.success).toBe(true);

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/website-colors');
      expect(options.method).toBe('PUT');

      const body = JSON.parse(options.body as string);
      expect(body.palette).toHaveLength(7);
      expect(body.colorThemes).toHaveLength(2);

      fetchSpy.mockRestore();
    });

    it('returns success on 200 response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateWebsiteColors(COLORS_FIXTURE);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      fetchSpy.mockRestore();
    });

    it('sends correct headers', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.updateWebsiteColors(COLORS_FIXTURE);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Cookie']).toContain('SS_SESSION_ID=sess123');

      fetchSpy.mockRestore();
    });

    it('handles error responses', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

      const result = await client.updateWebsiteColors(COLORS_FIXTURE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('400');

      fetchSpy.mockRestore();
    });

    it('handles network errors gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.updateWebsiteColors(COLORS_FIXTURE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');

      fetchSpy.mockRestore();
    });
  });

  // ── updatePaletteColor convenience helper ─────────────────────────────

  describe('updatePaletteColor', () => {
    it('GETs current colors, finds palette entry by id, updates HSL values', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }))  // GET
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));                            // PUT

      const result = await client.updatePaletteColor('accent', { hue: 200, saturation: 80, lightness: 50 });

      expect(result.success).toBe(true);

      // Verify GET was called
      const [getUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(getUrl).toContain('/api/website-colors');

      // Verify PUT was called with updated color
      const [putUrl, putOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(putUrl).toContain('/api/website-colors');
      expect(putOpts.method).toBe('PUT');

      const putBody = JSON.parse(putOpts.body as string);
      const accentColor = putBody.palette.find((c: any) => c.id === 'accent');
      expect(accentColor.value.values.hue).toBe(200);
      expect(accentColor.value.values.saturation).toBe(80);
      expect(accentColor.value.values.lightness).toBe(50);

      fetchSpy.mockRestore();
    });

    it('preserves other palette entries', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.updatePaletteColor('accent', { hue: 180, saturation: 60, lightness: 45 });

      const [, putOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOpts.body as string);

      // Other palette entries should be unchanged
      const white = putBody.palette.find((c: any) => c.id === 'white');
      expect(white.value.values.hue).toBe(0);
      expect(white.value.values.saturation).toBe(0);
      expect(white.value.values.lightness).toBe(100);

      const black = putBody.palette.find((c: any) => c.id === 'black');
      expect(black.value.values.hue).toBe(0);
      expect(black.value.values.lightness).toBe(0);

      // All palette entries should still be present
      expect(putBody.palette).toHaveLength(7);

      fetchSpy.mockRestore();
    });

    it('returns error if color id not found', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }));

      const result = await client.updatePaletteColor('nonexistentColor', { hue: 0, saturation: 0, lightness: 50 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');

      // Should NOT have made a PUT call
      expect(fetchSpy.mock.calls).toHaveLength(1);

      fetchSpy.mockRestore();
    });

    it('preserves colorThemes when updating palette', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.updatePaletteColor('accent', { hue: 120, saturation: 50, lightness: 50 });

      const [, putOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOpts.body as string);

      // colorThemes should be unchanged
      expect(putBody.colorThemes).toHaveLength(2);
      expect(putBody.colorThemes[0].themeName).toBe('white');

      fetchSpy.mockRestore();
    });

    it('handles GET failure', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await client.updatePaletteColor('accent', { hue: 0, saturation: 0, lightness: 0 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');

      fetchSpy.mockRestore();
    });
  });

  // ── saveAdvancedSettings ─────────────────────────────────────────────

  describe('saveAdvancedSettings', () => {
    const ADVANCED_SETTINGS_DATA = {
      mappings: '/old-page -> /new-page\n/blog -> /news',
    };

    it('POSTs to /api/config/SaveAdvancedSettings', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.saveAdvancedSettings(ADVANCED_SETTINGS_DATA);

      expect(result.success).toBe(true);

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/api/config/SaveAdvancedSettings');
      expect(options.method).toBe('POST');

      fetchSpy.mockRestore();
    });

    it('uses application/x-www-form-urlencoded content type (NOT application/json)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.saveAdvancedSettings(ADVANCED_SETTINGS_DATA);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = options.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      fetchSpy.mockRestore();
    });

    it('includes crumb in URL', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.saveAdvancedSettings(ADVANCED_SETTINGS_DATA);

      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('crumb=crumb-token-abc');

      fetchSpy.mockRestore();
    });

    it('encodes body as form data', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.saveAdvancedSettings(ADVANCED_SETTINGS_DATA);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = options.body as string;
      // Should be URL-encoded, not JSON
      expect(body).toContain('mappings=');
      expect(() => JSON.parse(body)).toThrow(); // NOT valid JSON

      fetchSpy.mockRestore();
    });

    it('handles error responses', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

      const result = await client.saveAdvancedSettings(ADVANCED_SETTINGS_DATA);

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');

      fetchSpy.mockRestore();
    });

    it('handles network errors gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Connection reset'));

      const result = await client.saveAdvancedSettings(ADVANCED_SETTINGS_DATA);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection reset');

      fetchSpy.mockRestore();
    });
  });

  // ── Type validation ──────────────────────────────────────────────────

  describe('type validation', () => {
    it('WebsiteFontsData has correct structure', () => {
      expect(FONTS_FIXTURE.name).toBe('libre-baskerville');
      expect(FONTS_FIXTURE.baseFontSize).toBe(16);
      expect(FONTS_FIXTURE.masterFonts).toBeInstanceOf(Array);
      expect(FONTS_FIXTURE.masterSizes).toBeInstanceOf(Array);
      expect(FONTS_FIXTURE.fontMappings).toBeInstanceOf(Array);

      // Verify MasterFont structure (nested fontValue)
      const headingFont = FONTS_FIXTURE.masterFonts[0];
      expect(headingFont.name).toBe('heading-font');
      expect(headingFont.fontValue.fontFamily).toBe('Libre Baskerville');
      expect(headingFont.fontValue.fontWeight).toBe(400);
      expect(headingFont.fontValue.letterSpacing).toEqual({ value: -0.02, unit: 'em' });
    });

    it('WebsiteColorsData has correct structure', () => {
      expect(COLORS_FIXTURE.palette).toBeInstanceOf(Array);
      expect(COLORS_FIXTURE.colorThemes).toBeInstanceOf(Array);

      // Verify PaletteColor structure (nested value.values)
      const accent = COLORS_FIXTURE.palette.find(c => c.id === 'accent');
      expect(accent).toBeDefined();
      expect(accent!.value.values.hue).toBe(32.82);
      expect(accent!.value.values.saturation).toBe(54.93);
      expect(accent!.value.values.lightness).toBe(58.24);
      expect(accent!.value.userFormat).toBe('rgb');
    });

    it('ColorTheme structure has proper mappings', () => {
      const whiteTheme = COLORS_FIXTURE.colorThemes[0];
      expect(whiteTheme.themeName).toBe('white');
      expect(whiteTheme.mappings).toBeDefined();
      expect(whiteTheme.mappings[0]).toEqual({
        variableName: 'heading-color',
        paletteColorMapping: { colorName: 'black', alphaModifier: 1 },
      });
    });

    it('MasterFont entries have required name and fontValue fields', () => {
      for (const font of FONTS_FIXTURE.masterFonts) {
        expect(font.name).toBeDefined();
        expect(font.fontValue).toBeDefined();
        expect(font.fontValue.fontFamily).toBeDefined();
        expect(typeof font.name).toBe('string');
        expect(typeof font.fontValue.fontFamily).toBe('string');
      }
    });

    it('palette entries have required id and nested HSL fields', () => {
      for (const color of COLORS_FIXTURE.palette) {
        expect(color.id).toBeDefined();
        expect(typeof color.value.values.hue).toBe('number');
        expect(typeof color.value.values.saturation).toBe('number');
        expect(typeof color.value.values.lightness).toBe('number');
      }
    });
  });
});
