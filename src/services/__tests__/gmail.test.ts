import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock googleapis
const mockGet = vi.fn();
const mockAttachmentsGet = vi.fn();
const mockSetCredentials = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn(function (this: any) { this.setCredentials = mockSetCredentials; }),
    },
    gmail: vi.fn(function () {
      return {
        users: {
          messages: {
            get: mockGet,
            attachments: { get: mockAttachmentsGet },
          },
        },
      };
    }),
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
