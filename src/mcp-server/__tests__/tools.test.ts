import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  getPageSections: vi.fn(),
  patchTextBlock: vi.fn(),
  updateTextBlock: vi.fn(),
  addBlankSection: vi.fn(),
  getSectionCatalog: vi.fn(),
  copyTemplateSection: vi.fn(),
  removeBlock: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
}));

vi.mock('../../services/section-catalog.js', () => ({
  lookupCatalogEntry: vi.fn((catalog: any, category: string, index: number) => {
    // The tool passes the raw category (e.g., "About"); lookupCatalogEntry normalizes internally
    if (category.toLowerCase() === 'about' && index === 0) {
      return { websiteId: 'ws-1', collectionId: 'col-1', sectionId: 'sec-1' };
    }
    return null;
  }),
  normalizeCategoryName: vi.fn((name: string) => name.toUpperCase()),
}));

import { resolvePageIds, getClient } from '../session.js';
import { registerTextTools } from '../tools/text.js';
import { registerSectionTools } from '../tools/section.js';
import { registerScreenshotTools } from '../tools/screenshot.js';

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

describe('MCP Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
  });

  describe('registerTextTools', () => {
    beforeEach(() => {
      registerTextTools(server as any);
    });

    it('should register sq_read_page and sq_update_text', () => {
      expect(server.tools.has('sq_read_page')).toBe(true);
      expect(server.tools.has('sq_update_text')).toBe(true);
    });

    it('sq_read_page should return page structure', async () => {
      mockClient.getPageSections.mockResolvedValue({
        sections: [
          {
            id: 'sec-1',
            sectionName: 'Hero',
            styles: { sectionTheme: 'dark' },
            fluidEngineContext: {
              gridContents: [
                { content: { id: 'blk-1', type: 2, value: { value: '<h1>Welcome</h1>' } } },
              ],
            },
          },
        ],
      });

      const result = await server.callTool('sq_read_page', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.sectionCount).toBe(1);
      expect(data.sections[0].sectionName).toBe('Hero');
      expect(data.sections[0].blocks).toHaveLength(1);
    });

    it('sq_read_page should return error for unknown page', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_read_page', {
        siteId: 'smyth-tavern',
        pageSlug: 'nonexistent',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('sq_update_text with patch mode should call patchTextBlock', async () => {
      mockClient.patchTextBlock.mockResolvedValue({ success: true, blockId: 'blk-1' });

      const result = await server.callTool('sq_update_text', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Old heading',
        newText: 'New heading',
        mode: 'patch',
      });

      expect(mockClient.patchTextBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Old heading', 'New heading',
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('sq_update_text with replace mode should call updateTextBlock', async () => {
      mockClient.updateTextBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_update_text', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Old',
        newText: '<h1>New</h1>',
        mode: 'replace',
      });

      expect(mockClient.updateTextBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Old', '<h1>New</h1>',
      );
    });

    it('sq_update_text should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_text', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'x',
        newText: 'y',
        mode: 'patch',
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('registerScreenshotTools', () => {
    beforeEach(() => {
      registerScreenshotTools(server as any);
    });

    it('should register sq_take_screenshot', () => {
      expect(server.tools.has('sq_take_screenshot')).toBe(true);
    });

    it('should return placeholder message about needing browser session', async () => {
      const result = await server.callTool('sq_take_screenshot', {
        siteId: 'smyth-tavern',
      });

      expect(result.content[0].text).toContain('browser session');
    });
  });

  describe('registerSectionTools', () => {
    beforeEach(() => {
      registerSectionTools(server as any);
    });

    it('should register sq_add_blank_section and sq_add_template_section', () => {
      expect(server.tools.has('sq_add_blank_section')).toBe(true);
      expect(server.tools.has('sq_add_template_section')).toBe(true);
    });

    it('sq_add_blank_section should add section and return result', async () => {
      mockClient.addBlankSection.mockResolvedValue({ success: true, sectionId: 'new-sec' });

      const result = await server.callTool('sq_add_blank_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.sectionId).toBe('new-sec');
    });

    it('sq_add_blank_section with position should include note', async () => {
      mockClient.addBlankSection.mockResolvedValue({ success: true, sectionId: 'new-sec' });

      const result = await server.callTool('sq_add_blank_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        position: 2,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.note).toContain('sq_move_section');
    });

    it('sq_add_blank_section should return error on failure', async () => {
      mockClient.addBlankSection.mockResolvedValue({ success: false, error: 'Server error' });

      const result = await server.callTool('sq_add_blank_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server error');
    });

    it('sq_add_template_section should copy template and apply replacements', async () => {
      mockClient.getSectionCatalog.mockResolvedValue({
        success: true,
        catalog: {
          ABOUT: [{ websiteId: 'ws-1', collectionId: 'col-1', sectionId: 'sec-1' }],
        },
      });
      mockClient.copyTemplateSection.mockResolvedValue({ success: true, sectionId: 'copied-sec' });
      mockClient.updateTextBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_add_template_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        category: 'About',
        templateIndex: 0,
        replacements: {
          texts: [{ searchText: 'About Us', newText: 'About Smyth Tavern' }],
        },
      });

      expect(mockClient.copyTemplateSection).toHaveBeenCalledWith('ws-1', 'col-1', 'sec-1');
      expect(mockClient.updateTextBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'About Us', 'About Smyth Tavern',
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('sq_add_template_section should handle catalog fetch failure', async () => {
      mockClient.getSectionCatalog.mockResolvedValue({ success: false, error: 'Network error' });

      const result = await server.callTool('sq_add_template_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        category: 'About',
        templateIndex: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
    });

    it('sq_add_template_section should handle template not found', async () => {
      mockClient.getSectionCatalog.mockResolvedValue({
        success: true,
        catalog: { ABOUT: [{ websiteId: 'ws-1', collectionId: 'col-1', sectionId: 'sec-1' }] },
      });

      const result = await server.callTool('sq_add_template_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        category: 'NonExistent',
        templateIndex: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Template not found');
    });

    it('sq_add_template_section should apply removeBlocks replacements', async () => {
      mockClient.getSectionCatalog.mockResolvedValue({
        success: true,
        catalog: { ABOUT: [{ websiteId: 'ws-1', collectionId: 'col-1', sectionId: 'sec-1' }] },
      });
      mockClient.copyTemplateSection.mockResolvedValue({ success: true });
      mockClient.removeBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_add_template_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        category: 'About',
        templateIndex: 0,
        replacements: {
          removeBlocks: ['Learn More'],
        },
      });

      expect(mockClient.removeBlock).toHaveBeenCalledWith('psi-home', 'col-home', 'Learn More');
      const data = JSON.parse(result.content[0].text);
      expect(data.replacementsApplied.removeBlocks).toHaveLength(1);
    });
  });
});
