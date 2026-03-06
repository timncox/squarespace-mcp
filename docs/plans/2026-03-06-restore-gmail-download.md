# Restore Gmail Attachment Download — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore minimal Gmail integration — only `sq_download_attachment` and `sq_setup_gmail` — so we can download email attachments (PDFs) for menu parsing. Claude.ai Gmail handles search/read; we fill the attachment download gap.

**Architecture:** Restore `src/services/gmail.ts` with only the functions needed for attachment download (skip `listInboxMessages`, `fetchNewMessages`, `markAsRead`). Add a minimal `src/mcp-server/tools/gmail.ts` with two tools. Keep existing `sq_parse_pdf_menu` in `pdf-menu.ts` as file-path-only.

**Tech Stack:** googleapis (Google APIs Node.js client), OAuth2

---

### Task 1: Add googleapis dependency

**Step 1: Install googleapis**

Run: `npm install googleapis`

**Step 2: Verify installation**

Run: `npm ls googleapis`
Expected: `googleapis@<version>` listed

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add googleapis for Gmail attachment download"
```

---

### Task 2: Restore Gmail service (minimal)

**Files:**
- Create: `src/services/gmail.ts`
- Test: `src/services/__tests__/gmail.test.ts`

**Step 1: Write the failing test**

Create `src/services/__tests__/gmail.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock googleapis
const mockGet = vi.fn();
const mockAttachmentsGet = vi.fn();
const mockSetCredentials = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn(() => ({ setCredentials: mockSetCredentials })),
    },
    gmail: vi.fn(() => ({
      users: {
        messages: {
          get: mockGet,
          attachments: { get: mockAttachmentsGet },
        },
      },
    })),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { getGmailClient, resetClient, fetchMessage, downloadAttachment, resolveAttachment } from '../gmail.js';

