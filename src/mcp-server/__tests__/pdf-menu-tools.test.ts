import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExtractPdfText = vi.fn();
const mockParseMenuText = vi.fn();

vi.mock('../../services/pdf-extractor.js', () => ({
  extractPdfText: (...args: any[]) => mockExtractPdfText(...args),
}));

vi.mock('../../services/menu-parser.js', () => ({
  parseMenuText: (...args: any[]) => mockParseMenuText(...args),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn((path: string) => {
      if (path === '/tmp/test-menu.pdf') return Buffer.from('fake-pdf-data');
      if (path === '/tmp/missing.pdf') throw new Error('ENOENT: no such file or directory');
      return actual.readFileSync(path);
    }),
    existsSync: vi.fn((path: string) => {
      if (path === '/tmp/test-menu.pdf') return true;
      if (path === '/tmp/missing.pdf') return false;
      return actual.existsSync(path);
    }),
  };
});

import { registerPdfMenuTools } from '../tools/pdf-menu.js';

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

describe('PDF Menu Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerPdfMenuTools(server as any);
  });

  it('should register sq_parse_pdf_menu tool', () => {
    expect(server.tools.has('sq_parse_pdf_menu')).toBe(true);
  });

  describe('sq_parse_pdf_menu', () => {
    it('should parse a PDF file and return structured menu JSON', async () => {
      mockExtractPdfText.mockResolvedValue({ text: 'Lunch\n========\nAppetizers\n-------\nSalad\nGarden salad\n$12', numPages: 1 });
      mockParseMenuText.mockReturnValue([{
        title: 'Lunch',
        description: null,
        sections: [{
          title: 'Appetizers',
          description: null,
          items: [{ title: 'Salad', description: 'Garden salad', variants: [{ price: '$12' }] }],
        }],
      }]);

      const result = await server.callTool('sq_parse_pdf_menu', { filePath: '/tmp/test-menu.pdf' });
      const data = JSON.parse(result.content[0].text);

      expect(data.parsed).toBe(true);
      expect(data.menus).toHaveLength(1);
      expect(data.menus[0].title).toBe('Lunch');
      expect(data.menus[0].sections[0].items[0].title).toBe('Salad');
      expect(data.numPages).toBe(1);
    });

    it('should return raw text when menu parsing fails', async () => {
      mockExtractPdfText.mockResolvedValue({ text: 'Some unstructured text from a PDF', numPages: 2 });
      mockParseMenuText.mockReturnValue([]);

      const result = await server.callTool('sq_parse_pdf_menu', { filePath: '/tmp/test-menu.pdf' });
      const data = JSON.parse(result.content[0].text);

      expect(data.parsed).toBe(false);
      expect(data.rawText).toBe('Some unstructured text from a PDF');
      expect(data.numPages).toBe(2);
    });

    it('should return error for missing file', async () => {
      const result = await server.callTool('sq_parse_pdf_menu', { filePath: '/tmp/missing.pdf' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not exist');
    });

    it('should return error when PDF extraction fails', async () => {
      mockExtractPdfText.mockRejectedValue(new Error('No text could be extracted from the PDF'));

      const result = await server.callTool('sq_parse_pdf_menu', { filePath: '/tmp/test-menu.pdf' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No text could be extracted');
    });
  });
});
