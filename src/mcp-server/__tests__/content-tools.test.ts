import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  createBlogPost: vi.fn(),
  updateBlogPost: vi.fn(),
  getCollectionItems: vi.fn(),
  findBlogPostByTitle: vi.fn(),
  getMenuBlock: vi.fn(),
  updateMenuBlock: vi.fn(),
  updateGallerySettings: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
}));

import { resolvePageIds } from '../session.js';
import { registerContentTools } from '../tools/content.js';

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

describe('Content Tools (Blog, Menu, Gallery)', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerContentTools(server as any);
  });

  it('should register all 7 content tools', () => {
    expect(server.tools.has('sq_create_blog_post')).toBe(true);
    expect(server.tools.has('sq_update_blog_post')).toBe(true);
    expect(server.tools.has('sq_list_blog_posts')).toBe(true);
    expect(server.tools.has('sq_find_blog_post')).toBe(true);
    expect(server.tools.has('sq_get_menu')).toBe(true);
    expect(server.tools.has('sq_update_menu')).toBe(true);
    expect(server.tools.has('sq_update_gallery')).toBe(true);
  });

  // ── Blog Tools ──────────────────────────────────────────────────────────────

  describe('sq_create_blog_post', () => {
    it('should create a blog post without resolvePageIds', async () => {
      mockClient.createBlogPost.mockResolvedValue({
        success: true,
        endpointAvailable: true,
        itemId: 'post-123',
        urlId: 'my-post',
      });

      const result = await server.callTool('sq_create_blog_post', {
        siteId: 'smyth-tavern',
        collectionId: 'blog-col-1',
        title: 'My First Post',
        body: '<p>Hello world</p>',
        tags: ['news'],
        draft: true,
      });

      // Blog tools do NOT call resolvePageIds
      expect(resolvePageIds).not.toHaveBeenCalled();
      expect(mockClient.createBlogPost).toHaveBeenCalledWith('blog-col-1', 'My First Post', {
        body: '<p>Hello world</p>',
        tags: ['news'],
        draft: true,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.itemId).toBe('post-123');
    });

    it('should return error on API failure', async () => {
      mockClient.createBlogPost.mockResolvedValue({
        success: false,
        endpointAvailable: true,
        error: 'API returned 500',
      });

      const result = await server.callTool('sq_create_blog_post', {
        siteId: 'smyth-tavern',
        collectionId: 'blog-col-1',
        title: 'Bad Post',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('API returned 500');
    });

    it('should return error on thrown exception', async () => {
      mockClient.createBlogPost.mockRejectedValue(new Error('Network timeout'));

      const result = await server.callTool('sq_create_blog_post', {
        siteId: 'smyth-tavern',
        collectionId: 'blog-col-1',
        title: 'Failing Post',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network timeout');
    });

    it('should pass excerpt, categories, slug, publishDate to createBlogPost', async () => {
      mockClient.createBlogPost.mockResolvedValue({
        success: true, endpointAvailable: true, itemId: 'post-456', urlId: 'custom-slug',
      });

      await server.callTool('sq_create_blog_post', {
        siteId: 'smyth-tavern', collectionId: 'blog-col-1', title: 'Full Post',
        body: '<p>Content</p>', excerpt: 'A brief summary', categories: ['food', 'nyc'],
        slug: 'custom-slug', publishDate: '2026-01-15T10:00:00Z', tags: ['review'], draft: false,
      });

      expect(mockClient.createBlogPost).toHaveBeenCalledWith('blog-col-1', 'Full Post', {
        body: '<p>Content</p>', excerpt: 'A brief summary', categories: ['food', 'nyc'],
        slug: 'custom-slug', publishDate: '2026-01-15T10:00:00Z', tags: ['review'], draft: false,
      });
    });
  });

  describe('sq_update_blog_post', () => {
    it('should update a blog post without resolvePageIds', async () => {
      mockClient.updateBlogPost.mockResolvedValue({
        success: true,
        itemId: 'post-123',
        updatedFields: ['title', 'body'],
      });

      const result = await server.callTool('sq_update_blog_post', {
        siteId: 'smyth-tavern',
        collectionId: 'blog-col-1',
        postId: 'post-123',
        title: 'Updated Title',
        body: '<p>Updated body</p>',
        tags: ['updated'],
        draft: false,
      });

      expect(resolvePageIds).not.toHaveBeenCalled();
      expect(mockClient.updateBlogPost).toHaveBeenCalledWith('blog-col-1', 'post-123', {
        title: 'Updated Title',
        body: '<p>Updated body</p>',
        tags: ['updated'],
        draft: false,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.updatedFields).toEqual(['title', 'body']);
    });

    it('should return error on failure', async () => {
      mockClient.updateBlogPost.mockResolvedValue({
        success: false,
        itemId: 'post-123',
        updatedFields: [],
        error: 'Post not found',
      });

      const result = await server.callTool('sq_update_blog_post', {
        siteId: 'smyth-tavern',
        collectionId: 'blog-col-1',
        postId: 'post-123',
        title: 'Nope',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Post not found');
    });

    it('should pass excerpt, categories, slug, publishDate to updateBlogPost', async () => {
      mockClient.updateBlogPost.mockResolvedValue({
        success: true, itemId: 'post-789', updatedFields: ['excerpt', 'categories', 'urlId', 'publishDate'],
      });

      await server.callTool('sq_update_blog_post', {
        siteId: 'smyth-tavern', collectionId: 'blog-col-1', postId: 'post-789',
        excerpt: 'Updated summary', categories: ['travel'], slug: 'new-slug', publishDate: '2026-06-01T00:00:00Z',
      });

      expect(mockClient.updateBlogPost).toHaveBeenCalledWith('blog-col-1', 'post-789', {
        excerpt: 'Updated summary', categories: ['travel'], urlId: 'new-slug', publishDate: '2026-06-01T00:00:00Z',
      });
    });
  });

  // ── List / Find Blog Posts ──────────────────────────────────────────────────

  describe('sq_list_blog_posts', () => {
    it('should list blog posts with default options', async () => {
      mockClient.getCollectionItems.mockResolvedValue({
        success: true,
        items: [
          { id: 'post-1', title: 'First Post', urlId: 'first-post', tags: ['news'] },
          { id: 'post-2', title: 'Second Post', urlId: 'second-post', tags: [] },
        ],
        total: 2,
      });
      const result = await server.callTool('sq_list_blog_posts', { siteId: 'smyth-tavern', collectionId: 'blog-col-1' });
      expect(mockClient.getCollectionItems).toHaveBeenCalledWith('blog-col-1', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.items).toHaveLength(2);
    });

    it('should pass filter and limit options', async () => {
      mockClient.getCollectionItems.mockResolvedValue({ success: true, items: [], total: 0 });
      await server.callTool('sq_list_blog_posts', { siteId: 'smyth-tavern', collectionId: 'blog-col-1', filter: 'published', limit: 10 });
      expect(mockClient.getCollectionItems).toHaveBeenCalledWith('blog-col-1', { filter: 'published', limit: 10 });
    });

    it('should return error on failure', async () => {
      mockClient.getCollectionItems.mockResolvedValue({ success: false, error: 'Collection not found' });
      const result = await server.callTool('sq_list_blog_posts', { siteId: 'smyth-tavern', collectionId: 'bad-col' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Collection not found');
    });
  });

  describe('sq_find_blog_post', () => {
    it('should find a blog post by title', async () => {
      mockClient.findBlogPostByTitle.mockResolvedValue({ id: 'post-1', title: 'Vegan Restaurants in NYC', urlId: 'vegan-restaurants' });
      const result = await server.callTool('sq_find_blog_post', { siteId: 'smyth-tavern', collectionId: 'blog-col-1', title: 'vegan' });
      expect(mockClient.findBlogPostByTitle).toHaveBeenCalledWith('blog-col-1', 'vegan');
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBe('post-1');
    });

    it('should return error when post not found', async () => {
      mockClient.findBlogPostByTitle.mockResolvedValue(null);
      const result = await server.callTool('sq_find_blog_post', { siteId: 'smyth-tavern', collectionId: 'blog-col-1', title: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No blog post found');
    });
  });

  // ── Menu Tools ──────────────────────────────────────────────────────────────

  describe('sq_get_menu', () => {
    it('should resolve page IDs and return menu data', async () => {
      mockClient.getMenuBlock.mockResolvedValue({
        success: true,
        menus: [{ title: 'Lunch', sections: [{ title: 'Mains', items: [{ title: 'Burger', price: '$12' }] }] }],
        menuStyle: 0,
        currencySymbol: '$',
        blockId: 'blk-menu-1',
      });

      const result = await server.callTool('sq_get_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'menu',
        searchText: 'Lunch',
      });

      // Menu tools DO call resolvePageIds
      expect(resolvePageIds).toHaveBeenCalledWith('smyth-tavern', 'menu');
      // getMenuBlock only takes pageSectionsId (not collectionId)
      expect(mockClient.getMenuBlock).toHaveBeenCalledWith('psi-menu', 'Lunch');
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.menus).toHaveLength(1);
      expect(data.menus[0].title).toBe('Lunch');
    });

    it('should return error for unknown page', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_get_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'nonexistent',
        searchText: 'Lunch',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error when menu block not found', async () => {
      mockClient.getMenuBlock.mockResolvedValue({
        success: false,
        error: 'Menu block not found for searchText "Missing"',
      });

      const result = await server.callTool('sq_get_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'menu',
        searchText: 'Missing',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Menu block not found');
    });
  });

  describe('sq_update_menu', () => {
    it('should resolve page IDs and update menu', async () => {
      const newMenus = [
        { title: 'Dinner', sections: [{ title: 'Starters', items: [{ title: 'Soup', price: '$8' }] }] },
      ];
      mockClient.updateMenuBlock.mockResolvedValue({
        success: true,
        blockId: 'blk-menu-1',
        sectionId: 'sec-1',
        oldTabCount: 1,
        newTabCount: 1,
        oldItemCount: 3,
        newItemCount: 1,
      });

      const result = await server.callTool('sq_update_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'menu',
        searchText: 'Lunch',
        menus: newMenus,
        preserveRaw: false,
      });

      expect(resolvePageIds).toHaveBeenCalledWith('smyth-tavern', 'menu');
      expect(mockClient.updateMenuBlock).toHaveBeenCalledWith(
        'psi-menu', 'col-menu', 'Lunch', newMenus, { preserveRaw: false },
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.newTabCount).toBe(1);
    });

    it('should return error for unknown page', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'nonexistent',
        searchText: 'Lunch',
        menus: [],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error on update failure', async () => {
      mockClient.updateMenuBlock.mockResolvedValue({
        success: false,
        error: 'Menu block not found for searchText "Bad"',
      });

      const result = await server.callTool('sq_update_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'menu',
        searchText: 'Bad',
        menus: [],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Menu block not found');
    });
  });

  // ── Gallery Tool ────────────────────────────────────────────────────────────

  describe('sq_update_gallery', () => {
    it('should resolve page IDs and update gallery settings', async () => {
      mockClient.updateGallerySettings.mockResolvedValue({
        success: true,
        blockId: 'blk-gallery-1',
        updatedFields: ['thumbnails-per-row', 'lightbox'],
      });

      const result = await server.callTool('sq_update_gallery', {
        siteId: 'smyth-tavern',
        pageSlug: 'gallery',
        searchText: 'gallery-col-1',
        settings: { 'thumbnails-per-row': 4, lightbox: true },
      });

      expect(resolvePageIds).toHaveBeenCalledWith('smyth-tavern', 'gallery');
      expect(mockClient.updateGallerySettings).toHaveBeenCalledWith(
        'psi-gallery', 'col-gallery', 'gallery-col-1', { 'thumbnails-per-row': 4, lightbox: true },
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.updatedFields).toContain('thumbnails-per-row');
    });

    it('should return error for unknown page', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_gallery', {
        siteId: 'smyth-tavern',
        pageSlug: 'nonexistent',
        searchText: 'gallery-col-1',
        settings: { lightbox: true },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error on gallery not found', async () => {
      mockClient.updateGallerySettings.mockResolvedValue({
        success: false,
        error: 'No gallery block found matching: bad-id',
      });

      const result = await server.callTool('sq_update_gallery', {
        siteId: 'smyth-tavern',
        pageSlug: 'gallery',
        searchText: 'bad-id',
        settings: { padding: 10 },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No gallery block found');
    });
  });
});
