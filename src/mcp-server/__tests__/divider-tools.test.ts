import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  updateSectionDivider: vi.fn(),
  removeSectionDivider: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
}));

import { resolvePageIds } from '../session.js';
import { registerDividerTools } from '../tools/divider.js';

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

describe('MCP Divider Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerDividerTools(server as any);
  });

  it('should register both divider tools', () => {
    expect(server.tools.has('sq_update_section_divider')).toBe(true);
    expect(server.tools.has('sq_remove_section_divider')).toBe(true);
  });

  // ── sq_update_section_divider ─────────────────────────────────────────────

  describe('sq_update_section_divider', () => {
    it('calls updateSectionDivider with correct params', async () => {
      mockClient.updateSectionDivider.mockResolvedValue({
        success: true,
        sectionId: 'sec-0',
      });

      const result = await server.callTool('sq_update_section_divider', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 0,
        type: 'jagged',
      });

      expect(mockClient.updateSectionDivider).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0,
        expect.objectContaining({ enabled: true, type: 'jagged' }),
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('passes all optional params as divider config', async () => {
      mockClient.updateSectionDivider.mockResolvedValue({
        success: true,
        sectionId: 'sec-0',
      });

      await server.callTool('sq_update_section_divider', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 1,
        type: 'scalloped',
        width: 50,
        height: 4,
        flipX: true,
        flipY: false,
        offset: 10,
        strokeStyle: 'dashed',
        strokeThickness: 8,
      });

      expect(mockClient.updateSectionDivider).toHaveBeenCalledWith(
        'psi-home', 'col-home', 1,
        expect.objectContaining({
          enabled: true,
          type: 'scalloped',
          width: { value: 50, unit: 'vw' },
          height: { value: 4, unit: 'vw' },
          isFlipX: true,
          isFlipY: false,
          offset: { value: 10, unit: 'px' },
          stroke: expect.objectContaining({
            style: 'dashed',
            thickness: { value: 8, unit: 'px' },
          }),
        }),
      );
    });

    it('returns error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_section_divider', {
        siteId: 'bad-site',
        pageSlug: 'nope',
        sectionIndex: 0,
        type: 'wavy',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('returns error when client method fails', async () => {
      mockClient.updateSectionDivider.mockResolvedValue({
        success: false,
        error: 'Section index 5 out of bounds',
      });

      const result = await server.callTool('sq_update_section_divider', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 5,
        type: 'pointed',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('out of bounds');
    });
  });

  // ── sq_remove_section_divider ─────────────────────────────────────────────

  describe('sq_remove_section_divider', () => {
    it('calls removeSectionDivider with correct params', async () => {
      mockClient.removeSectionDivider.mockResolvedValue({
        success: true,
        sectionId: 'sec-0',
      });

      const result = await server.callTool('sq_remove_section_divider', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(mockClient.removeSectionDivider).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('returns error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_remove_section_divider', {
        siteId: 'bad-site',
        pageSlug: 'nope',
        sectionIndex: 0,
      });

      expect(result.isError).toBe(true);
    });
  });
});
