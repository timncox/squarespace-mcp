/**
 * MCP Tools — Block management
 *
 * sq_add_button: Add a button block to a section
 * sq_update_button: Update an existing button block
 * sq_add_image: Add an image block to a section
 * sq_update_image: Update image block metadata or asset
 * sq_upload_image: Upload an image file, returns assetUrl
 * sq_remove_block: Remove a block by search text
 * sq_move_block: Move a block in the grid
 * sq_resize_block: Resize a block in the grid
 * sq_swap_blocks: Swap positions of two blocks
 * sq_duplicate_block: Duplicate a block
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, getMediaClient, resolvePageIds } from '../session.js';

export function registerBlockTools(server: McpServer) {
  // ── sq_add_button ───────────────────────────────────────────────────────────
  server.registerTool('sq_add_button', {
    description:
      'Add a button block to a section on a Squarespace page.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the button to'),
      label: z.string().describe('Button label text'),
      url: z.string().describe('Button link URL'),
      design: z.object({
        size: z.enum(['small', 'medium', 'large']).optional(),
        style: z.enum(['primary', 'secondary', 'tertiary']).optional(),
        alignment: z.enum(['left', 'center', 'right']).optional(),
        variant: z.enum(['solid', 'outline']).optional(),
      }).optional().describe('Optional button design settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, label, url, design }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.addButtonBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, label, url, undefined, design);

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

  // ── sq_update_button ────────────────────────────────────────────────────────
  server.registerTool('sq_update_button', {
    description:
      'Update an existing button block on a Squarespace page. Finds the button by search text and updates label, URL, or design.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the button (matches label)'),
      label: z.string().optional().describe('New button label'),
      url: z.string().optional().describe('New button URL'),
      design: z.object({
        size: z.enum(['small', 'medium', 'large']).optional(),
        style: z.enum(['primary', 'secondary', 'tertiary']).optional(),
        alignment: z.enum(['left', 'center', 'right']).optional(),
        variant: z.enum(['solid', 'outline']).optional(),
      }).optional().describe('Optional button design updates'),
    },
  }, async ({ siteId, pageSlug, searchText, label, url, design }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const updates: Record<string, any> = {};
      if (label !== undefined) updates.newLabel = label;
      if (url !== undefined) updates.url = url;
      if (design) {
        if (design.size) updates.size = design.size;
        if (design.style) updates.style = design.style;
        if (design.alignment) updates.alignment = design.alignment;
        if (design.variant) updates.variant = design.variant;
      }
      const result = await client.updateButtonBlock(ids.pageSectionsId, ids.collectionId, searchText, updates);

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

  // ── sq_add_image ────────────────────────────────────────────────────────────
  server.registerTool('sq_add_image', {
    description:
      'Add an image block to a section on a Squarespace page. Use sq_upload_image first to get an assetUrl.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the image to'),
      assetUrl: z.string().describe('Squarespace asset URL (from sq_upload_image)'),
      altText: z.string().optional().describe('Image alt text for accessibility'),
      layout: z.object({
        columns: z.number().optional().describe('Number of grid columns to span'),
      }).optional().describe('Optional layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, assetUrl, altText, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const options: Record<string, any> = {};
      if (altText !== undefined) options.altText = altText;
      if (layout) options.layout = layout;
      const result = await client.addImageBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, assetUrl, Object.keys(options).length > 0 ? options : undefined);

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

  // ── sq_update_image ─────────────────────────────────────────────────────────
  server.registerTool('sq_update_image', {
    description:
      'Update an existing image block on a Squarespace page. Can change the asset URL, alt text, or title.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the image block (matches title, description, or alt text)'),
      assetUrl: z.string().optional().describe('New asset URL to replace the image'),
      altText: z.string().optional().describe('New alt text'),
      title: z.string().optional().describe('New image title'),
    },
  }, async ({ siteId, pageSlug, searchText, assetUrl, altText, title }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const fields: Record<string, any> = {};
      if (assetUrl !== undefined) fields.assetUrl = assetUrl;
      if (altText !== undefined) fields.altText = altText;
      if (title !== undefined) fields.title = title;
      const result = await client.updateImageBlock(ids.pageSectionsId, ids.collectionId, searchText, fields);

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

  // ── sq_upload_image ─────────────────────────────────────────────────────────
  server.registerTool('sq_upload_image', {
    description:
      'Upload an image file to the Squarespace media library. Returns an assetUrl that can be used with sq_add_image or sq_update_image. Does not require a page slug.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      imageUrl: z.string().describe('Path to the image file to upload'),
    },
  }, async ({ siteId, imageUrl }) => {
    try {
      const mediaClient = getMediaClient(siteId);
      const result = await mediaClient.uploadImage(imageUrl);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ assetUrl: result.assetUrl ?? null, ...result }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_remove_block ─────────────────────────────────────────────────────────
  server.registerTool('sq_remove_block', {
    description:
      'Remove a block from a Squarespace page by searching for its text content.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the block to remove'),
    },
  }, async ({ siteId, pageSlug, searchText }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.removeBlock(ids.pageSectionsId, ids.collectionId, searchText);

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

  // ── sq_move_block ───────────────────────────────────────────────────────────
  server.registerTool('sq_move_block', {
    description:
      'Move a block in the grid on a Squarespace page. Shifts the block in the specified direction by gridSteps.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the block to move'),
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction to move the block'),
      gridSteps: z.number().optional().describe('Number of grid steps to move (default: 1)'),
    },
  }, async ({ siteId, pageSlug, searchText, direction, gridSteps }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.moveBlock(ids.pageSectionsId, ids.collectionId, searchText, direction, gridSteps);

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

  // ── sq_resize_block ─────────────────────────────────────────────────────────
  server.registerTool('sq_resize_block', {
    description:
      'Resize a block in the grid on a Squarespace page. Desktop grid is 24 columns.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the block to resize'),
      width: z.enum(['smaller', 'larger', 'full']).optional().describe('Width adjustment'),
      height: z.enum(['shorter', 'taller']).optional().describe('Height adjustment'),
    },
  }, async ({ siteId, pageSlug, searchText, width, height }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.resizeBlock(ids.pageSectionsId, ids.collectionId, searchText, width, height);

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

  // ── sq_swap_blocks ──────────────────────────────────────────────────────────
  server.registerTool('sq_swap_blocks', {
    description:
      'Swap the positions of two blocks on a Squarespace page. Exchanges their full layout (desktop + mobile + zIndex).',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText1: z.string().describe('Text to find the first block'),
      searchText2: z.string().describe('Text to find the second block'),
    },
  }, async ({ siteId, pageSlug, searchText1, searchText2 }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.swapBlocks(ids.pageSectionsId, ids.collectionId, searchText1, searchText2);

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

  // ── sq_duplicate_block ──────────────────────────────────────────────────────
  server.registerTool('sq_duplicate_block', {
    description:
      'Duplicate a block on a Squarespace page. Creates a copy of the block in the same section.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the block to duplicate'),
    },
  }, async ({ siteId, pageSlug, searchText }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.duplicateBlock(ids.pageSectionsId, ids.collectionId, searchText);

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
}
