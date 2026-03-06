import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

// ── Mock child_process ───────────────────────────────────────────────────────

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

// ── Mock fs ──────────────────────────────────────────────────────────────────

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: (...args: any[]) => {
      if (typeof args[0] === 'string' && args[0].endsWith('package.json')) {
        return actual.existsSync(...args as Parameters<typeof actual.existsSync>);
      }
      return mockExistsSync(...args);
    },
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
  };
});

// ── Mock gmail service ───────────────────────────────────────────────────────

const mockLoadCredentials = vi.fn();
const mockSaveTokens = vi.fn();
const mockDownloadAttachment = vi.fn();

vi.mock('../../services/gmail.js', () => ({
  loadCredentials: (...args: any[]) => mockLoadCredentials(...args),
  saveTokens: (...args: any[]) => mockSaveTokens(...args),
  downloadAttachment: (...args: any[]) => mockDownloadAttachment(...args),
}));

// ── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Import after mocks ──────────────────────────────────────────────────────

import { registerGmailTools } from '../tools/gmail.js';

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Gmail Tools (OAuth2)', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);

    server = createMockServer();
    registerGmailTools(server as any);
  });

  it('should register sq_login_gmail and sq_download_attachment', () => {
    expect(server.tools.has('sq_login_gmail')).toBe(true);
    expect(server.tools.has('sq_download_attachment')).toBe(true);
    expect(server.tools.size).toBe(2);
  });

  describe('sq_login_gmail', () => {
    it('should return error when credentials file is missing', async () => {
      mockLoadCredentials.mockImplementation(() => {
        throw new Error('Gmail credentials not found');
      });

      const result = await server.callTool('sq_login_gmail', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('credentials not found');
    });
  });

  describe('sq_download_attachment', () => {
    it('should download attachment and return file path', async () => {
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/menu.pdf');

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'msg-1',
        filename: 'menu.pdf',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.filePath).toBe('/storage/uploads/menu.pdf');
      expect(mockDownloadAttachment).toHaveBeenCalledWith('msg-1', 'menu.pdf');
    });

    it('should return error when attachment not found', async () => {
      mockDownloadAttachment.mockRejectedValue(
        new Error('No attachment named "missing.pdf" in message. Available: menu.pdf'),
      );

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'msg-1',
        filename: 'missing.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No attachment named "missing.pdf"');
    });

    it('should return error when not authorized', async () => {
      mockDownloadAttachment.mockRejectedValue(
        new Error('Gmail not authorized. Run sq_login_gmail to complete OAuth2 authorization.'),
      );

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'msg-1',
        filename: 'file.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not authorized');
    });
  });
});
