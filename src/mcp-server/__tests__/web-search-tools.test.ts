import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock brave-search module
const mockWebSearch = vi.fn();

vi.mock('../../services/brave-search.js', () => ({
  webSearch: mockWebSearch,
}));

// Mock global fetch for sq_fetch_url
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { registerWebSearchTools } from '../tools/web-search.js';

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

describe('MCP Web Search Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerWebSearchTools(server as any);
  });

  it('should register both web search tools', () => {
    expect(server.tools.has('sq_web_search')).toBe(true);
    expect(server.tools.has('sq_fetch_url')).toBe(true);
  });

  // ── sq_web_search ──────────────────────────────────────────────────────────

  describe('sq_web_search', () => {
    it('should call webSearch and return results', async () => {
      mockWebSearch.mockResolvedValue([
        { title: 'Result 1', url: 'https://example.com/1', description: 'First result' },
        { title: 'Result 2', url: 'https://example.com/2', description: 'Second result' },
      ]);

      const result = await server.callTool('sq_web_search', {
        query: 'squarespace templates',
        count: 2,
      });

      expect(mockWebSearch).toHaveBeenCalledWith('squarespace templates', 2);
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(2);
      expect(data[0].title).toBe('Result 1');
      expect(data[1].url).toBe('https://example.com/2');
    });

    it('should default count to 5', async () => {
      mockWebSearch.mockResolvedValue([]);

      await server.callTool('sq_web_search', { query: 'test' });

      expect(mockWebSearch).toHaveBeenCalledWith('test', 5);
    });

    it('should handle errors gracefully', async () => {
      mockWebSearch.mockRejectedValue(new Error('API key invalid'));

      const result = await server.callTool('sq_web_search', { query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('API key invalid');
    });
  });

  // ── sq_fetch_url ───────────────────────────────────────────────────────────

  describe('sq_fetch_url', () => {
    it('should fetch and strip HTML', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '<html><head><style>body{}</style></head><body><h1>Hello</h1><p>World</p><script>alert(1)</script></body></html>',
      });

      const result = await server.callTool('sq_fetch_url', {
        url: 'https://example.com',
      });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Hello');
      expect(text).toContain('World');
      expect(text).not.toContain('<script>');
      expect(text).not.toContain('<style>');
      expect(text).not.toContain('<h1>');
    });

    it('should return error for non-ok responses', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });

      const result = await server.callTool('sq_fetch_url', {
        url: 'https://example.com/missing',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('HTTP 404');
    });

    it('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      const result = await server.callTool('sq_fetch_url', {
        url: 'https://example.com',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network timeout');
    });

    it('should decode HTML entities', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '<p>Tom &amp; Jerry &lt;3 &quot;cheese&quot;</p>',
      });

      const result = await server.callTool('sq_fetch_url', {
        url: 'https://example.com',
      });

      const text = result.content[0].text;
      expect(text).toContain('Tom & Jerry');
      expect(text).toContain('<3');
      expect(text).toContain('"cheese"');
    });

    it('should truncate long content to 10,000 chars', async () => {
      const longContent = '<p>' + 'A'.repeat(20_000) + '</p>';
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => longContent,
      });

      const result = await server.callTool('sq_fetch_url', {
        url: 'https://example.com',
      });

      expect(result.content[0].text.length).toBeLessThanOrEqual(10_000);
    });
  });
});
