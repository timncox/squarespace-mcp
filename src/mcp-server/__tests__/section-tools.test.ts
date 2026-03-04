import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  addBlankSection: vi.fn(),
  addSectionWithBlocks: vi.fn(),
  getSectionCatalog: vi.fn(),
  copyTemplateSection: vi.fn(),
  getPageSections: vi.fn(),
  savePageSections: vi.fn(),
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

  it('should register all 6 section tools', () => {
    expect(server.tools.has('sq_add_blank_section')).toBe(true);
    expect(server.tools.has('sq_add_section')).toBe(true);
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

  // ── sq_add_template_section (orphan fix) ──────────────────────────────

  describe('sq_add_template_section', () => {
    it('appends copied section to target page via GET+PUT', async () => {
      const { lookupCatalogEntry } = await import('../../services/section-catalog.js');
      vi.mocked(lookupCatalogEntry).mockReturnValue({
        websiteId: 'template-site',
        collectionId: 'template-col',
        sectionId: 'template-sec',
      });

      mockClient.getSectionCatalog.mockResolvedValue({
        success: true,
        catalog: { CONTACT: [{ websiteId: 'template-site', collectionId: 'template-col', sectionId: 'template-sec' }] },
      });

      // copyTemplateSection returns the new section data
      mockClient.copyTemplateSection.mockResolvedValue({
        success: true,
        sectionId: 'new-sec-id',
        sectionData: {
          id: 'new-sec-id',
          sectionName: 'FLUID_ENGINE',
          fluidEngineContext: {
            id: 'ctx-new',
            gridContents: [{ content: { value: { id: 'blk-1', type: 2, value: { html: '<p>Template content</p>' } } } }],
            gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
          },
        },
      });

      // getPageSections returns current page
      mockClient.getPageSections.mockResolvedValue({
        sections: [{ id: 'existing-sec', sectionName: 'FLUID_ENGINE', fluidEngineContext: { gridContents: [] } }],
      });

      mockClient.savePageSections.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_add_template_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        category: 'Contact',
        templateIndex: 0,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.sectionId).toBe('new-sec-id');
      // Verify the section was attached to the page
      expect(mockClient.savePageSections).toHaveBeenCalled();
      const savedSections = mockClient.savePageSections.mock.calls[0][2];
      expect(savedSections).toHaveLength(2);
      expect(savedSections[1].id).toBe('new-sec-id');
    });

    it('returns error when copy fails', async () => {
      const { lookupCatalogEntry } = await import('../../services/section-catalog.js');
      vi.mocked(lookupCatalogEntry).mockReturnValue({
        websiteId: 'template-site',
        collectionId: 'template-col',
        sectionId: 'template-sec',
      });

      mockClient.getSectionCatalog.mockResolvedValue({ success: true, catalog: { CONTACT: [{}] } });
      mockClient.copyTemplateSection.mockResolvedValue({ success: false, error: 'Copy failed' });

      const result = await server.callTool('sq_add_template_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        category: 'Contact',
        templateIndex: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Copy failed');
    });
  });

  // ── sq_add_section ────────────────────────────────────────────────────

  describe('sq_add_section', () => {
    it('should register sq_add_section tool', () => {
      expect(server.tools.has('sq_add_section')).toBe(true);
    });

    it('should call addSectionWithBlocks with text block', async () => {
      mockClient.addSectionWithBlocks.mockResolvedValue({
        success: true,
        sectionId: 'sec-new',
        sectionIndex: 2,
        blockIds: ['blk-1'],
      });

      const result = await server.callTool('sq_add_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        blocks: [{ type: 'text', html: '<p>Contact us at hello@example.com</p>' }],
      });

      expect(mockClient.addSectionWithBlocks).toHaveBeenCalledWith(
        'psi-contact', 'col-contact',
        [{ type: 'text', html: '<p>Contact us at hello@example.com</p>' }],
        { position: undefined, styles: undefined },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.sectionId).toBe('sec-new');
      expect(data.blockIds).toEqual(['blk-1']);
    });

    it('should pass position and styles options', async () => {
      mockClient.addSectionWithBlocks.mockResolvedValue({
        success: true,
        sectionId: 'sec-new',
        sectionIndex: 0,
        blockIds: ['blk-1'],
      });

      await server.callTool('sq_add_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        blocks: [{ type: 'text', html: '<h1>Hero</h1>' }],
        position: 0,
        styles: { sectionTheme: 'dark' },
      });

      expect(mockClient.addSectionWithBlocks).toHaveBeenCalledWith(
        'psi-home', 'col-home',
        [{ type: 'text', html: '<h1>Hero</h1>' }],
        { position: 0, styles: { sectionTheme: 'dark' } },
      );
    });

    it('should return error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_section', {
        siteId: 'bad-site',
        pageSlug: 'home',
        blocks: [{ type: 'text', html: '<p>Test</p>' }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error when addSectionWithBlocks fails', async () => {
      mockClient.addSectionWithBlocks.mockResolvedValue({
        success: false,
        error: 'at least one block required',
      });

      const result = await server.callTool('sq_add_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        blocks: [],
      });

      expect(result.isError).toBe(true);
    });
  });
});
