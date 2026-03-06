# Gmail Playwright Rewrite — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace googleapis-based Gmail tools with Playwright browser login + cookie-based attachment download.

**Architecture:** `sq_login_gmail` launches headful Chromium → user logs into Gmail → tool polls for `GMAIL_AT` cookie → saves session to `storage/auth/gmail-session.json`. `sq_download_attachment` loads saved cookies, fetches raw MIME message from Gmail web endpoint, parses MIME to extract attachment by filename, saves to disk.

**Tech Stack:** Playwright (already a dependency), native `fetch`, custom MIME parser (~50 lines).

---

### Task 1: Rewrite Gmail Service — Cookie Loading + MIME Parser

**Files:**
- Rewrite: `src/services/gmail.ts`
- Test: `src/services/__tests__/gmail.test.ts`

The service provides three functions: `loadGmailCookies()`, `fetchAndExtractAttachment()`, and `formatCookieHeader()`.

**Step 1: Write the failing tests**

Rewrite `src/services/__tests__/gmail.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  loadGmailCookies,
  formatCookieHeader,
  fetchAndExtractAttachment,
} from '../gmail.js';

// ── Test data ────────────────────────────────────────────────────────────────

const SAMPLE_SESSION = {
  cookies: [
    { name: 'GMAIL_AT', value: 'af-token-123', domain: '.mail.google.com', path: '/' },
    { name: 'SID', value: 'sid-abc', domain: '.google.com', path: '/' },
    { name: 'HSID', value: 'hsid-def', domain: '.google.com', path: '/' },
    { name: '__Secure-1PSID', value: 'psid-ghi', domain: '.google.com', path: '/' },
  ],
  origins: [],
};

// Minimal multipart MIME message with one text/plain body and one attachment
function buildMimeMessage(filename: string, contentBase64: string): string {
  const boundary = '----=_Part_123_456.789';
  return [
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    `Subject: Test email`,
    `From: sender@example.com`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    `Hello world`,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    contentBase64,
    `--${boundary}--`,
  ].join('\r\n');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Gmail Service (cookie-based)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadGmailCookies', () => {
    it('should load cookies from gmail-session.json', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_SESSION));

      const cookies = loadGmailCookies();
      expect(cookies).toEqual(SAMPLE_SESSION.cookies);
    });

    it('should throw when session file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => loadGmailCookies()).toThrow('Gmail session not found');
    });

    it('should throw when session has no cookies', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ cookies: [] }));
      expect(() => loadGmailCookies()).toThrow('Gmail session has no cookies');
    });
  });

  describe('formatCookieHeader', () => {
    it('should format cookies as semicolon-separated header string', () => {
      const header = formatCookieHeader(SAMPLE_SESSION.cookies as any);
      expect(header).toContain('GMAIL_AT=af-token-123');
      expect(header).toContain('SID=sid-abc');
      expect(header).toContain('; ');
    });
  });

  describe('fetchAndExtractAttachment', () => {
    it('should fetch raw MIME and extract attachment by filename', async () => {
      const pdfContent = Buffer.from('fake-pdf-bytes');
      const pdfBase64 = pdfContent.toString('base64');
      const mime = buildMimeMessage('menu.pdf', pdfBase64);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_SESSION));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mime),
      });

      const result = await fetchAndExtractAttachment('msg-abc123', 'menu.pdf');

      expect(result.buffer.toString()).toBe('fake-pdf-bytes');
      expect(result.filename).toBe('menu.pdf');
      expect(result.mimeType).toBe('application/pdf');
    });

    it('should match filename case-insensitively', async () => {
      const content = Buffer.from('data').toString('base64');
      const mime = buildMimeMessage('Menu.PDF', content);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_SESSION));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mime),
      });

      const result = await fetchAndExtractAttachment('msg-1', 'menu.pdf');
      expect(result.filename).toBe('Menu.PDF');
    });

    it('should throw when attachment not found in MIME', async () => {
      const content = Buffer.from('data').toString('base64');
      const mime = buildMimeMessage('other.pdf', content);

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_SESSION));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(mime),
      });

      await expect(fetchAndExtractAttachment('msg-1', 'missing.pdf'))
        .rejects.toThrow('No attachment named "missing.pdf"');
    });

    it('should throw on HTTP error (likely auth expired)', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_SESSION));
      mockFetch.mockResolvedValue({
        ok: false,
        status: 302,
        text: () => Promise.resolve('Redirect to login'),
      });

      await expect(fetchAndExtractAttachment('msg-1', 'file.pdf'))
        .rejects.toThrow('Gmail request failed (302)');
    });

    it('should include available filenames in error when attachment not found', async () => {
      const mime = buildMimeMessage('invoice.pdf', Buffer.from('x').toString('base64'));

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_SESSION));
      mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(mime) });

      await expect(fetchAndExtractAttachment('msg-1', 'missing.pdf'))
        .rejects.toThrow('Available: invoice.pdf');
    });

    it('should send cookies in request header', async () => {
      const mime = buildMimeMessage('f.pdf', Buffer.from('x').toString('base64'));

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_SESSION));
      mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(mime) });

      await fetchAndExtractAttachment('msg-1', 'f.pdf');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('msg-1'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Cookie: expect.stringContaining('GMAIL_AT=af-token-123'),
          }),
        }),
      );
    });

    it('should handle nested multipart MIME', async () => {
      const boundary1 = '----=_Outer_123';
      const boundary2 = '----=_Inner_456';
      const content = Buffer.from('nested-data').toString('base64');
      const mime = [
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary1}"`,
        ``,
        `--${boundary1}`,
        `Content-Type: multipart/alternative; boundary="${boundary2}"`,
        ``,
        `--${boundary2}`,
        `Content-Type: text/plain`,
        ``,
        `Body text`,
        `--${boundary2}--`,
        `--${boundary1}`,
        `Content-Type: application/octet-stream; name="data.bin"`,
        `Content-Disposition: attachment; filename="data.bin"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        content,
        `--${boundary1}--`,
      ].join('\r\n');

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(SAMPLE_SESSION));
      mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(mime) });

      const result = await fetchAndExtractAttachment('msg-1', 'data.bin');
      expect(result.buffer.toString()).toBe('nested-data');
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
 * Gmail service — cookie-based attachment download.
 * Uses saved Playwright session cookies to fetch raw MIME messages
 * from Gmail's web interface and extract attachments.
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const SESSION_PATH = join(PROJECT_ROOT, 'storage', 'auth', 'gmail-session.json');

export interface GmailCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  expires?: number;
}

interface MimeAttachment {
  filename: string;
  mimeType: string;
  encoding: string;
  body: string;
}

// ── Cookie management ────────────────────────────────────────────────────────

export function loadGmailCookies(): GmailCookie[] {
  if (!existsSync(SESSION_PATH)) {
    throw new Error(
      'Gmail session not found. Use sq_login_gmail to log into Gmail first.',
    );
  }

  const raw = readFileSync(SESSION_PATH, 'utf-8');
  const session = JSON.parse(raw);
  const cookies: GmailCookie[] = session.cookies ?? [];

  if (cookies.length === 0) {
    throw new Error('Gmail session has no cookies. Use sq_login_gmail to log in again.');
  }

  return cookies;
}

export function formatCookieHeader(cookies: GmailCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ── MIME parsing ─────────────────────────────────────────────────────────────

function parseMimeParts(body: string, boundary: string): MimeAttachment[] {
  const attachments: MimeAttachment[] = [];
  const parts = body.split(`--${boundary}`);

  for (const part of parts) {
    if (part.trim() === '' || part.trim() === '--') continue;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerSection = part.substring(0, headerEnd);
    const bodySection = part.substring(headerEnd + 4).trim();

    // Check for nested multipart
    const ctMatch = headerSection.match(/Content-Type:\s*multipart\/\S+;\s*boundary="?([^"\r\n]+)"?/i);
    if (ctMatch) {
      attachments.push(...parseMimeParts(part.substring(headerEnd + 4), ctMatch[1]));
      continue;
    }

    // Extract filename from Content-Disposition or Content-Type
    const cdMatch = headerSection.match(/filename="?([^"\r\n;]+)"?/i);
    if (!cdMatch) continue;

    const filename = cdMatch[1].trim();

    // Extract MIME type
    const mimeMatch = headerSection.match(/Content-Type:\s*([^\s;]+)/i);
    const mimeType = mimeMatch?.[1] ?? 'application/octet-stream';

    // Extract encoding
    const encMatch = headerSection.match(/Content-Transfer-Encoding:\s*(\S+)/i);
    const encoding = encMatch?.[1]?.toLowerCase() ?? '7bit';

    attachments.push({ filename, mimeType, encoding, body: bodySection });
  }

  return attachments;
}

// ── Attachment download ──────────────────────────────────────────────────────

export async function fetchAndExtractAttachment(
  messageId: string,
  targetFilename: string,
): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const cookies = loadGmailCookies();
  const cookieHeader = formatCookieHeader(cookies);

  // Fetch raw MIME message from Gmail web
  const url = `https://mail.google.com/mail/u/0/?ui=2&view=om&th=${messageId}`;
  const response = await fetch(url, {
    headers: {
      Cookie: cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    redirect: 'manual',
  });

  if (!response.ok) {
    const hint = response.status === 302 || response.status === 401
      ? ' Session may have expired — use sq_login_gmail to log in again.'
      : '';
    throw new Error(`Gmail request failed (${response.status}).${hint}`);
  }

  const rawMime = await response.text();

  // Extract boundary from top-level Content-Type
  const boundaryMatch = rawMime.match(/Content-Type:\s*multipart\/\S+;\s*boundary="?([^"\r\n]+)"?/i);
  if (!boundaryMatch) {
    throw new Error('Could not parse MIME message — no multipart boundary found.');
  }

  const attachments = parseMimeParts(rawMime, boundaryMatch[1]);

  // Find attachment by filename (case-insensitive)
  const match = attachments.find(
    (a) => a.filename.toLowerCase() === targetFilename.toLowerCase(),
  );

  if (!match) {
    const available = attachments.map((a) => a.filename).join(', ');
    throw new Error(
      `No attachment named "${targetFilename}" in message. Available: ${available || 'none'}`,
    );
  }

  // Decode body
  let buffer: Buffer;
  if (match.encoding === 'base64') {
    buffer = Buffer.from(match.body.replace(/\s/g, ''), 'base64');
  } else {
    buffer = Buffer.from(match.body, 'utf-8');
  }

  logger.info({ messageId, filename: match.filename, size: buffer.length }, 'Attachment extracted from MIME');

  return { buffer, filename: match.filename, mimeType: match.mimeType };
}

