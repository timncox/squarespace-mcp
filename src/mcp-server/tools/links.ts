/**
 * MCP Tools — Link validation
 *
 * sq_validate_links: Validate all links on a page (HTTP, mailto, relative)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds, getSiteBaseUrl } from '../session.js';
import { extractAndValidateLinks } from '../../services/link-validator.js';

export function registerLinkTools(server: McpServer) {
  server.registerTool('sq_validate_links', {
    description:
      'Validate all links on a Squarespace page. Checks HTTP URLs (HEAD then GET), mailto addresses, and resolves relative URLs. Returns a summary with broken/ok/redirected counts and per-link details.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug (e.g. "home", "about", "menu")'),
    },
  }, async ({ siteId, pageSlug }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return {
          content: [{ type: 'text' as const, text: `Could not resolve page "${pageSlug}" on site "${siteId}"` }],
          isError: true,
        };
      }

      const client = getClient(siteId);
      const data = await client.getPageSections(ids.pageSectionsId);
      const sections = data.sections ?? [];

      const siteBaseUrl = getSiteBaseUrl(siteId);
      const summary = await extractAndValidateLinks(sections, { siteBaseUrl });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
