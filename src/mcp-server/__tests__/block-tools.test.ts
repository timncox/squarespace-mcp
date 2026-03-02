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

  it('should register all 10 block tools', () => {
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
});
