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
