/**
 * MCP Tools — PDF Menu Parsing (legacy)
 *
 * sq_parse_pdf_menu has been moved to menu.ts with enhanced capabilities
 * (URL download, AI-powered structuring). This module is kept for backward
 * compatibility but registers no tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPdfMenuTools(_server: McpServer) {
  // sq_parse_pdf_menu is now registered by registerMenuParserTools in menu.ts
}
