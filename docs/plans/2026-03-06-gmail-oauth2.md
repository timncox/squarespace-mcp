# Gmail OAuth2 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Playwright-based Gmail login + cookie-based MIME scraping with Google OAuth2 + Gmail API for downloading email attachments.

**Architecture:** `sq_login_gmail` starts a local HTTP server, opens the user's real browser (via `open` command) to Google's OAuth consent page, receives the auth code callback, exchanges it for access + refresh tokens, and saves them to `storage/auth/gmail-oauth.json`. `sq_download_attachment` uses the Gmail API (`messages.get` for attachment IDs, `messages.attachments.get` for data), decodes base64url, and saves to disk. Credentials (client_id + client_secret) are loaded from `storage/auth/gmail-credentials.json`.

**Tech Stack:** Node.js `http` module (callback server), native `fetch` (Google OAuth + Gmail API), `open` npm package or `child_process.exec('open ...')` for launching browser.

---

### Task 1: Rewrite Gmail Service — OAuth2 Token Management + Gmail API

**Files:**
- Rewrite: `src/services/gmail.ts`
- Rewrite: `src/services/__tests__/gmail.test.ts`

**Step 1: Write the failing tests**

Rewrite `src/services/__tests__/gmail.test.ts`:

```typescript
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
      expect(mockFetch.mock.calls[0][0]).toContain('oauth2/v4/token');
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/gmail.test.ts`
Expected: FAIL — current gmail.ts exports different functions

**Step 3: Write the implementation**

Rewrite `src/services/gmail.ts`:

```typescript
/**
 * Gmail service — OAuth2-based attachment download.
 * Uses Google OAuth2 tokens to call the Gmail API for downloading
 * email attachments.
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const AUTH_DIR = join(PROJECT_ROOT, 'storage', 'auth');
const CREDENTIALS_PATH = join(AUTH_DIR, 'gmail-credentials.json');
const TOKENS_PATH = join(AUTH_DIR, 'gmail-oauth.json');

const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// ── Credentials ──────────────────────────────────────────────────────────────

export interface GmailCredentials {
  client_id: string;
  client_secret: string;
}

export interface GmailTokens {
  access_token: string;
  refresh_token: string;
  expiry: number;
}

export function loadCredentials(): GmailCredentials {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      'Gmail credentials not found. Save your Google OAuth client_id and client_secret ' +
      'to storage/auth/gmail-credentials.json as { "client_id": "...", "client_secret": "..." }',
    );
  }

  const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
  const creds = JSON.parse(raw);

  if (!creds.client_id || !creds.client_secret) {
    throw new Error(
      'Gmail credentials must contain both client_id and client_secret.',
    );
  }

  return { client_id: creds.client_id, client_secret: creds.client_secret };
}

// ── Token management ─────────────────────────────────────────────────────────

export function loadTokens(): GmailTokens {
  if (!existsSync(TOKENS_PATH)) {
    throw new Error(
      'Gmail not authorized. Run sq_login_gmail to complete OAuth2 authorization.',
    );
  }

  const raw = readFileSync(TOKENS_PATH, 'utf-8');
  return JSON.parse(raw);
}

export function saveTokens(tokens: GmailTokens): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
}

export async function refreshAccessToken(): Promise<string> {
  const creds = loadCredentials();
  const tokens = loadTokens();

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };

  const updated: GmailTokens = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token,
    expiry: Date.now() + data.expires_in * 1000,
  };

  saveTokens(updated);
  logger.info('Gmail access token refreshed');

  return data.access_token;
}

async function getAccessToken(): Promise<string> {
  const creds = loadCredentials(); // validate credentials exist
  const tokens = loadTokens();

  // Refresh if expired or expiring within 5 minutes
  if (tokens.expiry < Date.now() + 300_000) {
    return refreshAccessToken();
  }

  return tokens.access_token;
}

// ── Gmail API ────────────────────────────────────────────────────────────────

interface GmailPart {
  filename?: string;
  mimeType: string;
  body: { attachmentId?: string; size: number; data?: string };
  parts?: GmailPart[];
}

function findAttachmentPart(
  parts: GmailPart[],
  targetFilename: string,
): GmailPart | undefined {
  for (const part of parts) {
    if (
      part.filename &&
      part.filename.toLowerCase() === targetFilename.toLowerCase() &&
      part.body.attachmentId
    ) {
      return part;
    }
    if (part.parts) {
      const nested = findAttachmentPart(part.parts, targetFilename);
      if (nested) return nested;
    }
  }
  return undefined;
}

function collectFilenames(parts: GmailPart[]): string[] {
  const filenames: string[] = [];
  for (const part of parts) {
    if (part.filename && part.body.attachmentId) {
      filenames.push(part.filename);
    }
    if (part.parts) {
      filenames.push(...collectFilenames(part.parts));
    }
  }
  return filenames;
}

export async function downloadAttachment(
  messageId: string,
  targetFilename: string,
): Promise<string> {
  const accessToken = await getAccessToken();

  const headers = { Authorization: `Bearer ${accessToken}` };

  // 1. Get message to find attachment ID
  const msgResponse = await fetch(
    `${GMAIL_API_BASE}/messages/${messageId}`,
    { headers },
  );

  if (!msgResponse.ok) {
    throw new Error(`Gmail API messages.get failed (${msgResponse.status})`);
  }

  const message = await msgResponse.json() as { payload: GmailPart };
  const parts = message.payload.parts ?? [message.payload];

  const attachmentPart = findAttachmentPart(parts, targetFilename);

  if (!attachmentPart) {
    const available = collectFilenames(parts).join(', ');
    throw new Error(
      `No attachment named "${targetFilename}" in message. Available: ${available || 'none'}`,
    );
  }

  // 2. Download attachment data
  const attResponse = await fetch(
    `${GMAIL_API_BASE}/messages/${messageId}/attachments/${attachmentPart.body.attachmentId}`,
    { headers },
  );

  if (!attResponse.ok) {
    throw new Error(`Gmail API attachments.get failed (${attResponse.status})`);
  }

  const attData = await attResponse.json() as { data: string };
  const buffer = Buffer.from(attData.data, 'base64url');

  // 3. Save to disk
  const uploadsDir = join(PROJECT_ROOT, 'storage', 'uploads');
  mkdirSync(uploadsDir, { recursive: true });

  const timestamp = Date.now();
  const safeName = attachmentPart.filename!.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(uploadsDir, `${timestamp}-${safeName}`);

  writeFileSync(filePath, buffer);
  logger.info(
    { messageId, filename: attachmentPart.filename, size: buffer.length },
    'Attachment downloaded via Gmail API',
  );

  return filePath;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/gmail.test.ts`
