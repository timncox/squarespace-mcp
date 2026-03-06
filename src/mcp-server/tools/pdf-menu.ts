/**
 * MCP Tools — PDF Menu Parsing
 *
 * sq_parse_pdf_menu: Read a PDF file from disk, extract text, parse as menu
 */

import { readFileSync, existsSync } from 'fs';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPdfMenuTools(server: McpServer) {
  server.registerTool('sq_parse_pdf_menu', {
    description:
      'Read a PDF file from disk, extract its text, and attempt to parse it as a Squarespace menu. ' +
      'If parsing succeeds, returns structured MenuTab[] JSON ready for sq_update_menu. ' +
      'If parsing fails, returns the raw extracted text for manual formatting.',
    inputSchema: {
      filePath: z.string().describe('Absolute path to the PDF file on disk'),
    },
  }, async ({ filePath }) => {
    try {
      if (!existsSync(filePath)) {
        return {
          content: [{ type: 'text' as const, text: `Error: File does not exist: ${filePath}` }],
          isError: true,
        };
      }

      const buffer = readFileSync(filePath);
      const { extractPdfText } = await import('../../services/pdf-extractor.js');
      const { parseMenuText } = await import('../../services/menu-parser.js');

      const { text, numPages } = await extractPdfText(buffer);
      const menus = parseMenuText(text);

      if (menus.length > 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ parsed: true, menus, numPages }, null, 2) }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ parsed: false, rawText: text, numPages }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
