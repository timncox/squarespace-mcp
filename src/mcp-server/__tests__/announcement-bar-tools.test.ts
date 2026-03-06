import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
}));

import { registerAnnouncementBarTools } from '../tools/announcement-bar.js';

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

describe('Announcement Bar Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerAnnouncementBarTools(server as any);
  });

  it('should register both announcement bar tools', () => {
    expect(server.tools.has('sq_get_announcement_bar')).toBe(true);
    expect(server.tools.has('sq_update_announcement_bar')).toBe(true);
  });

  // ── sq_get_announcement_bar ───────────────────────────────────────────────

  describe('sq_get_announcement_bar', () => {
    it('should return defaults when never configured (empty {})', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: { announcementBarSettings: {} },
      });

      const result = await server.callTool('sq_get_announcement_bar', { siteId: 'test-site' });
      const data = JSON.parse(result.content[0].text);

      expect(data.enabled).toBe(false);
      expect(data.text).toBe('');
      expect(data.url).toBe('');
      expect(data.newWindow).toBe(false);
    });

    it('should return defaults when announcementBarSettings is missing', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: {},
      });

      const result = await server.callTool('sq_get_announcement_bar', { siteId: 'test-site' });
      const data = JSON.parse(result.content[0].text);

      expect(data.enabled).toBe(false);
      expect(data.text).toBe('');
    });

    it('should return configured announcement bar state', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: {
          announcementBarSettings: {
            style: 2,
            text: { html: '<p>Happy hour 4-6pm!</p>', raw: false },
            clickthroughUrl: { url: 'https://example.com/menu', newWindow: true },
          },
        },
      });

      const result = await server.callTool('sq_get_announcement_bar', { siteId: 'test-site' });
      const data = JSON.parse(result.content[0].text);

      expect(data.enabled).toBe(true);
      expect(data.text).toBe('Happy hour 4-6pm!');
      expect(data.url).toBe('https://example.com/menu');
      expect(data.newWindow).toBe(true);
    });

    it('should return disabled when style is 1', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: {
          announcementBarSettings: {
            style: 1,
            text: { html: '<p>Still here</p>', raw: false },
          },
        },
      });

      const result = await server.callTool('sq_get_announcement_bar', { siteId: 'test-site' });
      const data = JSON.parse(result.content[0].text);

      expect(data.enabled).toBe(false);
      expect(data.text).toBe('Still here');
    });

    it('should return error when getSettings fails', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: false,
        error: 'Session expired',
      });

      const result = await server.callTool('sq_get_announcement_bar', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session expired');
    });
  });

  // ── sq_update_announcement_bar ────────────────────────────────────────────

  describe('sq_update_announcement_bar', () => {
    it('should update text only', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: {
          announcementBarSettings: {
            style: 2,
            text: { html: '<p>Old text</p>', raw: false },
          },
        },
      });
      mockClient.updateSettings.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_announcement_bar', {
        siteId: 'test-site',
        text: 'New text',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      const call = mockClient.updateSettings.mock.calls[0][0];
      expect(call.announcementBarSettings.text.html).toBe('<p>New text</p>');
      expect(call.announcementBarSettings.style).toBe(2); // preserved
    });

    it('should toggle enabled on', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: {
          announcementBarSettings: {
            style: 1,
            text: { html: '<p>Existing</p>', raw: false },
          },
        },
      });
      mockClient.updateSettings.mockResolvedValue({ success: true });

      await server.callTool('sq_update_announcement_bar', {
        siteId: 'test-site',
        enabled: true,
      });

      const call = mockClient.updateSettings.mock.calls[0][0];
      expect(call.announcementBarSettings.style).toBe(2);
      expect(call.announcementBarSettings.text.html).toBe('<p>Existing</p>'); // preserved
    });

    it('should toggle enabled off', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: {
          announcementBarSettings: {
            style: 2,
            text: { html: '<p>Visible</p>', raw: false },
          },
        },
      });
      mockClient.updateSettings.mockResolvedValue({ success: true });

      await server.callTool('sq_update_announcement_bar', {
        siteId: 'test-site',
        enabled: false,
      });

      const call = mockClient.updateSettings.mock.calls[0][0];
      expect(call.announcementBarSettings.style).toBe(1);
    });

    it('should set URL and newWindow', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: { announcementBarSettings: { style: 2 } },
      });
      mockClient.updateSettings.mockResolvedValue({ success: true });

      await server.callTool('sq_update_announcement_bar', {
        siteId: 'test-site',
        url: 'https://example.com',
        newWindow: true,
      });

      const call = mockClient.updateSettings.mock.calls[0][0];
      expect(call.announcementBarSettings.clickthroughUrl.url).toBe('https://example.com');
      expect(call.announcementBarSettings.clickthroughUrl.newWindow).toBe(true);
    });

    it('should clear URL when empty string', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: {
          announcementBarSettings: {
            style: 2,
            clickthroughUrl: { url: 'https://old.com', newWindow: true },
          },
        },
      });
      mockClient.updateSettings.mockResolvedValue({ success: true });

      await server.callTool('sq_update_announcement_bar', {
        siteId: 'test-site',
        url: '',
      });

      const call = mockClient.updateSettings.mock.calls[0][0];
      expect(call.announcementBarSettings.clickthroughUrl).toEqual({});
    });

    it('should handle partial update from empty state', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: { announcementBarSettings: {} },
      });
      mockClient.updateSettings.mockResolvedValue({ success: true });

      await server.callTool('sq_update_announcement_bar', {
        siteId: 'test-site',
        enabled: true,
        text: 'Grand opening!',
      });

      const call = mockClient.updateSettings.mock.calls[0][0];
      expect(call.announcementBarSettings.style).toBe(2);
      expect(call.announcementBarSettings.text.html).toBe('<p>Grand opening!</p>');
    });

    it('should return error when read fails', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: false,
        error: 'Session expired',
      });

      const result = await server.callTool('sq_update_announcement_bar', {
        siteId: 'test-site',
        enabled: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session expired');
    });

    it('should return error when write fails', async () => {
      mockClient.getSettings.mockResolvedValue({
        success: true,
        data: { announcementBarSettings: {} },
      });
      mockClient.updateSettings.mockResolvedValue({
        success: false,
        error: 'Something went wrong',
      });

      const result = await server.callTool('sq_update_announcement_bar', {
        siteId: 'test-site',
        text: 'Test',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Something went wrong');
    });
  });
});
