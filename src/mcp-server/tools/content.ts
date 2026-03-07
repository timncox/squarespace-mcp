/**
 * MCP Tools — Blog, Menu & Gallery
 *
 * sq_create_blog_post: Create a new blog post
 * sq_update_blog_post: Update an existing blog post
 * sq_set_blog_featured_image: Set a blog post's featured/thumbnail image
 * sq_list_blog_posts: List blog posts in a collection
 * sq_find_blog_post: Find a blog post by title
 * sq_get_menu: Read menu block data
 * sq_update_menu: Update menu block
 * sq_add_menu: Add a new menu block
 * sq_update_gallery: Update gallery display settings
 * sq_list_gallery_images: List images in a gallery
 * sq_remove_gallery_image: Remove an image from a gallery
 * sq_reorder_gallery_images: Reorder images in a gallery
 * sq_add_gallery_image: Upload and add an image to a gallery
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, getMediaClient, resolvePageIds } from '../session.js';

export function registerContentTools(server: McpServer) {
  // ── sq_create_blog_post ─────────────────────────────────────────────────────
  server.registerTool('sq_create_blog_post', {
    description:
      'Create a new blog post on a Squarespace site. Requires the blog collectionId (get it from sq_list_pages). Returns the new post itemId and urlId. Body, tags, excerpt, and categories are set via a follow-up update after creation.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (e.g. "my-site")'),
      collectionId: z.string().describe('Blog collection ID (from sq_list_pages)'),
      title: z.string().describe('Blog post title'),
      body: z.string().optional().describe('Blog post body HTML'),
      tags: z.array(z.string()).optional().describe('Tags for the post'),
      excerpt: z.string().optional().describe('Post excerpt / summary text'),
      categories: z.array(z.string()).optional().describe('Post categories'),
      slug: z.string().optional().describe('Custom URL slug (e.g. "my-post-title")'),
      publishDate: z.string().optional().describe('Publish date as ISO 8601 string (e.g. "2026-01-15T10:00:00Z"). Defaults to now.'),
      coverImageUrl: z.string().optional().describe('Featured image / thumbnail URL (use sq_upload_image to get URL first)'),
      draft: z.boolean().optional().default(true).describe('Create as draft (default true)'),
    },
  }, async ({ siteId, collectionId, title, body, tags, excerpt, categories, slug, publishDate, coverImageUrl, draft }) => {
    try {
      const client = getClient(siteId);
      const result = await client.createBlogPost(collectionId, title, {
        body,
        tags,
        excerpt,
        categories,
        slug,
        publishDate,
        coverImageUrl,
        draft,
      });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Unknown error'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_blog_post ─────────────────────────────────────────────────────
  server.registerTool('sq_update_blog_post', {
    description:
      'Update an existing blog post on a Squarespace site. Requires collectionId and the post itemId.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      collectionId: z.string().describe('Blog collection ID'),
      postId: z.string().describe('Blog post item ID to update'),
      title: z.string().optional().describe('New title'),
      body: z.string().optional().describe('New body HTML'),
      tags: z.array(z.string()).optional().describe('New tags'),
      excerpt: z.string().optional().describe('Post excerpt / summary text'),
      categories: z.array(z.string()).optional().describe('Post categories'),
      slug: z.string().optional().describe('Custom URL slug'),
      publishDate: z.string().optional().describe('Publish date as ISO 8601 string (e.g. "2026-01-15T10:00:00Z")'),
      coverImageUrl: z.string().optional().describe('Featured image / thumbnail URL (use sq_upload_image to get URL first)'),
      draft: z.boolean().optional().describe('Set draft status (true=draft, false=published)'),
    },
  }, async ({ siteId, collectionId, postId, title, body, tags, excerpt, categories, slug, publishDate, coverImageUrl, draft }) => {
    try {
      const client = getClient(siteId);
      const result = await client.updateBlogPost(collectionId, postId, {
        title,
        body,
        tags,
        excerpt,
        categories,
        urlId: slug,
        publishDate,
        coverImageUrl,
        draft,
      });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Unknown error'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_set_blog_featured_image ────────────────────────────────────────────
  server.registerTool('sq_set_blog_featured_image', {
    description:
      'Set the featured/thumbnail image for a blog post. Uses the SaveMedia API to upload and link the image directly to the post. ' +
      'Accepts a local file path, HTTP/HTTPS URL, or base64-encoded image data. ' +
      'Note: coverImageUrl on sq_create_blog_post / sq_update_blog_post does NOT work — use this tool instead.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      collectionId: z.string().describe('Blog collection ID'),
      postId: z.string().describe('Blog post item ID'),
      imagePath: z.string().optional().describe('Local file path to image'),
      imageUrl: z.string().optional().describe('HTTP/HTTPS URL of image to download'),
      imageData: z.string().optional().describe('Base64-encoded image data'),
      filename: z.string().optional().describe('Filename (required with imageData, optional otherwise, e.g. "featured.jpg")'),
    },
  }, async ({ siteId, collectionId, postId, imagePath, imageUrl, imageData, filename }) => {
    try {
      if (!imagePath && !imageUrl && !imageData) {
        return { content: [{ type: 'text' as const, text: 'Error: Must provide imagePath, imageUrl, or imageData' }], isError: true };
      }

      const client = getClient(siteId);
      let imageBuffer: Buffer;
      let resolvedFilename: string;
      let contentType = 'image/jpeg';

      if (imageData) {
        imageBuffer = Buffer.from(imageData, 'base64');
        resolvedFilename = filename || 'featured.jpg';
      } else if (imageUrl) {
        const resp = await fetch(imageUrl, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) {
          return { content: [{ type: 'text' as const, text: `Error: Failed to download image: ${resp.status}` }], isError: true };
        }
        imageBuffer = Buffer.from(await resp.arrayBuffer());
        const urlPath = new URL(imageUrl).pathname;
        resolvedFilename = filename || urlPath.split('/').pop() || 'featured.jpg';
        const respType = resp.headers.get('content-type');
        if (respType) contentType = respType.split(';')[0].trim();
      } else {
        const { readFileSync } = await import('node:fs');
        const path = await import('node:path');
        imageBuffer = readFileSync(imagePath!);
        resolvedFilename = filename || path.default.basename(imagePath!);
        const ext = path.default.extname(resolvedFilename).toLowerCase();
        if (ext === '.png') contentType = 'image/png';
        else if (ext === '.webp') contentType = 'image/webp';
        else if (ext === '.gif') contentType = 'image/gif';
      }

      const result = await client.setBlogPostFeaturedImage(collectionId, postId, imageBuffer, resolvedFilename, contentType);

      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Unknown error'}` }], isError: true };
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

  // ── sq_list_blog_posts ────────────────────────────────────────────────────
  server.registerTool('sq_list_blog_posts', {
    description:
      'List blog posts in a Squarespace blog collection. Returns post IDs, titles, URLs, tags, and status. Use this to discover post IDs for sq_update_blog_post.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      collectionId: z.string().describe('Blog collection ID (from sq_list_pages, type: 11)'),
      filter: z.enum(['published', 'draft', 'all']).optional().describe('Filter by status (default: all)'),
      limit: z.number().optional().describe('Max number of posts to return'),
    },
  }, async ({ siteId, collectionId, filter, limit }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getCollectionItems(collectionId, {
        ...(filter ? { filter } : {}),
        ...(limit ? { limit } : {}),
      });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Unknown error'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_find_blog_post ─────────────────────────────────────────────────────
  server.registerTool('sq_find_blog_post', {
    description:
      'Find a blog post by title (case-insensitive substring match). Returns the first matching post with its ID, title, URL, and metadata.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      collectionId: z.string().describe('Blog collection ID'),
      title: z.string().describe('Title text to search for (case-insensitive substring match)'),
    },
  }, async ({ siteId, collectionId, title }) => {
    try {
      const client = getClient(siteId);
      const post = await client.findBlogPostByTitle(collectionId, title);

      if (!post) {
        return {
          content: [{ type: 'text' as const, text: `No blog post found matching "${title}"` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(post, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_get_menu ─────────────────────────────────────────────────────────────
  server.registerTool('sq_get_menu', {
    description:
      'Read menu block data from a Squarespace page. Returns the menus array (tabs, sections, items with prices), menuStyle, and currencySymbol.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the menu'),
      searchText: z.string().describe('Text to find the menu block (e.g. menu item name or tab title)'),
    },
  }, async ({ siteId, pageSlug, searchText }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.getMenuBlock(ids.pageSectionsId, searchText);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Menu block not found'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_menu ──────────────────────────────────────────────────────────
  server.registerTool('sq_update_menu', {
    description:
      'Update a menu block on a Squarespace page. Provide the full MenuTab[] JSON structure. Each MenuTab has { title, sections: [{ title, items: [{ title, description, price }] }] }.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the menu'),
      searchText: z.string().describe('Text to find the menu block'),
      menus: z.array(z.object({
        title: z.string(),
        description: z.string().optional().nullable(),
        sections: z.array(z.object({
          title: z.string().nullable(),
          items: z.array(z.object({
            title: z.string(),
            description: z.string().optional().nullable(),
            variants: z.array(z.object({
              price: z.string(),
            })).optional().nullable().default([]),
          })).optional().default([]),
        })).optional().default([]),
      })).describe('Full MenuTab[] structure to set'),
      preserveRaw: z.boolean().optional().default(false).describe('If true, keep existing raw text instead of regenerating'),
    },
  }, async ({ siteId, pageSlug, searchText, menus, preserveRaw }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateMenuBlock(ids.pageSectionsId, ids.collectionId, searchText, menus, { preserveRaw });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Menu update failed'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_add_menu_tab ────────────────────────────────────────────────────────
  server.registerTool('sq_add_menu_tab', {
    description:
      'Insert a single menu tab into an existing menu block at a specific position. ' +
      'Much simpler than sq_update_menu when you only need to add one tab — no need to pass all existing tabs.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the menu'),
      searchText: z.string().describe('Text to find the menu block (e.g. any existing tab name)'),
      index: z.number().describe('0-based position to insert the new tab. Use -1 to append at the end.'),
      tab: z.object({
        title: z.string(),
        description: z.string().optional().nullable(),
        sections: z.array(z.object({
          title: z.string().nullable(),
          items: z.array(z.object({
            title: z.string(),
            description: z.string().optional().nullable(),
            variants: z.array(z.object({
              price: z.string(),
            })).optional().nullable().default([]),
          })).optional().default([]),
        })).optional().default([]),
      }).describe('The menu tab to insert'),
    },
  }, async ({ siteId, pageSlug, searchText, index, tab }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      // Read existing menu
      const existing = await client.getMenuBlock(ids.pageSectionsId, searchText);
      if (!existing.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${existing.error ?? 'Menu block not found'}` }], isError: true };
      }

      const menus = [...(existing.menus || [])];
      const insertAt = index < 0 ? menus.length : Math.min(index, menus.length);
      menus.splice(insertAt, 0, tab);

      // Write back
      const result = await client.updateMenuBlock(ids.pageSectionsId, ids.collectionId, searchText, menus);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Menu update failed'}` }], isError: true };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...result,
            insertedAt: insertAt,
            tabTitle: tab.title,
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

  // ── sq_add_menu ──────────────────────────────────────────────────────────────
  server.registerTool('sq_add_menu', {
    description:
      'Add a new menu block (type 18) to a section on a Squarespace page. Optionally provide initial menu content in Squarespace menu text format (tabs with ========, sections with ------, items with $price).',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the menu to'),
      menuText: z.string().optional().describe('Menu content in Squarespace text format — tabs (========), sections (------), items ($price). Omit for empty menu.'),
      menuStyle: z.string().optional().describe('Menu display style (default: "classic")'),
      currencySymbol: z.string().optional().describe('Currency symbol (default: "$")'),
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
  }, async ({ siteId, pageSlug, sectionIndex, menuText, menuStyle, currencySymbol, layout }) => {
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

      // Build options from top-level params + resolved layout
      const options = (menuStyle || currencySymbol || resolvedLayout)
        ? { ...resolvedLayout, ...(menuStyle ? { menuStyle } : {}), ...(currencySymbol ? { currencySymbol } : {}) }
        : undefined;

      const result = await client.addMenuBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, menuText, options);

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

  // ── sq_update_gallery ───────────────────────────────────────────────────────
  server.registerTool('sq_update_gallery', {
    description:
      'Update gallery display settings on a Squarespace page. Finds the gallery block by search text (collectionId or block ID prefix) and updates specified settings.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the gallery'),
      searchText: z.string().describe('Gallery collectionId, block ID prefix, or text to find the gallery block'),
      settings: z.object({
        'thumbnails-per-row': z.number().optional().describe('Number of thumbnails per row'),
        'aspect-ratio': z.string().optional().describe('Image aspect ratio'),
        lightbox: z.boolean().optional().describe('Enable lightbox on click'),
        design: z.string().optional().describe('Gallery design style'),
        padding: z.number().optional().describe('Padding between images'),
      }).describe('Gallery settings to update (partial — only provided fields are changed)'),
    },
  }, async ({ siteId, pageSlug, searchText, settings }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateGallerySettings(ids.pageSectionsId, ids.collectionId, searchText, settings);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Gallery update failed'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_list_gallery_images ─────────────────────────────────────────────────
  server.registerTool('sq_list_gallery_images', {
    description:
      'List all images in a gallery on a Squarespace page. Returns image IDs, filenames, titles, display order, and asset URLs. Use this to discover image IDs before removing or reordering.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the gallery'),
      searchText: z.string().optional().describe('Gallery collectionId or block ID prefix (optional — uses first gallery if omitted)'),
    },
  }, async ({ siteId, pageSlug, searchText }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const data = await client.getPageSections(ids.pageSectionsId);
      const found = client.findGalleryBlock(data.sections, searchText);
      if (!found) {
        return { content: [{ type: 'text' as const, text: 'Error: No gallery block found on this page' }], isError: true };
      }
      const result = await client.getGalleryItems(found.galleryCollectionId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to fetch gallery items'}` }], isError: true };
      }
      const summary = (result.items ?? []).map((item: any) => ({
        id: item.id,
        displayIndex: item.displayIndex,
        filename: item.filename,
        title: item.title,
        assetUrl: item.assetUrl,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, galleryCollectionId: found.galleryCollectionId, items: summary }, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── sq_remove_gallery_image ────────────────────────────────────────────────
  server.registerTool('sq_remove_gallery_image', {
    description:
      'Remove an image from a gallery. Use sq_list_gallery_images first to get the image item ID.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      itemId: z.string().describe('Gallery image item ID (from sq_list_gallery_images)'),
    },
  }, async ({ siteId, itemId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.removeGalleryImage('', itemId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to remove image'}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── sq_reorder_gallery_images ──────────────────────────────────────────────
  server.registerTool('sq_reorder_gallery_images', {
    description:
      'Reorder images in a gallery. Pass the complete list of image item IDs in the desired order. Use sq_list_gallery_images first to get current IDs and order.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the gallery'),
      itemIds: z.array(z.string()).describe('Complete ordered list of all gallery image item IDs in desired display order'),
      searchText: z.string().optional().describe('Gallery collectionId or block ID prefix (optional — uses first gallery if omitted)'),
    },
  }, async ({ siteId, pageSlug, itemIds, searchText }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const data = await client.getPageSections(ids.pageSectionsId);
      const found = client.findGalleryBlock(data.sections, searchText);
      if (!found) {
        return { content: [{ type: 'text' as const, text: 'Error: No gallery block found on this page' }], isError: true };
      }
      const result = await client.reorderGalleryImages(found.galleryCollectionId, itemIds);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to reorder images'}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── sq_add_gallery_image ──────────────────────────────────────────────────
  server.registerTool('sq_add_gallery_image', {
    description:
      'Upload an image and add it to a gallery. Use sq_list_gallery_images to verify after adding. Requires a local file path or URL as the image source.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the gallery'),
      imagePath: z.string().optional().describe('Local file path to image'),
      imageUrl: z.string().optional().describe('HTTP/HTTPS URL of image to download and upload'),
      imageData: z.string().optional().describe('Base64-encoded image data (for Claude Desktop cloud-to-local bridge)'),
      filename: z.string().optional().describe('Filename when using imageData (e.g. "photo.jpg")'),
      title: z.string().optional().describe('Image title/caption'),
      description: z.string().optional().describe('Image description/alt text'),
      searchText: z.string().optional().describe('Gallery block ID or text to find specific gallery (optional — uses first gallery if omitted)'),
    },
  }, async ({ siteId, pageSlug, imagePath, imageUrl, imageData, filename, title, description, searchText }) => {
    try {
      if (!imagePath && !imageUrl && !imageData) {
        return { content: [{ type: 'text' as const, text: 'Error: Must provide imagePath, imageUrl, or imageData' }], isError: true };
      }

      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const mediaClient = getMediaClient(siteId);

      // Find the gallery block to get the galleryCollectionId
      const data = await client.getPageSections(ids.pageSectionsId);
      const found = client.findGalleryBlock(data.sections, searchText);
      if (!found) {
        return { content: [{ type: 'text' as const, text: 'Error: No gallery block found on this page' }], isError: true };
      }

      // Upload the image
      let uploadResult;
      if (imageData && filename) {
        // Base64 bridge: write to temp file, upload, clean up
        const os = await import('node:os');
        const path = await import('node:path');
        const { writeFile, unlink } = await import('node:fs/promises');
        const tmpPath = path.join(os.default.tmpdir(), `sq-gallery-${Date.now()}-${filename}`);
        await writeFile(tmpPath, Buffer.from(imageData, 'base64'));
        try {
          uploadResult = await mediaClient.uploadImage(tmpPath);
        } finally {
          await unlink(tmpPath).catch(() => {});
        }
      } else if (imageUrl) {
        uploadResult = await mediaClient.uploadImageFromUrl(imageUrl);
      } else if (imagePath) {
        uploadResult = await mediaClient.uploadImage(imagePath);
      }

      if (!uploadResult?.success || !uploadResult.assetId) {
        return { content: [{ type: 'text' as const, text: `Error: Image upload failed: ${uploadResult?.error ?? 'no assetId returned'}` }], isError: true };
      }

      // Add to gallery
      const result = await client.addGalleryImage(found.galleryCollectionId, uploadResult.assetId, { title, description });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...result, assetUrl: uploadResult.assetUrl }, null, 2) }],
        ...(result.success ? {} : { isError: true }),
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });
}
