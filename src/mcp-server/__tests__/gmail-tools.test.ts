import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock service dependencies ────────────────────────────────────────────────

const mockFetchMessage = vi.fn();
const mockDownloadAttachment = vi.fn();
const mockListInboxMessages = vi.fn();
const mockResolveAttachment = vi.fn();

vi.mock('../../services/gmail.js', () => ({
  fetchMessage: (...args: any[]) => mockFetchMessage(...args),
  downloadAttachment: (...args: any[]) => mockDownloadAttachment(...args),
  listInboxMessages: (...args: any[]) => mockListInboxMessages(...args),
  resolveAttachment: (...args: any[]) => mockResolveAttachment(...args),
}));

const mockProcessEmail = vi.fn();

vi.mock('../../services/email-processor.js', () => ({
  processEmail: (...args: any[]) => mockProcessEmail(...args),
}));

const mockExtractPdfText = vi.fn();

vi.mock('../../services/pdf-extractor.js', () => ({
  extractPdfText: (...args: any[]) => mockExtractPdfText(...args),
}));

const mockParseMenuText = vi.fn();

vi.mock('../../services/menu-parser.js', () => ({
  parseMenuText: (...args: any[]) => mockParseMenuText(...args),
}));

const mockListEmails = vi.fn();

vi.mock('../../db/emails.js', () => ({
  listEmails: (...args: any[]) => mockListEmails(...args),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => Buffer.from('fake-pdf-content')),
  };
});

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

