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
