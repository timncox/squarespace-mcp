import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  getAvailableForms: vi.fn(),
  addFormBlock: vi.fn(),
  updateFormBlock: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
}));

import { resolvePageIds } from '../session.js';
import { registerFormTools } from '../tools/forms.js';

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

describe('Form Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerFormTools(server as any);
  });

  it('should register all 3 form tools', () => {
    expect(server.tools.has('sq_list_forms')).toBe(true);
    expect(server.tools.has('sq_add_form_block')).toBe(true);
    expect(server.tools.has('sq_update_form_block')).toBe(true);
  });

  // ── sq_list_forms ──────────────────────────────────────────────────────────

  describe('sq_list_forms', () => {
    it('should list available forms', async () => {
      mockClient.getAvailableForms.mockResolvedValue({
        success: true,
        forms: [
          { id: 'form-1', name: 'Contact' },
          { id: 'form-2', name: 'Newsletter Signup' },
        ],
      });

      const result = await server.callTool('sq_list_forms', {
        siteId: 'smyth-tavern',
      });

      expect(mockClient.getAvailableForms).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.forms).toHaveLength(2);
      expect(data.forms[0].name).toBe('Contact');
    });

    it('should return error on API failure', async () => {
      mockClient.getAvailableForms.mockResolvedValue({
        success: false,
        error: 'Failed to fetch forms',
      });

      const result = await server.callTool('sq_list_forms', {
        siteId: 'smyth-tavern',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to fetch forms');
    });

    it('should return error on thrown exception', async () => {
      mockClient.getAvailableForms.mockRejectedValue(new Error('Network timeout'));

      const result = await server.callTool('sq_list_forms', {
        siteId: 'smyth-tavern',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network timeout');
    });
  });

  // ── sq_add_form_block ──────────────────────────────────────────────────────

  describe('sq_add_form_block', () => {
    it('should add a form block with defaults', async () => {
      mockClient.addFormBlock.mockResolvedValue({
        success: true,
        blockId: 'form-blk-1',
        sectionIndex: 0,
      });

      const result = await server.callTool('sq_add_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        sectionIndex: 0,
        formId: 'form-1',
      });

      expect(resolvePageIds).toHaveBeenCalledWith('smyth-tavern', 'contact');
      expect(mockClient.addFormBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 0, 'form-1', undefined, undefined,
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('form-blk-1');
    });

    it('should pass all options', async () => {
      mockClient.addFormBlock.mockResolvedValue({
        success: true,
        blockId: 'form-blk-2',
        sectionIndex: 1,
      });

      await server.callTool('sq_add_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        sectionIndex: 1,
        formId: 'form-2',
        buttonVariant: 'primary',
        buttonAlignment: 'center',
        useLightbox: true,
      });

      expect(mockClient.addFormBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 1, 'form-2',
        { buttonVariant: 'primary', buttonAlignment: 'center', useLightbox: true },
        undefined,
      );
    });

    it('should resolve offsetColumns to startX/endX', async () => {
      mockClient.addFormBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        sectionIndex: 0,
        formId: 'form-1',
        columns: 12,
        offsetColumns: 4,
      });

      const callArgs = mockClient.addFormBlock.mock.calls[0];
      const passedLayout = callArgs[5];
      expect(passedLayout.startX).toBe(5);
      expect(passedLayout.endX).toBe(17);
      expect(passedLayout.offsetColumns).toBeUndefined();
    });

    it('should pass layout with columns and rowHeight', async () => {
      mockClient.addFormBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        sectionIndex: 0,
        formId: 'form-1',
        columns: 16,
        rowHeight: 8,
      });

      const callArgs = mockClient.addFormBlock.mock.calls[0];
      const passedLayout = callArgs[5];
      expect(passedLayout.columns).toBe(16);
      expect(passedLayout.rowHeight).toBe(8);
    });

    it('should return error on page not found', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_form_block', {
        siteId: 'bad-site',
        pageSlug: 'contact',
        sectionIndex: 0,
        formId: 'form-1',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error on API failure', async () => {
      mockClient.addFormBlock.mockResolvedValue({
        success: false,
        error: 'Form not found',
      });

      const result = await server.callTool('sq_add_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        sectionIndex: 0,
        formId: 'bad-form-id',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Form not found');
    });

    it('should return error on thrown exception', async () => {
      mockClient.addFormBlock.mockRejectedValue(new Error('Connection refused'));

      const result = await server.callTool('sq_add_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        sectionIndex: 0,
        formId: 'form-1',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Connection refused');
    });
  });

  // ── sq_update_form_block ───────────────────────────────────────────────────

  describe('sq_update_form_block', () => {
    it('should update a form block', async () => {
      mockClient.updateFormBlock.mockResolvedValue({
        success: true,
        blockId: 'form-blk-1',
      });

      const result = await server.callTool('sq_update_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        searchText: 'Contact',
        buttonVariant: 'secondary',
      });

      expect(resolvePageIds).toHaveBeenCalledWith('smyth-tavern', 'contact');
      expect(mockClient.updateFormBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 'Contact',
        { buttonVariant: 'secondary' },
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('form-blk-1');
    });

    it('should pass multiple update options', async () => {
      mockClient.updateFormBlock.mockResolvedValue({
        success: true,
        blockId: 'form-blk-1',
      });

      await server.callTool('sq_update_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        searchText: 'Contact',
        buttonVariant: 'primary',
        buttonAlignment: 'left',
        useLightbox: false,
      });

      expect(mockClient.updateFormBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 'Contact',
        { buttonVariant: 'primary', buttonAlignment: 'left', useLightbox: false },
      );
    });

    it('should return error on page not found', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_form_block', {
        siteId: 'bad-site',
        pageSlug: 'contact',
        searchText: 'Contact',
        buttonVariant: 'primary',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error on block not found', async () => {
      mockClient.updateFormBlock.mockResolvedValue({
        success: false,
        error: 'Block not found',
      });

      const result = await server.callTool('sq_update_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        searchText: 'Missing Form',
        buttonVariant: 'primary',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Block not found');
    });

    it('should return error on thrown exception', async () => {
      mockClient.updateFormBlock.mockRejectedValue(new Error('Server error'));

      const result = await server.callTool('sq_update_form_block', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        searchText: 'Contact',
        buttonVariant: 'primary',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server error');
    });
  });
});