export async function downloadAttachment(messageId: string, filename: string): Promise<string> {
  const { buffer, filename: resolvedName } = await fetchAndExtractAttachment(messageId, filename);

  const uploadsDir = join(PROJECT_ROOT, 'storage', 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const timestamp = Date.now();
  const safeName = resolvedName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(uploadsDir, `${timestamp}-${safeName}`);

  writeFileSync(filePath, buffer);
  logger.info({ filePath, filename: resolvedName, size: buffer.length }, 'Attachment downloaded');

  return filePath;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/gmail.test.ts`
Expected: PASS — all 9 tests

**Step 5: Commit**

```bash
git add src/services/gmail.ts src/services/__tests__/gmail.test.ts
git commit -m "refactor: rewrite Gmail service to use cookies instead of googleapis"
```

---

### Task 2: Rewrite Gmail Tools — sq_login_gmail + sq_download_attachment

**Files:**
- Rewrite: `src/mcp-server/tools/gmail.ts`
- Test: `src/mcp-server/__tests__/gmail-tools.test.ts`

**Step 1: Write the failing tests**

Rewrite `src/mcp-server/__tests__/gmail-tools.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp-server/__tests__/gmail-tools.test.ts`
Expected: FAIL — current tools export different functions/tools

**Step 3: Write the implementation**

Rewrite `src/mcp-server/tools/gmail.ts`:

```typescript
/**
 * MCP Tools — Gmail browser login + attachment download
 *
 * sq_login_gmail: Launch Playwright browser for Gmail login, capture cookies
 * sq_download_attachment: Download email attachment using saved cookies
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SESSION_DIR = join(PROJECT_ROOT, 'storage', 'auth');
const SESSION_PATH = join(SESSION_DIR, 'gmail-session.json');

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

export function registerGmailTools(server: McpServer) {
  // ── sq_login_gmail ─────────────────────────────────────────────────────────
  server.registerTool('sq_login_gmail', {
    description:
      'Launch a browser window for Gmail login. The user logs in manually, ' +
      'and the tool automatically captures session cookies (including HTTP-only) ' +
      'once authentication is detected. No Google Cloud project or OAuth setup needed.',
    inputSchema: {
      timeoutMs: z.number().optional().describe(
        `Max milliseconds to wait for login (default ${DEFAULT_TIMEOUT_MS})`,
      ),
    },
  }, async ({ timeoutMs }) => {
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let browser: any = null;

    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: false });
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto('https://mail.google.com', { waitUntil: 'domcontentloaded' });

      // Poll for GMAIL_AT cookie — indicates successful Gmail login
      const cookies = await new Promise<any[]>((resolve, reject) => {
        const deadline = Date.now() + timeout;

        const poll = async () => {
          try {
            const allCookies = await context.cookies();
            const hasGmailAt = allCookies.some(
              (c: { name: string }) => c.name === 'GMAIL_AT',
            );

            if (hasGmailAt) {
              resolve(allCookies);
              return;
            }

            if (Date.now() >= deadline) {
              reject(new Error('timeout'));
              return;
            }

            setTimeout(poll, POLL_INTERVAL_MS);
          } catch (err) {
            reject(err);
          }
        };

        poll();
      });

      // Save session
      mkdirSync(SESSION_DIR, { recursive: true });

      if (existsSync(SESSION_PATH)) {
        copyFileSync(SESSION_PATH, SESSION_PATH + '.bak');
      }

      const storageState = { cookies, origins: [] };
      writeFileSync(SESSION_PATH, JSON.stringify(storageState, null, 2), 'utf-8');

      await browser.close();
      browser = null;

      const hasGmailAt = cookies.some((c: { name: string }) => c.name === 'GMAIL_AT');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status: 'saved',
          cookieCount: cookies.length,
          hasGmailAt,
          sessionPath: SESSION_PATH,
          message: `Gmail session saved with ${cookies.length} cookies. Attachment downloads are now ready.`,
        }, null, 2) }],
      };
    } catch (err) {
      if (browser) {
        try { await browser.close(); } catch { /* best effort */ }
      }

      const msg = err instanceof Error ? err.message : String(err);

      if (msg === 'timeout') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            status: 'timeout',
            message: `Login timed out after ${timeout}ms. Please try again and complete the Gmail login within the time limit.`,
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
      'Download an email attachment to disk using saved Gmail session cookies. ' +
      'Returns the local file path. Requires sq_login_gmail to have been run first.',
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
git commit -m "refactor: rewrite Gmail tools to use Playwright login + cookie-based download"
```

---

### Task 3: Remove googleapis dependency

**Files:**
- Modify: `package.json`

**Step 1: Remove the dependency**

Run: `npm uninstall googleapis`

**Step 2: Verify no remaining imports**

Run: `grep -r "googleapis\|google-auth-library" src/`
Expected: No matches (the gmail.ts rewrite in Task 1 removed the import)

**Step 3: Verify all tests pass**

Run: `npm test`
Expected: All ~1367 tests pass

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove googleapis dependency — Gmail now uses Playwright cookies"
```

---

### Task 4: Clean up .env references and CLAUDE.md

**Files:**
- Modify: `src/mcp-server/index.ts` (update INSTRUCTIONS if they mention Gmail OAuth)
- Check: `.env` or `.env.example` for GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN references

**Step 1: Check for stale Gmail OAuth references in instructions**

Run: `grep -n "GMAIL\|gmail.*oauth\|gmail.*setup\|sq_setup_gmail" src/mcp-server/index.ts`

If any found, update the INSTRUCTIONS string to reference `sq_login_gmail` instead.

**Step 2: Check for stale .env references**

Run: `grep -rn "GMAIL_CLIENT_ID\|GMAIL_CLIENT_SECRET\|GMAIL_REFRESH_TOKEN" src/`
Expected: No matches after Task 1 rewrite

**Step 3: Verify full test suite**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit (if any changes)**

```bash
git add -A
git commit -m "chore: clean up stale Gmail OAuth references"
```

---

### Task 5: Final verification

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile, no errors

**Step 3: Verify no googleapis references remain**

Run: `grep -r "googleapis" src/ package.json`
Expected: No matches
