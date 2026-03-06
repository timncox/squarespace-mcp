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
 * sq_add_video: Add a video block (YouTube, Vimeo, etc.)
 * sq_update_video: Update an existing video block
 * sq_add_embed: Add a raw HTML embed block
 * sq_update_embed: Update an existing embed block
 * sq_add_quote: Add a quote/testimonial block
 * sq_update_quote: Update a quote block
 * sq_add_marquee: Add a scrolling text marquee block
 * sq_update_marquee: Update a marquee block
 * sq_add_newsletter: Add a newsletter/email signup block
 * sq_update_newsletter: Update a newsletter block
 * sq_add_divider: Add a line/space divider block
 * sq_add_code: Add a code/HTML block
 * sq_update_code: Update a code block
 * sq_add_social_links_block: Add a social links display block
 * sq_update_social_links_block: Update social links block display options
 */

import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
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
      'Upload an image to the Squarespace media library. Accepts a local Mac file path, HTTP/HTTPS URL, or base64-encoded image data (via imageData param). ' +
      'Returns an assetUrl + assetId for use with sq_add_image, sq_update_image, or sq_attach_product_image.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      imageUrl: z.string().optional().describe('Local file path OR http/https URL of the image to upload'),
      imageData: z.string().optional().describe('Base64-encoded image data. Use this when the image is in a cloud path (/mnt/user-data/) that the MCP server cannot access.'),
      filename: z.string().optional().describe('Filename for the image when using imageData (e.g., "photo.jpg")'),
    },
  }, async ({ siteId, imageUrl, imageData, filename }) => {
    try {
      // Validate: need either imageUrl or imageData
      if (!imageUrl && !imageData) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Either imageUrl or imageData is required' }],
          isError: true,
        };
      }

      // Detect cloud container paths — direct the caller to use imageData instead
      if (imageUrl && (imageUrl.startsWith('/mnt/') || imageUrl.startsWith('/tmp/user-data') || imageUrl.startsWith('/home/user/'))) {
        return {
          content: [{ type: 'text' as const, text:
            `CLOUD_PATH_DETECTED: The file at this path is in your cloud environment and inaccessible to the MCP server. ` +
            `To fix this: read the file using your file reading tools, base64 encode it, then call sq_upload_image again with the imageData parameter (base64 string) and filename parameter instead of imageUrl.`
          }],
          isError: true,
        };
      }

      const mediaClient = getMediaClient(siteId);

      // Handle base64 image data: decode → temp file → upload → cleanup
      if (imageData) {
        const tempName = filename || `upload-${Date.now()}.jpg`;
        const tempPath = path.join(os.tmpdir(), tempName);
        try {
          await writeFile(tempPath, Buffer.from(imageData, 'base64'));
          const result = await mediaClient.uploadImage(tempPath);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ assetUrl: result.assetUrl ?? null, ...result }, null, 2) }],
          };
        } finally {
          await unlink(tempPath).catch(() => {});
        }
      }

      // Handle URL or local path
      const isUrl = imageUrl!.startsWith('http://') || imageUrl!.startsWith('https://');
      const result = isUrl
        ? await mediaClient.uploadImageFromUrl(imageUrl!)
        : await mediaClient.uploadImage(imageUrl!);

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

  // ── sq_upload_images (batch) ─────────────────────────────────────────────────
  server.registerTool('sq_upload_images', {
    description:
      'Upload multiple images in parallel. Accepts local Mac paths, HTTP/HTTPS URLs, and/or base64 data objects. ' +
      'For /mnt/user-data/ paths, read the files and pass as base64 data objects instead. ' +
      'Returns an array of results (assetUrl + assetId) in the same order as the input.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      images: z.array(z.union([
        z.string().describe('Local file path or HTTP/HTTPS URL'),
        z.object({
          data: z.string().describe('Base64-encoded image data'),
          filename: z.string().describe('Filename for the image'),
        }),
      ])).describe('Array of image sources — file paths, URLs, or base64 data objects'),
    },
  }, async ({ siteId, images }) => {
    try {
      // Detect cloud container paths before attempting uploads
      const cloudPaths = images.filter(img =>
        typeof img === 'string' && (img.startsWith('/mnt/') || img.startsWith('/tmp/user-data') || img.startsWith('/home/user/'))
      );
      if (cloudPaths.length > 0) {
        return {
          content: [{ type: 'text' as const, text:
            `CLOUD_PATH_DETECTED: ${cloudPaths.length} path(s) are in your cloud environment and inaccessible to the MCP server. ` +
            `To fix this: read each file using your file reading tools, base64 encode them, then call sq_upload_images again ` +
            `with base64 data objects ({data: "base64...", filename: "name.jpg"}) instead of the cloud paths.`
          }],
          isError: true,
        };
      }

      const mediaClient = getMediaClient(siteId);

      // Build upload jobs for each item
      const allResults: { idx: number; promise: Promise<any>; tempPath?: string }[] = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (typeof img === 'object' && img.data) {
          // Base64 data object: decode → temp file → upload
          const tempName = img.filename || `upload-${Date.now()}-${i}.jpg`;
          const tempPath = path.join(os.tmpdir(), tempName);
          const p = (async () => {
            await writeFile(tempPath, Buffer.from(img.data, 'base64'));
            return mediaClient.uploadImage(tempPath);
          })().catch(e => ({ error: e instanceof Error ? e.message : String(e) }));
          allResults.push({ idx: i, promise: p, tempPath });
        } else if (typeof img === 'string') {
          if (img.startsWith('http://') || img.startsWith('https://')) {
            allResults.push({ idx: i, promise: mediaClient.uploadImageFromUrl(img).catch(e => ({ error: e instanceof Error ? e.message : String(e) })) });
          } else {
            allResults.push({ idx: i, promise: mediaClient.uploadImage(img).catch(e => ({ error: e instanceof Error ? e.message : String(e) })) });
          }
        }
      }

      const settled = await Promise.all(allResults.map(async r => ({ idx: r.idx, result: await r.promise, tempPath: r.tempPath })));

      // Clean up temp files
      for (const s of settled) {
        if (s.tempPath) await unlink(s.tempPath).catch(() => {});
      }

      settled.sort((a, b) => a.idx - b.idx);

      const output = settled.map(s => {
        const source = typeof images[s.idx] === 'string' ? images[s.idx] : (images[s.idx] as any).filename;
        if (s.result?.error) return { source, success: false, error: s.result.error };
        return { source, success: true, assetUrl: s.result.assetUrl ?? null, assetId: s.result.assetId ?? null };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
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

  // ── sq_add_video ──────────────────────────────────────────────────────────
  server.registerTool('sq_add_video', {
    description:
      'Add a video block (YouTube, Vimeo, etc.) to a section on a Squarespace page. Default: full-width (24 cols), 8 rows tall.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the video to'),
      videoUrl: z.string().describe('Video URL (YouTube, Vimeo, etc.)'),
      title: z.string().optional().describe('Optional video title'),
      description: z.string().optional().describe('Optional video description'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 24)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns (e.g. 12 = right half)'),
        rowHeight: z.number().optional().describe('Rows tall (default: 8)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, videoUrl, title, description, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      // Resolve offsetColumns to startX/endX, then strip convenience keys
      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 24);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      const options: Record<string, any> = {};
      if (title !== undefined) options.title = title;
      if (description !== undefined) options.description = description;
      if (resolvedLayout) options.layout = resolvedLayout;
      const result = await client.addVideoBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, videoUrl, Object.keys(options).length > 0 ? options : undefined);

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

  // ── sq_update_video ───────────────────────────────────────────────────────
  server.registerTool('sq_update_video', {
    description:
      'Update an existing video block on a Squarespace page. Finds the video by search text (matches URL, title, or description) and updates fields.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the video block (matches URL, title, or description)'),
      videoUrl: z.string().optional().describe('New video URL'),
      title: z.string().optional().describe('New video title'),
      description: z.string().optional().describe('New video description'),
    },
  }, async ({ siteId, pageSlug, searchText, videoUrl, title, description }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const updates: Record<string, any> = {};
      if (videoUrl !== undefined) updates.url = videoUrl;
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      const result = await client.updateVideoBlock(ids.pageSectionsId, ids.collectionId, searchText, updates);

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

  // ── sq_add_embed ──────────────────────────────────────────────────────────
  server.registerTool('sq_add_embed', {
    description:
      'Add a raw HTML embed block to a section on a Squarespace page. Use for iframes, Google Maps, Calendly, custom scripts, etc. Default: 12 cols wide, 6 rows tall.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the embed to'),
      html: z.string().optional().describe('Raw HTML embed code (iframe, script, etc.) — blank placeholder if omitted'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 12)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns (e.g. 12 = right half)'),
        rowHeight: z.number().optional().describe('Rows tall (default: 6)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, html, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      // Resolve offsetColumns to startX/endX, then strip convenience keys
      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 12);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      const result = await client.addEmbedBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, html, resolvedLayout);

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

  // ── sq_update_embed ───────────────────────────────────────────────────────
  server.registerTool('sq_update_embed', {
    description:
      'Update the HTML content of an existing embed block on a Squarespace page. Finds the block by ID prefix or content match.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Block ID prefix or content text to find the embed block'),
      html: z.string().describe('New HTML embed code'),
    },
  }, async ({ siteId, pageSlug, searchText, html }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateEmbedBlock(ids.pageSectionsId, ids.collectionId, searchText, html);

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

  // ── sq_add_accordion ──────────────────────────────────────────────────────
  server.registerTool('sq_add_accordion', {
    description:
      'Add an accordion (expandable FAQ/content) block to a section. Each item has a title and description that expands on click. Great for FAQs, service details, pricing breakdowns.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the accordion to'),
      items: z.array(z.object({
        title: z.string().describe('Accordion item heading'),
        description: z.string().describe('Expandable content (plain text or HTML)'),
      })).describe('Array of accordion items (title + description)'),
      expandFirst: z.boolean().optional().describe('Expand the first item by default (default: false)'),
      allowMultipleOpen: z.boolean().optional().describe('Allow multiple items open at once (default: false)'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 24 = full width)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns'),
        rowHeight: z.number().optional().describe('Rows tall (default: auto based on item count)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, items, expandFirst, allowMultipleOpen, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 24);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      const result = await client.addAccordionBlock(
        ids.pageSectionsId, ids.collectionId, sectionIndex, items,
        { isExpandedFirstItem: expandFirst, shouldAllowMultipleOpenItems: allowMultipleOpen },
        resolvedLayout,
      );

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

  // ── sq_update_accordion ───────────────────────────────────────────────────
  server.registerTool('sq_update_accordion', {
    description:
      'Update an existing accordion block. Replace items, toggle expand-first, or allow multiple open. Finds the block by matching item titles/descriptions.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the accordion block (matches item titles or descriptions)'),
      items: z.array(z.object({
        title: z.string().describe('Accordion item heading'),
        description: z.string().describe('Expandable content'),
      })).optional().describe('New items to replace existing ones'),
      expandFirst: z.boolean().optional().describe('Expand the first item by default'),
      allowMultipleOpen: z.boolean().optional().describe('Allow multiple items open at once'),
    },
  }, async ({ siteId, pageSlug, searchText, items, expandFirst, allowMultipleOpen }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const updates: Record<string, any> = {};
      if (items !== undefined) updates.items = items;
      if (expandFirst !== undefined) updates.isExpandedFirstItem = expandFirst;
      if (allowMultipleOpen !== undefined) updates.shouldAllowMultipleOpenItems = allowMultipleOpen;

      const result = await client.updateAccordionBlock(ids.pageSectionsId, ids.collectionId, searchText, updates);

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

  // ── sq_add_quote ────────────────────────────────────────────────────────────
  server.registerTool('sq_add_quote', {
    description:
      'Add a quote/testimonial block to a section. Displays a styled quote with optional attribution (source). Great for testimonials, pullquotes, reviews.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the quote to'),
      quoteText: z.string().describe('The quote text (HTML supported)'),
      attribution: z.string().optional().describe('Quote attribution/source (e.g. "— Jane Doe, CEO")'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 24 = full width)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns'),
        rowHeight: z.number().optional().describe('Rows tall (default: 3)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, quoteText, attribution, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 24);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      const result = await client.addQuoteBlock(
        ids.pageSectionsId, ids.collectionId, sectionIndex, quoteText, attribution, resolvedLayout,
      );

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

  // ── sq_update_quote ─────────────────────────────────────────────────────────
  server.registerTool('sq_update_quote', {
    description:
      'Update an existing quote block\'s text and/or attribution. Finds the block by matching quote text or source/attribution.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the quote block (matches quote text or attribution)'),
      quoteText: z.string().optional().describe('New quote text (HTML supported)'),
      attribution: z.string().optional().describe('New attribution/source text'),
    },
  }, async ({ siteId, pageSlug, searchText, quoteText, attribution }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateQuoteBlock(ids.pageSectionsId, ids.collectionId, searchText, { quoteText, attribution });

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

  // ── sq_add_marquee ──────────────────────────────────────────────────────────
  server.registerTool('sq_add_marquee', {
    description:
      'Add a marquee (scrolling text banner) block to a section. Displays text items that scroll horizontally. Great for announcements, promotions, or decorative text.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the marquee to'),
      items: z.array(z.object({
        text: z.string().describe('Marquee item text'),
        linkTo: z.string().optional().describe('Optional URL to link this item to'),
      })).describe('Array of marquee text items'),
      animationDirection: z.enum(['left', 'right']).optional().describe('Scroll direction (default: left)'),
      animationSpeed: z.number().optional().describe('Scroll speed multiplier (default: 1)'),
      textStyle: z.string().optional().describe('Text style (default: heading-1)'),
      pausedOnHover: z.boolean().optional().describe('Pause scrolling on hover (default: false)'),
      fadeEdges: z.boolean().optional().describe('Fade text at edges (default: false)'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 24 = full width)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns'),
        rowHeight: z.number().optional().describe('Rows tall (default: 4)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, items, animationDirection, animationSpeed, textStyle, pausedOnHover, fadeEdges, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 24);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      const result = await client.addMarqueeBlock(
        ids.pageSectionsId, ids.collectionId, sectionIndex, items,
        { animationDirection, animationSpeed, textStyle, pausedOnHover, fadeEdges },
        resolvedLayout,
      );

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

  // ── sq_update_marquee ───────────────────────────────────────────────────────
  server.registerTool('sq_update_marquee', {
    description:
      'Update an existing marquee block. Change items, animation direction, speed, or text style. Finds the block by matching marquee item text.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the marquee block (matches marquee item text)'),
      items: z.array(z.object({
        text: z.string().describe('Marquee item text'),
        linkTo: z.string().optional().describe('Optional URL to link this item to'),
      })).optional().describe('New marquee items to replace existing ones'),
      animationDirection: z.enum(['left', 'right']).optional().describe('Scroll direction'),
      animationSpeed: z.number().optional().describe('Scroll speed multiplier'),
      textStyle: z.string().optional().describe('Text style'),
      pausedOnHover: z.boolean().optional().describe('Pause scrolling on hover'),
    },
  }, async ({ siteId, pageSlug, searchText, items, animationDirection, animationSpeed, textStyle, pausedOnHover }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateMarqueeBlock(ids.pageSectionsId, ids.collectionId, searchText, {
        items, animationDirection, animationSpeed, textStyle, pausedOnHover,
      });

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

  // ── sq_add_newsletter ───────────────────────────────────────────────────────
  server.registerTool('sq_add_newsletter', {
    description:
      'Add a newsletter/email signup block to a section. Displays a subscribe form with customizable title, description, and button text.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the newsletter block to'),
      title: z.string().optional().describe('Form heading (default: "Subscribe")'),
      description: z.string().optional().describe('Description text (default: "Sign up with your email address to receive news and updates.")'),
      submitButtonText: z.string().optional().describe('Button text (default: "Sign Up")'),
      alignment: z.string().optional().describe('Alignment: alignLeft, alignCenter, alignRight (default: alignCenter)'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 24 = full width)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns'),
        rowHeight: z.number().optional().describe('Rows tall (default: 4)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, title, description, submitButtonText, alignment, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 24);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      const result = await client.addNewsletterBlock(
        ids.pageSectionsId, ids.collectionId, sectionIndex,
        { title, description, submitButtonText, alignment },
        resolvedLayout,
      );

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

  // ── sq_update_newsletter ────────────────────────────────────────────────────
  server.registerTool('sq_update_newsletter', {
    description:
      'Update an existing newsletter/email signup block. Change title, description, button text, or alignment. Finds the block by matching description, title, or button text.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the newsletter block (matches description, title, or button text)'),
      title: z.string().optional().describe('New form heading'),
      description: z.string().optional().describe('New description text'),
      submitButtonText: z.string().optional().describe('New button text'),
      alignment: z.string().optional().describe('New alignment: alignLeft, alignCenter, alignRight'),
      captchaEnabled: z.boolean().optional().describe('Enable/disable captcha'),
    },
  }, async ({ siteId, pageSlug, searchText, title, description, submitButtonText, alignment, captchaEnabled }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateNewsletterBlock(ids.pageSectionsId, ids.collectionId, searchText, {
        title, description, submitButtonText, alignment, captchaEnabled,
      });

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

  // ── sq_add_divider ──────────────────────────────────────────────────────────
  server.registerTool('sq_add_divider', {
    description:
      'Add a line/space divider block to a section. Structural block with no editable content — used to visually separate content within a section (not between sections).',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the divider to'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 24 = full width)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns'),
        rowHeight: z.number().optional().describe('Rows tall (default: 1 = thin line)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 24);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      const result = await client.addDividerBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, resolvedLayout);

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

  // ── sq_add_code ─────────────────────────────────────────────────────────────
  server.registerTool('sq_add_code', {
    description:
      'Add a code/HTML block to a section. Renders code or custom HTML on the page. Useful for custom scripts, styled HTML snippets, or code displays.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the code block to'),
      code: z.string().describe('Code or HTML content'),
      language: z.string().optional().describe('Language mode (default: htmlmixed). Options: htmlmixed, javascript, css, markdown, etc.'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 24 = full width)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns'),
        rowHeight: z.number().optional().describe('Rows tall (default: 3)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, code, language, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 24);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      const result = await client.addCodeBlock(
        ids.pageSectionsId, ids.collectionId, sectionIndex, code, language, resolvedLayout,
      );

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

  // ── sq_update_code ──────────────────────────────────────────────────────────
  server.registerTool('sq_update_code', {
    description:
      'Update an existing code/HTML block. Change the code content and/or language mode. Finds the block by matching code content.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the code block (matches code content)'),
      code: z.string().optional().describe('New code/HTML content'),
      language: z.string().optional().describe('New language mode (htmlmixed, javascript, css, etc.)'),
    },
  }, async ({ siteId, pageSlug, searchText, code, language }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateCodeBlock(ids.pageSectionsId, ids.collectionId, searchText, { code, language });

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

  // ── sq_add_social_links_block ───────────────────────────────────────────────
  server.registerTool('sq_add_social_links_block', {
    description:
      'Add a social links display block to a section. Shows icons for the site\'s connected social accounts (configured via sq_add_social_link). Display-only — reads social URLs from site-level config.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index'),
      iconAlignment: z.enum(['left', 'center', 'right']).optional().describe('Icon alignment (default: center)'),
      iconSize: z.enum(['small', 'medium', 'large']).optional().describe('Icon size (default: small)'),
      iconStyle: z.enum(['icon-only', 'icon-text']).optional().describe('Display style (default: icon-only)'),
      iconColor: z.enum(['black', 'white']).optional().describe('Icon color (default: black)'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 12)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns'),
        rowHeight: z.number().optional().describe('Rows tall (default: 3)'),
        startX: z.number().optional().describe('Absolute grid start X'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, iconAlignment, iconSize, iconStyle, iconColor, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 12);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      const result = await client.addSocialLinksBlock(
        ids.pageSectionsId, ids.collectionId, sectionIndex,
        { iconAlignment, iconSize, iconStyle, iconColor },
        resolvedLayout,
      );

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

  // ── sq_update_social_links_block ────────────────────────────────────────────
  server.registerTool('sq_update_social_links_block', {
    description:
      'Update display options of an existing social links block. Finds the block by ID or falls back to first social links block on the page.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Block ID prefix or text to find the social links block'),
      iconAlignment: z.enum(['left', 'center', 'right']).optional().describe('Icon alignment'),
      iconSize: z.enum(['small', 'medium', 'large']).optional().describe('Icon size'),
      iconStyle: z.enum(['icon-only', 'icon-text']).optional().describe('Display style'),
      iconColor: z.enum(['black', 'white']).optional().describe('Icon color'),
    },
  }, async ({ siteId, pageSlug, searchText, iconAlignment, iconSize, iconStyle, iconColor }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateSocialLinksBlock(ids.pageSectionsId, ids.collectionId, searchText, {
        iconAlignment, iconSize, iconStyle, iconColor,
      });

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
