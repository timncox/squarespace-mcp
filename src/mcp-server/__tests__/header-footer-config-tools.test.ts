import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  getHeaderFooter: vi.fn(),
  saveHeaderFooter: vi.fn(),
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

describe('Header/Footer Config Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerSiteTools(server as any);
  });

  // ── Registration ──────────────────────────────────────────────────────────

  it('should register both header/footer config tools', () => {
    expect(server.tools.has('sq_get_header_footer_config')).toBe(true);
    expect(server.tools.has('sq_update_header_footer_config')).toBe(true);
  });

  // ── sq_get_header_footer_config ───────────────────────────────────────────

  describe('sq_get_header_footer_config', () => {
    it('should return full config as JSON', async () => {
      const fullConfig = {
        header: {
          pageSectionsId: 'hdr-ps-id',
          layoutType: 'nav-left',
          background: { color: '#ffffff' },
          logoSettings: { width: 200 },
        },
        footer: {
          pageSectionsId: 'ftr-ps-id',
          layoutType: 'stacked',
          background: { color: '#000000' },
        },
        websiteId: 'site-123',
      };
      mockClient.getHeaderFooter.mockResolvedValue({
        success: true,
        config: fullConfig,
      });

      const result = await server.callTool('sq_get_header_footer_config', { siteId: 'test-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.header.layoutType).toBe('nav-left');
      expect(data.footer.layoutType).toBe('stacked');
      expect(data.websiteId).toBe('site-123');
    });

    it('should return error when API fails', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: false,
        error: 'Session expired',
      });

      const result = await server.callTool('sq_get_header_footer_config', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session expired');
    });

    it('should return error when config is missing', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: true,
        config: undefined,
      });

      const result = await server.callTool('sq_get_header_footer_config', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to get header/footer config');
    });

    it('should return error on exception', async () => {
      mockClient.getHeaderFooter.mockRejectedValue(new Error('Network timeout'));

      const result = await server.callTool('sq_get_header_footer_config', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network timeout');
    });
  });

  // ── sq_update_header_footer_config ────────────────────────────────────────

  describe('sq_update_header_footer_config', () => {
    it('should merge header fields into existing config', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: true,
        config: {
          header: { layoutType: 'nav-left', background: { color: '#fff' } },
          footer: { layoutType: 'stacked' },
        },
      });
      mockClient.saveHeaderFooter.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_header_footer_config', {
        siteId: 'test-site',
        header: { layoutType: 'nav-center', logoWidth: 300 },
      });

      expect(result.isError).toBeUndefined();
      const savedConfig = mockClient.saveHeaderFooter.mock.calls[0][0];
      expect(savedConfig.header.layoutType).toBe('nav-center');
      expect(savedConfig.header.logoWidth).toBe(300);
      // Existing field preserved (shallow merge)
      expect(savedConfig.header.background).toEqual({ color: '#fff' });
      // Footer unchanged
      expect(savedConfig.footer.layoutType).toBe('stacked');
    });

    it('should merge footer fields into existing config', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: true,
        config: {
          header: { layoutType: 'nav-left' },
          footer: { layoutType: 'stacked', background: { color: '#000' } },
        },
      });
      mockClient.saveHeaderFooter.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_header_footer_config', {
        siteId: 'test-site',
        footer: { layoutType: 'columns', showSocialLinks: true },
      });

      expect(result.isError).toBeUndefined();
      const savedConfig = mockClient.saveHeaderFooter.mock.calls[0][0];
      expect(savedConfig.footer.layoutType).toBe('columns');
      expect(savedConfig.footer.showSocialLinks).toBe(true);
      // Existing field preserved
      expect(savedConfig.footer.background).toEqual({ color: '#000' });
      // Header unchanged
      expect(savedConfig.header.layoutType).toBe('nav-left');
    });

    it('should merge topLevel fields excluding header/footer keys', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: true,
        config: {
          header: { layoutType: 'nav-left' },
          footer: { layoutType: 'stacked' },
          websiteId: 'site-123',
        },
      });
      mockClient.saveHeaderFooter.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_header_footer_config', {
        siteId: 'test-site',
        topLevel: { customField: 'value', header: 'should-be-ignored', footer: 'should-be-ignored' },
      });

      expect(result.isError).toBeUndefined();
      const savedConfig = mockClient.saveHeaderFooter.mock.calls[0][0];
      expect(savedConfig.customField).toBe('value');
      // header and footer keys in topLevel should be ignored
      expect(savedConfig.header).toEqual({ layoutType: 'nav-left' });
      expect(savedConfig.footer).toEqual({ layoutType: 'stacked' });
    });

    it('should read current config before writing (read-modify-write)', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: true,
        config: { header: { existing: true }, footer: { existing: true } },
      });
      mockClient.saveHeaderFooter.mockResolvedValue({ success: true });

      await server.callTool('sq_update_header_footer_config', {
        siteId: 'test-site',
        header: { newField: 'value' },
      });

      // getHeaderFooter should be called first
      expect(mockClient.getHeaderFooter).toHaveBeenCalledTimes(1);
      // Then saveHeaderFooter with merged config
      expect(mockClient.saveHeaderFooter).toHaveBeenCalledTimes(1);
      const savedConfig = mockClient.saveHeaderFooter.mock.calls[0][0];
      expect(savedConfig.header.existing).toBe(true);
      expect(savedConfig.header.newField).toBe('value');
    });

    it('should create header object when it does not exist', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: true,
        config: { footer: { layoutType: 'stacked' } },
      });
      mockClient.saveHeaderFooter.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_header_footer_config', {
        siteId: 'test-site',
        header: { layoutType: 'nav-center' },
      });

      expect(result.isError).toBeUndefined();
      const savedConfig = mockClient.saveHeaderFooter.mock.calls[0][0];
      expect(savedConfig.header).toEqual({ layoutType: 'nav-center' });
    });

    it('should create footer object when it does not exist', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: true,
        config: { header: { layoutType: 'nav-left' } },
      });
      mockClient.saveHeaderFooter.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_header_footer_config', {
        siteId: 'test-site',
        footer: { layoutType: 'columns' },
      });

      expect(result.isError).toBeUndefined();
      const savedConfig = mockClient.saveHeaderFooter.mock.calls[0][0];
      expect(savedConfig.footer).toEqual({ layoutType: 'columns' });
    });

    it('should return error when getHeaderFooter fails', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: false,
        error: 'Auth expired',
      });

      const result = await server.callTool('sq_update_header_footer_config', {
        siteId: 'test-site',
        header: { layoutType: 'nav-center' },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Auth expired');
      expect(mockClient.saveHeaderFooter).not.toHaveBeenCalled();
    });

    it('should return error when saveHeaderFooter fails', async () => {
      mockClient.getHeaderFooter.mockResolvedValue({
        success: true,
        config: { header: { layoutType: 'nav-left' }, footer: {} },
      });
      mockClient.saveHeaderFooter.mockResolvedValue({
        success: false,
        error: 'PUT 400: invalid config',
      });

      const result = await server.callTool('sq_update_header_footer_config', {
        siteId: 'test-site',
        header: { layoutType: 'bad-value' },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('PUT 400: invalid config');
    });

    it('should return error on exception', async () => {
      mockClient.getHeaderFooter.mockRejectedValue(new Error('Connection refused'));

      const result = await server.callTool('sq_update_header_footer_config', {
        siteId: 'test-site',
        header: { layoutType: 'nav-center' },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Connection refused');
    });
  });
});