describe('Gmail Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClient();
    process.env.GMAIL_CLIENT_ID = 'test-client-id';
    process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';
    process.env.GMAIL_REFRESH_TOKEN = 'test-refresh-token';
  });

  describe('getGmailClient', () => {
    it('should create Gmail client with OAuth2 credentials', () => {
      const client = getGmailClient();
      expect(client).toBeDefined();
      expect(mockSetCredentials).toHaveBeenCalledWith({ refresh_token: 'test-refresh-token' });
    });

    it('should throw when credentials are missing', () => {
      delete process.env.GMAIL_CLIENT_ID;
      expect(() => getGmailClient()).toThrow('Gmail API not configured');
    });

    it('should return cached client on second call', () => {
      const client1 = getGmailClient();
      const client2 = getGmailClient();
      expect(client1).toBe(client2);
    });
  });

  describe('fetchMessage', () => {
    it('should fetch and parse a message with attachments', async () => {
      mockGet.mockResolvedValue({
        data: {
          threadId: 'thread-1',
          payload: {
            headers: [
              { name: 'From', value: 'Test User <test@example.com>' },
              { name: 'Subject', value: 'Menu update' },
              { name: 'Date', value: '2026-03-06' },
            ],
            mimeType: 'multipart/mixed',
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: Buffer.from('Hello world').toString('base64url') },
              },
              {
                filename: 'menu.pdf',
                mimeType: 'application/pdf',
                body: { attachmentId: 'att-1', size: 12345 },
              },
            ],
          },
        },
      });

      const msg = await fetchMessage('msg-1');
      expect(msg).not.toBeNull();
      expect(msg!.subject).toBe('Menu update');
      expect(msg!.attachments).toHaveLength(1);
      expect(msg!.attachments[0].attachmentId).toBe('att-1');
      expect(msg!.attachments[0].filename).toBe('menu.pdf');
    });

    it('should return null when payload is missing', async () => {
      mockGet.mockResolvedValue({ data: {} });
      const msg = await fetchMessage('msg-1');
      expect(msg).toBeNull();
    });
  });

  describe('resolveAttachment', () => {
    it('should find attachment by filename', async () => {
      mockGet.mockResolvedValue({
        data: {
          threadId: 'thread-1',
          payload: {
            headers: [
              { name: 'From', value: 'test@example.com' },
              { name: 'Subject', value: 'Test' },
              { name: 'Date', value: '2026-03-06' },
            ],
            mimeType: 'multipart/mixed',
            parts: [
              {
                filename: 'menu.pdf',
                mimeType: 'application/pdf',
                body: { attachmentId: 'att-1', size: 100 },
              },
            ],
          },
        },
      });

      const att = await resolveAttachment('msg-1', 'menu.pdf');
      expect(att.attachmentId).toBe('att-1');
    });

    it('should throw when filename not found', async () => {
      mockGet.mockResolvedValue({
        data: {
          threadId: 'thread-1',
          payload: {
            headers: [
              { name: 'From', value: 'test@example.com' },
              { name: 'Subject', value: 'Test' },
              { name: 'Date', value: '2026-03-06' },
            ],
            parts: [
              {
                filename: 'other.pdf',
                mimeType: 'application/pdf',
                body: { attachmentId: 'att-1', size: 100 },
              },
            ],
          },
        },
      });

      await expect(resolveAttachment('msg-1', 'missing.pdf')).rejects.toThrow('No attachment named "missing.pdf"');
    });
  });

  describe('downloadAttachment', () => {
    it('should download and save attachment to disk', async () => {
      const content = 'fake-pdf-bytes';
      mockAttachmentsGet.mockResolvedValue({
        data: { data: Buffer.from(content).toString('base64url') },
      });

      const { writeFileSync } = await import('fs');
      const path = await downloadAttachment('msg-1', 'att-1', 'menu.pdf');

      expect(path).toContain('menu.pdf');
      expect(writeFileSync).toHaveBeenCalled();
    });

    it('should throw when attachment data is empty', async () => {
      mockAttachmentsGet.mockResolvedValue({ data: {} });
      await expect(downloadAttachment('msg-1', 'att-1', 'file.pdf')).rejects.toThrow('No data in attachment');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/__tests__/gmail.test.ts`
Expected: FAIL — module `../gmail.js` not found

**Step 3: Write the Gmail service**

Create `src/services/gmail.ts`:

```typescript
/**
 * Gmail API client — minimal: attachment download only.
 * Search/read handled by Claude.ai Gmail MCP.
 */

import { google, gmail_v1 } from 'googleapis';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  messageId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  fromName?: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  attachments: GmailAttachment[];
}

let gmailClient: gmail_v1.Gmail | null = null;

export function resetClient(): void {
  gmailClient = null;
}

export function getGmailClient(): gmail_v1.Gmail {
  if (gmailClient) return gmailClient;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Gmail API not configured. Use sq_setup_gmail to connect your Gmail account, ' +
      'or set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in .env.',
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
  logger.info('Gmail API client initialized');
  return gmailClient;
}

export async function fetchMessage(messageId: string): Promise<GmailMessage | null> {
  const gmail = getGmailClient();

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const message = response.data;
  if (!message.payload) return null;

  const headers = message.payload.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const from = getHeader('From');
  const subject = getHeader('Subject');
  const date = getHeader('Date');

  const fromMatch = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
  const fromName = fromMatch?.[1]?.trim();

  const { text: bodyText, html: bodyHtml } = extractBody(message.payload);
  const attachments = extractAttachments(message.payload, messageId);

  return { id: messageId, threadId: message.threadId ?? messageId, from, fromName, subject, date, bodyText, bodyHtml, attachments };
}

export async function resolveAttachment(messageId: string, filename: string): Promise<GmailAttachment> {
  const message = await fetchMessage(messageId);
  if (!message) throw new Error(`Email with messageId ${messageId} not found`);

  const match = message.attachments.find(
    (a) => a.filename.toLowerCase() === filename.toLowerCase(),
  );
  if (!match) {
    const available = message.attachments.map((a) => a.filename).join(', ');
    throw new Error(`No attachment named "${filename}" in message. Available: ${available || 'none'}`);
  }

  return match;
}

export async function downloadAttachment(messageId: string, attachmentId: string, filename: string): Promise<string> {
  const gmail = getGmailClient();

  const response = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  const data = response.data.data;
  if (!data) throw new Error(`No data in attachment ${attachmentId}`);

  const buffer = Buffer.from(data, 'base64url');

  const uploadsDir = join(PROJECT_ROOT, 'storage', 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const timestamp = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(uploadsDir, `${timestamp}-${safeName}`);

  writeFileSync(filePath, buffer);
  logger.info({ filePath, filename, size: buffer.length }, 'Attachment downloaded');

  return filePath;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractBody(payload: gmail_v1.Schema$MessagePart): { text: string; html: string } {
  let text = '';
  let html = '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    text = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  } else if (payload.mimeType === 'text/html' && payload.body?.data) {
    html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const sub = extractBody(part);
      if (sub.text && !text) text = sub.text;
      if (sub.html && !html) html = sub.html;
    }
  }

  return { text, html };
}

function extractAttachments(payload: gmail_v1.Schema$MessagePart, messageId: string): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];

  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    attachments.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? 'application/octet-stream',
      size: payload.body.size ?? 0,
      attachmentId: payload.body.attachmentId,
      messageId,
    });
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part, messageId));
    }
  }

  return attachments;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/__tests__/gmail.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/gmail.ts src/services/__tests__/gmail.test.ts
