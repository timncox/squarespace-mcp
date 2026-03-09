import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  listColorThemes: vi.fn(),
  updateColorTheme: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
}));

import { registerSiteTools } from '../tools/site.js';

// Create a mock McpServer that captures registrations
function createMockServer() {
  const tools = new Map<string, { config: any; handler: Function }>();
  return {
    registerTool: vi.fn((name: string, config: any, handler: Function) => {
      tools.set(name, { config, handler });
    }),
    tools,
    callTool: async (name: string, params: any) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(params);
    },
  };
}

describe('Color Theme Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerSiteTools(server as any);
  });

  it('should register both color theme tools', () => {
    expect(server.tools.has('sq_list_color_themes')).toBe(true);
    expect(server.tools.has('sq_update_color_theme')).toBe(true);
  });

  // ── sq_list_color_themes ────────────────────────────────────────────────

  describe('sq_list_color_themes', () => {
    it('should return themes', async () => {
      mockClient.listColorThemes.mockResolvedValue({
        success: true,
        themes: [
          { themeName: 'white', mappingCount: 3 },
          { themeName: 'dark', mappingCount: 3 },
        ],
        defaultTheme: 'white',
      });

      const result = await server.callTool('sq_list_color_themes', { siteId: 'test-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.themes).toHaveLength(2);
      expect(data.themes[0].themeName).toBe('white');
      expect(data.defaultTheme).toBe('white');
    });

    it('should return error on failure', async () => {
      mockClient.listColorThemes.mockResolvedValue({
        success: false,
        error: 'Session expired',
      });

      const result = await server.callTool('sq_list_color_themes', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session expired');
    });
  });

  // ── sq_update_color_theme ───────────────────────────────────────────────

  describe('sq_update_color_theme', () => {
    it('should call service with correct args', async () => {
      mockClient.updateColorTheme.mockResolvedValue({
        success: true,
        themeName: 'dark',
        updatedMappings: 2,
      });

      const mappings = [
        { variableName: 'heading-color', colorName: 'accent' },
        { variableName: 'body-color', colorName: 'white', alphaModifier: 0.9 },
      ];

      const result = await server.callTool('sq_update_color_theme', {
        siteId: 'test-site',
        themeName: 'dark',
        mappings,
      });

      expect(mockClient.updateColorTheme).toHaveBeenCalledWith('dark', mappings);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.themeName).toBe('dark');
      expect(data.updatedMappings).toBe(2);
    });

    it('should return error on failure', async () => {
      mockClient.updateColorTheme.mockResolvedValue({
        success: false,
        error: 'Theme "nonexistent" not found. Available: white, dark',
      });

      const result = await server.callTool('sq_update_color_theme', {
        siteId: 'test-site',
        themeName: 'nonexistent',
        mappings: [{ variableName: 'heading-color', colorName: 'black' }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });
});
