/**
 * MCP Tools — Page management
 *
 * sq_create_page: Create a new page or blog
 * sq_delete_page: Delete a page by collectionId
 * sq_list_pages: List all pages/collections
 * sq_get_navigation: Get site navigation structure
 * sq_update_navigation: Reorder/update navigation items
 * sq_update_page_metadata: Update page SEO and metadata
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds } from '../session.js';

/** Map friendly pageType to Squarespace collection type number */
function pageTypeToNumber(pageType?: string): number | undefined {
  if (!pageType) return undefined;
  switch (pageType) {
    case 'blog': return 11;
    case 'page':
    default: return 1;
  }
}

export function registerPageTools(server: McpServer) {
  // ── sq_create_page ──────────────────────────────────────────────────────────
  server.registerTool('sq_create_page', {
    description: 'Create a new Squarespace page or blog collection.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      title: z.string().describe('Page title'),
      slug: z.string().optional().describe('URL slug (e.g. "about-us"). Auto-generated from title if omitted.'),
      pageType: z.enum(['page', 'blog']).optional().describe('Page type: "page" (default) or "blog"'),
    },
  }, async ({ siteId, title, slug, pageType }) => {
    try {
      const client = getClient(siteId);
      const typeNum = pageTypeToNumber(pageType);
      const result = await client.createPageViaApi(title, slug, typeNum != null ? { type: typeNum } : undefined);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to create page'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            pageId: result.pageId ?? null,
            urlId: result.urlId ?? null,
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

  // ── sq_delete_page ──────────────────────────────────────────────────────────
  server.registerTool('sq_delete_page', {
    description: 'Delete a Squarespace page by its collection ID. Use sq_list_pages to find collection IDs.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      collectionId: z.string().describe('Collection ID of the page to delete'),
    },
  }, async ({ siteId, collectionId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.deletePageViaApi(collectionId);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to delete page'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, collectionId: result.collectionId ?? collectionId }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_list_pages ───────────────────────────────────────────────────────────
  server.registerTool('sq_list_pages', {
    description: 'List all pages and collections on a Squarespace site. Returns id, urlId, title, type, and typeName for each.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const collections = await client.listCollections();

      const summary = collections.map((c: any) => ({
        id: c.id,
        urlId: c.urlId,
        title: c.title,
        type: c.type,
        typeName: c.typeName,
        itemCount: c.itemCount ?? 0,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ pageCount: summary.length, pages: summary }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_get_navigation ───────────────────────────────────────────────────────
  server.registerTool('sq_get_navigation', {
    description: 'Get the site navigation structure including main navigation and hidden pages.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getNavigation();

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to get navigation'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.data, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_navigation ────────────────────────────────────────────────────
  server.registerTool('sq_update_navigation', {
    description: 'Reorder or update navigation items. Use sq_get_navigation first to see current structure, then pass the updated items array.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      fieldName: z.string().describe('Navigation field: "mainNav" for main navigation, "_hidden" for not-linked pages'),
      items: z.array(z.any()).describe('Array of navigation item objects in the desired order'),
    },
  }, async ({ siteId, fieldName, items }) => {
    try {
      const client = getClient(siteId);
      const result = await client.updateNavigation(fieldName, items);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to update navigation'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, fieldName }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_page_metadata ─────────────────────────────────────────────────
  server.registerTool('sq_update_page_metadata', {
    description: 'Update page metadata including SEO title, description, and navigation title. Requires resolving page to get collectionId.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      seoTitle: z.string().optional().describe('SEO title for search engines'),
      seoDescription: z.string().optional().describe('SEO meta description'),
      description: z.string().optional().describe('Page description'),
      navigationTitle: z.string().optional().describe('Title shown in navigation menu'),
    },
  }, async ({ siteId, pageSlug, seoTitle, seoDescription, description, navigationTitle }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updatePageMetadata(ids.collectionId, {
        ...(seoTitle != null ? { seoTitle } : {}),
        ...(seoDescription != null ? { seoDescription } : {}),
        ...(description != null ? { description } : {}),
        ...(navigationTitle != null ? { navigationTitle } : {}),
      });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to update page metadata'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            collectionId: result.collectionId ?? ids.collectionId,
            updatedFields: result.updatedFields ?? [],
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
