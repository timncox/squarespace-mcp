/**
 * MCP Tools — Announcement Bar
 *
 * sq_get_announcement_bar: Read announcement bar state (enabled, text, url)
 * sq_update_announcement_bar: Update or toggle announcement bar
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient } from '../session.js';

export function registerAnnouncementBarTools(server: McpServer) {
  // ── sq_get_announcement_bar ─────────────────────────────────────────────────
  server.registerTool('sq_get_announcement_bar', {
    description:
      'Read the announcement bar settings for a site. Returns enabled state, text content, optional click-through URL, and newWindow flag. ' +
      'Announcement bars are a paid feature (Business/Commerce plans).',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getSettings();

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to get settings'}` }],
          isError: true,
        };
      }

      const abs = result.data?.announcementBarSettings ?? {};

      // Normalize the raw API shape into a clean response
      const enabled = abs.style === 2;
      let text = '';
      if (abs.text?.html) {
        // Strip <p> wrapper tags
        text = abs.text.html.replace(/^<p>/, '').replace(/<\/p>$/, '');
      }
      const url = abs.clickthroughUrl?.url ?? '';
      const newWindow = abs.clickthroughUrl?.newWindow ?? false;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ enabled, text, url, newWindow }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_announcement_bar ──────────────────────────────────────────────
  server.registerTool('sq_update_announcement_bar', {
    description:
      'Update the announcement bar: toggle visibility, change text, set click-through URL. All params optional — only provided fields change. ' +
      'Text is plain text (HTML wrapping handled automatically). Set url to empty string to remove the link.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      enabled: z.boolean().optional().describe('Show (true) or hide (false) the announcement bar'),
      text: z.string().optional().describe('Plain text content for the announcement bar'),
      url: z.string().optional().describe('Click-through URL (empty string to remove)'),
      newWindow: z.boolean().optional().describe('Open link in new window (default: false)'),
    },
  }, async ({ siteId, enabled, text, url, newWindow }) => {
    try {
      const client = getClient(siteId);

      // Read current settings to merge
      const current = await client.getSettings();
      if (!current.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${current.error ?? 'Failed to read current settings'}` }],
          isError: true,
        };
      }

      const currentAbs = current.data?.announcementBarSettings ?? {};

      // Build merged announcement bar settings
      const merged: Record<string, any> = { ...currentAbs };

      if (enabled !== undefined) {
        merged.style = enabled ? 2 : 1;
      }

      if (text !== undefined) {
        merged.text = { html: `<p>${text}</p>`, raw: false };
      }

      if (url !== undefined) {
        if (url === '') {
          merged.clickthroughUrl = {};
        } else {
          merged.clickthroughUrl = {
            url,
            newWindow: newWindow ?? currentAbs.clickthroughUrl?.newWindow ?? false,
          };
        }
      } else if (newWindow !== undefined && merged.clickthroughUrl?.url) {
        merged.clickthroughUrl = { ...merged.clickthroughUrl, newWindow };
      }

      const result = await client.updateSettings({ announcementBarSettings: merged });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to update announcement bar'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }, null, 2),
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
