import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  createPageViaApi: vi.fn(),
  deletePageViaApi: vi.fn(),
  listCollections: vi.fn(),
  getNavigation: vi.fn(),
  updateNavigation: vi.fn(),
  updatePageMetadata: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
}));

import { resolvePageIds } from '../session.js';
import { registerPageTools } from '../tools/pages.js';

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

describe('Page Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerPageTools(server as any);
  });

  it('should register all 6 page tools', () => {
    expect(server.tools.has('sq_create_page')).toBe(true);
    expect(server.tools.has('sq_delete_page')).toBe(true);
    expect(server.tools.has('sq_list_pages')).toBe(true);
    expect(server.tools.has('sq_get_navigation')).toBe(true);
    expect(server.tools.has('sq_update_navigation')).toBe(true);
    expect(server.tools.has('sq_update_page_metadata')).toBe(true);
  });

  // ── sq_create_page ──────────────────────────────────────────────────────────

  describe('sq_create_page', () => {
    it('should create a page and return result', async () => {
      mockClient.createPageViaApi.mockResolvedValue({
        success: true,
        pageId: 'page-123',
        urlId: 'my-page',
        endpointAvailable: true,
      });

      const result = await server.callTool('sq_create_page', {
        siteId: 'test-site',
        title: 'My Page',
        slug: 'my-page',
      });

      expect(mockClient.createPageViaApi).toHaveBeenCalledWith('My Page', 'my-page', undefined);
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.pageId).toBe('page-123');
      expect(data.urlId).toBe('my-page');
    });

    it('should pass type 11 for blog pages', async () => {
      mockClient.createPageViaApi.mockResolvedValue({ success: true, pageId: 'blog-1' });

      await server.callTool('sq_create_page', {
        siteId: 'test-site',
        title: 'Blog',
        pageType: 'blog',
      });

      expect(mockClient.createPageViaApi).toHaveBeenCalledWith('Blog', undefined, { type: 11 });
    });

    it('should pass type 1 for page type', async () => {
      mockClient.createPageViaApi.mockResolvedValue({ success: true, pageId: 'p-1' });

      await server.callTool('sq_create_page', {
        siteId: 'test-site',
        title: 'About',
        pageType: 'page',
      });

      expect(mockClient.createPageViaApi).toHaveBeenCalledWith('About', undefined, { type: 1 });
    });

    it('should return error when creation fails', async () => {
      mockClient.createPageViaApi.mockResolvedValue({
        success: false,
        error: 'Endpoint not available',
        endpointAvailable: false,
      });

      const result = await server.callTool('sq_create_page', {
        siteId: 'test-site',
        title: 'Broken',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Endpoint not available');
    });

    it('should return error on exception', async () => {
      mockClient.createPageViaApi.mockRejectedValue(new Error('Network failure'));

      const result = await server.callTool('sq_create_page', {
        siteId: 'test-site',
        title: 'Oops',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network failure');
    });
  });

  // ── sq_delete_page ──────────────────────────────────────────────────────────

  describe('sq_delete_page', () => {
    it('should delete a page and return result', async () => {
      mockClient.deletePageViaApi.mockResolvedValue({
        success: true,
        collectionId: 'col-abc',
      });

      const result = await server.callTool('sq_delete_page', {
        siteId: 'test-site',
        collectionId: 'col-abc',
      });

      expect(mockClient.deletePageViaApi).toHaveBeenCalledWith('col-abc');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.collectionId).toBe('col-abc');
    });

    it('should return error when deletion fails', async () => {
      mockClient.deletePageViaApi.mockResolvedValue({
        success: false,
        error: 'Session expired',
      });

      const result = await server.callTool('sq_delete_page', {
        siteId: 'test-site',
        collectionId: 'col-bad',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session expired');
    });
  });

  // ── sq_list_pages ───────────────────────────────────────────────────────────

  describe('sq_list_pages', () => {
    it('should list all collections', async () => {
      mockClient.listCollections.mockResolvedValue([
        { id: 'c1', urlId: 'home', title: 'Home', type: 1, typeName: 'page', itemCount: 0 },
        { id: 'c2', urlId: 'blog', title: 'Blog', type: 11, typeName: 'blog', itemCount: 5 },
      ]);

      const result = await server.callTool('sq_list_pages', { siteId: 'test-site' });

      const data = JSON.parse(result.content[0].text);
      expect(data.pageCount).toBe(2);
      expect(data.pages[0].urlId).toBe('home');
      expect(data.pages[1].type).toBe(11);
    });

    it('should return empty array on error', async () => {
      mockClient.listCollections.mockResolvedValue([]);

      const result = await server.callTool('sq_list_pages', { siteId: 'test-site' });

      const data = JSON.parse(result.content[0].text);
      expect(data.pageCount).toBe(0);
      expect(data.pages).toEqual([]);
    });

    it('should return error on exception', async () => {
      mockClient.listCollections.mockRejectedValue(new Error('Auth failed'));

      const result = await server.callTool('sq_list_pages', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Auth failed');
    });
  });

  // ── sq_get_navigation ───────────────────────────────────────────────────────

  describe('sq_get_navigation', () => {
    it('should return navigation structure', async () => {
      mockClient.getNavigation.mockResolvedValue({
        success: true,
        data: {
          mainNavigation: [{ id: 'n1', title: 'Home' }],
          notLinked: [{ id: 'n2', title: 'Draft' }],
        },
      });

      const result = await server.callTool('sq_get_navigation', { siteId: 'test-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.mainNavigation).toHaveLength(1);
      expect(data.notLinked).toHaveLength(1);
    });

    it('should return error on failure', async () => {
      mockClient.getNavigation.mockResolvedValue({
        success: false,
        error: 'Cannot read navigation',
      });

      const result = await server.callTool('sq_get_navigation', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot read navigation');
    });
  });

  // ── sq_update_navigation ────────────────────────────────────────────────────

  describe('sq_update_navigation', () => {
    it('should update navigation and return success', async () => {
      mockClient.updateNavigation.mockResolvedValue({ success: true });

      const items = [{ id: 'n1', title: 'Home' }, { id: 'n2', title: 'About' }];
      const result = await server.callTool('sq_update_navigation', {
        siteId: 'test-site',
        fieldName: 'mainNav',
        items,
      });

      expect(mockClient.updateNavigation).toHaveBeenCalledWith('mainNav', items);
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.fieldName).toBe('mainNav');
    });

    it('should return error when update fails', async () => {
      mockClient.updateNavigation.mockResolvedValue({
        success: false,
        error: 'Invalid field name',
      });

      const result = await server.callTool('sq_update_navigation', {
        siteId: 'test-site',
        fieldName: 'badField',
        items: [],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid field name');
    });
  });

  // ── sq_update_page_metadata ─────────────────────────────────────────────────

  describe('sq_update_page_metadata', () => {
    it('should update metadata using collectionId from resolvePageIds', async () => {
      mockClient.updatePageMetadata.mockResolvedValue({
        success: true,
        collectionId: 'col-about',
        updatedFields: ['seoTitle', 'seoDescription'],
      });

      const result = await server.callTool('sq_update_page_metadata', {
        siteId: 'test-site',
        pageSlug: 'about',
        seoTitle: 'About Us | Test Site',
        seoDescription: 'Learn about our story',
      });

      expect(mockClient.updatePageMetadata).toHaveBeenCalledWith('col-about', {
        seoTitle: 'About Us | Test Site',
        seoDescription: 'Learn about our story',
      });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.updatedFields).toContain('seoTitle');
    });

    it('should return error when page cannot be resolved', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_page_metadata', {
        siteId: 'test-site',
        pageSlug: 'nonexistent',
        seoTitle: 'Test',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error when metadata update fails', async () => {
      mockClient.updatePageMetadata.mockResolvedValue({
        success: false,
        error: 'No fields provided for update',
      });

      const result = await server.callTool('sq_update_page_metadata', {
        siteId: 'test-site',
        pageSlug: 'about',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No fields provided');
    });
  });
});
