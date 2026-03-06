import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  getAvailableForms: vi.fn(),
  addFormBlock: vi.fn(),
  updateFormBlock: vi.fn(),
  createForm: vi.fn(),
  getForm: vi.fn(),
  updateForm: vi.fn(),
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

  it('should register all 6 form tools', () => {
    expect(server.tools.has('sq_list_forms')).toBe(true);
    expect(server.tools.has('sq_add_form_block')).toBe(true);
    expect(server.tools.has('sq_update_form_block')).toBe(true);
    expect(server.tools.has('sq_create_form')).toBe(true);
    expect(server.tools.has('sq_get_form')).toBe(true);
    expect(server.tools.has('sq_update_form')).toBe(true);
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

  // ── sq_create_form ──────────────────────────────────────────────────────────
  describe('sq_create_form', () => {
    it('should create a form with defaults', async () => {
      mockClient.createForm.mockResolvedValue({ success: true, formId: 'form-new-1' });

      const result = await server.callTool('sq_create_form', { siteId: 'test-site' });

      expect(mockClient.createForm).toHaveBeenCalledWith(undefined, undefined, undefined);
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.formId).toBe('form-new-1');
    });

    it('should pass typed fields array', async () => {
      mockClient.createForm.mockResolvedValue({ success: true, formId: 'form-new-2' });

      await server.callTool('sq_create_form', {
        siteId: 'test-site',
        name: 'Booking Form',
        fields: [
          { type: 'name', title: 'Full Name', required: true },
          { type: 'email', title: 'Email', required: true },
          { type: 'date', title: 'Preferred Date' },
        ],
        submitButtonText: 'Book Now',
        submissionMessage: 'Thanks for booking!',
      });

      const call = mockClient.createForm.mock.calls[0];
      expect(call[0]).toBe('Booking Form');
      // fields should be stringified
      expect(call[1]).toHaveLength(3);
      const parsed = JSON.parse(call[1][0]);
      expect(parsed.type).toBe('name');
      expect(parsed.title).toBe('Full Name');
      expect(parsed.id).toBeDefined();
      // options
      expect(call[2]).toEqual(expect.objectContaining({ submitButtonText: 'Book Now', submissionMessage: 'Thanks for booking!' }));
    });

    it('should handle errors', async () => {
      mockClient.createForm.mockRejectedValue(new Error('session expired'));

      const result = await server.callTool('sq_create_form', { siteId: 'test-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('session expired');
    });
  });

  // ── sq_get_form ─────────────────────────────────────────────────────────────
  describe('sq_get_form', () => {
    it('should get form details', async () => {
      mockClient.getForm.mockResolvedValue({ success: true, data: { id: 'form-1', name: 'Contact', fields: [] } });

      const result = await server.callTool('sq_get_form', { siteId: 'test-site', formId: 'form-1' });

      expect(mockClient.getForm).toHaveBeenCalledWith('form-1');
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('Contact');
    });

    it('should handle errors', async () => {
      mockClient.getForm.mockResolvedValue({ success: false, error: 'Form not found' });

      const result = await server.callTool('sq_get_form', { siteId: 'test-site', formId: 'bad-id' });

      expect(result.isError).toBe(true);
    });
  });

  // ── sq_update_form ──────────────────────────────────────────────────────────
  describe('sq_update_form', () => {
    it('should update form name and submissionMessage', async () => {
      mockClient.updateForm.mockResolvedValue({ success: true, data: {} });

      const result = await server.callTool('sq_update_form', {
        siteId: 'test-site',
        formId: 'form-1',
        name: 'Updated Contact',
        submissionMessage: 'Thanks!',
      });

      expect(mockClient.updateForm).toHaveBeenCalledWith('form-1', expect.objectContaining({
        name: 'Updated Contact',
        submissionMessage: 'Thanks!',
      }));
      expect(result.isError).toBeUndefined();
    });

    it('should pass typed fields', async () => {
      mockClient.updateForm.mockResolvedValue({ success: true, data: {} });

      await server.callTool('sq_update_form', {
        siteId: 'test-site',
        formId: 'form-1',
        fields: [{ type: 'textarea', title: 'Message' }],
      });

      const call = mockClient.updateForm.mock.calls[0];
      expect(call[1].fields).toHaveLength(1);
      const parsed = JSON.parse(call[1].fields[0]);
      expect(parsed.type).toBe('textarea');
    });

    it('should handle errors', async () => {
      mockClient.updateForm.mockRejectedValue(new Error('auth error'));

      const result = await server.callTool('sq_update_form', {
        siteId: 'test-site',
        formId: 'form-1',
        name: 'test',
      });

      expect(result.isError).toBe(true);
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
