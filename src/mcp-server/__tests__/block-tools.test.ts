import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  addButtonBlock: vi.fn(),
  updateButtonBlock: vi.fn(),
  addImageBlock: vi.fn(),
  updateImageBlock: vi.fn(),
  removeBlock: vi.fn(),
  moveBlock: vi.fn(),
  resizeBlock: vi.fn(),
  swapBlocks: vi.fn(),
  duplicateBlock: vi.fn(),
  addVideoBlock: vi.fn(),
  updateVideoBlock: vi.fn(),
  addEmbedBlock: vi.fn(),
  updateEmbedBlock: vi.fn(),
  addAccordionBlock: vi.fn(),
  updateAccordionBlock: vi.fn(),
  addQuoteBlock: vi.fn(),
  updateQuoteBlock: vi.fn(),
  addMarqueeBlock: vi.fn(),
  updateMarqueeBlock: vi.fn(),
  addNewsletterBlock: vi.fn(),
  updateNewsletterBlock: vi.fn(),
  addDividerBlock: vi.fn(),
  addCodeBlock: vi.fn(),
  updateCodeBlock: vi.fn(),
  addSocialLinksBlock: vi.fn(),
  updateSocialLinksBlock: vi.fn(),
  addAudioBlock: vi.fn(),
  updateAudioBlock: vi.fn(),
  addPageLinkBlock: vi.fn(),
  updatePageLinkBlock: vi.fn(),
  addHorizontalRuleBlock: vi.fn(),
  addSearchBlock: vi.fn(),
  updateSearchBlock: vi.fn(),
  addMarkdownBlock: vi.fn(),
  updateMarkdownBlock: vi.fn(),
  addSummaryBlock: vi.fn(),
  updateSummaryBlock: vi.fn(),
  addProductBlock: vi.fn(),
  updateProductBlock: vi.fn(),
};

