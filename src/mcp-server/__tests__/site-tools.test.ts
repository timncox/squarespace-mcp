import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
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
  saveCustomCSS: vi.fn(),
  getSocialAccounts: vi.fn(),
  addSocialAccount: vi.fn(),
  removeSocialAccount: vi.fn(),
  getSiteIdentity: vi.fn(),
  updateSiteIdentity: vi.fn(),
  getAdvancedSettings: vi.fn(),
  saveAdvancedSettings: vi.fn(),
  patchCustomCSS: vi.fn(),
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

describe('Site Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerSiteTools(server as any);
  });

  it('should register all 18 site tools', () => {
    expect(server.tools.has('sq_list_sites')).toBe(true);
    expect(server.tools.has('sq_get_settings')).toBe(true);
    expect(server.tools.has('sq_update_settings')).toBe(true);
    expect(server.tools.has('sq_get_design')).toBe(true);
    expect(server.tools.has('sq_update_design')).toBe(true);
    expect(server.tools.has('sq_get_code_injection')).toBe(true);
    expect(server.tools.has('sq_update_code_injection')).toBe(true);
    expect(server.tools.has('sq_update_css')).toBe(true);
    expect(server.tools.has('sq_patch_css')).toBe(true);
    expect(server.tools.has('sq_list_social_links')).toBe(true);
    expect(server.tools.has('sq_add_social_link')).toBe(true);
    expect(server.tools.has('sq_remove_social_link')).toBe(true);
    expect(server.tools.has('sq_get_site_identity')).toBe(true);
    expect(server.tools.has('sq_update_site_identity')).toBe(true);
    expect(server.tools.has('sq_get_advanced_settings')).toBe(true);
    expect(server.tools.has('sq_save_advanced_settings')).toBe(true);
    expect(server.tools.has('sq_get_header_footer_config')).toBe(true);
    expect(server.tools.has('sq_update_header_footer_config')).toBe(true);
  });

  // ── sq_get_settings ─────────────────────────────────────────────────────────

  describe('sq_get_settings', () => {
    it('should return site settings', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: { siteTitle: 'Test Site', siteDescription: 'A test', language: 'en' },
      });

      const result = await server.callTool('sq_get_settings', { siteId: 'test-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.siteTitle).toBe('Test Site');
    });

    it('should return error on failure', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: false,
        error: 'Session expired',
      });

      const result = await server.callTool('sq_get_settings', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session expired');
    });
  });

  // ── sq_update_settings ──────────────────────────────────────────────────────

  describe('sq_update_settings', () => {
    it('should update settings and return success', async () => {
      mockClient.updateSettings.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_settings', {
        siteId: 'test-site',
        updates: { siteTitle: 'New Title' },
      });

      expect(mockClient.updateSettings).toHaveBeenCalledWith({ siteTitle: 'New Title' });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error when update fails', async () => {
      mockClient.updateSettings.mockResolvedValue({
        success: false,
        error: 'No fields to update',
      });

      const result = await server.callTool('sq_update_settings', {
        siteId: 'test-site',
        updates: {},
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No fields to update');
    });
  });

  // ── sq_get_design ───────────────────────────────────────────────────────────

  describe('sq_get_design', () => {
    it('should return combined fonts, colors, and tweaks', async () => {
      mockClient.getWebsiteFonts.mockResolvedValue({
        success: true,
        data: { name: 'default', baseFontSize: 16 },
      });
      mockClient.getWebsiteColors.mockResolvedValue({
        success: true,
        data: { palette: [{ id: 'white', hue: 0 }] },
      });
      mockClient.getTemplateTweakSettings.mockResolvedValue({
        success: true,
        data: { 'header-height': '80px' },
      });

      const result = await server.callTool('sq_get_design', { siteId: 'test-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.fonts).toBeTruthy();
      expect(data.colors).toBeTruthy();
      expect(data.tweaks).toBeTruthy();
      expect(data.warnings).toBeUndefined();
    });

    it('should return partial results with warnings', async () => {
      mockClient.getWebsiteFonts.mockResolvedValue({
        success: true,
        data: { name: 'default' },
      });
      mockClient.getWebsiteColors.mockResolvedValue({
        success: false,
        error: 'Colors API error',
      });
      mockClient.getTemplateTweakSettings.mockResolvedValue({
        success: true,
        data: {},
      });

      const result = await server.callTool('sq_get_design', { siteId: 'test-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.fonts).toBeTruthy();
      expect(data.colors).toBeNull();
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings[0]).toContain('Colors API error');
    });

    it('should return error when all reads fail', async () => {
      mockClient.getWebsiteFonts.mockResolvedValue({ success: false, error: 'fail1' });
      mockClient.getWebsiteColors.mockResolvedValue({ success: false, error: 'fail2' });
      mockClient.getTemplateTweakSettings.mockResolvedValue({ success: false, error: 'fail3' });

      const result = await server.callTool('sq_get_design', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('All design reads failed');
    });
  });

  // ── sq_update_design ────────────────────────────────────────────────────────

  describe('sq_update_design', () => {
    it('should update font', async () => {
      mockClient.updateFont.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_design', {
        siteId: 'test-site',
        font: { fontName: 'heading-font', updates: { fontFamily: 'Playfair Display' } },
      });

      expect(mockClient.updateFont).toHaveBeenCalledWith('heading-font', { fontFamily: 'Playfair Display' });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.results.font.success).toBe(true);
    });

    it('should update color', async () => {
      mockClient.updatePaletteColor.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_design', {
        siteId: 'test-site',
        color: { colorId: 'accent', hsl: { hue: 200, saturation: 50, lightness: 60 } },
      });

      expect(mockClient.updatePaletteColor).toHaveBeenCalledWith('accent', { hue: 200, saturation: 50, lightness: 60 });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should update tweaks', async () => {
      mockClient.setTemplateTweakSettings.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_design', {
        siteId: 'test-site',
        tweaks: { 'header-height': '100px' },
      });

      expect(mockClient.setTemplateTweakSettings).toHaveBeenCalledWith({ 'header-height': '100px' });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should update multiple design aspects at once', async () => {
      mockClient.updateFont.mockResolvedValue({ success: true });
      mockClient.updatePaletteColor.mockResolvedValue({ success: true });
      mockClient.setTemplateTweakSettings.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_design', {
        siteId: 'test-site',
        font: { fontName: 'body-font', updates: { fontFamily: 'Arial' } },
        color: { colorId: 'white', hsl: { hue: 0, saturation: 0, lightness: 100 } },
        tweaks: { 'nav-style': 'fixed' },
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.results.font.success).toBe(true);
      expect(data.results.color.success).toBe(true);
      expect(data.results.tweaks.success).toBe(true);
    });

    it('should report partial failure', async () => {
      mockClient.updateFont.mockResolvedValue({ success: true });
      mockClient.updatePaletteColor.mockResolvedValue({ success: false, error: 'Color not found' });

      const result = await server.callTool('sq_update_design', {
        siteId: 'test-site',
        font: { fontName: 'heading-font', updates: { fontFamily: 'Georgia' } },
        color: { colorId: 'bad-id', hsl: { hue: 0, saturation: 0, lightness: 0 } },
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(false);
      expect(data.results.font.success).toBe(true);
      expect(data.results.color.success).toBe(false);
      expect(data.results.color.error).toContain('Color not found');
    });

    it('should return error when no updates provided', async () => {
      const result = await server.callTool('sq_update_design', {
        siteId: 'test-site',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No design updates provided');
    });
  });

  // ── sq_get_code_injection ───────────────────────────────────────────────────

  describe('sq_get_code_injection', () => {
    it('should return code injection data', async () => {
      mockClient.getCodeInjection.mockResolvedValue({
        success: true,
        data: { header: '<script>ga()</script>', footer: '' },
      });

      const result = await server.callTool('sq_get_code_injection', { siteId: 'test-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.header).toContain('ga()');
    });

    it('should return error on failure', async () => {
      mockClient.getCodeInjection.mockResolvedValue({
        success: false,
        error: 'Settings read failed',
      });

      const result = await server.callTool('sq_get_code_injection', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Settings read failed');
    });
  });

  // ── sq_update_code_injection ────────────────────────────────────────────────

  describe('sq_update_code_injection', () => {
    it('should save code injection', async () => {
      mockClient.saveCodeInjection.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_code_injection', {
        siteId: 'test-site',
        header: '<script>analytics()</script>',
        footer: '<div>Footer widget</div>',
      });

      expect(mockClient.saveCodeInjection).toHaveBeenCalledWith(
        '<script>analytics()</script>',
        '<div>Footer widget</div>',
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should handle partial update (header only)', async () => {
      mockClient.saveCodeInjection.mockResolvedValue({ success: true });

      await server.callTool('sq_update_code_injection', {
        siteId: 'test-site',
        header: '<script>new()</script>',
      });

      expect(mockClient.saveCodeInjection).toHaveBeenCalledWith('<script>new()</script>', undefined);
    });

    it('should return error on failure', async () => {
      mockClient.saveCodeInjection.mockResolvedValue({
        success: false,
        error: 'Injection save failed',
      });

      const result = await server.callTool('sq_update_code_injection', {
        siteId: 'test-site',
        header: 'bad',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Injection save failed');
    });
  });

  // ── sq_update_css ───────────────────────────────────────────────────────────

  describe('sq_update_css', () => {
    it('should save custom CSS', async () => {
      mockClient.saveCustomCSS.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_css', {
        siteId: 'test-site',
        css: 'body { color: red; }',
      });

      expect(mockClient.saveCustomCSS).toHaveBeenCalledWith('body { color: red; }');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error on failure', async () => {
      mockClient.saveCustomCSS.mockResolvedValue({
        success: false,
        error: 'CSS save failed',
      });

      const result = await server.callTool('sq_update_css', {
        siteId: 'test-site',
        css: 'invalid css',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('CSS save failed');
    });

    it('should return error on exception', async () => {
      mockClient.saveCustomCSS.mockRejectedValue(new Error('Network timeout'));

      const result = await server.callTool('sq_update_css', {
        siteId: 'test-site',
        css: 'body {}',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network timeout');
    });
  });

  // ── sq_list_social_links ──────────────────────────────────────────────────

  describe('sq_list_social_links', () => {
    it('should return social accounts list', async () => {
      mockClient.getSocialAccounts.mockResolvedValue({
        success: true,
        data: [
          { id: 'acc-1', serviceId: 62, screenname: 'Twitter', profileUrl: 'https://twitter.com/test', iconEnabled: true, serviceName: 'twitter-unauth' },
          { id: 'acc-2', serviceId: 64, screenname: 'Instagram', profileUrl: 'https://instagram.com/test', iconEnabled: true, serviceName: 'instagram-unauth' },
        ],
      });

      const result = await server.callTool('sq_list_social_links', { siteId: 'test-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(2);
      expect(data[0].serviceName).toBe('twitter-unauth');
    });

    it('should return error on failure', async () => {
      mockClient.getSocialAccounts.mockResolvedValue({
        success: false,
        error: 'Session expired',
      });

      const result = await server.callTool('sq_list_social_links', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session expired');
    });
  });

  // ── sq_add_social_link ────────────────────────────────────────────────────

  describe('sq_add_social_link', () => {
    it('should add social link by platform name', async () => {
      mockClient.addSocialAccount.mockResolvedValue({
        success: true,
        data: { id: 'acc-new', serviceId: 64, screenname: 'Instagram', profileUrl: 'https://instagram.com/new', iconEnabled: true, serviceName: 'instagram-unauth' },
      });

      const result = await server.callTool('sq_add_social_link', {
        siteId: 'test-site',
        service: 'instagram',
        username: 'Instagram',
        profileUrl: 'https://instagram.com/new',
      });

      expect(result.isError).toBeUndefined();
      expect(mockClient.addSocialAccount).toHaveBeenCalledWith(64, 'Instagram', 'https://instagram.com/new');
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBe('acc-new');
    });

    it('should accept "x" as alias for twitter', async () => {
      mockClient.addSocialAccount.mockResolvedValue({
        success: true,
        data: { id: 'acc-x', serviceId: 62, screenname: 'X', profileUrl: 'https://x.com/test', iconEnabled: true, serviceName: 'twitter-unauth' },
      });

      await server.callTool('sq_add_social_link', {
        siteId: 'test-site',
        service: 'x',
        username: 'X',
        profileUrl: 'https://x.com/test',
      });

      expect(mockClient.addSocialAccount).toHaveBeenCalledWith(62, 'X', 'https://x.com/test');
    });

    it('should accept numeric service ID', async () => {
      mockClient.addSocialAccount.mockResolvedValue({
        success: true,
        data: { id: 'acc-num', serviceId: 69, screenname: 'YouTube', profileUrl: 'https://youtube.com/test', iconEnabled: true, serviceName: 'youtube-unauth' },
      });

      await server.callTool('sq_add_social_link', {
        siteId: 'test-site',
        service: '69',
        username: 'YouTube',
        profileUrl: 'https://youtube.com/test',
      });

      expect(mockClient.addSocialAccount).toHaveBeenCalledWith(69, 'YouTube', 'https://youtube.com/test');
    });

    it('should reject unknown service name', async () => {
      const result = await server.callTool('sq_add_social_link', {
        siteId: 'test-site',
        service: 'myspace',
        username: 'MySpace',
        profileUrl: 'https://myspace.com/test',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown service');
      expect(mockClient.addSocialAccount).not.toHaveBeenCalled();
    });

    it('should return error on API failure', async () => {
      mockClient.addSocialAccount.mockResolvedValue({
        success: false,
        error: 'CreateNonOAuthAccount failed: 400',
      });

      const result = await server.callTool('sq_add_social_link', {
        siteId: 'test-site',
        service: 'facebook',
        username: 'Facebook',
        profileUrl: 'https://facebook.com/test',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('400');
    });
  });

  // ── sq_remove_social_link ─────────────────────────────────────────────────

  describe('sq_remove_social_link', () => {
    it('should remove social account by ID', async () => {
      mockClient.removeSocialAccount.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_remove_social_link', {
        siteId: 'test-site',
        accountId: 'acc-123',
      });

      expect(result.isError).toBeUndefined();
      expect(mockClient.removeSocialAccount).toHaveBeenCalledWith('acc-123');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.removedAccountId).toBe('acc-123');
    });

    it('should return error on failure', async () => {
      mockClient.removeSocialAccount.mockResolvedValue({
        success: false,
        error: 'Account not found',
      });

      const result = await server.callTool('sq_remove_social_link', {
        siteId: 'test-site',
        accountId: 'nonexistent',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Account not found');
    });
  });

  // ── sq_get_site_identity ─────────────────────────────────────────────────────
  describe('sq_get_site_identity', () => {
    it('should get site identity', async () => {
      mockClient.getSiteIdentity.mockResolvedValue({
        success: true,
        data: { businessName: 'Acme', siteTitle: 'Acme Corp', phone: '555-1234' },
      });

      const result = await server.callTool('sq_get_site_identity', { siteId: 'test-site' });

      expect(mockClient.getSiteIdentity).toHaveBeenCalled();
      const data = JSON.parse(result.content[0].text);
      expect(data.data.businessName).toBe('Acme');
    });

    it('should handle errors', async () => {
      mockClient.getSiteIdentity.mockResolvedValue({ success: false, error: 'API failed' });

      const result = await server.callTool('sq_get_site_identity', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_update_site_identity ──────────────────────────────────────────────────
  describe('sq_update_site_identity', () => {
    it('should update site identity fields', async () => {
      mockClient.updateSiteIdentity.mockResolvedValue({ success: true, data: {} });

      const result = await server.callTool('sq_update_site_identity', {
        siteId: 'test-site',
        businessName: 'New Name',
        phone: '555-9999',
      });

      expect(mockClient.updateSiteIdentity).toHaveBeenCalledWith({
        businessName: 'New Name',
        address: undefined,
        address2: undefined,
        siteTitle: undefined,
        phone: '555-9999',
        email: undefined,
      });
      expect(result.isError).toBeUndefined();
    });

    it('should handle errors', async () => {
      mockClient.updateSiteIdentity.mockRejectedValue(new Error('auth error'));

      const result = await server.callTool('sq_update_site_identity', {
        siteId: 'test-site',
        siteTitle: 'test',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_get_advanced_settings ─────────────────────────────────────────────────
  describe('sq_get_advanced_settings', () => {
    it('should get advanced settings', async () => {
      mockClient.getAdvancedSettings.mockResolvedValue({
        success: true,
        data: { mappings: '[{"from":"/old","to":"/new","statusCode":301}]' },
      });

      const result = await server.callTool('sq_get_advanced_settings', { siteId: 'test-site' });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should handle errors', async () => {
      mockClient.getAdvancedSettings.mockRejectedValue(new Error('network error'));

      const result = await server.callTool('sq_get_advanced_settings', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_save_advanced_settings ────────────────────────────────────────────────
  describe('sq_save_advanced_settings', () => {
    it('should save mappings', async () => {
      mockClient.saveAdvancedSettings.mockResolvedValue({ success: true });

      const mappingsJson = '[{"from":"/old","to":"/new","statusCode":301}]';
      const result = await server.callTool('sq_save_advanced_settings', {
        siteId: 'test-site',
        mappings: mappingsJson,
      });

      expect(mockClient.saveAdvancedSettings).toHaveBeenCalledWith({ mappings: mappingsJson });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should error when no data provided', async () => {
      const result = await server.callTool('sq_save_advanced_settings', {
        siteId: 'test-site',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Must provide');
    });

    it('should handle errors', async () => {
      mockClient.saveAdvancedSettings.mockRejectedValue(new Error('save failed'));

      const result = await server.callTool('sq_save_advanced_settings', {
        siteId: 'test-site',
        mappings: '[]',
      });

      expect(result.isError).toBe(true);
    });
  });
});
