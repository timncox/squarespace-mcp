import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  createBlogPost: vi.fn(),
  updateBlogPost: vi.fn(),
  getCollectionItems: vi.fn(),
  findBlogPostByTitle: vi.fn(),
  getMenuBlock: vi.fn(),
  updateMenuBlock: vi.fn(),
  addMenuBlock: vi.fn(),
  updateGallerySettings: vi.fn(),
  getPageSections: vi.fn(),
  findGalleryBlock: vi.fn(),
  getGalleryItems: vi.fn(),
  removeGalleryImage: vi.fn(),
  reorderGalleryImages: vi.fn(),
  addGalleryImage: vi.fn(),
  deleteBlogPost: vi.fn(),
};

const mockMediaClient = {
  uploadImage: vi.fn(),
  uploadImageFromUrl: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  getMediaClient: vi.fn(() => mockMediaClient),
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

  it('should register all content tools', () => {
    expect(server.tools.has('sq_create_blog_post')).toBe(true);
    expect(server.tools.has('sq_update_blog_post')).toBe(true);
    expect(server.tools.has('sq_delete_blog_post')).toBe(true);
    expect(server.tools.has('sq_list_blog_posts')).toBe(true);
    expect(server.tools.has('sq_find_blog_post')).toBe(true);
    expect(server.tools.has('sq_get_menu')).toBe(true);
    expect(server.tools.has('sq_update_menu')).toBe(true);
    expect(server.tools.has('sq_add_menu')).toBe(true);
    expect(server.tools.has('sq_update_gallery')).toBe(true);
    expect(server.tools.has('sq_list_gallery_images')).toBe(true);
    expect(server.tools.has('sq_remove_gallery_image')).toBe(true);
    expect(server.tools.has('sq_reorder_gallery_images')).toBe(true);
    expect(server.tools.has('sq_add_gallery_image')).toBe(true);
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

  // ── Delete Blog Post ───────────────────────────────────────────────────────

  describe('sq_delete_blog_post', () => {
    it('should delete a blog post without resolvePageIds', async () => {
      mockClient.deleteBlogPost.mockResolvedValue({
        success: true,
        postId: 'post-123',
      });

      const result = await server.callTool('sq_delete_blog_post', {
        siteId: 'smyth-tavern',
        collectionId: 'blog-col-1',
        postId: 'post-123',
      });

      expect(resolvePageIds).not.toHaveBeenCalled();
      expect(mockClient.deleteBlogPost).toHaveBeenCalledWith('blog-col-1', 'post-123');
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.postId).toBe('post-123');
    });

    it('should return error on API failure', async () => {
      mockClient.deleteBlogPost.mockResolvedValue({
        success: false,
        postId: 'post-123',
        error: 'RemoveItem returned 500',
      });

      const result = await server.callTool('sq_delete_blog_post', {
        siteId: 'smyth-tavern',
        collectionId: 'blog-col-1',
        postId: 'post-123',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('RemoveItem returned 500');
    });

    it('should return error on thrown exception', async () => {
      mockClient.deleteBlogPost.mockRejectedValue(new Error('Network timeout'));

      const result = await server.callTool('sq_delete_blog_post', {
        siteId: 'smyth-tavern',
        collectionId: 'blog-col-1',
        postId: 'post-456',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network timeout');
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

  describe('sq_add_menu', () => {
    it('should add a menu block with menuText', async () => {
      mockClient.addMenuBlock.mockResolvedValue({ success: true, blockId: 'menu-1', sectionIndex: 0 });

      const result = await server.callTool('sq_add_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'menu-page',
        sectionIndex: 0,
        menuText: 'Lunch\n========\nStarters\n------\nSoup\n$10',
      });

      expect(mockClient.addMenuBlock).toHaveBeenCalledWith(
        'psi-menu-page', 'col-menu-page', 0, 'Lunch\n========\nStarters\n------\nSoup\n$10', undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('menu-1');
    });

    it('should add empty menu block when menuText omitted', async () => {
      mockClient.addMenuBlock.mockResolvedValue({ success: true, blockId: 'menu-2' });

      await server.callTool('sq_add_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(mockClient.addMenuBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, undefined, undefined,
      );
    });

    it('should pass menuStyle and currencySymbol as options', async () => {
      mockClient.addMenuBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        menuStyle: 'modern',
        currencySymbol: '€',
      });

      const callArgs = mockClient.addMenuBlock.mock.calls[0];
      const passedOpts = callArgs[4];
      expect(passedOpts.menuStyle).toBe('modern');
      expect(passedOpts.currencySymbol).toBe('€');
    });

    it('should resolve offsetColumns to startX/endX', async () => {
      mockClient.addMenuBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        layout: { columns: 12, offsetColumns: 12 },
      });

      const callArgs = mockClient.addMenuBlock.mock.calls[0];
      const passedOpts = callArgs[4];
      expect(passedOpts.startX).toBe(13);
      expect(passedOpts.endX).toBe(25);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_menu', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(result.isError).toBe(true);
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

  // ── Gallery Image Management Tools ──────────────────────────────────────

  describe('sq_list_gallery_images', () => {
    it('lists gallery images on a page', async () => {
      mockClient.getPageSections.mockResolvedValue({
        sections: [{ id: 'sec-1' }],
        updatedOn: Date.now(),
      });
      mockClient.findGalleryBlock.mockReturnValue({
        galleryCollectionId: 'gal-col-1',
        sectionIndex: 0,
        blockIndex: 0,
        gridContent: {},
      });
      mockClient.getGalleryItems.mockResolvedValue({
        success: true,
        items: [
          { id: 'img-1', displayIndex: 0, filename: 'photo1.jpg', assetUrl: 'https://cdn/photo1.jpg' },
          { id: 'img-2', displayIndex: 1, filename: 'photo2.jpg', assetUrl: 'https://cdn/photo2.jpg' },
        ],
      });

      const result = await server.callTool('sq_list_gallery_images', {
        siteId: 'test-site',
        pageSlug: 'gallery',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.items).toHaveLength(2);
    });

    it('returns error when no gallery block found', async () => {
      mockClient.getPageSections.mockResolvedValue({
        sections: [{ id: 'sec-1' }],
        updatedOn: Date.now(),
      });
      mockClient.findGalleryBlock.mockReturnValue(null);

      const result = await server.callTool('sq_list_gallery_images', {
        siteId: 'test-site',
        pageSlug: 'no-gallery',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No gallery block found');
    });
  });

  describe('sq_remove_gallery_image', () => {
    it('removes a gallery image', async () => {
      mockClient.removeGalleryImage.mockResolvedValue({ success: true, itemId: 'img-1' });

      const result = await server.callTool('sq_remove_gallery_image', {
        siteId: 'test-site',
        itemId: 'img-1',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('returns error on failure', async () => {
      mockClient.removeGalleryImage.mockResolvedValue({ success: false, error: 'Not found' });

      const result = await server.callTool('sq_remove_gallery_image', {
        siteId: 'test-site',
        itemId: 'bad-id',
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('sq_reorder_gallery_images', () => {
    it('reorders gallery images', async () => {
      mockClient.getPageSections.mockResolvedValue({
        sections: [{ id: 'sec-1' }],
        updatedOn: Date.now(),
      });
      mockClient.findGalleryBlock.mockReturnValue({
        galleryCollectionId: 'gal-col-1',
        sectionIndex: 0,
        blockIndex: 0,
        gridContent: {},
      });
      mockClient.reorderGalleryImages.mockResolvedValue({
        success: true,
        items: [
          { id: 'img-2', displayIndex: 0 },
          { id: 'img-1', displayIndex: 1 },
        ],
      });

      const result = await server.callTool('sq_reorder_gallery_images', {
        siteId: 'test-site',
        pageSlug: 'gallery',
        itemIds: ['img-2', 'img-1'],
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(mockClient.reorderGalleryImages).toHaveBeenCalledWith('gal-col-1', ['img-2', 'img-1']);
    });
  });

  // ── sq_add_gallery_image ───────────────────────────────────────────────────
  describe('sq_add_gallery_image', () => {
    it('should upload and add image to gallery', async () => {
      mockClient.getPageSections.mockResolvedValue({ sections: [] });
      mockClient.findGalleryBlock.mockReturnValue({ galleryCollectionId: 'gal-123' });
      mockMediaClient.uploadImage.mockResolvedValue({ success: true, assetId: 'asset-1', assetUrl: 'https://images.squarespace-cdn.com/asset-1.jpg' });
      mockClient.addGalleryImage.mockResolvedValue({ success: true, itemId: 'item-1' });

      const result = await server.callTool('sq_add_gallery_image', {
        siteId: 'test-site',
        pageSlug: 'gallery',
        imagePath: '/tmp/photo.jpg',
        title: 'Beach sunset',
      });

      expect(mockMediaClient.uploadImage).toHaveBeenCalledWith('/tmp/photo.jpg');
      expect(mockClient.addGalleryImage).toHaveBeenCalledWith('gal-123', 'asset-1', { title: 'Beach sunset', description: undefined });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.itemId).toBe('item-1');
    });

    it('should upload from URL', async () => {
      mockClient.getPageSections.mockResolvedValue({ sections: [] });
      mockClient.findGalleryBlock.mockReturnValue({ galleryCollectionId: 'gal-123' });
      mockMediaClient.uploadImageFromUrl.mockResolvedValue({ success: true, assetId: 'asset-2', assetUrl: 'https://images.squarespace-cdn.com/asset-2.jpg' });
      mockClient.addGalleryImage.mockResolvedValue({ success: true, itemId: 'item-2' });

      const result = await server.callTool('sq_add_gallery_image', {
        siteId: 'test-site',
        pageSlug: 'gallery',
        imageUrl: 'https://example.com/photo.jpg',
      });

      expect(mockMediaClient.uploadImageFromUrl).toHaveBeenCalledWith('https://example.com/photo.jpg');
      expect(result.isError).toBeUndefined();
    });

    it('should error when no image source provided', async () => {
      const result = await server.callTool('sq_add_gallery_image', {
        siteId: 'test-site',
        pageSlug: 'gallery',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Must provide');
    });

    it('should error when no gallery found', async () => {
      mockClient.getPageSections.mockResolvedValue({ sections: [] });
      mockClient.findGalleryBlock.mockReturnValue(null);

      const result = await server.callTool('sq_add_gallery_image', {
        siteId: 'test-site',
        pageSlug: 'about',
        imagePath: '/tmp/photo.jpg',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No gallery block found');
    });

    it('should handle page resolution failure', async () => {
      (resolvePageIds as any).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_gallery_image', {
        siteId: 'test-site',
        pageSlug: 'missing',
        imagePath: '/tmp/photo.jpg',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });
});
