import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock Playwright ──────────────────────────────────────────────────────────

const mockGoto = vi.fn();
const mockClose = vi.fn();
const mockPageClose = vi.fn();
const mockContextCookies = vi.fn();
const mockNewPage = vi.fn();

const mockBrowserContext = {
  cookies: mockContextCookies,
  newPage: mockNewPage,
  close: vi.fn(),
};

const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockBrowserContext),
  close: mockClose,
};

const mockChromiumLaunch = vi.fn().mockResolvedValue(mockBrowser);

vi.mock('playwright', () => ({
  chromium: {
    launch: (...args: any[]) => mockChromiumLaunch(...args),
  },
}));

// ── Mock fs ──────────────────────────────────────────────────────────────────

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockCopyFileSync = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    copyFileSync: (...args: any[]) => mockCopyFileSync(...args),
  };
});

// ── Mock gmail service ───────────────────────────────────────────────────────

const mockDownloadAttachment = vi.fn();

vi.mock('../../services/gmail.js', () => ({
  downloadAttachment: (...args: any[]) => mockDownloadAttachment(...args),
}));

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

// ── Helpers ──────────────────────────────────────────────────────────────────

const GMAIL_AT_COOKIE = {
  name: 'GMAIL_AT',
  value: 'af-token-123',
  domain: '.mail.google.com',
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'None' as const,
  expires: Date.now() / 1000 + 86400,
};

const SID_COOKIE = {
  name: 'SID',
  value: 'sid-abc',
  domain: '.google.com',
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'None' as const,
  expires: Date.now() / 1000 + 86400,
};

function fullCookieSet() {
  return [GMAIL_AT_COOKIE, SID_COOKIE];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Gmail Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockNewPage.mockResolvedValue({ goto: mockGoto, close: mockPageClose });
    mockBrowser.newContext.mockResolvedValue(mockBrowserContext);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);
    mockExistsSync.mockReturnValue(false);

    server = createMockServer();
    registerGmailTools(server as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should register sq_login_gmail and sq_download_attachment', () => {
    expect(server.tools.has('sq_login_gmail')).toBe(true);
    expect(server.tools.has('sq_download_attachment')).toBe(true);
    expect(server.tools.size).toBe(2);
  });

  describe('sq_login_gmail', () => {
    it('should launch chromium in headful mode', async () => {
      mockContextCookies.mockResolvedValue(fullCookieSet());

      await server.callTool('sq_login_gmail', {});

      expect(mockChromiumLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ headless: false }),
      );
    });

    it('should navigate to Gmail', async () => {
      mockContextCookies.mockResolvedValue(fullCookieSet());

      await server.callTool('sq_login_gmail', {});

      expect(mockGoto).toHaveBeenCalledWith(
        'https://mail.google.com',
        expect.objectContaining({ waitUntil: 'domcontentloaded' }),
      );
    });

    it('should save session with cookies in storageState format', async () => {
      mockContextCookies.mockResolvedValue(fullCookieSet());

      await server.callTool('sq_login_gmail', {});

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('gmail-session.json'),
        expect.any(String),
        'utf-8',
      );

      const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(writtenData.cookies).toEqual(fullCookieSet());
      expect(writtenData.origins).toEqual([]);
    });

    it('should backup existing session before saving', async () => {
      mockExistsSync.mockReturnValue(true);
      mockContextCookies.mockResolvedValue(fullCookieSet());

      await server.callTool('sq_login_gmail', {});

      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('gmail-session.json'),
        expect.stringContaining('gmail-session.json.bak'),
      );
    });

    it('should not backup when no existing session', async () => {
      mockExistsSync.mockReturnValue(false);
      mockContextCookies.mockResolvedValue(fullCookieSet());

      await server.callTool('sq_login_gmail', {});

      expect(mockCopyFileSync).not.toHaveBeenCalled();
    });

    it('should close browser after capturing cookies', async () => {
      mockContextCookies.mockResolvedValue(fullCookieSet());

      await server.callTool('sq_login_gmail', {});

      expect(mockClose).toHaveBeenCalled();
    });

    it('should return success with cookie details', async () => {
      mockContextCookies.mockResolvedValue(fullCookieSet());

      const result = await server.callTool('sq_login_gmail', {});

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('saved');
      expect(data.cookieCount).toBe(2);
      expect(data.hasGmailAt).toBe(true);
    });

    it('should poll until GMAIL_AT cookie appears', async () => {
      mockContextCookies
        .mockResolvedValueOnce([SID_COOKIE])
        .mockResolvedValueOnce([SID_COOKIE])
        .mockResolvedValue(fullCookieSet());

      const promise = server.callTool('sq_login_gmail', {});

      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;

      expect(mockContextCookies).toHaveBeenCalledTimes(3);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('saved');
      expect(data.hasGmailAt).toBe(true);
    });

    it('should return timeout error when login takes too long', async () => {
      mockContextCookies.mockResolvedValue([SID_COOKIE]);

      const promise = server.callTool('sq_login_gmail', { timeoutMs: 6000 });

      await vi.advanceTimersByTimeAsync(8000);

      const result = await promise;

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('timeout');
      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle browser launch failure', async () => {
      mockChromiumLaunch.mockRejectedValue(new Error('Executable not found'));

      const result = await server.callTool('sq_login_gmail', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Executable not found');
    });

    it('should ensure storage directory exists before writing', async () => {
      mockContextCookies.mockResolvedValue(fullCookieSet());

      await server.callTool('sq_login_gmail', {});

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it('should close browser even when save fails', async () => {
      mockContextCookies.mockResolvedValue(fullCookieSet());
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = await server.callTool('sq_login_gmail', {});

      expect(result.isError).toBe(true);
      expect(mockClose).toHaveBeenCalled();
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

    it('should return error on download failure', async () => {
      mockDownloadAttachment.mockRejectedValue(new Error('Gmail request failed (302)'));

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'msg-1',
        filename: 'file.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Gmail request failed');
    });
  });
});