describe('Gmail Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerGmailTools(server as any);
  });

  it('should register all 7 gmail tools', () => {
    expect(server.tools.has('sq_setup_gmail')).toBe(true);
    expect(server.tools.has('sq_list_emails')).toBe(true);
    expect(server.tools.has('sq_read_email')).toBe(true);
    expect(server.tools.has('sq_process_email')).toBe(true);
    expect(server.tools.has('sq_download_attachment')).toBe(true);
    expect(server.tools.has('sq_list_processed_emails')).toBe(true);
    expect(server.tools.has('sq_parse_pdf_menu')).toBe(true);
  });

  // ── sq_list_emails ────────────────────────────────────────────────────────

  describe('sq_list_emails', () => {
    it('should list inbox emails with summaries', async () => {
      mockListInboxMessages.mockResolvedValue([
        {
          id: 'msg-1',
          threadId: 'thread-1',
          from: 'client@example.com',
          fromName: 'Client',
          subject: 'New dinner menu',
          date: '2026-03-04T10:00:00Z',
          bodyText: 'Here is the updated menu',
          bodyHtml: '',
          attachments: [
            { filename: 'dinner.pdf', mimeType: 'application/pdf', size: 12345, attachmentId: 'att-1', messageId: 'msg-1' },
          ],
        },
      ]);

      const result = await server.callTool('sq_list_emails', {});

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('msg-1');
      expect(data[0].subject).toBe('New dinner menu');
      expect(data[0].attachmentCount).toBe(1);
      expect(data[0].attachments[0].filename).toBe('dinner.pdf');
      // Should not include body text in list view
      expect(data[0].bodyText).toBeUndefined();
      expect(mockListInboxMessages).toHaveBeenCalledWith({ query: undefined, maxResults: undefined });
    });

    it('should pass query and limit params', async () => {
      mockListInboxMessages.mockResolvedValue([]);

      await server.callTool('sq_list_emails', { query: 'from:chef@restaurant.com', limit: 5 });

      expect(mockListInboxMessages).toHaveBeenCalledWith({ query: 'from:chef@restaurant.com', maxResults: 5 });
    });

    it('should return empty array when no messages', async () => {
      mockListInboxMessages.mockResolvedValue([]);

      const result = await server.callTool('sq_list_emails', {});

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toEqual([]);
    });

    it('should return error on failure', async () => {
      mockListInboxMessages.mockRejectedValue(new Error('Gmail API not configured'));

      const result = await server.callTool('sq_list_emails', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Gmail API not configured');
    });
  });

  // ── sq_read_email ─────────────────────────────────────────────────────────

  describe('sq_read_email', () => {
    it('should return full email with attachmentIds', async () => {
      mockFetchMessage.mockResolvedValue({
        id: 'msg-1',
        threadId: 'thread-1',
        from: 'client@example.com',
        fromName: 'Client',
        subject: 'Menu update',
        date: '2026-03-04T10:00:00Z',
        bodyText: 'Please update the dinner menu',
        bodyHtml: '<p>Please update the dinner menu</p>',
        attachments: [
          { filename: 'dinner.pdf', mimeType: 'application/pdf', size: 12345, attachmentId: 'ANGjdJ-real-token', messageId: 'msg-1' },
        ],
      });

      const result = await server.callTool('sq_read_email', { messageId: 'msg-1' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBe('msg-1');
      expect(data.bodyText).toBe('Please update the dinner menu');
      expect(data.attachments[0].attachmentId).toBe('ANGjdJ-real-token');
      expect(mockFetchMessage).toHaveBeenCalledWith('msg-1');
    });

    it('should return error when message not found', async () => {
      mockFetchMessage.mockResolvedValue(null);

      const result = await server.callTool('sq_read_email', { messageId: 'bad-id' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Email with messageId bad-id not found');
    });

    it('should return error on API failure', async () => {
      mockFetchMessage.mockRejectedValue(new Error('Token expired'));

      const result = await server.callTool('sq_read_email', { messageId: 'msg-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Token expired');
    });
  });

  // ── sq_process_email ──────────────────────────────────────────────────────

  describe('sq_process_email', () => {
    it('should process email and return extraction result', async () => {
      const mockMessage = {
        id: 'msg-1',
        threadId: 'thread-1',
        from: 'client@example.com',
        subject: 'Update homepage text',
        date: '2026-03-04T10:00:00Z',
        bodyText: 'Change the heading to "Welcome"',
        bodyHtml: '<p>Change the heading to "Welcome"</p>',
        attachments: [],
      };
      mockFetchMessage.mockResolvedValue(mockMessage);
      mockProcessEmail.mockResolvedValue({
        emailId: 'stored-1',
        subject: 'Update homepage text',
        from: 'client@example.com',
        tasks: [{ id: 'task-1', description: 'Update heading' }],
        reasoning: 'Client wants heading changed',
      });

      const result = await server.callTool('sq_process_email', { messageId: 'msg-1' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.emailId).toBe('stored-1');
      expect(data.tasks).toHaveLength(1);
      expect(mockFetchMessage).toHaveBeenCalledWith('msg-1');
      expect(mockProcessEmail).toHaveBeenCalledWith(mockMessage);
    });

    it('should return error when message not found', async () => {
      mockFetchMessage.mockResolvedValue(null);

      const result = await server.callTool('sq_process_email', { messageId: 'bad-id' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Email with messageId bad-id not found');
    });

    it('should return error on processing failure', async () => {
      mockFetchMessage.mockResolvedValue({ id: 'msg-1', attachments: [] });
      mockProcessEmail.mockRejectedValue(new Error('Claude API rate limited'));

      const result = await server.callTool('sq_process_email', { messageId: 'msg-1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Claude API rate limited');
    });
  });

  // ── sq_download_attachment ────────────────────────────────────────────────

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
      expect(data.filename).toBe('menu.pdf');
      expect(mockDownloadAttachment).toHaveBeenCalledWith('msg-1', 'att-1', 'menu.pdf');
      expect(mockResolveAttachment).not.toHaveBeenCalled();
    });

    it('should resolve attachmentId by filename when not provided', async () => {
      mockResolveAttachment.mockResolvedValue({
        filename: 'dinner.pdf',
        attachmentId: 'resolved-att-id',
        mimeType: 'application/pdf',
        size: 12345,
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

    it('should return error when attachment not found by filename', async () => {
      mockResolveAttachment.mockRejectedValue(
        new Error('No attachment named "missing.pdf" in message. Available: menu.pdf'),
      );

      const result = await server.callTool('sq_download_attachment', {
        messageId: 'msg-1',
        filename: 'missing.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No attachment named "missing.pdf"');
      expect(result.content[0].text).toContain('Available: menu.pdf');
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

  // ── sq_list_processed_emails ──────────────────────────────────────────────

  describe('sq_list_processed_emails', () => {
    it('should list stored emails with defaults', async () => {
      mockListEmails.mockReturnValue([
        { id: 'e1', subject: 'Menu update', fromAddress: 'a@b.com', receivedAt: '2026-03-04', processedAt: '2026-03-04' },
        { id: 'e2', subject: 'New photos', fromAddress: 'c@d.com', receivedAt: '2026-03-03', processedAt: null },
      ]);

      const result = await server.callTool('sq_list_processed_emails', {});

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.emails).toHaveLength(2);
      expect(data.total).toBe(2);
      expect(mockListEmails).toHaveBeenCalledWith({ limit: 20, status: 'all' });
    });

    it('should pass limit and status params', async () => {
      mockListEmails.mockReturnValue([]);

      await server.callTool('sq_list_processed_emails', { limit: 5, status: 'processed' });

      expect(mockListEmails).toHaveBeenCalledWith({ limit: 5, status: 'processed' });
    });

    it('should return error on thrown exception', async () => {
      mockListEmails.mockImplementation(() => { throw new Error('Database locked'); });

      const result = await server.callTool('sq_list_processed_emails', {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Database locked');
    });
  });

  // ── sq_parse_pdf_menu ─────────────────────────────────────────────────────

  describe('sq_parse_pdf_menu', () => {
    it('should parse PDF into structured menus when parsing succeeds', async () => {
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/menu.pdf');
      mockExtractPdfText.mockResolvedValue({ text: 'Drinks\n========\nCocktails\n-------\nMojito $12', numPages: 2 });
      mockParseMenuText.mockReturnValue([
        { title: 'Drinks', sections: [{ title: 'Cocktails', items: [{ title: 'Mojito', price: '$12' }] }] },
      ]);

      const result = await server.callTool('sq_parse_pdf_menu', {
        messageId: 'msg-1',
        attachmentId: 'att-1',
        filename: 'menu.pdf',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.parsed).toBe(true);
      expect(data.menus).toHaveLength(1);
      expect(data.menus[0].title).toBe('Drinks');
      expect(data.numPages).toBe(2);
    });

    it('should resolve attachmentId by filename when not provided', async () => {
      mockResolveAttachment.mockResolvedValue({
        filename: 'menu.pdf',
        attachmentId: 'resolved-att-id',
        mimeType: 'application/pdf',
        size: 12345,
        messageId: 'msg-1',
      });
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/menu.pdf');
      mockExtractPdfText.mockResolvedValue({ text: 'Lunch\n========\nSalads\n-------\nCaesar $14', numPages: 1 });
      mockParseMenuText.mockReturnValue([
        { title: 'Lunch', sections: [{ title: 'Salads', items: [{ title: 'Caesar', price: '$14' }] }] },
      ]);

      const result = await server.callTool('sq_parse_pdf_menu', {
        messageId: 'msg-1',
        filename: 'menu.pdf',
      });

      expect(result.isError).toBeUndefined();
      expect(mockResolveAttachment).toHaveBeenCalledWith('msg-1', 'menu.pdf');
      expect(mockDownloadAttachment).toHaveBeenCalledWith('msg-1', 'resolved-att-id', 'menu.pdf');
    });

    it('should return raw text when parsing finds no menus', async () => {
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/invoice.pdf');
      mockExtractPdfText.mockResolvedValue({ text: 'Invoice #1234\nTotal: $500', numPages: 1 });
      mockParseMenuText.mockReturnValue([]);

      const result = await server.callTool('sq_parse_pdf_menu', {
        messageId: 'msg-1',
        attachmentId: 'att-2',
        filename: 'invoice.pdf',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.parsed).toBe(false);
      expect(data.rawText).toContain('Invoice #1234');
      expect(data.numPages).toBe(1);
    });

    it('should return error on PDF extraction failure', async () => {
      mockDownloadAttachment.mockResolvedValue('/storage/uploads/scan.pdf');
      mockExtractPdfText.mockRejectedValue(new Error('No text could be extracted from the PDF'));

      const result = await server.callTool('sq_parse_pdf_menu', {
        messageId: 'msg-1',
        attachmentId: 'att-3',
        filename: 'scan.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No text could be extracted');
    });

    it('should return error on download failure', async () => {
      mockDownloadAttachment.mockRejectedValue(new Error('Attachment expired'));

      const result = await server.callTool('sq_parse_pdf_menu', {
        messageId: 'msg-1',
        attachmentId: 'att-4',
        filename: 'menu.pdf',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Attachment expired');
    });
  });
});
