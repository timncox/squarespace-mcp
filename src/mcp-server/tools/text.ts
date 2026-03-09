/**
 * MCP Tools — Text reading and editing
 *
 * sq_read_page: Read all sections/blocks from a page
 * sq_update_text: Update text content on a page (patch or replace)
 * sq_update_html: Replace block HTML directly (raw HTML mode)
 * sq_patch_text: Surgical substring replacement within a block
 * sq_format_text: Apply formatting (heading, alignment, bold, italic) to existing text
 * sq_add_text: Add a new text block to a section
 * sq_update_footer_text: Edit footer text (site-wide, no page needed)
 * sq_update_header_text: Edit header text (site-wide, no page needed)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds } from '../session.js';

export function registerTextTools(server: McpServer) {
  // ── sq_read_page ────────────────────────────────────────────────────────────
  server.registerTool('sq_read_page', {
    description:
      'Read all sections and blocks from a Squarespace page. Returns the page structure as JSON including text content, block types, and section layout.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (e.g. "my-site")'),
      pageSlug: z.string().describe('Page URL slug (e.g. "about", "home")'),
    },
  }, async ({ siteId, pageSlug }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const data = await client.getPageSections(ids.pageSectionsId);

      // Build a readable summary of sections and their blocks
      const summary = (data.sections ?? []).map((section: any, sIdx: number) => {
        const blocks = section.fluidEngineContext?.gridContents ?? [];
        return {
          sectionIndex: sIdx,
          sectionId: section.id,
          sectionName: section.sectionName ?? null,
          sectionTheme: section.styles?.sectionTheme ?? null,
          blocks: blocks.map((block: any, bIdx: number) => {
            const value = block.content?.value?.value ?? block.content?.value ?? {};
            const blockType = block.content?.value?.type ?? null;
            const result: Record<string, any> = {
              blockIndex: bIdx,
              blockId: block.content?.value?.id ?? null,
              type: blockType,
            };

            // Extract text content for text blocks (type 2)
            if (blockType === 2 && typeof value === 'string') {
              result.text = value;
            } else if (blockType === 2 && value?.html) {
              result.text = value.html;
            }

            // Extract button info (type 46 legacy)
            if (blockType === 46) {
              result.label = value?.label ?? null;
              result.url = value?.url ?? null;
            }

            // Extract button info (type 1337 new buttons)
            if (blockType === 1337 && value?.buttonText !== undefined) {
              result.buttonText = value.buttonText;
              result.buttonLink = value.buttonLink ?? null;
            }

            // Extract image info (type 1337 images)
            if (blockType === 1337 && value?.assetUrl !== undefined) {
              result.assetUrl = value.assetUrl;
              result.altText = value.altText ?? null;
            }

            // Extract audio info (type 41)
            if (blockType === 41) {
              result.title = value?.title ?? null;
              result.author = value?.iTunesAuthor ?? null;
              result.audioAssetId = value?.audioAssetId ?? null;
              result.designStyle = value?.designStyle ?? null;
              result.colorTheme = value?.colorTheme ?? null;
            }

            // Extract page link info (type 12)
            if (blockType === 12) {
              result.linkTitle = value?.linkTitle ?? null;
              result.linkTarget = value?.linkTarget ?? null;
              result.newWindow = value?.newWindow ?? false;
            }

            // Extract horizontal rule / search info (type 33 — shared type number)
            if (blockType === 33) {
              if (value?.collectionFilter) {
                result.blockType = 'search';
                result.targetCollectionId = value?.collectionId ?? null;
                result.searchPreview = value?.searchPreview ?? null;
                result.theme = value?.theme ?? null;
              } else {
                result.blockType = 'horizontal-rule';
              }
            }

            // Extract markdown info (type 44)
            if (blockType === 44) {
              result.markdownSource = value?.wysiwyg?.source ?? null;
              result.html = value?.html ?? null;
            }

            // Extract summary info (type 55)
            if (blockType === 55) {
              result.targetCollectionId = value?.collectionId ?? null;
              result.design = value?.design ?? null;
              result.headerText = value?.headerText ?? null;
              result.pageSize = value?.pageSize ?? null;
              result.showTitle = value?.showTitle ?? null;
              result.showThumbnail = value?.showThumbnail ?? null;
              result.showExcerpt = value?.showExcerpt ?? null;
            }

            // Extract product info (type 1337 with product definitionName)
            if (blockType === 1337 && block.content?.value?.definitionName === 'website.components.product') {
              result.productId = value?.productId ?? null;
              result.showTitle = value?.showTitle ?? null;
              result.showPrice = value?.showPrice ?? null;
              result.showBuyButton = value?.showBuyButton ?? null;
              result.showImage = value?.showImage ?? null;
              result.alignment = value?.alignment ?? null;
            }

            // Extract menu info (type 18)
            if (blockType === 18) {
              result.menuTabCount = value?.menus?.length ?? 0;
              result.raw = value?.raw?.substring(0, 200) ?? null;
            }

            return result;
          }),
        };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ pageSlug, sectionCount: summary.length, sections: summary }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_text ──────────────────────────────────────────────────────────
  server.registerTool('sq_update_text', {
    description:
      'Update text on a Squarespace page. Finds the block containing searchText and replaces it. Use mode="patch" for surgical substring replacement (safer) or mode="replace" for full block replacement.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find in the page (matches against block content)'),
      newText: z.string().describe('New text to replace with'),
      mode: z.enum(['replace', 'patch']).default('patch').describe('patch = surgical substring replacement (safer), replace = full block replacement'),
    },
  }, async ({ siteId, pageSlug, searchText, newText, mode }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      let result;
      if (mode === 'patch') {
        result = await client.patchTextBlock(ids.pageSectionsId, ids.collectionId, searchText, newText);
      } else {
        result = await client.updateTextBlock(ids.pageSectionsId, ids.collectionId, searchText, newText);
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

  // ── sq_update_html ──────────────────────────────────────────────────────────
  server.registerTool('sq_update_html', {
    description:
      'Replace a text block\'s HTML directly. Finds the block containing searchText and sets its HTML to the provided value. Use this when you need precise HTML control (e.g. rich formatting, links, lists).',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find in the page (matches against block content)'),
      html: z.string().describe('Raw HTML to set as the block content'),
    },
  }, async ({ siteId, pageSlug, searchText, html }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateTextBlockHtml(ids.pageSectionsId, ids.collectionId, searchText, html);

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

  // ── sq_patch_text ───────────────────────────────────────────────────────────
  server.registerTool('sq_patch_text', {
    description:
      'Surgical substring replacement within a text block. Finds the block containing searchText and replaces just that substring, preserving surrounding HTML and formatting.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Exact substring to find and replace'),
      newText: z.string().describe('Replacement text'),
    },
  }, async ({ siteId, pageSlug, searchText, newText }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.patchTextBlock(ids.pageSectionsId, ids.collectionId, searchText, newText);

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

  // ── sq_format_text ──────────────────────────────────────────────────────────
  server.registerTool('sq_format_text', {
    description:
      'Apply formatting to an existing text block. Finds the block, strips its current HTML to plain text, re-wraps with the specified formatting, and writes back.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find in the page (matches against block content)'),
      format: z.object({
        tag: z.enum(['h1', 'h2', 'h3', 'h4', 'p']).optional().describe('HTML tag to wrap with'),
        alignment: z.enum(['left', 'center', 'right']).optional().describe('Text alignment'),
        bold: z.boolean().optional().describe('Apply bold formatting'),
        italic: z.boolean().optional().describe('Apply italic formatting'),
      }).describe('Formatting options to apply'),
    },
  }, async ({ siteId, pageSlug, searchText, format }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      // Step 1: Get page sections and find the block
      const data = await client.getPageSections(ids.pageSectionsId);
      const match = client.findBlock(data.sections, searchText);
      if (!match) {
        return {
          content: [{ type: 'text' as const, text: `Error: No block found containing "${searchText}"` }],
          isError: true,
        };
      }

      // Step 2: Extract current HTML and strip to plain text
      const blockValue = match.gridContent.content?.value;
      const currentHtml = blockValue?.value?.html ?? blockValue?.value?.source ?? '';
      const plainText = currentHtml
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();

      // Step 3: Apply formatting via formatHtml
      const formattedHtml = client.formatHtml(plainText, format);

      // Step 4: Write back via updateTextBlockHtml
      const result = await client.updateTextBlockHtml(ids.pageSectionsId, ids.collectionId, searchText, formattedHtml);

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

  // ── sq_add_text ─────────────────────────────────────────────────────────────
  server.registerTool('sq_add_text', {
    description:
      'Add a new text block to a section. The block is appended below existing blocks in the specified section.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the block to'),
      html: z.string().describe('HTML content for the new text block'),
      layout: z.object({
        columns: z.number().optional().describe('Column span (default: full width = 24)'),
        gapRows: z.number().optional().describe('Gap rows above the block (default: 2, 0 for first block)'),
        rowHeight: z.number().optional().describe('Row height (default: 3)'),
      }).optional().describe('Optional layout overrides'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, html, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.addTextBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, html, layout);

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

  // ── sq_update_footer_text ───────────────────────────────────────────────────
  server.registerTool('sq_update_footer_text', {
    description:
      'Edit text in the site footer. Surgical find-and-replace — finds a substring in the footer and replaces only that portion. No page slug needed (footer is site-wide).',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      searchText: z.string().describe('Text to find in the footer'),
      newText: z.string().describe('Replacement text'),
    },
  }, async ({ siteId, searchText, newText }) => {
    try {
      const client = getClient(siteId);
      const result = await client.patchFooterTextBlock(searchText, newText);

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

  // ── sq_update_header_text ──────────────────────────────────────────────────
  server.registerTool('sq_update_header_text', {
    description:
      'Edit text in the site header. Surgical find-and-replace — finds a substring in the header and replaces only that portion. No page slug needed (header is site-wide).',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      searchText: z.string().describe('Text to find in the header'),
      newText: z.string().describe('Replacement text'),
    },
  }, async ({ siteId, searchText, newText }) => {
    try {
      const client = getClient(siteId);
      const result = await client.patchHeaderTextBlock(searchText, newText);

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
