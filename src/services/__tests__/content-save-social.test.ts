import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';

// ── Mock session file ─────────────────────────────────────────────────────

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })), // 1 hour old
}));

// ── Test fixtures ─────────────────────────────────────────────────────────

const SOCIAL_ACCOUNTS_RESPONSE = {
  results: [
    {
      serviceId: 62,
      screenname: 'Twitter',
      addedOn: 1602001109779,
      profileUrl: 'https://twitter.com/testuser',
      id: 'acc-twitter-123',
      websiteId: 'ws-123',
      pullEnabled: false,
      pushEnabled: true,
      autoPushEnabled: false,
      iconEnabled: true,
      defaultPushMessage: '%t %u',
      accountState: 1,
      serviceName: 'twitter-unauth',
      pushAvailable: true,
    },
    {
      serviceId: 64,
      screenname: 'Instagram',
      addedOn: 1602001209779,
      profileUrl: 'https://instagram.com/testuser',
      id: 'acc-instagram-456',
      websiteId: 'ws-123',
      pullEnabled: false,
      pushEnabled: true,
      autoPushEnabled: false,
      iconEnabled: true,
      defaultPushMessage: '%t %u',
      accountState: 1,
      serviceName: 'instagram-unauth',
      pushAvailable: true,
    },
  ],
  hasPreviousPage: false,
  hasNextPage: false,
};

const CREATE_ACCOUNT_RESPONSE = {
  account: {
    serviceId: 64,
    screenname: 'Instagram',
    addedOn: 1772592275432,
    profileUrl: 'http://instagram.com/newuser',
    id: 'acc-new-789',
    websiteId: 'ws-123',
    pullEnabled: false,
    pushEnabled: true,
    autoPushEnabled: false,
    iconEnabled: true,
    defaultPushMessage: '%t %u',
    serviceName: 'instagram-unauth',
    pushAvailable: true,
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Social Accounts', () => {
  let client: ContentSaveClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ── getSocialAccounts ─────────────────────────────────────────────────

  describe('getSocialAccounts', () => {
    it('should return list of social accounts', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(SOCIAL_ACCOUNTS_RESPONSE), { status: 200 }));

      const result = await client.getSocialAccounts();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data![0]).toEqual({
        id: 'acc-twitter-123',
        serviceId: 62,
        screenname: 'Twitter',
        profileUrl: 'https://twitter.com/testuser',
        iconEnabled: true,
        serviceName: 'twitter-unauth',
      });
      expect(result.data![1].serviceName).toBe('instagram-unauth');

      // Verify GET request
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/rest/social-accounts');
      expect(opts?.method ?? 'GET').toBe('GET');
    });

    it('should return empty array when no accounts', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [], hasPreviousPage: false, hasNextPage: false }), { status: 200 }),
      );

      const result = await client.getSocialAccounts();

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });

    it('should return error on HTTP failure', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      const result = await client.getSocialAccounts();

      expect(result.success).toBe(false);
      expect(result.error).toContain('401');
    });

    it('should return error on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await client.getSocialAccounts();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');
    });
  });

  // ── addSocialAccount ──────────────────────────────────────────────────

  describe('addSocialAccount', () => {
    it('should create a social account with form-encoded body', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(CREATE_ACCOUNT_RESPONSE), { status: 200 }));

      const result = await client.addSocialAccount(64, 'Instagram', 'http://instagram.com/newuser');

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        id: 'acc-new-789',
        serviceId: 64,
        screenname: 'Instagram',
        profileUrl: 'http://instagram.com/newuser',
        iconEnabled: true,
        serviceName: 'instagram-unauth',
      });

      // Verify POST request
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/config/CreateNonOAuthAccount');
      expect(opts?.method).toBe('POST');
      expect(opts?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(opts?.headers?.['X-CSRF-Token']).toBe('crumb-token-abc');
      expect(opts?.body).toContain('service=64');
      expect(opts?.body).toContain('username=Instagram');
      expect(opts?.body).toContain('profileUrl=');
    });

    it('should URL-encode special characters in profileUrl', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(CREATE_ACCOUNT_RESPONSE), { status: 200 }));

      await client.addSocialAccount(60, 'Facebook', 'http://facebook.com/some page');

      const body = fetchSpy.mock.calls[0][1]?.body as string;
      expect(body).toContain('profileUrl=http%3A%2F%2Ffacebook.com%2Fsome%20page');
    });

    it('should return error on HTTP failure', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

      const result = await client.addSocialAccount(64, 'Instagram', 'http://instagram.com/test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('400');
    });

    it('should return error when response has no account', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

      const result = await client.addSocialAccount(64, 'Instagram', 'http://instagram.com/test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('no account object');
    });
  });

  // ── removeSocialAccount ───────────────────────────────────────────────

  describe('removeSocialAccount', () => {
    it('should delete a social account by ID', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

      const result = await client.removeSocialAccount('acc-twitter-123');

      expect(result.success).toBe(true);

      // Verify DELETE request
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/rest/social-accounts/acc-twitter-123');
      expect(opts?.method).toBe('DELETE');
      expect(opts?.headers?.['X-CSRF-Token']).toBe('crumb-token-abc');
    });

    it('should return error on HTTP failure', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      const result = await client.removeSocialAccount('nonexistent-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('404');
    });

    it('should return error on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.removeSocialAccount('acc-123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });
  });
});
