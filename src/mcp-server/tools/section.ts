/**
 * MCP Tools — Section management
 *
 * sq_add_blank_section: Add a new blank section to a page
 * sq_add_template_section: Add a section from the template catalog with optional replacements
 * sq_edit_section_style: Change section theme/height/width/alignment
 * sq_move_section: Reorder a section up or down
 * sq_duplicate_section: Duplicate a section
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds } from '../session.js';
import { lookupCatalogEntry, normalizeCategoryName } from '../../services/section-catalog.js';

export function registerSectionTools(server: McpServer) {
  // ── sq_add_blank_section ────────────────────────────────────────────────────
  server.registerTool('sq_add_blank_section', {
    description: 'Add a new blank (empty) section. WARNING: Squarespace may reject subsequent block insertions into API-created blank sections — use sq_add_section instead to create sections with initial content.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      position: z.number().optional().describe('Section index position (0-based). Omit to append at end.'),
    },
  }, async ({ siteId, pageSlug, position }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.addBlankSection(ids.pageSectionsId, ids.collectionId, position);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to add blank section'}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          sectionId: result.sectionId ?? null,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_add_section ──────────────────────────────────────────────────────
  server.registerTool('sq_add_section', {
    description:
      'Add a new section to a page with initial content blocks. Preferred over sq_add_blank_section because blank sections may reject subsequent block insertions. ' +
      'Supports text, embed, button, image, and video blocks.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      blocks: z.array(z.union([
        z.object({
          type: z.literal('text'),
          html: z.string().describe('HTML content or plain text'),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
          formatting: z.object({
            tag: z.enum(['h1', 'h2', 'h3', 'h4', 'p']).optional(),
            alignment: z.enum(['left', 'center', 'right']).optional(),
            bold: z.boolean().optional(),
            italic: z.boolean().optional(),
          }).optional(),
        }),
        z.object({
          type: z.literal('embed'),
          html: z.string().describe('Raw HTML (iframes, scripts, etc.)'),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
        }),
        z.object({
          type: z.literal('button'),
          text: z.string().describe('Button label'),
          url: z.string().describe('Button link URL'),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
        }),
        z.object({
          type: z.literal('image'),
          assetUrl: z.string().describe('Image asset URL (from sq_upload_image)'),
          altText: z.string().optional().describe('Image alt text'),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
        }),
        z.object({
          type: z.literal('video'),
          videoUrl: z.string().describe('Video URL (YouTube, Vimeo)'),
          title: z.string().optional(),
          description: z.string().optional(),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
        }),
      ])).min(1).describe('Array of blocks to add to the new section'),
      position: z.number().optional().describe('Section index position (0-based). Omit to append at end.'),
      styles: z.object({
        sectionTheme: z.string().optional().describe('Section theme (e.g. "dark", "light")'),
        sectionHeight: z.string().optional().describe('Section height (e.g. "medium", "large")'),
        contentWidth: z.string().optional().describe('Content width (e.g. "wide", "full")'),
      }).optional().describe('Section style overrides'),
    },
  }, async ({ siteId, pageSlug, blocks, position, styles }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.addSectionWithBlocks(ids.pageSectionsId, ids.collectionId, blocks, { position, styles });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to add section'}` }],
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

  // ── sq_add_template_section ─────────────────────────────────────────────────
  server.registerTool('sq_add_template_section', {
    description:
      'Add a section from the template catalog to a Squarespace page, with optional text/button/image replacements.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      category: z.string().describe('Template category: Intro, About, Team, Contact, Services, Products, FAQs, Images'),
      templateIndex: z.number().describe('0-based index within the category'),
      replacements: z.object({
        texts: z.array(z.object({
          searchText: z.string(),
          newText: z.string(),
        })).optional(),
        buttons: z.array(z.object({
          searchText: z.string(),
          newLabel: z.string().optional(),
          url: z.string().optional(),
        })).optional(),
        images: z.array(z.object({
          searchText: z.string(),
          filePath: z.string(),
          altText: z.string().optional(),
        })).optional(),
        removeBlocks: z.array(z.string()).optional(),
      }).optional().describe('Optional replacements to apply after adding the template section'),
    },
  }, async ({ siteId, pageSlug, category, templateIndex, replacements }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const { pageSectionsId, collectionId } = ids;
      const client = getClient(siteId);

      // Look up the template entry from the catalog
      const catalogResponse = await client.getSectionCatalog();
      if (!catalogResponse.success || !catalogResponse.catalog) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${catalogResponse.error ?? 'Failed to fetch section catalog'}` }],
          isError: true,
        };
      }

      const entry = lookupCatalogEntry(catalogResponse.catalog, category, templateIndex);
      if (!entry) {
        const normalized = normalizeCategoryName(category);
        const available = Object.keys(catalogResponse.catalog);
        const categoryEntries = catalogResponse.catalog[normalized];
        return {
          content: [{
            type: 'text' as const,
            text: `Error: Template not found. Category "${category}" (normalized: "${normalized}"), index ${templateIndex}. ` +
              (categoryEntries
                ? `Category has ${categoryEntries.length} templates (indexes 0-${categoryEntries.length - 1}).`
                : `Available categories: ${available.join(', ')}.`),
          }],
          isError: true,
        };
      }

      // Copy the template section (catalog entry uses websiteId/collectionId/sectionId)
      const copyResult = await client.copyTemplateSection(
        entry.websiteId,
        entry.collectionId,
        entry.sectionId,
      );

      if (!copyResult.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${copyResult.error ?? 'Failed to copy template section'}` }],
          isError: true,
        };
      }

      const results: Record<string, any> = {
        success: true,
        sectionId: copyResult.sectionId ?? null,
        replacementsApplied: {},
      };

      // After copy, attach the section to the target page.
      // copyTemplateSection creates the section site-wide (orphaned).
      // We need to GET page sections → append → PUT.
      const sectionData = copyResult.sectionData as Record<string, unknown> | undefined;
      if (sectionData && typeof sectionData === 'object') {
        try {
          const pageData = await client.getPageSections(pageSectionsId);
          const updatedSections = [...pageData.sections, sectionData as any];
          const saveResult = await client.savePageSections(pageSectionsId, collectionId, updatedSections);
          if (!saveResult.success) {
            results.attachWarning = `Section copied but failed to attach to page: ${saveResult.error}`;
          }
        } catch (attachErr) {
          results.attachWarning = `Section copied but failed to attach: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`;
        }
      } else {
        results.attachWarning = 'Section copied but no section data returned — may need manual placement.';
      }

      // Apply text replacements
      if (replacements?.texts?.length) {
        const textResults = [];
        for (const { searchText, newText } of replacements.texts) {
          try {
            const r = await client.updateTextBlock(pageSectionsId, collectionId, searchText, newText);
            textResults.push({ searchText, success: r.success, error: r.error ?? null });
          } catch (e) {
            textResults.push({ searchText, success: false, error: e instanceof Error ? e.message : String(e) });
          }
        }
        results.replacementsApplied.texts = textResults;
      }

      // Remove blocks
      if (replacements?.removeBlocks?.length) {
        const removeResults = [];
        for (const searchText of replacements.removeBlocks) {
          try {
            const r = await client.removeBlock(pageSectionsId, collectionId, searchText);
            removeResults.push({ searchText, success: r.success, error: r.error ?? null });
          } catch (e) {
            removeResults.push({ searchText, success: false, error: e instanceof Error ? e.message : String(e) });
          }
        }
        results.replacementsApplied.removeBlocks = removeResults;
      }

      // Button and image replacements — noted as TODO
      if (replacements?.buttons?.length) {
        results.replacementsApplied.buttons = { note: 'Button replacements not yet implemented via MCP. Use sq_update_text as a workaround for button labels.' };
      }
      if (replacements?.images?.length) {
        results.replacementsApplied.images = { note: 'Image replacements not yet implemented via MCP. Use browser agent for image uploads.' };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_edit_section_style ─────────────────────────────────────────────────
  server.registerTool('sq_edit_section_style', {
    description:
      'Change a section\'s style properties (theme, height, width, alignment). Accepts section by index or by text content.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionSearch: z.union([z.number(), z.string()]).describe('Section index (number) or text content to search for (string)'),
      styles: z.object({
        sectionTheme: z.string().optional().describe('Section theme (e.g. "dark", "light", "white", "black")'),
        sectionHeight: z.string().optional().describe('Section height (e.g. "medium", "large", "custom")'),
        contentWidth: z.string().optional().describe('Content width (e.g. "wide", "full", "narrow")'),
        verticalAlignment: z.string().optional().describe('Vertical alignment (e.g. "top", "middle", "bottom")'),
      }).describe('Style properties to set'),
    },
  }, async ({ siteId, pageSlug, sectionSearch, styles }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.editSectionStyle(ids.pageSectionsId, ids.collectionId, sectionSearch, styles);

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

  // ── sq_move_section ───────────────────────────────────────────────────────
  server.registerTool('sq_move_section', {
    description:
      'Reorder a section up or down on the page. Finds the section containing the search text and moves it one position in the specified direction.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionSearch: z.string().describe('Text content to search for in the section'),
      direction: z.enum(['up', 'down']).describe('Direction to move the section'),
    },
  }, async ({ siteId, pageSlug, sectionSearch, direction }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.moveSection(ids.pageSectionsId, ids.collectionId, sectionSearch, direction);

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

  // ── sq_duplicate_section ──────────────────────────────────────────────────
  server.registerTool('sq_duplicate_section', {
    description:
      'Duplicate a section (deep clone with regenerated IDs). The clone is inserted immediately after the original.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionSearch: z.union([z.number(), z.string()]).describe('Section index (number) or text content to search for (string)'),
    },
  }, async ({ siteId, pageSlug, sectionSearch }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.duplicateSection(ids.pageSectionsId, ids.collectionId, sectionSearch);

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
