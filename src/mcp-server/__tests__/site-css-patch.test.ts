import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  getCustomCSS: vi.fn(),
  saveCustomCSS: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getWebsiteFonts: vi.fn(),
  getWebsiteColors: vi.fn(),
  getTemplateTweakSettings: vi.fn(),
  updateFont: vi.fn(),
  updatePaletteColor: vi.fn(),
  setTemplateTweakSettings: vi.fn(),
  getCodeInjection: vi.fn(),
  saveCodeInjection: vi.fn(),
  getSocialAccounts: vi.fn(),
  addSocialAccount: vi.fn(),
  removeSocialAccount: vi.fn(),
  getSiteIdentity: vi.fn(),
  updateSiteIdentity: vi.fn(),
  getAdvancedSettings: vi.fn(),
  saveAdvancedSettings: vi.fn(),
  getHeaderFooter: vi.fn(),
  saveHeaderFooter: vi.fn(),
  patchCustomCSS: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  listSites: vi.fn(() => []),
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

describe('sq_patch_css Tool', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerSiteTools(server as any);
  });

  it('should register sq_patch_css tool', () => {
    expect(server.tools.has('sq_patch_css')).toBe(true);
  });

  it('should add CSS rule to end', async () => {
    mockClient.patchCustomCSS.mockResolvedValue({ success: true, appliedOps: 1 });

    const result = await server.callTool('sq_patch_css', {
      siteId: 'test-site',
      operations: [
        { action: 'add', css: '.new-class { color: red; }' },
      ],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.appliedOps).toBe(1);
    expect(mockClient.patchCustomCSS).toHaveBeenCalledWith([
      { action: 'add', css: '.new-class { color: red; }' },
    ]);
  });

  it('should remove CSS rule by selector', async () => {
    mockClient.patchCustomCSS.mockResolvedValue({ success: true, appliedOps: 1 });

    const result = await server.callTool('sq_patch_css', {
      siteId: 'test-site',
      operations: [
        { action: 'remove', selector: '.old-class' },
      ],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.appliedOps).toBe(1);
  });

  it('should replace CSS rule by selector', async () => {
    mockClient.patchCustomCSS.mockResolvedValue({ success: true, appliedOps: 1 });

    const result = await server.callTool('sq_patch_css', {
      siteId: 'test-site',
      operations: [
        { action: 'replace', selector: '.existing', css: '.existing { color: blue; }' },
      ],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
  });

  it('should handle multiple operations', async () => {
    mockClient.patchCustomCSS.mockResolvedValue({ success: true, appliedOps: 3 });

    const result = await server.callTool('sq_patch_css', {
      siteId: 'test-site',
      operations: [
        { action: 'remove', selector: '.old' },
        { action: 'add', css: '.new { display: flex; }' },
        { action: 'replace', selector: 'body', css: 'body { margin: 0; }' },
      ],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.appliedOps).toBe(3);
  });

  it('should return error when selector not found', async () => {
    mockClient.patchCustomCSS.mockResolvedValue({
      success: false,
      appliedOps: 0,
      error: 'Selector not found: .missing',
    });

    const result = await server.callTool('sq_patch_css', {
      siteId: 'test-site',
      operations: [
        { action: 'remove', selector: '.missing' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Selector not found');
  });

  it('should return error when patchCustomCSS fails', async () => {
    mockClient.patchCustomCSS.mockResolvedValue({
      success: false,
      error: 'Failed to read current CSS: Session expired',
    });

    const result = await server.callTool('sq_patch_css', {
      siteId: 'test-site',
      operations: [
        { action: 'add', css: 'body { color: red; }' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session expired');
  });

  it('should return error on exception', async () => {
    mockClient.patchCustomCSS.mockRejectedValue(new Error('Network timeout'));

    const result = await server.callTool('sq_patch_css', {
      siteId: 'test-site',
      operations: [
        { action: 'add', css: 'body {}' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network timeout');
  });
});