const mockMediaClient = {
  uploadImage: vi.fn(),
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
import { registerBlockTools } from '../tools/blocks.js';

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

describe('Block Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerBlockTools(server as any);
  });

  it('should register all block tools', () => {
    expect(server.tools.has('sq_add_button')).toBe(true);
    expect(server.tools.has('sq_update_button')).toBe(true);
    expect(server.tools.has('sq_add_image')).toBe(true);
    expect(server.tools.has('sq_update_image')).toBe(true);
    expect(server.tools.has('sq_upload_image')).toBe(true);
    expect(server.tools.has('sq_remove_block')).toBe(true);
    expect(server.tools.has('sq_move_block')).toBe(true);
    expect(server.tools.has('sq_resize_block')).toBe(true);
    expect(server.tools.has('sq_swap_blocks')).toBe(true);
    expect(server.tools.has('sq_duplicate_block')).toBe(true);
    expect(server.tools.has('sq_add_video')).toBe(true);
    expect(server.tools.has('sq_update_video')).toBe(true);
    expect(server.tools.has('sq_add_embed')).toBe(true);
    expect(server.tools.has('sq_update_embed')).toBe(true);
    expect(server.tools.has('sq_add_accordion')).toBe(true);
    expect(server.tools.has('sq_update_accordion')).toBe(true);
    expect(server.tools.has('sq_add_quote')).toBe(true);
    expect(server.tools.has('sq_update_quote')).toBe(true);
    expect(server.tools.has('sq_add_marquee')).toBe(true);
    expect(server.tools.has('sq_update_marquee')).toBe(true);
    expect(server.tools.has('sq_add_newsletter')).toBe(true);
    expect(server.tools.has('sq_update_newsletter')).toBe(true);
    expect(server.tools.has('sq_add_divider')).toBe(true);
    expect(server.tools.has('sq_add_code')).toBe(true);
    expect(server.tools.has('sq_update_code')).toBe(true);
    expect(server.tools.has('sq_add_social_links_block')).toBe(true);
    expect(server.tools.has('sq_update_social_links_block')).toBe(true);
    expect(server.tools.has('sq_add_audio')).toBe(true);
    expect(server.tools.has('sq_update_audio')).toBe(true);
    expect(server.tools.has('sq_add_page_link')).toBe(true);
    expect(server.tools.has('sq_update_page_link')).toBe(true);
    expect(server.tools.has('sq_add_horizontal_rule')).toBe(true);
    expect(server.tools.has('sq_add_search')).toBe(true);
    expect(server.tools.has('sq_update_search')).toBe(true);
    expect(server.tools.has('sq_add_markdown')).toBe(true);
    expect(server.tools.has('sq_update_markdown')).toBe(true);
    expect(server.tools.has('sq_add_summary')).toBe(true);
    expect(server.tools.has('sq_update_summary')).toBe(true);
    expect(server.tools.has('sq_add_product_block')).toBe(true);
    expect(server.tools.has('sq_update_product_block')).toBe(true);
  });

  // ── sq_add_button ─────────────────────────────────────────────────────────
  describe('sq_add_button', () => {
    it('should add a button block', async () => {
      mockClient.addButtonBlock.mockResolvedValue({ success: true, blockId: 'btn-1' });

      const result = await server.callTool('sq_add_button', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        label: 'Learn More',
        url: '/about',
      });

      expect(mockClient.addButtonBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, 'Learn More', '/about', undefined, undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('btn-1');
    });

    it('should pass design options', async () => {
      mockClient.addButtonBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_button', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 1,
        label: 'Contact',
        url: '/contact',
        design: { size: 'large', style: 'primary', variant: 'solid' },
      });

      expect(mockClient.addButtonBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 1, 'Contact', '/contact', undefined,
        { size: 'large', style: 'primary', variant: 'solid' },
      );
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_button', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
        label: 'X',
        url: '/',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_update_button ──────────────────────────────────────────────────────
  describe('sq_update_button', () => {
    it('should update button label and URL', async () => {
      mockClient.updateButtonBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_button', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Learn More',
        label: 'Read More',
        url: '/blog',
      });

      expect(mockClient.updateButtonBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Learn More', { newLabel: 'Read More', url: '/blog' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should include design updates', async () => {
      mockClient.updateButtonBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_update_button', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Contact',
        design: { size: 'small', alignment: 'center' },
      });

      expect(mockClient.updateButtonBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Contact', { size: 'small', alignment: 'center' },
      );
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_button', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_add_image ──────────────────────────────────────────────────────────
  describe('sq_add_image', () => {
    it('should add an image block', async () => {
      mockClient.addImageBlock.mockResolvedValue({ success: true, blockId: 'img-1' });

      const result = await server.callTool('sq_add_image', {
        siteId: 'smyth-tavern',
        pageSlug: 'about',
        sectionIndex: 0,
        assetUrl: 'https://images.squarespace-cdn.com/content/abc.jpg',
        altText: 'Team photo',
      });

      expect(mockClient.addImageBlock).toHaveBeenCalledWith(
        'psi-about', 'col-about', 0, 'https://images.squarespace-cdn.com/content/abc.jpg',
        { altText: 'Team photo' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should pass layout options', async () => {
      mockClient.addImageBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_image', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 2,
        assetUrl: 'https://example.com/img.jpg',
        layout: { columns: 12 },
      });

      expect(mockClient.addImageBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 2, 'https://example.com/img.jpg',
        { layout: { columns: 12 } },
      );
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_image', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
        assetUrl: 'https://example.com/img.jpg',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_update_image ───────────────────────────────────────────────────────
  describe('sq_update_image', () => {
    it('should update image metadata', async () => {
      mockClient.updateImageBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_image', {
        siteId: 'smyth-tavern',
        pageSlug: 'about',
        searchText: 'Team photo',
        altText: 'Updated team photo',
        title: 'Our Team',
      });

      expect(mockClient.updateImageBlock).toHaveBeenCalledWith(
        'psi-about', 'col-about', 'Team photo', { altText: 'Updated team photo', title: 'Our Team' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should update image asset URL', async () => {
      mockClient.updateImageBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_update_image', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Hero image',
        assetUrl: 'https://images.squarespace-cdn.com/content/new.jpg',
      });

      expect(mockClient.updateImageBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Hero image', { assetUrl: 'https://images.squarespace-cdn.com/content/new.jpg' },
      );
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_image', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_upload_image ───────────────────────────────────────────────────────
  describe('sq_upload_image', () => {
    it('should upload image and return assetUrl', async () => {
      mockMediaClient.uploadImage.mockResolvedValue({
        assetUrl: 'https://images.squarespace-cdn.com/content/uploaded.jpg',
        jobId: 'job-1',
      });

      const result = await server.callTool('sq_upload_image', {
        siteId: 'smyth-tavern',
        imageUrl: '/tmp/photo.jpg',
      });

      expect(mockMediaClient.uploadImage).toHaveBeenCalledWith('/tmp/photo.jpg');
      const data = JSON.parse(result.content[0].text);
      expect(data.assetUrl).toBe('https://images.squarespace-cdn.com/content/uploaded.jpg');
      expect(result.isError).toBeUndefined();
    });

    it('should not call resolvePageIds', async () => {
      mockMediaClient.uploadImage.mockResolvedValue({ assetUrl: 'https://example.com/img.jpg' });

      await server.callTool('sq_upload_image', {
        siteId: 'smyth-tavern',
        imageUrl: '/tmp/photo.jpg',
      });

      expect(resolvePageIds).not.toHaveBeenCalled();
    });

    it('should return error on upload failure', async () => {
      mockMediaClient.uploadImage.mockRejectedValue(new Error('Upload failed: 413'));

      const result = await server.callTool('sq_upload_image', {
        siteId: 'smyth-tavern',
        imageUrl: '/tmp/huge.jpg',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Upload failed: 413');
    });

    it('should require imageUrl', async () => {
      const result = await server.callTool('sq_upload_image', {
        siteId: 'smyth-tavern',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('imageUrl is required');
    });
  });

  // ── sq_remove_block ───────────────────────────────────────────────────────
  describe('sq_remove_block', () => {
    it('should remove a block', async () => {
      mockClient.removeBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_remove_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Old paragraph',
      });

      expect(mockClient.removeBlock).toHaveBeenCalledWith('psi-home', 'col-home', 'Old paragraph');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_remove_block', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_move_block ─────────────────────────────────────────────────────────
  describe('sq_move_block', () => {
    it('should move a block', async () => {
      mockClient.moveBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_move_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Heading',
        direction: 'left',
        gridSteps: 3,
      });

      expect(mockClient.moveBlock).toHaveBeenCalledWith('psi-home', 'col-home', 'Heading', 'left', 3);
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should work without gridSteps', async () => {
      mockClient.moveBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_move_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Heading',
        direction: 'up',
      });

      expect(mockClient.moveBlock).toHaveBeenCalledWith('psi-home', 'col-home', 'Heading', 'up', undefined);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_move_block', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
        direction: 'up',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_resize_block ───────────────────────────────────────────────────────
  describe('sq_resize_block', () => {
    it('should resize a block', async () => {
      mockClient.resizeBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_resize_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Hero text',
        width: 'full',
        height: 'taller',
      });

      expect(mockClient.resizeBlock).toHaveBeenCalledWith('psi-home', 'col-home', 'Hero text', 'full', 'taller');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_resize_block', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_swap_blocks ────────────────────────────────────────────────────────
  describe('sq_swap_blocks', () => {
    it('should swap two blocks', async () => {
      mockClient.swapBlocks.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_swap_blocks', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText1: 'Block A',
        searchText2: 'Block B',
      });

      expect(mockClient.swapBlocks).toHaveBeenCalledWith('psi-home', 'col-home', 'Block A', 'Block B');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_swap_blocks', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText1: 'A',
        searchText2: 'B',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_duplicate_block ────────────────────────────────────────────────────
  describe('sq_duplicate_block', () => {
    it('should duplicate a block', async () => {
      mockClient.duplicateBlock.mockResolvedValue({ success: true, blockId: 'dup-1' });

      const result = await server.callTool('sq_duplicate_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Testimonial',
      });

      expect(mockClient.duplicateBlock).toHaveBeenCalledWith('psi-home', 'col-home', 'Testimonial');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('dup-1');
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_duplicate_block', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_add_video ───────────────────────────────────────────────────────
  describe('sq_add_video', () => {
    it('should add a video block with URL', async () => {
      mockClient.addVideoBlock.mockResolvedValue({ success: true, blockId: 'vid-1' });

      const result = await server.callTool('sq_add_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        videoUrl: 'https://www.youtube.com/watch?v=WCkcPcMTYuQ',
      });

      expect(mockClient.addVideoBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, 'https://www.youtube.com/watch?v=WCkcPcMTYuQ', undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('vid-1');
    });

    it('should pass title, description, and layout', async () => {
      mockClient.addVideoBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 1,
        videoUrl: 'https://vimeo.com/12345',
        title: 'Our Story',
        description: 'A short video about us',
        layout: { columns: 12, rowHeight: 10 },
      });

      expect(mockClient.addVideoBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 1, 'https://vimeo.com/12345',
        { title: 'Our Story', description: 'A short video about us', layout: { columns: 12, rowHeight: 10 } },
      );
    });

    it('should resolve offsetColumns to startX/endX', async () => {
      mockClient.addVideoBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        videoUrl: 'https://www.youtube.com/watch?v=abc',
        layout: { columns: 12, offsetColumns: 12 },
      });

      const callArgs = mockClient.addVideoBlock.mock.calls[0];
      const options = callArgs[4];
      expect(options.layout.startX).toBe(13);
      expect(options.layout.endX).toBe(25);
    });

    it('should not override explicit startX/endX with offsetColumns', async () => {
      mockClient.addVideoBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        videoUrl: 'https://www.youtube.com/watch?v=abc',
        layout: { startX: 5, endX: 20, offsetColumns: 12 },
      });

      const callArgs = mockClient.addVideoBlock.mock.calls[0];
      const options = callArgs[4];
      expect(options.layout.startX).toBe(5);
      expect(options.layout.endX).toBe(20);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_video', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
        videoUrl: 'https://www.youtube.com/watch?v=abc',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_update_video ────────────────────────────────────────────────────
  describe('sq_update_video', () => {
    it('should update video URL', async () => {
      mockClient.updateVideoBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'youtube.com',
        videoUrl: 'https://www.youtube.com/watch?v=newvid',
      });

      expect(mockClient.updateVideoBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'youtube.com', { url: 'https://www.youtube.com/watch?v=newvid' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should update title and description', async () => {
      mockClient.updateVideoBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_update_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Our Story',
        title: 'Updated Title',
        description: 'Updated description',
      });

      expect(mockClient.updateVideoBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Our Story', { title: 'Updated Title', description: 'Updated description' },
      );
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_video', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_add_embed ───────────────────────────────────────────────────────
  describe('sq_add_embed', () => {
    it('should add an embed block with HTML', async () => {
      mockClient.addEmbedBlock.mockResolvedValue({ success: true, blockId: 'emb-1' });

      const result = await server.callTool('sq_add_embed', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        sectionIndex: 1,
        html: '<iframe src="https://calendly.com/example"></iframe>',
      });

      expect(mockClient.addEmbedBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 1, '<iframe src="https://calendly.com/example"></iframe>', undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('emb-1');
    });

    it('should add blank embed when html omitted', async () => {
      mockClient.addEmbedBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_embed', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(mockClient.addEmbedBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, undefined, undefined,
      );
    });

    it('should resolve offsetColumns to startX/endX', async () => {
      mockClient.addEmbedBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_embed', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        html: '<div>test</div>',
        layout: { columns: 12, offsetColumns: 12 },
      });

      const callArgs = mockClient.addEmbedBlock.mock.calls[0];
      const passedLayout = callArgs[4];
      expect(passedLayout.startX).toBe(13);
      expect(passedLayout.endX).toBe(25);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_embed', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_update_embed ────────────────────────────────────────────────────
  describe('sq_update_embed', () => {
    it('should update embed HTML', async () => {
      mockClient.updateEmbedBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_embed', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        searchText: 'calendly',
        html: '<iframe src="https://calendly.com/new-link"></iframe>',
      });

      expect(mockClient.updateEmbedBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 'calendly', '<iframe src="https://calendly.com/new-link"></iframe>',
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_embed', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
        html: '<div>test</div>',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── Exception handling ────────────────────────────────────────────────────
  describe('exception handling', () => {
    it('should catch thrown errors and return isError', async () => {
      mockClient.removeBlock.mockRejectedValue(new Error('Network timeout'));

      const result = await server.callTool('sq_remove_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'X',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network timeout');
    });

    it('should handle non-Error thrown values', async () => {
      mockClient.swapBlocks.mockRejectedValue('unexpected string error');

      const result = await server.callTool('sq_swap_blocks', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText1: 'A',
        searchText2: 'B',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('unexpected string error');
    });
  });

  // ── sq_add_accordion ──────────────────────────────────────────────────────
  describe('sq_add_accordion', () => {
    it('should register sq_add_accordion tool', () => {
      expect(server.tools.has('sq_add_accordion')).toBe(true);
    });

    it('should add an accordion block', async () => {
      mockClient.addAccordionBlock.mockResolvedValue({ success: true, blockId: 'acc-1', sectionIndex: 0 });

      const result = await server.callTool('sq_add_accordion', {
        siteId: 'smyth-tavern',
        pageSlug: 'faq',
        sectionIndex: 0,
        items: [
          { title: 'What are your hours?', description: 'Mon-Sat 5pm-11pm' },
          { title: 'Do you take reservations?', description: 'Yes, via OpenTable.' },
        ],
      });

      expect(mockClient.addAccordionBlock).toHaveBeenCalledWith(
        'psi-faq', 'col-faq', 0,
        [
          { title: 'What are your hours?', description: 'Mon-Sat 5pm-11pm' },
          { title: 'Do you take reservations?', description: 'Yes, via OpenTable.' },
        ],
        { isExpandedFirstItem: undefined, shouldAllowMultipleOpenItems: undefined },
        undefined,
      );
      expect(result.content[0].text).toContain('acc-1');
    });

    it('should pass expandFirst and allowMultipleOpen options', async () => {
      mockClient.addAccordionBlock.mockResolvedValue({ success: true, blockId: 'acc-2', sectionIndex: 0 });

      await server.callTool('sq_add_accordion', {
        siteId: 'smyth-tavern',
        pageSlug: 'faq',
        sectionIndex: 0,
        items: [{ title: 'Q1', description: 'A1' }],
        expandFirst: true,
        allowMultipleOpen: true,
      });

      expect(mockClient.addAccordionBlock).toHaveBeenCalledWith(
        'psi-faq', 'col-faq', 0,
        [{ title: 'Q1', description: 'A1' }],
        { isExpandedFirstItem: true, shouldAllowMultipleOpenItems: true },
        undefined,
      );
    });

    it('should resolve offsetColumns for accordion', async () => {
      mockClient.addAccordionBlock.mockResolvedValue({ success: true, blockId: 'acc-3', sectionIndex: 0 });

      await server.callTool('sq_add_accordion', {
        siteId: 'smyth-tavern',
        pageSlug: 'faq',
        sectionIndex: 0,
        items: [{ title: 'Q', description: 'A' }],
        layout: { offsetColumns: 6, columns: 12 },
      });

      const call = mockClient.addAccordionBlock.mock.calls[0];
      const layout = call[5];
      expect(layout.startX).toBe(7);
      expect(layout.endX).toBe(19);
      expect(layout.offsetColumns).toBeUndefined();
    });

    it('should handle page resolution failure', async () => {
      (resolvePageIds as any).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_accordion', {
        siteId: 'smyth-tavern',
        pageSlug: 'missing',
        sectionIndex: 0,
        items: [{ title: 'Q', description: 'A' }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_update_accordion ───────────────────────────────────────────────────
  describe('sq_update_accordion', () => {
    it('should register sq_update_accordion tool', () => {
      expect(server.tools.has('sq_update_accordion')).toBe(true);
    });

    it('should update accordion items', async () => {
      mockClient.updateAccordionBlock.mockResolvedValue({ success: true, blockId: 'acc-1' });

      const result = await server.callTool('sq_update_accordion', {
        siteId: 'smyth-tavern',
        pageSlug: 'faq',
        searchText: 'hours',
        items: [
          { title: 'Updated Q1', description: 'Updated A1' },
        ],
      });

      expect(mockClient.updateAccordionBlock).toHaveBeenCalledWith(
        'psi-faq', 'col-faq', 'hours',
        { items: [{ title: 'Updated Q1', description: 'Updated A1' }] },
      );
      expect(result.content[0].text).toContain('acc-1');
    });

    it('should pass expandFirst and allowMultipleOpen', async () => {
      mockClient.updateAccordionBlock.mockResolvedValue({ success: true, blockId: 'acc-1' });

      await server.callTool('sq_update_accordion', {
        siteId: 'smyth-tavern',
        pageSlug: 'faq',
        searchText: 'hours',
        expandFirst: true,
        allowMultipleOpen: false,
      });

      expect(mockClient.updateAccordionBlock).toHaveBeenCalledWith(
        'psi-faq', 'col-faq', 'hours',
        { isExpandedFirstItem: true, shouldAllowMultipleOpenItems: false },
      );
    });

    it('should handle errors', async () => {
      mockClient.updateAccordionBlock.mockRejectedValue(new Error('block not found'));

      const result = await server.callTool('sq_update_accordion', {
        siteId: 'smyth-tavern',
        pageSlug: 'faq',
        searchText: 'missing',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('block not found');
    });
  });

  // ── sq_add_quote ────────────────────────────────────────────────────────────
  describe('sq_add_quote', () => {
    it('should add a quote block', async () => {
      mockClient.addQuoteBlock.mockResolvedValue({ success: true, blockId: 'q-1', sectionIndex: 0 });

      const result = await server.callTool('sq_add_quote', {
        siteId: 'test-site',
        pageSlug: 'about',
        sectionIndex: 0,
        quoteText: 'Best restaurant in town!',
        attribution: '— Jane Doe',
      });

      expect(mockClient.addQuoteBlock).toHaveBeenCalledWith(
        'psi-about', 'col-about', 0, 'Best restaurant in town!', '— Jane Doe', undefined,
      );
      expect(result.content[0].text).toContain('q-1');
    });

    it('should resolve offsetColumns for quote', async () => {
      mockClient.addQuoteBlock.mockResolvedValue({ success: true, blockId: 'q-2', sectionIndex: 0 });

      await server.callTool('sq_add_quote', {
        siteId: 'test-site',
        pageSlug: 'about',
        sectionIndex: 0,
        quoteText: 'Great food!',
        layout: { offsetColumns: 4, columns: 16 },
      });

      const call = mockClient.addQuoteBlock.mock.calls[0];
      const layout = call[5];
      expect(layout.startX).toBe(5);
      expect(layout.endX).toBe(21);
      expect(layout.offsetColumns).toBeUndefined();
    });

    it('should handle page resolution failure', async () => {
      (resolvePageIds as any).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_quote', {
        siteId: 'test-site',
        pageSlug: 'missing',
        sectionIndex: 0,
        quoteText: 'test',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_update_quote ─────────────────────────────────────────────────────────
  describe('sq_update_quote', () => {
    it('should update a quote block', async () => {
      mockClient.updateQuoteBlock.mockResolvedValue({ success: true, blockId: 'q-1' });

      const result = await server.callTool('sq_update_quote', {
        siteId: 'test-site',
        pageSlug: 'about',
        searchText: 'Best restaurant',
        quoteText: 'Updated quote text',
        attribution: '— John Smith',
      });

      expect(mockClient.updateQuoteBlock).toHaveBeenCalledWith(
        'psi-about', 'col-about', 'Best restaurant', { quoteText: 'Updated quote text', attribution: '— John Smith' },
      );
      expect(result.content[0].text).toContain('q-1');
    });

    it('should handle errors', async () => {
      mockClient.updateQuoteBlock.mockRejectedValue(new Error('not found'));

      const result = await server.callTool('sq_update_quote', {
        siteId: 'test-site',
        pageSlug: 'about',
        searchText: 'missing',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  // ── sq_add_marquee ──────────────────────────────────────────────────────────
  describe('sq_add_marquee', () => {
    it('should add a marquee block', async () => {
      mockClient.addMarqueeBlock.mockResolvedValue({ success: true, blockId: 'm-1', sectionIndex: 0 });

      const result = await server.callTool('sq_add_marquee', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 0,
        items: [{ text: 'Welcome!' }, { text: 'Happy Hour 4-6pm' }],
      });

      expect(mockClient.addMarqueeBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0,
        [{ text: 'Welcome!' }, { text: 'Happy Hour 4-6pm' }],
        { animationDirection: undefined, animationSpeed: undefined, textStyle: undefined, pausedOnHover: undefined, fadeEdges: undefined },
        undefined,
      );
      expect(result.content[0].text).toContain('m-1');
    });

    it('should pass animation options', async () => {
      mockClient.addMarqueeBlock.mockResolvedValue({ success: true, blockId: 'm-2', sectionIndex: 0 });

      await server.callTool('sq_add_marquee', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 0,
        items: [{ text: 'Sale!' }],
        animationDirection: 'right',
        animationSpeed: 2,
        pausedOnHover: true,
      });

      const call = mockClient.addMarqueeBlock.mock.calls[0];
      expect(call[4]).toEqual({
        animationDirection: 'right',
        animationSpeed: 2,
        textStyle: undefined,
        pausedOnHover: true,
        fadeEdges: undefined,
      });
    });

    it('should resolve offsetColumns for marquee', async () => {
      mockClient.addMarqueeBlock.mockResolvedValue({ success: true, blockId: 'm-3', sectionIndex: 0 });

      await server.callTool('sq_add_marquee', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 0,
        items: [{ text: 'Test' }],
        layout: { offsetColumns: 2, columns: 20 },
      });

      const call = mockClient.addMarqueeBlock.mock.calls[0];
      const layout = call[5];
      expect(layout.startX).toBe(3);
      expect(layout.endX).toBe(23);
      expect(layout.offsetColumns).toBeUndefined();
    });
  });

  // ── sq_update_marquee ───────────────────────────────────────────────────────
  describe('sq_update_marquee', () => {
    it('should update marquee items', async () => {
      mockClient.updateMarqueeBlock.mockResolvedValue({ success: true, blockId: 'm-1' });

      const result = await server.callTool('sq_update_marquee', {
        siteId: 'test-site',
        pageSlug: 'home',
        searchText: 'Welcome',
        items: [{ text: 'New text!' }],
        animationDirection: 'right',
      });

      expect(mockClient.updateMarqueeBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Welcome',
        { items: [{ text: 'New text!' }], animationDirection: 'right', animationSpeed: undefined, textStyle: undefined, pausedOnHover: undefined },
      );
      expect(result.content[0].text).toContain('m-1');
    });

    it('should handle errors', async () => {
      mockClient.updateMarqueeBlock.mockRejectedValue(new Error('marquee not found'));

      const result = await server.callTool('sq_update_marquee', {
        siteId: 'test-site',
        pageSlug: 'home',
        searchText: 'missing',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('marquee not found');
    });
  });

  // ── sq_add_newsletter ───────────────────────────────────────────────────────
  describe('sq_add_newsletter', () => {
    it('should add a newsletter block with defaults', async () => {
      mockClient.addNewsletterBlock.mockResolvedValue({ success: true, blockId: 'nl-1', sectionIndex: 0 });

      const result = await server.callTool('sq_add_newsletter', {
        siteId: 'test-site',
        pageSlug: 'contact',
        sectionIndex: 1,
      });

      expect(mockClient.addNewsletterBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 1,
        { title: undefined, description: undefined, submitButtonText: undefined, alignment: undefined },
        undefined,
      );
      expect(result.content[0].text).toContain('nl-1');
    });

    it('should pass custom options', async () => {
      mockClient.addNewsletterBlock.mockResolvedValue({ success: true, blockId: 'nl-2', sectionIndex: 0 });

      await server.callTool('sq_add_newsletter', {
        siteId: 'test-site',
        pageSlug: 'contact',
        sectionIndex: 0,
        title: 'Join Our Mailing List',
        description: 'Get weekly updates',
        submitButtonText: 'Subscribe Now',
        alignment: 'alignLeft',
      });

      expect(mockClient.addNewsletterBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 0,
        { title: 'Join Our Mailing List', description: 'Get weekly updates', submitButtonText: 'Subscribe Now', alignment: 'alignLeft' },
        undefined,
      );
    });

    it('should handle page resolution failure', async () => {
      (resolvePageIds as any).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_newsletter', {
        siteId: 'test-site',
        pageSlug: 'missing',
        sectionIndex: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_update_newsletter ────────────────────────────────────────────────────
  describe('sq_update_newsletter', () => {
    it('should update newsletter block fields', async () => {
      mockClient.updateNewsletterBlock.mockResolvedValue({ success: true, blockId: 'nl-1' });

      const result = await server.callTool('sq_update_newsletter', {
        siteId: 'test-site',
        pageSlug: 'contact',
        searchText: 'Subscribe',
        title: 'Stay Updated',
        submitButtonText: 'Join',
      });

      expect(mockClient.updateNewsletterBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 'Subscribe',
        { title: 'Stay Updated', description: undefined, submitButtonText: 'Join', alignment: undefined, captchaEnabled: undefined },
      );
      expect(result.content[0].text).toContain('nl-1');
    });

    it('should handle errors', async () => {
      mockClient.updateNewsletterBlock.mockRejectedValue(new Error('not found'));

      const result = await server.callTool('sq_update_newsletter', {
        siteId: 'test-site',
        pageSlug: 'contact',
        searchText: 'missing',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  // ── sq_add_divider ──────────────────────────────────────────────────────────
  describe('sq_add_divider', () => {
    it('should add a divider block', async () => {
      mockClient.addDividerBlock.mockResolvedValue({ success: true, blockId: 'div-1', sectionIndex: 0 });

      const result = await server.callTool('sq_add_divider', {
        siteId: 'test-site',
        pageSlug: 'about',
        sectionIndex: 0,
      });

      expect(mockClient.addDividerBlock).toHaveBeenCalledWith('psi-about', 'col-about', 0, undefined);
      expect(result.content[0].text).toContain('div-1');
    });

    it('should resolve offsetColumns for divider', async () => {
      mockClient.addDividerBlock.mockResolvedValue({ success: true, blockId: 'div-2', sectionIndex: 0 });

      await server.callTool('sq_add_divider', {
        siteId: 'test-site',
        pageSlug: 'about',
        sectionIndex: 0,
        layout: { offsetColumns: 4, columns: 16 },
      });

      const call = mockClient.addDividerBlock.mock.calls[0];
      const layout = call[3];
      expect(layout.startX).toBe(5);
      expect(layout.endX).toBe(21);
      expect(layout.offsetColumns).toBeUndefined();
    });

    it('should handle page resolution failure', async () => {
      (resolvePageIds as any).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_divider', {
        siteId: 'test-site',
        pageSlug: 'missing',
        sectionIndex: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_add_code ─────────────────────────────────────────────────────────────
  describe('sq_add_code', () => {
    it('should add a code block', async () => {
      mockClient.addCodeBlock.mockResolvedValue({ success: true, blockId: 'code-1', sectionIndex: 0 });

      const result = await server.callTool('sq_add_code', {
        siteId: 'test-site',
        pageSlug: 'dev',
        sectionIndex: 0,
        code: '<div class="custom">Hello</div>',
      });

      expect(mockClient.addCodeBlock).toHaveBeenCalledWith(
        'psi-dev', 'col-dev', 0, '<div class="custom">Hello</div>', undefined, undefined,
      );
      expect(result.content[0].text).toContain('code-1');
    });

    it('should pass language option', async () => {
      mockClient.addCodeBlock.mockResolvedValue({ success: true, blockId: 'code-2', sectionIndex: 0 });

      await server.callTool('sq_add_code', {
        siteId: 'test-site',
        pageSlug: 'dev',
        sectionIndex: 0,
        code: 'console.log("hi")',
        language: 'javascript',
      });

      expect(mockClient.addCodeBlock).toHaveBeenCalledWith(
        'psi-dev', 'col-dev', 0, 'console.log("hi")', 'javascript', undefined,
      );
    });

    it('should resolve offsetColumns for code', async () => {
      mockClient.addCodeBlock.mockResolvedValue({ success: true, blockId: 'code-3', sectionIndex: 0 });

      await server.callTool('sq_add_code', {
        siteId: 'test-site',
        pageSlug: 'dev',
        sectionIndex: 0,
        code: 'test',
        layout: { offsetColumns: 6, columns: 12 },
      });

      const call = mockClient.addCodeBlock.mock.calls[0];
      const layout = call[5];
      expect(layout.startX).toBe(7);
      expect(layout.endX).toBe(19);
      expect(layout.offsetColumns).toBeUndefined();
    });

    it('should handle page resolution failure', async () => {
      (resolvePageIds as any).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_code', {
        siteId: 'test-site',
        pageSlug: 'missing',
        sectionIndex: 0,
        code: 'test',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_update_code ──────────────────────────────────────────────────────────
  describe('sq_update_code', () => {
    it('should update a code block', async () => {
      mockClient.updateCodeBlock.mockResolvedValue({ success: true, blockId: 'code-1' });

      const result = await server.callTool('sq_update_code', {
        siteId: 'test-site',
        pageSlug: 'dev',
        searchText: 'console.log',
        code: 'console.log("updated")',
        language: 'javascript',
      });

      expect(mockClient.updateCodeBlock).toHaveBeenCalledWith(
        'psi-dev', 'col-dev', 'console.log', { code: 'console.log("updated")', language: 'javascript' },
      );
      expect(result.content[0].text).toContain('code-1');
    });

    it('should handle errors', async () => {
      mockClient.updateCodeBlock.mockRejectedValue(new Error('code block not found'));

      const result = await server.callTool('sq_update_code', {
        siteId: 'test-site',
        pageSlug: 'dev',
        searchText: 'missing',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('code block not found');
    });
  });

  // ── sq_add_social_links_block ──────────────────────────────────────────────
  describe('sq_add_social_links_block', () => {
    it('should add a social links block', async () => {
      mockClient.addSocialLinksBlock.mockResolvedValue({ success: true, blockId: 'sl-1', sectionIndex: 0 });

      const result = await server.callTool('sq_add_social_links_block', {
        siteId: 'test-site',
        pageSlug: 'contact',
        sectionIndex: 0,
        iconAlignment: 'center',
        iconSize: 'medium',
      });

      expect(mockClient.addSocialLinksBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 0,
        { iconAlignment: 'center', iconSize: 'medium', iconStyle: undefined, iconColor: undefined },
        undefined,
      );
      expect(result.content[0].text).toContain('sl-1');
    });

    it('should resolve offsetColumns', async () => {
      mockClient.addSocialLinksBlock.mockResolvedValue({ success: true, blockId: 'sl-2', sectionIndex: 0 });

      await server.callTool('sq_add_social_links_block', {
        siteId: 'test-site',
        pageSlug: 'contact',
        sectionIndex: 0,
        layout: { offsetColumns: 6, columns: 12 },
      });

      const call = mockClient.addSocialLinksBlock.mock.calls[0];
      const layout = call[4];
      expect(layout.startX).toBe(7);
      expect(layout.endX).toBe(19);
    });

    it('should handle page resolution failure', async () => {
      (resolvePageIds as any).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_social_links_block', {
        siteId: 'test-site',
        pageSlug: 'missing',
        sectionIndex: 0,
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_update_social_links_block ───────────────────────────────────────────
  describe('sq_update_social_links_block', () => {
    it('should update social links block', async () => {
      mockClient.updateSocialLinksBlock.mockResolvedValue({ success: true, blockId: 'sl-1' });

      const result = await server.callTool('sq_update_social_links_block', {
        siteId: 'test-site',
        pageSlug: 'contact',
        searchText: 'sl-1',
        iconAlignment: 'left',
        iconColor: 'white',
      });

      expect(mockClient.updateSocialLinksBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 'sl-1',
        { iconAlignment: 'left', iconSize: undefined, iconStyle: undefined, iconColor: 'white' },
      );
      expect(result.content[0].text).toContain('sl-1');
    });

    it('should handle errors', async () => {
      mockClient.updateSocialLinksBlock.mockRejectedValue(new Error('not found'));

      const result = await server.callTool('sq_update_social_links_block', {
        siteId: 'test-site',
        pageSlug: 'contact',
        searchText: 'missing',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_add_audio ──────────────────────────────────────────────────────
  describe('sq_add_audio', () => {
    it('should add an audio block with asset ID', async () => {
      mockClient.addAudioBlock.mockResolvedValue({ success: true, blockId: 'aud-1' });

      const result = await server.callTool('sq_add_audio', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        audioAssetId: '69aef9fcffda2f168895b06e',
      });

      expect(mockClient.addAudioBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, '69aef9fcffda2f168895b06e', undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('aud-1');
    });

    it('should pass title, author, and layout', async () => {
      mockClient.addAudioBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_audio', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 1,
        audioAssetId: 'abc123def456789012345678',
        title: 'My Song',
        author: 'Artist Name',
        layout: { columns: 12, rowHeight: 3 },
      });

      expect(mockClient.addAudioBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 1, 'abc123def456789012345678',
        { title: 'My Song', author: 'Artist Name', layout: { columns: 12, rowHeight: 3 } },
      );
    });

    it('should pass design options', async () => {
      mockClient.addAudioBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_audio', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        audioAssetId: 'abc123def456789012345678',
        designStyle: 'minimal',
        colorTheme: 'light',
        showDownload: true,
      });

      const callArgs = mockClient.addAudioBlock.mock.calls[0];
      const options = callArgs[4];
      expect(options.designStyle).toBe('minimal');
      expect(options.colorTheme).toBe('light');
      expect(options.showDownload).toBe(true);
    });

    it('should resolve offsetColumns to startX/endX', async () => {
      mockClient.addAudioBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_audio', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        audioAssetId: 'abc123def456789012345678',
        layout: { columns: 12, offsetColumns: 12 },
      });

      const callArgs = mockClient.addAudioBlock.mock.calls[0];
      const options = callArgs[4];
      expect(options.layout.startX).toBe(13);
      expect(options.layout.endX).toBe(25);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_audio', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
        audioAssetId: 'abc123def456789012345678',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });

  // ── sq_update_audio ───────────────────────────────────────────────────
  describe('sq_update_audio', () => {
    it('should update audio title', async () => {
      mockClient.updateAudioBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_audio', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Broken',
        title: 'New Title',
      });

      expect(mockClient.updateAudioBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Broken', { title: 'New Title' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should update author and design options', async () => {
      mockClient.updateAudioBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_update_audio', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Broken',
        author: 'New Author',
        colorTheme: 'light',
        showDownload: true,
      });

      expect(mockClient.updateAudioBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Broken', { author: 'New Author', colorTheme: 'light', showDownload: true },
      );
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_audio', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
      });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_add_page_link ──────────────────────────────────────────────────
  describe('sq_add_page_link', () => {
    it('should add a page link block', async () => {
      mockClient.addPageLinkBlock.mockResolvedValue({ success: true, blockId: 'pl-1' });

      const result = await server.callTool('sq_add_page_link', {
        siteId: 'smyth-tavern', pageSlug: 'home', sectionIndex: 0,
        linkTitle: 'About Us', linkTarget: '/about',
      });

      expect(mockClient.addPageLinkBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, 'About Us', '/about', { newWindow: undefined, layout: undefined },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);
      const result = await server.callTool('sq_add_page_link', {
        siteId: 'bad', pageSlug: 'home', sectionIndex: 0, linkTitle: 'X', linkTarget: '/x',
      });
      expect(result.isError).toBe(true);
    });
  });

  // ── sq_update_page_link ───────────────────────────────────────────────
  describe('sq_update_page_link', () => {
    it('should update page link title', async () => {
      mockClient.updatePageLinkBlock.mockResolvedValue({ success: true });
      const result = await server.callTool('sq_update_page_link', {
        siteId: 'smyth-tavern', pageSlug: 'home', searchText: 'About', linkTitle: 'About Page',
      });
      expect(mockClient.updatePageLinkBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'About', { linkTitle: 'About Page' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  // ── sq_add_horizontal_rule ────────────────────────────────────────────
  describe('sq_add_horizontal_rule', () => {
    it('should add a horizontal rule block', async () => {
      mockClient.addHorizontalRuleBlock.mockResolvedValue({ success: true, blockId: 'hr-1' });
      const result = await server.callTool('sq_add_horizontal_rule', {
        siteId: 'smyth-tavern', pageSlug: 'home', sectionIndex: 0,
      });
      expect(mockClient.addHorizontalRuleBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  // ── sq_add_search ──────────────────────────────────────────────────────
  describe('sq_add_search', () => {
    it('should add a search block', async () => {
      mockClient.addSearchBlock.mockResolvedValue({ success: true, blockId: 'search-1' });
      const result = await server.callTool('sq_add_search', {
        siteId: 'smyth-tavern', pageSlug: 'home', sectionIndex: 0,
      });
      expect(mockClient.addSearchBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should pass options', async () => {
      mockClient.addSearchBlock.mockResolvedValue({ success: true, blockId: 'search-2' });
      await server.callTool('sq_add_search', {
        siteId: 'smyth-tavern', pageSlug: 'home', sectionIndex: 0,
        targetCollectionId: 'blog-123', theme: 'light',
      });
      expect(mockClient.addSearchBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, { targetCollectionId: 'blog-123', theme: 'light' },
      );
    });
  });

  // ── sq_update_search ─────────────────────────────────────────────────
  describe('sq_update_search', () => {
    it('should update search block', async () => {
      mockClient.updateSearchBlock.mockResolvedValue({ success: true });
      const result = await server.callTool('sq_update_search', {
        siteId: 'smyth-tavern', pageSlug: 'home', searchText: 'dark',
        theme: 'light', searchPreview: false,
      });
      expect(mockClient.updateSearchBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'dark', { theme: 'light', searchPreview: false },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  // ── sq_add_markdown ───────────────────────────────────────────────────
  describe('sq_add_markdown', () => {
    it('should add a markdown block', async () => {
      mockClient.addMarkdownBlock.mockResolvedValue({ success: true, blockId: 'md-1' });
      const result = await server.callTool('sq_add_markdown', {
        siteId: 'smyth-tavern', pageSlug: 'home', sectionIndex: 0, source: '# Hello',
      });
      expect(mockClient.addMarkdownBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, '# Hello', undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  // ── sq_update_markdown ────────────────────────────────────────────────
  describe('sq_update_markdown', () => {
    it('should update markdown source', async () => {
      mockClient.updateMarkdownBlock.mockResolvedValue({ success: true });
      const result = await server.callTool('sq_update_markdown', {
        siteId: 'smyth-tavern', pageSlug: 'home', searchText: 'Hello', source: '# Updated',
      });
      expect(mockClient.updateMarkdownBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Hello', { source: '# Updated' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  // ── sq_add_summary ────────────────────────────────────────────────────
  describe('sq_add_summary', () => {
    it('should add a summary block', async () => {
      mockClient.addSummaryBlock.mockResolvedValue({ success: true, blockId: 'sum-1' });
      const result = await server.callTool('sq_add_summary', {
        siteId: 'smyth-tavern', pageSlug: 'home', sectionIndex: 0,
        targetCollectionId: 'blog-123', headerText: 'Latest Posts',
      });
      expect(mockClient.addSummaryBlock).toHaveBeenCalled();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  // ── sq_update_summary ─────────────────────────────────────────────────
  describe('sq_update_summary', () => {
    it('should update summary block', async () => {
      mockClient.updateSummaryBlock.mockResolvedValue({ success: true });
      const result = await server.callTool('sq_update_summary', {
        siteId: 'smyth-tavern', pageSlug: 'home', searchText: 'Featured',
        headerText: 'Recent Posts', pageSize: 6,
      });
      expect(mockClient.updateSummaryBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Featured', { headerText: 'Recent Posts', pageSize: 6 },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  // ── sq_add_product_block ──────────────────────────────────────────────
  describe('sq_add_product_block', () => {
    it('should add a product block', async () => {
      mockClient.addProductBlock.mockResolvedValue({ success: true, blockId: 'prod-1' });
      const result = await server.callTool('sq_add_product_block', {
        siteId: 'smyth-tavern', pageSlug: 'home', sectionIndex: 0,
        productId: 'product-abc', showBuyButton: true,
      });
      expect(mockClient.addProductBlock).toHaveBeenCalled();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });

  // ── sq_update_product_block ───────────────────────────────────────────
  describe('sq_update_product_block', () => {
    it('should update product block', async () => {
      mockClient.updateProductBlock.mockResolvedValue({ success: true });
      const result = await server.callTool('sq_update_product_block', {
        siteId: 'smyth-tavern', pageSlug: 'home', searchText: 'product-abc',
        showBuyButton: true, showPrice: false,
      });
      expect(mockClient.updateProductBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'product-abc', { showBuyButton: true, showPrice: false },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });
  });
});
