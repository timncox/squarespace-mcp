import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSiteBaseUrl } from '../session.js';
import { listWaybackSnapshots, fetchWaybackContent } from '../../services/wayback.js';

export function registerWaybackTools(server: McpServer) {
  server.registerTool('sq_wayback_snapshots', {
    description:
      'List archived versions of a page from the Wayback Machine. Returns timestamps that can be used with sq_wayback_fetch to retrieve content.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page slug, e.g. "about" or "" for homepage'),
      limit: z.number().optional().default(20).describe('Max snapshots to return'),
    },
  }, async ({ siteId, pageSlug, limit }) => {
    try {
      const baseUrl = getSiteBaseUrl(siteId);
      const pageUrl = `${baseUrl}/${pageSlug}`.replace(/\/+$/, '');
      const snapshots = await listWaybackSnapshots(pageUrl, { limit });

      if (snapshots.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No Wayback Machine snapshots found for ${pageUrl}` }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            pageUrl,
            snapshotCount: snapshots.length,
            snapshots,
            hint: 'Use sq_wayback_fetch with a timestamp to retrieve page content for reconstruction.',
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  server.registerTool('sq_wayback_fetch', {
    description:
      'Fetch and extract structured content from an archived Wayback Machine page. Returns headings, paragraphs, images, and links organized by section.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page slug, e.g. "about" or "" for homepage'),
      timestamp: z.string().describe('Wayback timestamp from sq_wayback_snapshots'),
    },
  }, async ({ siteId, pageSlug, timestamp }) => {
    try {
      const baseUrl = getSiteBaseUrl(siteId);
      const pageUrl = `${baseUrl}/${pageSlug}`.replace(/\/+$/, '');
      const content = await fetchWaybackContent(pageUrl, timestamp);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...content,
            reconstructionGuide: {
              steps: [
                'Use sq_add_section to create a section for each extracted section.',
                'Use sq_add_text or sq_update_text to add headings and paragraphs.',
                'Use sq_add_image to add images (original URLs may need re-uploading via sq_upload_image).',
                'Use sq_add_button for important links/CTAs.',
                'Review the extracted content — Wayback HTML parsing may miss dynamic or JS-rendered content.',
              ],
            },
          }, null, 2),
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