git commit -m "feat: restore minimal Gmail service for attachment download"
```

---

### Task 3: Restore Gmail tools (sq_download_attachment + sq_setup_gmail)

**Files:**
- Create: `src/mcp-server/tools/gmail.ts`
- Test: `src/mcp-server/__tests__/gmail-tools.test.ts`

**Step 1: Write the failing test**

Create `src/mcp-server/__tests__/gmail-tools.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchMessage = vi.fn();
const mockDownloadAttachment = vi.fn();
const mockResolveAttachment = vi.fn();
const mockResetClient = vi.fn();
const mockGetGmailClient = vi.fn();

vi.mock('../../services/gmail.js', () => ({
  fetchMessage: (...args: any[]) => mockFetchMessage(...args),
  downloadAttachment: (...args: any[]) => mockDownloadAttachment(...args),
  resolveAttachment: (...args: any[]) => mockResolveAttachment(...args),
  resetClient: (...args: any[]) => mockResetClient(...args),
  getGmailClient: (...args: any[]) => mockGetGmailClient(...args),
}));

import { registerGmailTools } from '../tools/gmail.js';

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

describe('Gmail Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerGmailTools(server as any);
  });

  it('should register sq_setup_gmail and sq_download_attachment', () => {
    expect(server.tools.has('sq_setup_gmail')).toBe(true);
    expect(server.tools.has('sq_download_attachment')).toBe(true);
    expect(server.tools.size).toBe(2);
  });

  describe('sq_download_attachment', () => {
    it('should download attachment with explicit attachmentId', async () => {
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/menu.pdf');

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'msg-1',
        attachmentId: 'att-1',
        filename: 'menu.pdf',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.filePath).toBe('/storage/uploads/menu.pdf');
      expect(mockDownloadAttachment).toHaveBeenCalledWith('msg-1', 'att-1', 'menu.pdf');
      expect(mockResolveAttachment).not.toHaveBeenCalled();
    });

    it('should resolve attachmentId by filename when not provided', async () => {
      mockResolveAttachment.mockResolvedValue({
        filename: 'dinner.pdf',
        attachmentId: 'resolved-att-id',
        messageId: 'msg-1',
      });
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/dinner.pdf');

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'msg-1',
        filename: 'dinner.pdf',
      });

      expect(result.isError).toBeUndefined();
      expect(mockResolveAttachment).toHaveBeenCalledWith('msg-1', 'dinner.pdf');
      expect(mockDownloadAttachment).toHaveBeenCalledWith('msg-1', 'resolved-att-id', 'dinner.pdf');
    });

    it('should return error when attachment not found', async () => {
      mockResolveAttachment.mockRejectedValue(
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
      mockDownloadAttachment.mockRejectedValue(new Error('Attachment not found'));

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'msg-1',
        attachmentId: 'bad-att',
        filename: 'file.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Attachment not found');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: FAIL — module `../tools/gmail.js` not found

**Step 3: Write the Gmail tools**

Create `src/mcp-server/tools/gmail.ts`:

```typescript
/**
 * MCP Tools — Gmail attachment download
 *
 * sq_setup_gmail: OAuth setup for Gmail API access
 * sq_download_attachment: Download email attachment to disk
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { readFileSync as readSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { URL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');
const OAUTH_PORT = 3456;

let oauthServer: Server | null = null;
let capturedRefreshToken: string | null = null;

function upsertEnvVar(key: string, value: string): void {
  let content: string;
  try {
    content = readSync(ENV_PATH, 'utf-8');
  } catch {
    content = '';
  }

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }

  writeFileSync(ENV_PATH, content, 'utf-8');
  process.env[key] = value;
}

export function registerGmailTools(server: McpServer) {
  // ── sq_setup_gmail ──────────────────────────────────────────────────────────
  server.registerTool('sq_setup_gmail', {
    description:
      'Set up Gmail API access. If already configured, tests the connection. ' +
      'If not configured, starts an OAuth flow: returns an authorization URL for the user to open in their browser. ' +
      'After authorizing, the token is captured automatically via a local callback server. ' +
      'Call this tool again after authorizing to verify the setup.',
    inputSchema: {
      clientId: z.string().optional().describe('Google OAuth Client ID (if not already in .env)'),
      clientSecret: z.string().optional().describe('Google OAuth Client Secret (if not already in .env)'),
      reauth: z.boolean().optional().describe('Force re-authorization with a different Gmail account (default false)'),
    },
  }, async ({ clientId, clientSecret, reauth }) => {
    try {
      if (clientId) upsertEnvVar('GMAIL_CLIENT_ID', clientId);
      if (clientSecret) upsertEnvVar('GMAIL_CLIENT_SECRET', clientSecret);

      const envClientId = process.env.GMAIL_CLIENT_ID;
      const envClientSecret = process.env.GMAIL_CLIENT_SECRET;
      const envRefreshToken = process.env.GMAIL_REFRESH_TOKEN;

      if (capturedRefreshToken) {
        upsertEnvVar('GMAIL_REFRESH_TOKEN', capturedRefreshToken);
        capturedRefreshToken = null;
        if (oauthServer) { oauthServer.close(); oauthServer = null; }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'configured',
            message: 'Gmail OAuth token captured and saved. Gmail API is now ready to use.',
          }, null, 2) }],
        };
      }

      if (envClientId && envClientSecret && envRefreshToken && !reauth) {
        try {
          const gmail = await import('../../services/gmail.js');
          if (gmail.resetClient) gmail.resetClient();
          const client = gmail.getGmailClient();
          const profile = await client.users.getProfile({ userId: 'me' });
          const email = profile.data.emailAddress;

          if (oauthServer) { oauthServer.close(); oauthServer = null; }

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              status: 'connected',
              email,
              message: `Gmail API is connected and working. Authorized as ${email}.`,
            }, null, 2) }],
          };
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          if (!errMessage.includes('not configured')) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                status: 'error',
                message: `Gmail credentials are set but connection failed: ${errMessage}. You may need to re-authorize.`,
                hint: 'Call sq_setup_gmail again without arguments to start re-authorization.',
              }, null, 2) }],
            };
          }
        }
      }

      if (!envClientId || !envClientSecret) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'needs_credentials',
            message: 'Gmail OAuth client credentials are not configured.',
            instructions: [
              '1. Go to https://console.cloud.google.com/',
              '2. Create a project (or select existing) and enable the Gmail API',
              '3. Go to APIs & Services > Credentials > Create Credentials > OAuth client ID',
              '4. Application type: Web application',
              `5. Add authorized redirect URI: http://localhost:${OAUTH_PORT}/oauth2callback`,
              '6. Call this tool again with clientId and clientSecret parameters',
            ],
          }, null, 2) }],
        };
      }

      const { google } = await import('googleapis');
      const oauth2Client = new google.auth.OAuth2(
        envClientId,
        envClientSecret,
        `http://localhost:${OAUTH_PORT}/oauth2callback`,
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.readonly'],
        prompt: 'consent',
      });

      if (!oauthServer) {
        capturedRefreshToken = null;

        oauthServer = createServer(async (req, res) => {
          const url = new URL(req.url ?? '', `http://localhost:${OAUTH_PORT}`);

          if (url.pathname === '/oauth2callback') {
            const code = url.searchParams.get('code');
            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<h1>Error: Missing authorization code</h1>');
              return;
            }

            try {
              const { tokens } = await oauth2Client.getToken(code);
              if (tokens.refresh_token) {
                capturedRefreshToken = tokens.refresh_token;
                upsertEnvVar('GMAIL_REFRESH_TOKEN', tokens.refresh_token);
                process.env.GMAIL_REFRESH_TOKEN = tokens.refresh_token;
              }

              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(
                '<h1>Gmail authorized successfully!</h1>' +
                '<p>You can close this window and go back to Claude.</p>' +
                '<p>The refresh token has been saved automatically.</p>',
              );
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'text/html' });
              res.end(`<h1>Error exchanging authorization code</h1><p>${err}</p>`);
            }
          } else {
            res.writeHead(404);
            res.end('Not found');
          }
        });

        oauthServer.listen(OAUTH_PORT);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status: 'awaiting_authorization',
          authUrl,
          message: 'Open the authorization URL in your browser to connect your Gmail account. After authorizing, call sq_setup_gmail again to verify the connection.',
          instructions: [
            '1. Open the authUrl link in your browser',
            '2. Sign in with your Google account and authorize access',
            '3. You\'ll see a "Gmail authorized successfully!" page',
            '4. Come back here and call sq_setup_gmail to confirm it worked',
          ],
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_download_attachment ──────────────────────────────────────────────────
  server.registerTool('sq_download_attachment', {
    description:
      'Download an email attachment to disk. Returns the local file path. ' +
      'You can provide attachmentId (from sq_read_email) OR just the filename — ' +
      'if attachmentId is omitted, the tool will look up the attachment by filename.',
    inputSchema: {
      messageId: z.string().describe('Gmail message ID'),
      filename: z.string().describe('Filename to save as (also used to find attachment if attachmentId omitted)'),
      attachmentId: z.string().optional().describe('Attachment ID (from sq_read_email). If omitted, resolved by filename.'),
    },
  }, async ({ messageId, filename, attachmentId }) => {
    try {
      const { downloadAttachment, resolveAttachment } = await import('../../services/gmail.js');

      let resolvedAttachmentId = attachmentId;
      if (!resolvedAttachmentId) {
        const att = await resolveAttachment(messageId, filename);
        resolvedAttachmentId = att.attachmentId;
      }

      const filePath = await downloadAttachment(messageId, resolvedAttachmentId, filename);

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

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp-server/tools/gmail.ts src/mcp-server/__tests__/gmail-tools.test.ts
git commit -m "feat: restore sq_download_attachment and sq_setup_gmail tools"
```

---

### Task 4: Register Gmail tools in index.ts

**Files:**
- Modify: `src/mcp-server/index.ts`

**Step 1: Add import**

Add after the `registerPdfMenuTools` import (line 35):

```typescript
import { registerGmailTools } from './tools/gmail.js';
```

**Step 2: Add registration call**

Find where `registerPdfMenuTools(server)` is called and add after it:

```typescript
registerGmailTools(server);
```

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/mcp-server/index.ts
git commit -m "feat: register Gmail tools in MCP server"
```

---

### Task 5: Build and clean dist

**Step 1: Clean stale dist Gmail files**

Run: `rm -f dist/src/services/gmail.js dist/src/services/gmail.d.ts dist/src/services/gmail.js.map dist/src/services/gmail.d.ts.map dist/src/mcp-server/tools/gmail.js dist/src/mcp-server/tools/gmail.d.ts dist/src/mcp-server/tools/gmail.js.map dist/src/mcp-server/tools/gmail.d.ts.map dist/src/mcp-server/__tests__/gmail-tools.test.js dist/src/mcp-server/__tests__/gmail-tools.test.d.ts dist/src/mcp-server/__tests__/gmail-tools.test.js.map dist/src/mcp-server/__tests__/gmail-tools.test.d.ts.map`

**Step 2: Build**

Run: `npm run build`

Note: There are pre-existing TS errors in `content-save.ts`. If build fails, verify the new Gmail files compile correctly by checking that `dist/src/services/gmail.js` and `dist/src/mcp-server/tools/gmail.js` exist from a previous partial build, or use `npx tsc --noEmit src/services/gmail.ts src/mcp-server/tools/gmail.ts` to verify just our files.

**Step 3: Commit if needed**

```bash
git add -A
git commit -m "build: rebuild dist with Gmail tools"
```
