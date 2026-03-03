/**
 * MCP Tools — Blog, Menu & Gallery
 *
 * sq_create_blog_post: Create a new blog post
 * sq_update_blog_post: Update an existing blog post
 * sq_list_blog_posts: List blog posts in a collection
 * sq_find_blog_post: Find a blog post by title
 * sq_get_menu: Read menu block data
 * sq_update_menu: Update menu block
 * sq_update_gallery: Update gallery display settings
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds } from '../session.js';

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
      draft: z.boolean().optional().default(true).describe('Create as draft (default true)'),
    },
  }, async ({ siteId, collectionId, title, body, tags, excerpt, categories, slug, publishDate, draft }) => {
    try {
      const client = getClient(siteId);
      const result = await client.createBlogPost(collectionId, title, {
        body,
        tags,
        excerpt,
        categories,
        slug,
        publishDate,
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
      draft: z.boolean().optional().describe('Set draft status (true=draft, false=published)'),
    },
  }, async ({ siteId, collectionId, postId, title, body, tags, excerpt, categories, slug, publishDate, draft }) => {
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
      menus: z.array(z.any()).describe('Full MenuTab[] structure to set'),
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
}
