import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  getPageSections: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
  getSiteBaseUrl: vi.fn(() => 'https://www.example.com'),
}));

// Mock link-validator
vi.mock('../../services/link-validator.js', () => ({
  extractAndValidateLinks: vi.fn(async () => ({
    total: 3,
    ok: 2,
    broken: 1,
    redirected: 0,
    timedOut: 0,
    skipped: 0,
    invalidEmails: 0,
    allPassed: false,
    results: [
      { href: 'https://example.com', text: 'Example', status: 'ok', durationMs: 100 },
      { href: 'https://good.com', text: 'Good', status: 'ok', durationMs: 50 },
      { href: 'https://broken.com', text: 'Broken', status: 'broken', statusCode: 404, error: 'HTTP 404', durationMs: 200 },
    ],
  })),
}));

import { resolvePageIds, getSiteBaseUrl } from '../session.js';
import { extractAndValidateLinks } from '../../services/link-validator.js';
import { registerLinkTools } from '../tools/links.js';

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

describe('Link Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerLinkTools(server as any);
  });

  it('should register sq_validate_links', () => {
    expect(server.tools.has('sq_validate_links')).toBe(true);
  });

  describe('sq_validate_links', () => {
    it('should validate links on a page and return summary', async () => {
      mockClient.getPageSections.mockResolvedValue({
        sections: [{ fluidEngineContext: { gridContents: [] } }],
      });

      const result = await server.callTool('sq_validate_links', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
      });

      expect(resolvePageIds).toHaveBeenCalledWith('smyth-tavern', 'home');
      expect(mockClient.getPageSections).toHaveBeenCalledWith('psi-home');
      expect(getSiteBaseUrl).toHaveBeenCalledWith('smyth-tavern');
      expect(extractAndValidateLinks).toHaveBeenCalledWith(
        [{ fluidEngineContext: { gridContents: [] } }],
        { siteBaseUrl: 'https://www.example.com' },
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.total).toBe(3);
      expect(data.ok).toBe(2);
      expect(data.broken).toBe(1);
      expect(data.allPassed).toBe(false);
    });

    it('should return error when page not found', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_validate_links', {
        siteId: 'smyth-tavern',
        pageSlug: 'nonexistent',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error on thrown exception', async () => {
      mockClient.getPageSections.mockRejectedValue(new Error('Session expired'));

      const result = await server.callTool('sq_validate_links', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session expired');
    });
  });
});
