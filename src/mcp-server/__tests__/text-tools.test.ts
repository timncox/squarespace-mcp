import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  getPageSections: vi.fn(),
  patchTextBlock: vi.fn(),
  updateTextBlock: vi.fn(),
  updateTextBlockHtml: vi.fn(),
  addTextBlock: vi.fn(),
  patchFooterTextBlock: vi.fn(),
  patchHeaderTextBlock: vi.fn(),
  findBlock: vi.fn(),
  formatHtml: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
}));

import { resolvePageIds } from '../session.js';
import { registerTextTools } from '../tools/text.js';

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

describe('MCP Text Tools (new)', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerTextTools(server as any);
  });

  it('should register all 8 text tools', () => {
    expect(server.tools.has('sq_read_page')).toBe(true);
    expect(server.tools.has('sq_update_text')).toBe(true);
    expect(server.tools.has('sq_update_html')).toBe(true);
    expect(server.tools.has('sq_patch_text')).toBe(true);
    expect(server.tools.has('sq_format_text')).toBe(true);
    expect(server.tools.has('sq_add_text')).toBe(true);
    expect(server.tools.has('sq_update_footer_text')).toBe(true);
    expect(server.tools.has('sq_update_header_text')).toBe(true);
  });

  // ── sq_update_html ──────────────────────────────────────────────────────────

  describe('sq_update_html', () => {
    it('should call updateTextBlockHtml with correct params', async () => {
      mockClient.updateTextBlockHtml.mockResolvedValue({ success: true, blockId: 'blk-1' });

      const result = await server.callTool('sq_update_html', {
        siteId: 'smyth-tavern',
        pageSlug: 'about',
        searchText: 'Old heading',
        html: '<h1 class="" style="white-space:pre-wrap;">New heading</h1>',
      });

      expect(mockClient.updateTextBlockHtml).toHaveBeenCalledWith(
        'psi-about', 'col-about', 'Old heading', '<h1 class="" style="white-space:pre-wrap;">New heading</h1>',
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_html', {
        siteId: 'bad-site',
        pageSlug: 'about',
        searchText: 'x',
        html: '<p>y</p>',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_patch_text ───────────────────────────────────────────────────────────

  describe('sq_patch_text', () => {
    it('should call patchTextBlock with correct params', async () => {
      mockClient.patchTextBlock.mockResolvedValue({ success: true, blockId: 'blk-2' });

      const result = await server.callTool('sq_patch_text', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Monday',
        newText: 'Tuesday',
      });

      expect(mockClient.patchTextBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Monday', 'Tuesday',
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_patch_text', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'x',
        newText: 'y',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_format_text ──────────────────────────────────────────────────────────

  describe('sq_format_text', () => {
    it('should strip HTML, format, and write back', async () => {
      // Mock getPageSections returns a section with a text block
      mockClient.getPageSections.mockResolvedValue({
        sections: [{
          id: 'sec-1',
          fluidEngineContext: {
            gridContents: [{
              content: {
                value: {
                  type: 2,
                  value: { html: '<p class="" style="white-space:pre-wrap;">Welcome to our site</p>' },
                },
              },
            }],
          },
        }],
      });

      // Mock findBlock returns the block
      mockClient.findBlock.mockReturnValue({
        section: {},
        gridContent: {
          content: {
            value: {
              type: 2,
              value: { html: '<p class="" style="white-space:pre-wrap;">Welcome to our site</p>' },
            },
          },
        },
        sectionIndex: 0,
        blockIndex: 0,
      });

      // Mock formatHtml returns formatted HTML
      mockClient.formatHtml.mockReturnValue('<h1 class="" style="white-space:pre-wrap;text-align:center;">Welcome to our site</h1>');

      // Mock updateTextBlockHtml succeeds
      mockClient.updateTextBlockHtml.mockResolvedValue({ success: true, blockId: 'blk-1' });

      const result = await server.callTool('sq_format_text', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Welcome',
        format: { tag: 'h1', alignment: 'center' },
      });

      expect(mockClient.findBlock).toHaveBeenCalled();
      expect(mockClient.formatHtml).toHaveBeenCalledWith('Welcome to our site', { tag: 'h1', alignment: 'center' });
      expect(mockClient.updateTextBlockHtml).toHaveBeenCalled();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error when block not found', async () => {
      mockClient.getPageSections.mockResolvedValue({ sections: [] });
      mockClient.findBlock.mockReturnValue(null);

      const result = await server.callTool('sq_format_text', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Nonexistent',
        format: { tag: 'h2' },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No block found');
    });
  });

  // ── sq_add_text ─────────────────────────────────────────────────────────────

  describe('sq_add_text', () => {
    it('should call addTextBlock with correct params', async () => {
      mockClient.addTextBlock.mockResolvedValue({ success: true, blockId: 'new-blk' });

      const result = await server.callTool('sq_add_text', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        html: '<p>New paragraph</p>',
      });

      expect(mockClient.addTextBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, '<p>New paragraph</p>', undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should pass layout options when provided', async () => {
      mockClient.addTextBlock.mockResolvedValue({ success: true, blockId: 'new-blk' });

      await server.callTool('sq_add_text', {
        siteId: 'smyth-tavern',
        pageSlug: 'about',
        sectionIndex: 1,
        html: '<h2>Title</h2>',
        layout: { columns: 12, gapRows: 4 },
      });

      expect(mockClient.addTextBlock).toHaveBeenCalledWith(
        'psi-about', 'col-about', 1, '<h2>Title</h2>', { columns: 12, gapRows: 4 },
      );
    });

    it('should return error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_text', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
        html: '<p>text</p>',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_update_footer_text ───────────────────────────────────────────────────

  describe('sq_update_footer_text', () => {
    it('should call patchFooterTextBlock without pageSlug', async () => {
      mockClient.patchFooterTextBlock.mockResolvedValue({ success: true, blockId: 'footer-blk' });

      const result = await server.callTool('sq_update_footer_text', {
        siteId: 'smyth-tavern',
        searchText: '© 2025',
        newText: '© 2026',
      });

      expect(mockClient.patchFooterTextBlock).toHaveBeenCalledWith('© 2025', '© 2026');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error when method throws', async () => {
      mockClient.patchFooterTextBlock.mockRejectedValue(new Error('Footer not found'));

      const result = await server.callTool('sq_update_footer_text', {
        siteId: 'smyth-tavern',
        searchText: 'missing',
        newText: 'new',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Footer not found');
    });
  });

  // ── sq_update_header_text ──────────────────────────────────────────────────

  describe('sq_update_header_text', () => {
    it('should call patchHeaderTextBlock without pageSlug', async () => {
      mockClient.patchHeaderTextBlock.mockResolvedValue({ success: true, blockId: 'header-blk' });

      const result = await server.callTool('sq_update_header_text', {
        siteId: 'smyth-tavern',
        searchText: 'Old Tagline',
        newText: 'New Tagline',
      });

      expect(mockClient.patchHeaderTextBlock).toHaveBeenCalledWith('Old Tagline', 'New Tagline');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error when method throws', async () => {
      mockClient.patchHeaderTextBlock.mockRejectedValue(new Error('Header not found'));

      const result = await server.callTool('sq_update_header_text', {
        siteId: 'smyth-tavern',
        searchText: 'missing',
        newText: 'new',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Header not found');
    });
  });
});
