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
    case 'blog': return 1;
    case 'page':
    default: return 10;
  }
}

export function registerPageTools(server: McpServer) {
  // ── sq_create_page ──────────────────────────────────────────────────────────
  server.registerTool('sq_create_page', {
    description: 'Create a new Squarespace page or blog collection. Creates the page via API and adds it to site navigation. After creation, use sq_add_section, sq_add_text_block, etc. to build out the page content.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      title: z.string().describe('Page title'),
      slug: z.string().optional().describe('URL slug (e.g. "about-us"). Auto-generated from title if omitted.'),
      pageType: z.enum(['page', 'blog']).optional().describe('Page type: "page" (default) or "blog" collection'),
      navigation: z.enum(['mainNav', '_hidden']).optional().describe('Where to place the page: "mainNav" for main navigation (visible), "_hidden" for not linked (default)'),
    },
  }, async ({ siteId, title, slug, pageType, navigation }) => {
    try {
      const client = getClient(siteId);
      const typeNum = pageTypeToNumber(pageType);
      const result = await client.createPageViaApi(title, slug, {
        ...(typeNum != null ? { type: typeNum } : {}),
        ...(navigation ? { navigation } : {}),
      });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to create page'}` }],
          isError: true,
        };
      }

      const response: Record<string, unknown> = {
        success: true,
        pageId: result.pageId ?? null,
        urlId: result.urlId ?? null,
      };
      if (result.warning) response.warning = result.warning;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
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
    description: 'Delete (move to trash) a Squarespace page by its collection ID. Use sq_list_pages to find collection IDs. Uses the RemoveCollection API to move the page to the trash (retained for ~30 days). Falls back to hiding from navigation if RemoveCollection fails.',
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

      const response: Record<string, unknown> = {
        success: true,
        collectionId: result.collectionId ?? collectionId,
      };
      if (result.method) response.method = result.method;
      if (result.note) response.note = result.note;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(response, null, 2),
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
    description: 'List all pages and collections on a Squarespace site. Returns id, urlId, title, type, typeName, and status (mainNav, notLinked, or deleted) for each. By default excludes deleted pages — set includeDeleted to true to show them.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      includeDeleted: z.boolean().optional().describe('Include deleted/trashed pages (default: false)'),
    },
  }, async ({ siteId, includeDeleted }) => {
    try {
      const client = getClient(siteId);
      const [collections, navResult] = await Promise.all([
        client.listCollections(),
        client.getNavigation(),
      ]);

      // Build lookup sets from navigation data
      const mainNavIds = new Set<string>();
      const notLinkedIds = new Set<string>();
      if (navResult.success && navResult.data) {
        const addIds = (items: Array<{ id?: string; collectionId?: string }>, set: Set<string>) => {
          for (const item of items) {
            if (item.collectionId) set.add(item.collectionId);
            if (item.id) set.add(item.id);
          }
        };
        addIds(navResult.data.mainNavigation, mainNavIds);
        addIds(navResult.data.notLinked, notLinkedIds);
      }

      const summary = collections
        .filter((c: any) => includeDeleted || !c.deleted)
        .map((c: any) => {
          let status: string;
          if (c.deleted) {
            status = 'deleted';
          } else if (mainNavIds.has(c.id)) {
            status = 'mainNav';
          } else if (notLinkedIds.has(c.id)) {
            status = 'notLinked';
          } else {
            status = 'notLinked';
          }
          return {
            id: c.id,
            urlId: c.urlId,
            title: c.title,
            type: c.type,
            typeName: c.typeName,
            status,
            itemCount: c.itemCount ?? 0,
          };
        });

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
