/**
 * Squarespace MCP Server Entry Point
 *
 * Exposes Squarespace editing capabilities as MCP tools for autonomous
 * Claude CLI agents. Uses stdio transport for JSON-RPC communication.
 *
 * CRITICAL: Never use console.log — it corrupts JSON-RPC on stdout.
 * Use console.error for any debugging output.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTextTools } from './tools/text.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { registerSectionTools } from './tools/section.js';
import { registerBlockTools } from './tools/blocks.js';
import { registerPageTools } from './tools/pages.js';
import { registerSiteTools } from './tools/site.js';
import { registerContentTools } from './tools/content.js';

const server = new McpServer({
  name: 'squarespace',
  version: '1.0.0',
});

registerTextTools(server);
registerScreenshotTools(server);
registerSectionTools(server);
registerBlockTools(server);
registerPageTools(server);
registerSiteTools(server);
registerContentTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Squarespace MCP server started');
