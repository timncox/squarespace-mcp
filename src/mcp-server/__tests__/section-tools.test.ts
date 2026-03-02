import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  addBlankSection: vi.fn(),
  getSectionCatalog: vi.fn(),
  copyTemplateSection: vi.fn(),
  updateTextBlock: vi.fn(),
  removeBlock: vi.fn(),
  editSectionStyle: vi.fn(),
  moveSection: vi.fn(),
  duplicateSection: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
}));

vi.mock('../../services/section-catalog.js', () => ({
  lookupCatalogEntry: vi.fn(() => null),
  normalizeCategoryName: vi.fn((name: string) => name.toUpperCase()),
}));

import { resolvePageIds } from '../session.js';
import { registerSectionTools } from '../tools/section.js';

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

describe('MCP Section Tools (new)', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerSectionTools(server as any);
  });

  it('should register all 5 section tools', () => {
    expect(server.tools.has('sq_add_blank_section')).toBe(true);
    expect(server.tools.has('sq_add_template_section')).toBe(true);
    expect(server.tools.has('sq_edit_section_style')).toBe(true);
    expect(server.tools.has('sq_move_section')).toBe(true);
    expect(server.tools.has('sq_duplicate_section')).toBe(true);
  });

  // ── sq_edit_section_style ─────────────────────────────────────────────────

  describe('sq_edit_section_style', () => {
    it('should call editSectionStyle with number index', async () => {
      mockClient.editSectionStyle.mockResolvedValue({
        success: true,
        sectionId: 'sec-1',
        updatedFields: ['sectionTheme'],
      });

      const result = await server.callTool('sq_edit_section_style', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionSearch: 0,
        styles: { sectionTheme: 'dark' },
      });

      expect(mockClient.editSectionStyle).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, { sectionTheme: 'dark' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should call editSectionStyle with text search', async () => {
      mockClient.editSectionStyle.mockResolvedValue({
        success: true,
        sectionId: 'sec-2',
        updatedFields: ['sectionHeight', 'contentWidth'],
      });

      const result = await server.callTool('sq_edit_section_style', {
        siteId: 'smyth-tavern',
        pageSlug: 'about',
        sectionSearch: 'About Us',
        styles: { sectionHeight: 'large', contentWidth: 'wide' },
      });

      expect(mockClient.editSectionStyle).toHaveBeenCalledWith(
        'psi-about', 'col-about', 'About Us', { sectionHeight: 'large', contentWidth: 'wide' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_edit_section_style', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionSearch: 0,
        styles: { sectionTheme: 'light' },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_move_section ───────────────────────────────────────────────────────

  describe('sq_move_section', () => {
    it('should call moveSection with correct params', async () => {
      mockClient.moveSection.mockResolvedValue({
        success: true,
        sectionId: 'sec-1',
        sectionName: 'Hero',
        oldIndex: 1,
        newIndex: 0,
      });

      const result = await server.callTool('sq_move_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionSearch: 'Hero section',
        direction: 'up',
      });

      expect(mockClient.moveSection).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Hero section', 'up',
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.oldIndex).toBe(1);
      expect(data.newIndex).toBe(0);
    });

    it('should handle move down direction', async () => {
      mockClient.moveSection.mockResolvedValue({
        success: true,
        sectionId: 'sec-1',
        oldIndex: 0,
        newIndex: 1,
      });

      await server.callTool('sq_move_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionSearch: 'Contact',
        direction: 'down',
      });

      expect(mockClient.moveSection).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Contact', 'down',
      );
    });

    it('should return error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_move_section', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionSearch: 'Hero',
        direction: 'up',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_duplicate_section ──────────────────────────────────────────────────

  describe('sq_duplicate_section', () => {
    it('should call duplicateSection with number index', async () => {
      mockClient.duplicateSection.mockResolvedValue({
        success: true,
        originalSectionId: 'sec-1',
        newSectionId: 'sec-clone-1',
        newIndex: 1,
      });

      const result = await server.callTool('sq_duplicate_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionSearch: 0,
      });

      expect(mockClient.duplicateSection).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.newSectionId).toBe('sec-clone-1');
    });

    it('should call duplicateSection with text search', async () => {
      mockClient.duplicateSection.mockResolvedValue({
        success: true,
        originalSectionId: 'sec-2',
        newSectionId: 'sec-clone-2',
        newIndex: 3,
      });

      const result = await server.callTool('sq_duplicate_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'about',
        sectionSearch: 'Team Members',
      });

      expect(mockClient.duplicateSection).toHaveBeenCalledWith(
        'psi-about', 'col-about', 'Team Members',
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_duplicate_section', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionSearch: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });
});
