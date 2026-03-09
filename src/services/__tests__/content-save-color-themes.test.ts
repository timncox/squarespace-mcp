import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { WebsiteColorsData } from '../content-save.js';

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

// ── Fixture data ──────────────────────────────────────────────────────────

const COLORS_FIXTURE: WebsiteColorsData = {
  palette: [
    { id: 'white', value: { values: { hue: 0, saturation: 0, lightness: 100 }, userFormat: 'hex' } },
    { id: 'black', value: { values: { hue: 0, saturation: 0, lightness: 0 }, userFormat: 'hex' } },
    { id: 'accent', value: { values: { hue: 32.82, saturation: 54.93, lightness: 58.24 }, userFormat: 'rgb' } },
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
    {
      themeName: 'light',
      mappings: [
        { variableName: 'heading-color', paletteColorMapping: { colorName: 'black', alphaModifier: 0.8 } },
      ],
    },
  ],
  defaultTheme: 'white',
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Color Theme Methods', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── listColorThemes ─────────────────────────────────────────────────

  describe('listColorThemes', () => {
    it('returns theme names and mapping counts', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }));

      const result = await client.listColorThemes();

      expect(result.success).toBe(true);
      expect(result.themes).toHaveLength(3);
      expect(result.themes![0]).toEqual({ themeName: 'white', mappingCount: 3 });
      expect(result.themes![1]).toEqual({ themeName: 'dark', mappingCount: 3 });
      expect(result.themes![2]).toEqual({ themeName: 'light', mappingCount: 1 });
    });

    it('returns defaultTheme', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }));

      const result = await client.listColorThemes();

      expect(result.success).toBe(true);
      expect(result.defaultTheme).toBe('white');
    });

    it('handles API error', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

      const result = await client.listColorThemes();

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });
  });

  // ── updateColorTheme ────────────────────────────────────────────────

  describe('updateColorTheme', () => {
    it('updates specific mappings', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }))  // GET
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));                            // PUT

      const result = await client.updateColorTheme('white', [
        { variableName: 'heading-color', colorName: 'accent' },
      ]);

      expect(result.success).toBe(true);
      expect(result.themeName).toBe('white');
      expect(result.updatedMappings).toBe(1);

      // Verify the PUT body has the updated mapping
      const [, putOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOpts.body as string);
      const whiteTheme = putBody.colorThemes.find((t: any) => t.themeName === 'white');
      const headingMapping = whiteTheme.mappings.find((m: any) => m.variableName === 'heading-color');
      expect(headingMapping.paletteColorMapping.colorName).toBe('accent');
    });

    it('preserves unmodified mappings', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.updateColorTheme('white', [
        { variableName: 'heading-color', colorName: 'accent' },
      ]);

      const [, putOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOpts.body as string);
      const whiteTheme = putBody.colorThemes.find((t: any) => t.themeName === 'white');

      // body-color and accent-color should be unchanged
      const bodyMapping = whiteTheme.mappings.find((m: any) => m.variableName === 'body-color');
      expect(bodyMapping.paletteColorMapping.colorName).toBe('black');
      expect(bodyMapping.paletteColorMapping.alphaModifier).toBe(1);

      const accentMapping = whiteTheme.mappings.find((m: any) => m.variableName === 'accent-color');
      expect(accentMapping.paletteColorMapping.colorName).toBe('accent');

      // All 3 original mappings should still be present
      expect(whiteTheme.mappings).toHaveLength(3);
    });

    it('returns error for unknown theme name', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }));

      const result = await client.updateColorTheme('nonexistent', [
        { variableName: 'heading-color', colorName: 'black' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.error).toContain('nonexistent');

      // Should NOT have made a PUT call
      expect(fetchSpy.mock.calls).toHaveLength(1);
    });

    it('adds new mappings that did not exist before', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateColorTheme('white', [
        { variableName: 'newVariable', colorName: 'accent', alphaModifier: 0.5 },
      ]);

      expect(result.success).toBe(true);
      expect(result.updatedMappings).toBe(1);

      const [, putOpts] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOpts.body as string);
      const whiteTheme = putBody.colorThemes.find((t: any) => t.themeName === 'white');

      // Should now have 4 mappings (3 original + 1 new)
      expect(whiteTheme.mappings).toHaveLength(4);

      const newMapping = whiteTheme.mappings.find((m: any) => m.variableName === 'newVariable');
      expect(newMapping).toBeDefined();
      expect(newMapping.paletteColorMapping.colorName).toBe('accent');
      expect(newMapping.paletteColorMapping.alphaModifier).toBe(0.5);
    });

    it('handles API write error', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(COLORS_FIXTURE), { status: 200 }))  // GET
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));                   // PUT

      const result = await client.updateColorTheme('white', [
        { variableName: 'heading-color', colorName: 'accent' },
      ]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });
  });
});
