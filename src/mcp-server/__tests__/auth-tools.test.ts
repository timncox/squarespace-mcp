import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────────

const mockCheckSessionHealth = vi.fn();

vi.mock('../../services/content-save.js', () => ({
  ContentSaveClient: {
    checkSessionHealth: (...args: any[]) => mockCheckSessionHealth(...args),
  },
}));

const mockReloadAllSessions = vi.fn();
const mockListSites = vi.fn();
const mockGetClient = vi.fn();

const mockSaveSite = vi.fn();

vi.mock('../session.js', () => ({
  reloadAllSessions: () => mockReloadAllSessions(),
  listSites: (...args: any[]) => mockListSites(...args),
  getClient: (...args: any[]) => mockGetClient(...args),
  saveSite: (...args: any[]) => mockSaveSite(...args),
}));

const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockCopyFileSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    copyFileSync: (...args: any[]) => mockCopyFileSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    statSync: (...args: any[]) => mockStatSync(...args),
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
    vi.resetAllMocks();
    // Default: no configured sites (avoids validation warnings)
    mockListSites.mockReturnValue([]);
    server = createMockServer();
    registerAuthTools(server as any);
  });

  it('should register all four auth tools', () => {
    expect(server.tools.has('sq_login')).toBe(true);
    expect(server.tools.has('sq_save_session')).toBe(true);
    expect(server.tools.has('sq_discover_sites')).toBe(true);
    expect(server.tools.has('sq_restore_session')).toBe(true);
    expect(server.tools.size).toBe(4);
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
      // No sites configured — probe skipped
      mockListSites.mockReturnValue([]);

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

    it('should include cookie export instructions in login_required response', async () => {
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
      expect(instructions).toContain('storageState');
      expect(instructions).toContain('sq_save_session');
      // sq_restore_session referenced in updated instructions
      expect(instructions).toContain('sq_restore_session');
    });

    // ── Active probe tests ─────────────────────────────────────────────────

    it('should return session_invalid when file is healthy but API returns 401', async () => {
      mockCheckSessionHealth.mockReturnValue({
        exists: true,
        ageHours: 2,
        isStale: false,
        hasCrumb: true,
      });
      // Simulate a configured site
      mockListSites.mockReturnValue([{ id: 'test-site', subdomain: 'test-site' }]);
      // Simulate API returning 401 Unauthorized
      const mockClient = {
        listCollections: vi.fn().mockRejectedValue(new Error('HTTP 401 Unauthorized')),
      };
      mockGetClient.mockReturnValue(mockClient);

      const result = await server.callTool('sq_login', {});

      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('session_invalid');
      expect(data.reason).toContain('401');
      expect(data.reason).toContain('Unauthorized');
      expect(data.suggestion).toContain('sq_restore_session');
    });

    it('should return healthy when file is healthy and API probe succeeds', async () => {
      mockCheckSessionHealth.mockReturnValue({
        exists: true,
        ageHours: 1,
        isStale: false,
        hasCrumb: true,
      });
      mockListSites.mockReturnValue([{ id: 'test-site', subdomain: 'test-site' }]);
      const mockClient = {
        listCollections: vi.fn().mockResolvedValue([{ id: 'col-1', title: 'Home' }]),
      };
      mockGetClient.mockReturnValue(mockClient);

      const result = await server.callTool('sq_login', {});

      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('healthy');
      expect(data.ageHours).toBe(1);
    });

    it('should return healthy when probe fails with non-auth error', async () => {
      mockCheckSessionHealth.mockReturnValue({
        exists: true,
        ageHours: 3,
        isStale: false,
        hasCrumb: true,
      });
      mockListSites.mockReturnValue([{ id: 'test-site', subdomain: 'test-site' }]);
      // Simulate a network timeout (non-auth error)
      const mockClient = {
        listCollections: vi.fn().mockRejectedValue(new Error('fetch failed: network timeout')),
      };
      mockGetClient.mockReturnValue(mockClient);

      const result = await server.callTool('sq_login', {});

      const data = JSON.parse(result.content[0].text);
      // Non-auth errors are ignored; session reported as healthy based on file check
      expect(data.status).toBe('healthy');
      expect(data.ageHours).toBe(3);
    });
  });

  // ── sq_save_session ───────────────────────────────────────────────────────

  describe('sq_save_session', () => {
    const validSession = JSON.stringify({
      cookies: [
        { name: 'crumb', value: 'abc123', domain: '.squarespace.com' },
        { name: 'SS_MID', value: 'mid-123', domain: '.squarespace.com' },
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
      expect(data.cookieCount).toBe(4);
      expect(data.hasCrumb).toBe(true);
      expect(data.sites).toContain('grey-yellow-hbxc');
      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockReloadAllSessions).toHaveBeenCalled();
    });

    it('should backup existing session before overwriting', async () => {
      mockExistsSync.mockReturnValue(true);
      // readFileSync for backup comparison — return a valid session with few cookies
      mockReadFileSync.mockReturnValue(JSON.stringify({ cookies: [{ name: 'a', value: 'b' }] }));

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
          { name: 'SS_MID', value: 'mid-456', domain: '.squarespace.com' },
          { name: 'JSESSIONID', value: 'sess-456', domain: '.squarespace.com' },
        ],
        origins: [],
      });

      const result = await server.callTool('sq_save_session', { sessionData: noCrumbSession });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      // May be 'saved' or 'saved_with_warnings' depending on site config
      expect(data.hasCrumb).toBe(false);
      expect(data.message).toContain('NO crumb token');
    });

    it('should extract multiple site subdomains from cookies', async () => {
      mockExistsSync.mockReturnValue(false);
      const multiSiteSession = JSON.stringify({
        cookies: [
          { name: 'crumb', value: 'abc', domain: '.squarespace.com' },
          { name: 'SS_MID', value: 'mid', domain: '.squarespace.com' },
          { name: 'JSESSIONID', value: 'j1', domain: '.site-one-abc.squarespace.com' },
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

    // ── Validation warning tests ───────────────────────────────────────────

    it('should return saved_with_warnings when cookies have no site-specific domains', async () => {
      mockExistsSync.mockReturnValue(false);
      // Configured sites exist but cookies don't match
      mockListSites.mockReturnValue([
        { id: 'my-site', subdomain: 'my-site-abc', aliases: [], adminUrl: 'https://my-site-abc.squarespace.com' },
      ]);
      const globalOnlySession = JSON.stringify({
        cookies: [
          { name: 'crumb', value: 'abc', domain: '.squarespace.com' },
          { name: 'SS_MID', value: 'mid', domain: '.squarespace.com' },
          { name: 'JSESSIONID', value: 'j1', domain: '.squarespace.com' },
        ],
        origins: [],
      });

      const result = await server.callTool('sq_save_session', { sessionData: globalOnlySession });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('saved_with_warnings');
      expect(data.warnings).toBeInstanceOf(Array);
      expect(data.warnings.some((w: string) => w.includes('No site-specific cookies'))).toBe(true);
    });

    it('should return saved_with_warnings when critical cookies are missing', async () => {
      mockExistsSync.mockReturnValue(false);
      // Session with crumb but missing SS_MID and JSESSIONID
      const noCriticalSession = JSON.stringify({
        cookies: [
          { name: 'crumb', value: 'abc', domain: '.squarespace.com' },
          { name: '_ga', value: 'tracking', domain: '.squarespace.com' },
        ],
        origins: [],
      });

      const result = await server.callTool('sq_save_session', { sessionData: noCriticalSession });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('saved_with_warnings');
      expect(data.warnings).toBeInstanceOf(Array);
      expect(data.warnings.some((w: string) => w.includes('Missing critical cookies'))).toBe(true);
      expect(data.warnings.some((w: string) => w.includes('SS_MID'))).toBe(true);
      expect(data.warnings.some((w: string) => w.includes('JSESSIONID'))).toBe(true);
    });

    it('should return saved_with_warnings when new session has far fewer cookies than backup', async () => {
      // Existing session has many cookies
      mockExistsSync.mockReturnValue(true);
      const existingCookies = Array.from({ length: 20 }, (_, i) => ({
        name: `cookie_${i}`, value: `val_${i}`, domain: '.squarespace.com',
      }));
      mockReadFileSync.mockReturnValue(JSON.stringify({ cookies: existingCookies }));

      // New session has only 3 cookies (< 50% of 20)
      const smallSession = JSON.stringify({
        cookies: [
          { name: 'crumb', value: 'abc', domain: '.squarespace.com' },
          { name: 'SS_MID', value: 'mid', domain: '.squarespace.com' },
          { name: 'JSESSIONID', value: 'j1', domain: '.squarespace.com' },
        ],
        origins: [],
      });

      const result = await server.callTool('sq_save_session', { sessionData: smallSession });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('saved_with_warnings');
      expect(data.warnings.some((w: string) => w.includes('incomplete capture'))).toBe(true);
      expect(data.warnings.some((w: string) => w.includes('3 cookies') && w.includes('20'))).toBe(true);
    });

    it('should return saved (no warnings) when session has adequate cookies', async () => {
      mockExistsSync.mockReturnValue(false);
      // Session with all required cookies (crumb, SS_MID, JSESSIONID)
      const goodSession = JSON.stringify({
        cookies: [
          { name: 'crumb', value: 'abc', domain: '.squarespace.com' },
          { name: 'SS_MID', value: 'mid', domain: '.squarespace.com' },
          { name: 'JSESSIONID', value: 'j1', domain: '.squarespace.com' },
          { name: 'SS_SESSION_ID', value: 'sess', domain: '.squarespace.com' },
        ],
        origins: [],
      });

      const result = await server.callTool('sq_save_session', { sessionData: goodSession });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('saved');
      expect(data.warnings).toBeUndefined();
    });
  });

  // ── sq_restore_session ─────────────────────────────────────────────────────

  describe('sq_restore_session', () => {
    it('should restore backup successfully and return cookie count + age', async () => {
      // Backup exists
      mockExistsSync.mockReturnValue(true);
      const backupCookies = [
        { name: 'crumb', value: 'abc', domain: '.squarespace.com' },
        { name: 'SS_MID', value: 'mid', domain: '.squarespace.com' },
        { name: 'JSESSIONID', value: 'j1', domain: '.squarespace.com' },
      ];
      mockReadFileSync.mockReturnValue(JSON.stringify({ cookies: backupCookies }));
      // Backup is 5 hours old
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 5 * 60 * 60 * 1000 });

      const result = await server.callTool('sq_restore_session', {});

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('restored');
      expect(data.cookieCount).toBe(3);
      expect(data.hasCrumb).toBe(true);
      expect(data.ageHours).toBeCloseTo(5, 0);
      expect(data.message).toContain('restored');
      expect(data.message).toContain('3 cookies');
      // Should have copied backup to session path
      expect(mockCopyFileSync).toHaveBeenCalled();
      expect(mockReloadAllSessions).toHaveBeenCalled();
    });

    it('should return error when no backup exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await server.callTool('sq_restore_session', {});

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('error');
      expect(data.message).toContain('No backup session file');
    });

    it('should report missing crumb in restored session', async () => {
      mockExistsSync.mockReturnValue(true);
      const noCrumbBackup = [
        { name: 'SS_MID', value: 'mid', domain: '.squarespace.com' },
      ];
      mockReadFileSync.mockReturnValue(JSON.stringify({ cookies: noCrumbBackup }));
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() - 2 * 60 * 60 * 1000 });

      const result = await server.callTool('sq_restore_session', {});

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('restored');
      expect(data.hasCrumb).toBe(false);
      expect(data.message).toContain('No crumb token');
    });
  });
});
