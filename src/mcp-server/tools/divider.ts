import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, resolvePageIds } from '../session.js';

const DIVIDER_TYPES = ['none', 'rounded', 'soft-corners', 'slanted', 'scalloped', 'wavy', 'jagged', 'pointed'] as const;
const STROKE_STYLES = ['none', 'solid', 'dashed'] as const;

export function registerDividerTools(server: McpServer) {
  // ── sq_update_section_divider ───────────────────────────────────────────
  server.registerTool('sq_update_section_divider', {
    description: 'Enable or update a decorative divider on the bottom edge of a section. Dividers are visual separators between sections (e.g. wavy lines, jagged edges, scalloped curves). Set type to choose the shape, and optionally configure width, height, flip, and stroke.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      pageSlug: z.string().describe('Page URL slug (e.g. "home", "about")'),
      sectionIndex: z.number().describe('0-based section index'),
      type: z.enum(DIVIDER_TYPES).optional().describe('Divider shape: none, rounded, soft-corners, slanted, scalloped, wavy, jagged, pointed'),
      width: z.number().optional().describe('Width in vw units (e.g. 5=small, 50=medium, 100=full width)'),
      height: z.number().optional().describe('Height in vw units (e.g. 2=small, 4=medium, 6=large)'),
      flipX: z.boolean().optional().describe('Flip horizontally'),
      flipY: z.boolean().optional().describe('Flip vertically'),
      offset: z.number().optional().describe('Vertical offset in px'),
      strokeStyle: z.enum(STROKE_STYLES).optional().describe('Stroke style: none, solid, dashed'),
      strokeThickness: z.number().optional().describe('Stroke thickness in px (e.g. 5=small, 10=medium, 15=large)'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, type, width, height, flipX, flipY, offset, strokeStyle, strokeThickness }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return {
          content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }],
          isError: true,
        };
      }

      // Build divider config from provided params
      const dividerConfig: Record<string, unknown> = { enabled: true };
      if (type !== undefined) dividerConfig.type = type;
      if (width !== undefined) dividerConfig.width = { value: width, unit: 'vw' };
      if (height !== undefined) dividerConfig.height = { value: height, unit: 'vw' };
      if (flipX !== undefined) dividerConfig.isFlipX = flipX;
      if (flipY !== undefined) dividerConfig.isFlipY = flipY;
      if (offset !== undefined) dividerConfig.offset = { value: offset, unit: 'px' };
      if (strokeStyle !== undefined || strokeThickness !== undefined) {
        const stroke: Record<string, unknown> = {};
        if (strokeStyle !== undefined) stroke.style = strokeStyle;
        if (strokeThickness !== undefined) stroke.thickness = { value: strokeThickness, unit: 'px' };
        stroke.color = { type: 'THEME_COLOR' };
        dividerConfig.stroke = stroke;
      }

      const client = getClient(siteId);
      const result = await client.updateSectionDivider(
        ids.pageSectionsId, ids.collectionId, sectionIndex, dividerConfig,
      );

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to update divider'}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          sectionId: result.sectionId ?? null,
          sectionIndex,
          dividerConfig,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_remove_section_divider ───────────────────────────────────────────
  server.registerTool('sq_remove_section_divider', {
    description: 'Remove (disable) a decorative divider from a section.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      pageSlug: z.string().describe('Page URL slug (e.g. "home", "about")'),
      sectionIndex: z.number().describe('0-based section index'),
    },
  }, async ({ siteId, pageSlug, sectionIndex }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return {
          content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }],
          isError: true,
        };
      }

      const client = getClient(siteId);
      const result = await client.removeSectionDivider(
        ids.pageSectionsId, ids.collectionId, sectionIndex,
      );

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to remove divider'}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          sectionId: result.sectionId ?? null,
          sectionIndex,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
