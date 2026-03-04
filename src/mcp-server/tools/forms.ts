/**
 * MCP Tools — Form blocks
 *
 * sq_list_forms: List available forms on a site
 * sq_add_form_block: Add a form block to a section
 * sq_update_form_block: Update an existing form block
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds } from '../session.js';

export function registerFormTools(server: McpServer) {
  // ── sq_list_forms ───────────────────────────────────────────────────────────
  server.registerTool('sq_list_forms', {
    description:
      'List available forms on a Squarespace site. Call this first to discover formIds before using sq_add_form_block.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getAvailableForms();

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Unknown error'}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_add_form_block ─────────────────────────────────────────────────────
  server.registerTool('sq_add_form_block', {
    description:
      'Add a form block to a section on a Squarespace page. Call sq_list_forms first to get the formId.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the form to'),
      formId: z.string().describe('Form ID (from sq_list_forms)'),
      buttonVariant: z.enum(['primary', 'secondary', 'tertiary']).optional().describe('Submit button style variant'),
      buttonAlignment: z.enum(['left', 'center', 'right']).optional().describe('Submit button alignment'),
      useLightbox: z.boolean().optional().describe('Display form in a lightbox overlay'),
      columns: z.number().optional().describe('Grid columns to span (default: 12)'),
      rowHeight: z.number().optional().describe('Rows tall'),
      offsetColumns: z.number().optional().describe('Push block right by N columns (e.g. 12 = right half)'),
      gapRows: z.number().optional().describe('Gap rows before block'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, formId, buttonVariant, buttonAlignment, useLightbox, columns, rowHeight, offsetColumns, gapRows }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      // Build options
      const options: Record<string, any> = {};
      if (buttonVariant !== undefined) options.buttonVariant = buttonVariant;
      if (buttonAlignment !== undefined) options.buttonAlignment = buttonAlignment;
      if (useLightbox !== undefined) options.useLightbox = useLightbox;

      // Build layout with offsetColumns resolution
      const layout: Record<string, any> = {};
      if (columns !== undefined) layout.columns = columns;
      if (rowHeight !== undefined) layout.rowHeight = rowHeight;
      if (gapRows !== undefined) layout.gapRows = gapRows;
      if (offsetColumns != null && layout.startX == null) {
        layout.startX = offsetColumns + 1;
        layout.endX = layout.startX + (columns ?? 12);
      }

      const result = await client.addFormBlock(
        ids.pageSectionsId,
        ids.collectionId,
        sectionIndex,
        formId,
        Object.keys(options).length > 0 ? options : undefined,
        Object.keys(layout).length > 0 ? layout : undefined,
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(result.success ? {} : { isError: true }),
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_form_block ──────────────────────────────────────────────────
  server.registerTool('sq_update_form_block', {
    description:
      'Update an existing form block on a Squarespace page. Finds the form block by formId or text content.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Form ID or text to find the form block'),
      buttonVariant: z.enum(['primary', 'secondary', 'tertiary']).optional().describe('New submit button style variant'),
      buttonAlignment: z.enum(['left', 'center', 'right']).optional().describe('New submit button alignment'),
      useLightbox: z.boolean().optional().describe('Display form in a lightbox overlay'),
    },
  }, async ({ siteId, pageSlug, searchText, buttonVariant, buttonAlignment, useLightbox }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      const updates: Record<string, any> = {};
      if (buttonVariant !== undefined) updates.buttonVariant = buttonVariant;
      if (buttonAlignment !== undefined) updates.buttonAlignment = buttonAlignment;
      if (useLightbox !== undefined) updates.useLightbox = useLightbox;

      const result = await client.updateFormBlock(ids.pageSectionsId, ids.collectionId, searchText, updates);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(result.success ? {} : { isError: true }),
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
