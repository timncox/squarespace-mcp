import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock Playwright ──────────────────────────────────────────────────────────

const mockGoto = vi.fn();
const mockClose = vi.fn();
const mockPageClose = vi.fn();
const mockContextCookies = vi.fn();
const mockNewPage = vi.fn();

const mockStorageState = vi.fn();

const mockBrowserContext = {
  cookies: mockContextCookies,
  storageState: mockStorageState,
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

// ── Mock session ─────────────────────────────────────────────────────────────

const mockReloadAllSessions = vi.fn();
const mockListSites = vi.fn().mockReturnValue([]);

vi.mock('../session.js', () => ({
  reloadAllSessions: () => mockReloadAllSessions(),
  listSites: (...args: any[]) => mockListSites(...args),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { registerAuthTools } from '../tools/auth.js';

// ── Mock MCP server ─────────────────────────────────────────────────────────

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

const MEMBER_SESSION_COOKIE = {
  name: 'member-session',
  value: 'ms-abc123',
  domain: '.squarespace.com',
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'None' as const,
  expires: Date.now() / 1000 + 86400,
};

const CRUMB_COOKIE = {
  name: 'crumb',
  value: 'crumb-xyz',
  domain: '.squarespace.com',
  path: '/',
  httpOnly: false,
  secure: true,
  sameSite: 'None' as const,
  expires: Date.now() / 1000 + 86400,
};

const SS_MID_COOKIE = {
  name: 'SS_MID',
  value: 'mid-456',
  domain: '.squarespace.com',
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'None' as const,
  expires: Date.now() / 1000 + 86400,
};

function fullCookieSet() {
  return [MEMBER_SESSION_COOKIE, CRUMB_COOKIE, SS_MID_COOKIE];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sq_login_browser', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default mock setup
    mockNewPage.mockResolvedValue({ goto: mockGoto, close: mockPageClose });
    mockBrowser.newContext.mockResolvedValue(mockBrowserContext);
    mockChromiumLaunch.mockResolvedValue(mockBrowser);
    mockExistsSync.mockReturnValue(false);
    mockStorageState.mockImplementation(async () => ({
      cookies: await mockContextCookies(),
      origins: [],
    }));

    server = createMockServer();
    registerAuthTools(server as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should register sq_login_browser tool', () => {
    expect(server.tools.has('sq_login_browser')).toBe(true);
  });

  it('should launch chromium in headful mode', async () => {
    // member-session found immediately on first poll
    mockContextCookies.mockResolvedValue(fullCookieSet());

    await server.callTool('sq_login_browser', {});

    expect(mockChromiumLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: false }),
    );
  });

  it('should navigate to Squarespace login page', async () => {
    mockContextCookies.mockResolvedValue(fullCookieSet());

    await server.callTool('sq_login_browser', {});

    expect(mockGoto).toHaveBeenCalledWith('https://login.squarespace.com');
  });

  it('should accept custom loginUrl', async () => {
    mockContextCookies.mockResolvedValue(fullCookieSet());

    await server.callTool('sq_login_browser', {
      loginUrl: 'https://login.squarespace.com/?redirect=/config/pages',
    });

    expect(mockGoto).toHaveBeenCalledWith(
      'https://login.squarespace.com/?redirect=/config/pages',
    );
  });

  it('should save session with cookies in storageState format', async () => {
    mockContextCookies.mockResolvedValue(fullCookieSet());

    await server.callTool('sq_login_browser', {});

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('sqsp-session.json'),
      expect.any(String),
      'utf-8',
    );

    // Verify storageState format
    const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
    expect(writtenData.cookies).toEqual(fullCookieSet());
    expect(writtenData.origins).toEqual([]);
  });

  it('should backup existing session before saving', async () => {
    mockExistsSync.mockReturnValue(true);
    mockContextCookies.mockResolvedValue(fullCookieSet());

    await server.callTool('sq_login_browser', {});

    expect(mockCopyFileSync).toHaveBeenCalledWith(
      expect.stringContaining('sqsp-session.json'),
      expect.stringContaining('sqsp-session.json.bak'),
    );
  });

  it('should not backup when no existing session', async () => {
    mockExistsSync.mockReturnValue(false);
    mockContextCookies.mockResolvedValue(fullCookieSet());

    await server.callTool('sq_login_browser', {});

    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it('should reload all sessions after saving', async () => {
    mockContextCookies.mockResolvedValue(fullCookieSet());

    await server.callTool('sq_login_browser', {});

    expect(mockReloadAllSessions).toHaveBeenCalled();
  });

  it('should close browser after capturing cookies', async () => {
    mockContextCookies.mockResolvedValue(fullCookieSet());

    await server.callTool('sq_login_browser', {});

    expect(mockClose).toHaveBeenCalled();
  });

  it('should return success with cookie details', async () => {
    mockContextCookies.mockResolvedValue(fullCookieSet());

    const result = await server.callTool('sq_login_browser', {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('saved');
    expect(data.cookieCount).toBeGreaterThanOrEqual(3);
    expect(data.hasCrumb).toBe(true);
    expect(data.hasMemberSession).toBe(true);
  });

  it('should poll until member-session cookie appears', async () => {
    // First two polls: no member-session; third poll: has it
    mockContextCookies
      .mockResolvedValueOnce([CRUMB_COOKIE])
      .mockResolvedValueOnce([CRUMB_COOKIE])
      .mockResolvedValue(fullCookieSet());

    const promise = server.callTool('sq_login_browser', {});

    // Advance timers to trigger polling intervals
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    // 2 polls without member-session + 1 with it + 1 from storageState() mock
    expect(mockContextCookies).toHaveBeenCalledTimes(4);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('saved');
    expect(data.hasMemberSession).toBe(true);
  });

  it('should return timeout error when login takes too long', async () => {
    // Never returns member-session
    mockContextCookies.mockResolvedValue([CRUMB_COOKIE]);

    const promise = server.callTool('sq_login_browser', { timeoutMs: 6000 });

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(8000);

    const result = await promise;

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('timeout');
    expect(mockClose).toHaveBeenCalled(); // browser still closed on timeout
  });

  it('should handle browser launch failure', async () => {
    mockChromiumLaunch.mockRejectedValue(new Error('Executable not found'));

    const result = await server.callTool('sq_login_browser', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Executable not found');
  });

  it('should ensure storage directory exists before writing', async () => {
    mockContextCookies.mockResolvedValue(fullCookieSet());

    await server.callTool('sq_login_browser', {});

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

    const result = await server.callTool('sq_login_browser', {});

    expect(result.isError).toBe(true);
    expect(mockClose).toHaveBeenCalled();
  });

  it('should warn when member-session is missing but other cookies present', async () => {
    // User logged in partially — crumb exists but no member-session
    // This shouldn't happen in practice if we poll for member-session,
    // but tests the timeout path where we have some cookies
    mockContextCookies.mockResolvedValue([CRUMB_COOKIE, SS_MID_COOKIE]);

    const promise = server.callTool('sq_login_browser', { timeoutMs: 4000 });
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('timeout');
  });
});
