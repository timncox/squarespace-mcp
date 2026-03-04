import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────────

const mockCheckSessionHealth = vi.fn();

vi.mock('../../services/content-save.js', () => ({
  ContentSaveClient: {
    checkSessionHealth: (...args: any[]) => mockCheckSessionHealth(...args),
  },
}));

const mockReloadAllSessions = vi.fn();

vi.mock('../session.js', () => ({
  reloadAllSessions: () => mockReloadAllSessions(),
}));

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

import { registerAuthTools } from '../tools/auth.js';

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

describe('Auth Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerAuthTools(server as any);
  });

  it('should register both auth tools', () => {
    expect(server.tools.has('sq_login')).toBe(true);
    expect(server.tools.has('sq_save_session')).toBe(true);
    expect(server.tools.size).toBe(2);
  });

  // ── sq_login ──────────────────────────────────────────────────────────────

  describe('sq_login', () => {
    it('should return healthy when session is valid', async () => {
      mockCheckSessionHealth.mockReturnValue({
        exists: true,
        ageHours: 2.5,
        isStale: false,
        hasCrumb: true,
      });

      const result = await server.callTool('sq_login', {});

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('healthy');
      expect(data.ageHours).toBe(2.5);
      expect(data.message).toContain('2.5h old');
    });

    it('should return login_required when session does not exist', async () => {
      mockCheckSessionHealth.mockReturnValue({
        exists: false,
        ageHours: -1,
        isStale: true,
        hasCrumb: false,
      });

      const result = await server.callTool('sq_login', {});

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('login_required');
      expect(data.reason).toContain('No session file found');
      expect(data.loginUrl).toBe('https://login.squarespace.com');
      expect(data.instructions).toBeInstanceOf(Array);
      expect(data.instructions.length).toBeGreaterThan(0);
    });

    it('should return login_required when session is stale', async () => {
      mockCheckSessionHealth.mockReturnValue({
        exists: true,
        ageHours: 30,
        isStale: true,
        hasCrumb: true,
      });

      const result = await server.callTool('sq_login', {});

      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('login_required');
      expect(data.reason).toContain('stale');
      expect(data.reason).toContain('30h');
    });

    it('should return login_required when session has no crumb', async () => {
      mockCheckSessionHealth.mockReturnValue({
        exists: true,
        ageHours: 1,
        isStale: false,
        hasCrumb: false,
      });

      const result = await server.callTool('sq_login', {});

      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('login_required');
      expect(data.reason).toContain('missing crumb token');
    });

    it('should accept optional siteId parameter', async () => {
      mockCheckSessionHealth.mockReturnValue({
        exists: true,
        ageHours: 1,
        isStale: false,
        hasCrumb: true,
      });

      const result = await server.callTool('sq_login', { siteId: 'my-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('healthy');
    });

    it('should return error on unexpected exception', async () => {
      mockCheckSessionHealth.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = await server.callTool('sq_login', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Permission denied');
    });

    it('should include Playwright instructions in login_required response', async () => {
      mockCheckSessionHealth.mockReturnValue({
        exists: false,
        ageHours: -1,
        isStale: true,
        hasCrumb: false,
      });

      const result = await server.callTool('sq_login', {});

      const data = JSON.parse(result.content[0].text);
      const instructions = data.instructions.join(' ');
      expect(instructions).toContain('Playwright');
      expect(instructions).toContain('login.squarespace.com');
      expect(instructions).toContain('storageState');
      expect(instructions).toContain('sq_save_session');
    });
  });

  // ── sq_save_session ───────────────────────────────────────────────────────

  describe('sq_save_session', () => {
    const validSession = JSON.stringify({
      cookies: [
        { name: 'crumb', value: 'abc123', domain: '.squarespace.com' },
        { name: 'JSESSIONID', value: 'sess-456', domain: '.grey-yellow-hbxc.squarespace.com' },
        { name: 'other', value: 'val', domain: '.example.com' },
      ],
      origins: [],
    });

    it('should save valid session and reload clients', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await server.callTool('sq_save_session', { sessionData: validSession });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('saved');
      expect(data.cookieCount).toBe(3);
      expect(data.hasCrumb).toBe(true);
      expect(data.sites).toContain('grey-yellow-hbxc');
      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockReloadAllSessions).toHaveBeenCalled();
    });

    it('should backup existing session before overwriting', async () => {
      mockExistsSync.mockReturnValue(true);

      await server.callTool('sq_save_session', { sessionData: validSession });

      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('sqsp-session.json'),
        expect.stringContaining('sqsp-session.json.bak'),
      );
    });

    it('should not backup when no existing session', async () => {
      mockExistsSync.mockReturnValue(false);

      await server.callTool('sq_save_session', { sessionData: validSession });

      expect(mockCopyFileSync).not.toHaveBeenCalled();
    });

    it('should reject invalid JSON', async () => {
      const result = await server.callTool('sq_save_session', { sessionData: 'not json{' });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('error');
      expect(data.message).toContain('Invalid JSON');
    });

    it('should reject session without cookies array', async () => {
      const result = await server.callTool('sq_save_session', {
        sessionData: JSON.stringify({ origins: [] }),
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('error');
      expect(data.message).toContain('missing "cookies" array');
    });

    it('should reject session with empty cookies', async () => {
      const result = await server.callTool('sq_save_session', {
        sessionData: JSON.stringify({ cookies: [] }),
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('error');
      expect(data.message).toContain('0 cookies');
    });

    it('should warn when crumb token is missing', async () => {
      mockExistsSync.mockReturnValue(false);
      const noCrumbSession = JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'sess-456', domain: '.squarespace.com' },
        ],
        origins: [],
      });

      const result = await server.callTool('sq_save_session', { sessionData: noCrumbSession });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('saved');
      expect(data.hasCrumb).toBe(false);
      expect(data.message).toContain('NO crumb token');
    });

    it('should extract multiple site subdomains from cookies', async () => {
      mockExistsSync.mockReturnValue(false);
      const multiSiteSession = JSON.stringify({
        cookies: [
          { name: 'crumb', value: 'abc', domain: '.squarespace.com' },
          { name: 'c1', value: 'v1', domain: '.site-one-abc.squarespace.com' },
          { name: 'c2', value: 'v2', domain: '.site-two-xyz.squarespace.com' },
          { name: 'c3', value: 'v3', domain: '.example.com' },
        ],
        origins: [],
      });

      const result = await server.callTool('sq_save_session', { sessionData: multiSiteSession });

      const data = JSON.parse(result.content[0].text);
      expect(data.sites).toContain('site-one-abc');
      expect(data.sites).toContain('site-two-xyz');
      expect(data.sites).not.toContain('example');
    });

    it('should return error on write failure', async () => {
      mockExistsSync.mockReturnValue(false);
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = await server.callTool('sq_save_session', { sessionData: validSession });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('EACCES');
    });
  });
});
