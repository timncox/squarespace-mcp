import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs
const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    existsSync: (...args: any[]) => mockExistsSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  };
});

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  loadCredentials,
  loadTokens,
  saveTokens,
  refreshAccessToken,
  downloadAttachment,
} from '../gmail.js';

// ── Test data ────────────────────────────────────────────────────────────────

const SAMPLE_CREDENTIALS = {
  client_id: 'test-client-id.apps.googleusercontent.com',
  client_secret: 'test-client-secret',
};

const SAMPLE_TOKENS = {
  access_token: 'ya29.test-access-token',
  refresh_token: '1//test-refresh-token',
  expiry: Date.now() + 3600_000,
};

const EXPIRED_TOKENS = {
  access_token: 'ya29.expired-token',
  refresh_token: '1//test-refresh-token',
  expiry: Date.now() - 60_000,
};

// Gmail API message response with attachment
const GMAIL_MESSAGE_RESPONSE = {
  id: 'msg-abc123',
  payload: {
    parts: [
      {
        mimeType: 'text/plain',
        body: { size: 100 },
      },
      {
        filename: 'menu.pdf',
        mimeType: 'application/pdf',
        body: {
          attachmentId: 'att-id-xyz',
          size: 53595,
        },
      },
    ],
  },
};

// Gmail API attachment response (base64url-encoded)
const PDF_BYTES = Buffer.from('fake-pdf-bytes');
const GMAIL_ATTACHMENT_RESPONSE = {
  size: PDF_BYTES.length,
  data: PDF_BYTES.toString('base64url'),
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Gmail Service (OAuth2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadCredentials', () => {
    it('should load client_id and client_secret from gmail-credentials.json', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_CREDENTIALS));

      const creds = loadCredentials();
      expect(creds.client_id).toBe(SAMPLE_CREDENTIALS.client_id);
      expect(creds.client_secret).toBe(SAMPLE_CREDENTIALS.client_secret);
    });

    it('should throw when credentials file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => loadCredentials()).toThrow('Gmail credentials not found');
    });

    it('should throw when credentials are missing client_id', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ client_secret: 'x' }));
      expect(() => loadCredentials()).toThrow('client_id');
    });
  });

  describe('loadTokens', () => {
    it('should load tokens from gmail-oauth.json', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_TOKENS));

      const tokens = loadTokens();
      expect(tokens.access_token).toBe(SAMPLE_TOKENS.access_token);
      expect(tokens.refresh_token).toBe(SAMPLE_TOKENS.refresh_token);
    });

    it('should throw when tokens file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => loadTokens()).toThrow('not authorized');
    });
  });

  describe('saveTokens', () => {
    it('should write tokens to gmail-oauth.json', () => {
      saveTokens(SAMPLE_TOKENS);

      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('gmail-oauth.json'),
        expect.any(String),
        'utf-8',
      );

      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(written.access_token).toBe(SAMPLE_TOKENS.access_token);
      expect(written.refresh_token).toBe(SAMPLE_TOKENS.refresh_token);
    });
  });

  describe('refreshAccessToken', () => {
    it('should exchange refresh token for new access token', async () => {
      // loadCredentials
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS))  // credentials
        .mockReturnValueOnce(JSON.stringify(EXPIRED_TOKENS));      // tokens

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: 'ya29.new-token',
          expires_in: 3600,
        }),
      });

      const newToken = await refreshAccessToken();
      expect(newToken).toBe('ya29.new-token');

      // Should save updated tokens
      expect(mockWriteFileSync).toHaveBeenCalled();
      const saved = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(saved.access_token).toBe('ya29.new-token');
      expect(saved.refresh_token).toBe(EXPIRED_TOKENS.refresh_token);
    });

    it('should throw on token refresh failure', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS))
        .mockReturnValueOnce(JSON.stringify(EXPIRED_TOKENS));

      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('invalid_grant'),
      });

      await expect(refreshAccessToken()).rejects.toThrow('refresh failed');
    });
  });

  describe('downloadAttachment', () => {
    it('should download attachment via Gmail API and save to disk', async () => {
      // Two readFileSync calls: credentials then tokens
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS))  // credentials (for getAccessToken)
        .mockReturnValueOnce(JSON.stringify(SAMPLE_TOKENS));       // tokens

      // First fetch: messages.get to find attachmentId
      // Second fetch: messages.attachments.get to get data
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(GMAIL_MESSAGE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(GMAIL_ATTACHMENT_RESPONSE),
        });

      const filePath = await downloadAttachment('msg-abc123', 'menu.pdf');

      expect(filePath).toMatch(/menu\.pdf$/);
      expect(mockWriteFileSync).toHaveBeenCalled();

      // Verify the buffer written matches original bytes
      const writeCall = mockWriteFileSync.mock.calls.find(
        (c: any[]) => c[0].includes('menu') || c[0].includes('upload'),
      );
      expect(writeCall).toBeDefined();
      expect(Buffer.isBuffer(writeCall![1])).toBe(true);
      expect(writeCall![1].toString()).toBe('fake-pdf-bytes');
    });

    it('should throw when attachment filename not found in message', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS))
        .mockReturnValueOnce(JSON.stringify(SAMPLE_TOKENS));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(GMAIL_MESSAGE_RESPONSE),
      });

      await expect(downloadAttachment('msg-1', 'missing.pdf'))
        .rejects.toThrow('No attachment named "missing.pdf"');
    });

    it('should include available filenames in error', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS))
        .mockReturnValueOnce(JSON.stringify(SAMPLE_TOKENS));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(GMAIL_MESSAGE_RESPONSE),
      });

      await expect(downloadAttachment('msg-1', 'missing.pdf'))
        .rejects.toThrow('Available: menu.pdf');
    });

    it('should match filename case-insensitively', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS))
        .mockReturnValueOnce(JSON.stringify(SAMPLE_TOKENS));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(GMAIL_MESSAGE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(GMAIL_ATTACHMENT_RESPONSE),
        });

      const filePath = await downloadAttachment('msg-abc123', 'Menu.PDF');
      expect(filePath).toBeDefined();
    });

    it('should auto-refresh expired token before API call', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS))  // credentials for getAccessToken
        .mockReturnValueOnce(JSON.stringify(EXPIRED_TOKENS))       // expired tokens
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS));  // credentials for refresh

      // First fetch: token refresh
      // Second fetch: messages.get
      // Third fetch: attachments.get
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'ya29.refreshed', expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(GMAIL_MESSAGE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(GMAIL_ATTACHMENT_RESPONSE),
        });

      const filePath = await downloadAttachment('msg-abc123', 'menu.pdf');
      expect(filePath).toBeDefined();

      // Verify token was refreshed (first fetch call is to token endpoint)
      expect(mockFetch.mock.calls[0][0]).toContain('oauth2.googleapis.com/token');
    });

    it('should send Authorization header with access token', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS))
        .mockReturnValueOnce(JSON.stringify(SAMPLE_TOKENS));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(GMAIL_MESSAGE_RESPONSE),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(GMAIL_ATTACHMENT_RESPONSE),
        });

      await downloadAttachment('msg-abc123', 'menu.pdf');

      // messages.get call should have Bearer token
      expect(mockFetch.mock.calls[0][1].headers.Authorization)
        .toBe(`Bearer ${SAMPLE_TOKENS.access_token}`);
    });

    it('should handle nested multipart message parts', async () => {
      const nestedMessage = {
        id: 'msg-nested',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                { mimeType: 'text/plain', body: { size: 10 } },
                { mimeType: 'text/html', body: { size: 50 } },
              ],
            },
            {
              filename: 'data.bin',
              mimeType: 'application/octet-stream',
              body: { attachmentId: 'att-nested', size: 100 },
            },
          ],
        },
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync
        .mockReturnValueOnce(JSON.stringify(SAMPLE_CREDENTIALS))
        .mockReturnValueOnce(JSON.stringify(SAMPLE_TOKENS));

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(nestedMessage),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            size: 4,
            data: Buffer.from('test').toString('base64url'),
          }),
        });

      const filePath = await downloadAttachment('msg-nested', 'data.bin');
      expect(filePath).toBeDefined();
    });
  });
});
