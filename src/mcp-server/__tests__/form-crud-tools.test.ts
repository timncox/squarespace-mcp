import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock session dependencies ────────────────────────────────────────────────

const mockGetClient = vi.fn();

vi.mock('../session.js', () => ({
  getClient: (...args: any[]) => mockGetClient(...args),
}));

import { registerFormTools } from '../tools/forms.js';

// ── Mock MCP server ──────────────────────────────────────────────────────────

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

// ── Helper to create a mock client ───────────────────────────────────────────

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    getAvailableForms: vi.fn().mockResolvedValue({ success: true, forms: [] }),
    createForm: vi.fn().mockResolvedValue({ success: true, formId: 'form-abc123' }),
    getForm: vi.fn().mockResolvedValue({ success: true, data: { id: 'form-abc123', name: 'Contact Form', fields: [] } }),
    updateForm: vi.fn().mockResolvedValue({ success: true, data: { id: 'form-abc123', name: 'Updated Form' } }),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Form CRUD MCP Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerFormTools(server as any);
  });

  it('registers all expected tools', () => {
    const toolNames = [...server.tools.keys()];
    expect(toolNames).toContain('sq_list_forms');
    expect(toolNames).toContain('sq_create_form');
    expect(toolNames).toContain('sq_get_form');
    expect(toolNames).toContain('sq_update_form');
    expect(toolNames).toContain('sq_add_form_block');
    expect(toolNames).toContain('sq_update_form_block');
  });

  // ── sq_create_form ──────────────────────────────────────────────────────

  describe('sq_create_form', () => {
    it('creates a default contact form when no fields specified', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      const result = await server.callTool('sq_create_form', { siteId: 'my-site' });

      expect(client.createForm).toHaveBeenCalledWith(undefined, undefined, undefined);
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.formId).toBe('form-abc123');
    });

    it('creates a form with custom name and submit text', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      await server.callTool('sq_create_form', {
        siteId: 'my-site',
        name: 'Inquiry Form',
        submitButtonText: 'Send',
      });

      expect(client.createForm).toHaveBeenCalledWith('Inquiry Form', undefined, { submitButtonText: 'Send' });
    });

    it('creates a form with custom fields', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      const fields = JSON.stringify([
        { type: 'name', title: 'Full Name', required: true },
        { type: 'email', title: 'Email', required: true },
      ]);

      await server.callTool('sq_create_form', {
        siteId: 'my-site',
        fields,
      });

      expect(client.createForm).toHaveBeenCalledWith(
        undefined,
        [{ type: 'name', title: 'Full Name', required: true }, { type: 'email', title: 'Email', required: true }],
        undefined,
      );
    });

    it('returns error for invalid fields JSON', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      const result = await server.callTool('sq_create_form', {
        siteId: 'my-site',
        fields: 'not valid json',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not valid JSON');
      expect(client.createForm).not.toHaveBeenCalled();
    });

    it('returns error for non-array fields', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      const result = await server.callTool('sq_create_form', {
        siteId: 'my-site',
        fields: '{"not": "an array"}',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('must be a JSON array');
    });

    it('returns error on API failure', async () => {
      const client = createMockClient({
        createForm: vi.fn().mockResolvedValue({ success: false, error: 'HTTP 403' }),
      });
      mockGetClient.mockReturnValue(client);

      const result = await server.callTool('sq_create_form', { siteId: 'my-site' });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
    });

    it('handles thrown exceptions', async () => {
      mockGetClient.mockImplementation(() => { throw new Error('No session'); });

      const result = await server.callTool('sq_create_form', { siteId: 'my-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No session');
    });
  });

  // ── sq_get_form ─────────────────────────────────────────────────────────

  describe('sq_get_form', () => {
    it('returns form details', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      const result = await server.callTool('sq_get_form', {
        siteId: 'my-site',
        formId: 'form-abc123',
      });

      expect(client.getForm).toHaveBeenCalledWith('form-abc123');
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.data.name).toBe('Contact Form');
    });

    it('returns error when form not found', async () => {
      const client = createMockClient({
        getForm: vi.fn().mockResolvedValue({ success: false, error: 'GET /api/rest/forms/bad-id failed: 404' }),
      });
      mockGetClient.mockReturnValue(client);

      const result = await server.callTool('sq_get_form', {
        siteId: 'my-site',
        formId: 'bad-id',
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('404');
    });

    it('handles thrown exceptions', async () => {
      mockGetClient.mockImplementation(() => { throw new Error('Connection failed'); });

      const result = await server.callTool('sq_get_form', {
        siteId: 'my-site',
        formId: 'form-abc123',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Connection failed');
    });
  });

  // ── sq_update_form ──────────────────────────────────────────────────────

  describe('sq_update_form', () => {
    it('updates form name', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      const result = await server.callTool('sq_update_form', {
        siteId: 'my-site',
        formId: 'form-abc123',
        name: 'Booking Form',
      });

      expect(client.updateForm).toHaveBeenCalledWith('form-abc123', { name: 'Booking Form' });
      expect(result.isError).toBeUndefined();
    });

    it('updates form with new fields', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      const fields = JSON.stringify([
        { type: 'email', title: 'Email', required: true },
      ]);

      await server.callTool('sq_update_form', {
        siteId: 'my-site',
        formId: 'form-abc123',
        fields,
      });

      expect(client.updateForm).toHaveBeenCalledWith('form-abc123', {
        fields: [{ type: 'email', title: 'Email', required: true }],
      });
    });

    it('updates submit button text', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      await server.callTool('sq_update_form', {
        siteId: 'my-site',
        formId: 'form-abc123',
        submitButtonText: 'Send Message',
      });

      expect(client.updateForm).toHaveBeenCalledWith('form-abc123', { submitButtonText: 'Send Message' });
    });

    it('returns error for invalid fields JSON', async () => {
      const client = createMockClient();
      mockGetClient.mockReturnValue(client);

      const result = await server.callTool('sq_update_form', {
        siteId: 'my-site',
        formId: 'form-abc123',
        fields: '{bad json',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not valid JSON');
      expect(client.updateForm).not.toHaveBeenCalled();
    });

    it('returns error on API failure', async () => {
      const client = createMockClient({
        updateForm: vi.fn().mockResolvedValue({ success: false, error: 'HTTP 500' }),
      });
      mockGetClient.mockReturnValue(client);

      const result = await server.callTool('sq_update_form', {
        siteId: 'my-site',
        formId: 'form-abc123',
        name: 'New Name',
      });

      expect(result.isError).toBe(true);
    });

    it('handles thrown exceptions', async () => {
      mockGetClient.mockImplementation(() => { throw new Error('Timeout'); });

      const result = await server.callTool('sq_update_form', {
        siteId: 'my-site',
        formId: 'form-abc123',
        name: 'New',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Timeout');
    });
  });
});
