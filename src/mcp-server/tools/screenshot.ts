/**
 * MCP Tools — Screenshot
 *
 * sq_take_screenshot: Take a screenshot of a Squarespace page (requires browser session)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerScreenshotTools(server: McpServer) {
  server.registerTool('sq_take_screenshot', {
    description:
      'Take a screenshot of a Squarespace page. Returns base64 image data. Requires an active browser session.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().optional().describe('Page URL slug. Omit to screenshot the current page.'),
    },
  }, async ({ siteId, pageSlug }) => {
    try {
      // Screenshot requires a live Playwright browser session.
      // For now, return an informative placeholder. When the browser agent
      // integration is wired up, this will call takeScreenshot() from
      // src/utils/screenshot.ts with the active page instance.
      return {
        content: [{
          type: 'text' as const,
          text: 'Screenshot tool requires an active browser session. Use sq_read_page for text-based page inspection instead.',
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