Expected: PASS — all tests

**Step 5: Commit**

```bash
git add src/services/gmail.ts src/services/__tests__/gmail.test.ts
git commit -m "refactor: rewrite Gmail service to use OAuth2 + Gmail API"
```

---

### Task 2: Rewrite Gmail Tools — OAuth2 Login + API Download

**Files:**
- Rewrite: `src/mcp-server/tools/gmail.ts`
- Rewrite: `src/mcp-server/__tests__/gmail-tools.test.ts`

**Step 1: Write the failing tests**

Rewrite `src/mcp-server/__tests__/gmail-tools.test.ts`:

```typescript
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
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: FAIL — current tools import different modules

**Step 3: Write the implementation**

Rewrite `src/mcp-server/tools/gmail.ts`:

```typescript
/**
 * MCP Tools — Gmail OAuth2 login + attachment download
 *
 * sq_login_gmail: OAuth2 flow — opens user's real browser, local callback server
 * sq_download_attachment: Download email attachment via Gmail API
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import http from 'http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const AUTH_DIR = join(PROJECT_ROOT, 'storage', 'auth');

const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function registerGmailTools(server: McpServer) {
  // ── sq_login_gmail ─────────────────────────────────────────────────────────
  server.registerTool('sq_login_gmail', {
    description:
      'Authorize Gmail access via Google OAuth2. Opens your default browser for Google login. ' +
      'Requires storage/auth/gmail-credentials.json with client_id and client_secret ' +
      'from a Google Cloud project with the Gmail API enabled (Desktop app type).',
    inputSchema: {
      timeoutMs: z.number().optional().describe(
        'Max milliseconds to wait for authorization (default 120000)',
      ),
    },
  }, async ({ timeoutMs }) => {
    const timeout = timeoutMs ?? 120_000;
    let httpServer: http.Server | null = null;

    try {
      const { loadCredentials, saveTokens } = await import('../../services/gmail.js');
      const creds = loadCredentials();

      // Start local HTTP server on random port
      const { port, code } = await new Promise<{ port: number; code: string }>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          if (httpServer) httpServer.close();
          reject(new Error('timeout'));
        }, timeout);

        httpServer = http.createServer((req, res) => {
          const url = new URL(req.url!, `http://localhost`);
          const authCode = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Authorization denied</h1><p>You can close this tab.</p>');
            clearTimeout(timeoutId);
            httpServer!.close();
            reject(new Error(`OAuth denied: ${error}`));
            return;
          }

          if (authCode) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Gmail authorized!</h1><p>You can close this tab and return to Claude.</p>');
            clearTimeout(timeoutId);
            httpServer!.close();
            resolve({ port: (httpServer!.address() as any).port, code: authCode });
            return;
          }

          res.writeHead(404);
          res.end();
        });

        httpServer.listen(0, '127.0.0.1', () => {
          const addr = httpServer!.address() as { port: number };
          const redirectUri = `http://127.0.0.1:${addr.port}`;

          const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
          authUrl.searchParams.set('client_id', creds.client_id);
          authUrl.searchParams.set('redirect_uri', redirectUri);
          authUrl.searchParams.set('response_type', 'code');
          authUrl.searchParams.set('scope', SCOPES);
          authUrl.searchParams.set('access_type', 'offline');
          authUrl.searchParams.set('prompt', 'consent');

          // Open user's real browser (not Playwright)
          try {
            execSync(`open "${authUrl.toString()}"`);
          } catch {
            reject(new Error(`Could not open browser. Visit this URL manually:\n${authUrl.toString()}`));
          }
        });
      });

      // Exchange auth code for tokens
      const redirectUri = `http://127.0.0.1:${port}`;
      const tokenResponse = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResponse.ok) {
        const body = await tokenResponse.text();
        throw new Error(`Token exchange failed (${tokenResponse.status}): ${body}`);
      }

      const tokenData = await tokenResponse.json() as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      mkdirSync(AUTH_DIR, { recursive: true });
      saveTokens({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expiry: Date.now() + tokenData.expires_in * 1000,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status: 'authorized',
          hasRefreshToken: !!tokenData.refresh_token,
          message: 'Gmail OAuth2 authorized. Attachment downloads are now ready. Token will auto-refresh.',
        }, null, 2) }],
      };
    } catch (err) {
      if (httpServer) {
        try { httpServer.close(); } catch { /* best effort */ }
      }

      const msg = err instanceof Error ? err.message : String(err);

      if (msg === 'timeout') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'timeout',
            message: `Authorization timed out after ${timeout}ms. Please try again.`,
          }, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  // ── sq_download_attachment ─────────────────────────────────────────────────
  server.registerTool('sq_download_attachment', {
    description:
      'Download an email attachment via Gmail API. Returns the local file path. ' +
      'Requires sq_login_gmail to have been run first for OAuth2 authorization.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID (from Claude.ai Gmail MCP)'),
      filename: z.string().describe('Filename of the attachment to download'),
    },
  }, async ({ messageId, filename }) => {
    try {
      const { downloadAttachment } = await import('../../services/gmail.js');
      const filePath = await downloadAttachment(messageId, filename);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ filePath, filename }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: PASS — all tests

**Step 5: Commit**

```bash
git add src/mcp-server/tools/gmail.ts src/mcp-server/__tests__/gmail-tools.test.ts
git commit -m "refactor: rewrite Gmail tools to use OAuth2 flow"
```

---

### Task 3: Run Full Test Suite + Verify

**Step 1: Run all tests**

Run: `npm test`
Expected: All ~1367 tests pass (existing tests unaffected)

**Step 2: Verify no stale Playwright/cookie references in Gmail files**

Run: `grep -n "GMAIL_AT\|chromium\|playwright\|cookie.*gmail\|gmail.*cookie\|MIME\|parseMime" src/services/gmail.ts src/mcp-server/tools/gmail.ts`
Expected: No matches — all Playwright/cookie/MIME code is gone

**Step 3: Commit if any fixes needed**

---

### Task 4: Credentials Setup + Manual Verification

This task is manual — guide the user through setup.

**Step 1: Create Google Cloud OAuth credentials**

The user needs to:
1. Go to https://console.cloud.google.com
2. Create a project (or select existing)
3. Enable the Gmail API: APIs & Services → Library → search "Gmail API" → Enable
4. Create credentials: APIs & Services → Credentials → Create Credentials → OAuth client ID
5. Application type: "Desktop app"
6. Copy the client_id and client_secret

**Step 2: Save credentials file**

Create `storage/auth/gmail-credentials.json`:
```json
{
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET"
}
```

**Step 3: Run sq_login_gmail**

This opens the user's real browser to Google OAuth consent. No Playwright. User authorizes, gets redirected to localhost, tokens are saved automatically.

**Step 4: Test sq_download_attachment**

Download the Sunday Supper PDF from the BMCo email to verify end-to-end.
