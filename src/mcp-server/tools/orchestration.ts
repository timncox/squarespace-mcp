/**
 * MCP Tools — Orchestration (high-level multi-step workflows)
 *
 * sq_import_menu_from_url: Fetch a restaurant URL, find PDF menus, parse them, create menu page
 * sq_bulk_operation: Run the same operation across multiple sites
 * sq_auto_chunk_wine_list: Parse a wine list PDF and add it as a summarized menu tab
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds } from '../session.js';
import { execSync } from 'child_process';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch a URL and return the HTML body text.
 */
async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SquarespaceMCP/1.0)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Download a binary resource (e.g. PDF) as a Buffer.
 */
async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SquarespaceMCP/1.0)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Find PDF links on a page. Looks for:
 * - href patterns containing .pdf
 * - /s/*.pdf patterns (Squarespace file hosting)
 * - Links with menu-related text (dinner, lunch, brunch, drinks, wine, menu, cocktail)
 */
function findPdfLinks(html: string, baseUrl: string): Array<{ url: string; label: string }> {
  const results: Array<{ url: string; label: string }> = [];
  const seen = new Set<string>();

  // Match all anchor tags with their href and inner text
  const anchorRe = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1];
    const rawLabel = match[2].replace(/<[^>]*>/g, '').trim();

    // Check if it's a PDF link
    const isPdf = /\.pdf(\?|$)/i.test(href);

    // Check if link text mentions menu-related keywords
    const menuKeywords = /\b(menu|dinner|lunch|brunch|drinks|wine|cocktail|beverage|food|dessert)\b/i;
    const hasMenuText = menuKeywords.test(rawLabel);

    if (isPdf || (hasMenuText && href)) {
      let fullUrl: string;
      try {
        fullUrl = new URL(href, baseUrl).href;
      } catch {
        continue;
      }

      // Only include PDF links or menu-keyword links that point to PDFs
      if (isPdf && !seen.has(fullUrl)) {
        seen.add(fullUrl);
        results.push({ url: fullUrl, label: rawLabel || 'menu' });
      }
    }
  }

  // Also scan for bare /s/*.pdf patterns (Squarespace file hosting)
  const sqFileRe = /\/s\/[^"'\s]+\.pdf/gi;
  let sqMatch: RegExpExecArray | null;
  while ((sqMatch = sqFileRe.exec(html)) !== null) {
    const href = sqMatch[0];
    let fullUrl: string;
    try {
      fullUrl = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (!seen.has(fullUrl)) {
      seen.add(fullUrl);
      results.push({ url: fullUrl, label: 'menu' });
    }
  }

  return results;
}

/**
 * Use claude -p to structure raw PDF text into menu sections.
 * Returns structured JSON for a single menu tab.
 */
function structureMenuWithClaude(rawText: string, label: string): {
  title: string;
  description: string | null;
  sections: Array<{
    title: string | null;
    items: Array<{
      title: string;
      description: string | null;
      variants: Array<{ price: string }>;
    }>;
  }>;
} {
  const prompt = `You are a menu parser. Given the following raw text extracted from a restaurant menu PDF, structure it into JSON.

Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "title": "${label}",
  "description": null,
  "sections": [
    {
      "title": "Section Name (e.g. Appetizers, Mains, etc.) or null if no section header",
      "items": [
        {
          "title": "Item Name",
          "description": "Item description or null",
          "variants": [{"price": "$XX"}]
        }
      ]
    }
  ]
}

Rules:
- Extract item names, descriptions, and prices
- Group items under section headers if they exist
- Use null for missing descriptions
- Format prices with $ and no trailing zeros on whole dollar amounts
- If no clear sections, use a single section with title null
- Keep the original item names — do not translate or modify them

Raw menu text:
${rawText}`;

  try {
    const result = execSync(
      `claude -p "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      { encoding: 'utf-8', timeout: 60_000, maxBuffer: 1024 * 1024 },
    );

    // Extract JSON from the response — handle markdown code fences
    let jsonStr = result.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    return JSON.parse(jsonStr);
  } catch (err) {
    // If Claude CLI fails, return a basic structure with the raw text
    return {
      title: label,
      description: null,
      sections: [{
        title: null,
        items: [{
          title: label,
          description: rawText.substring(0, 200),
          variants: [],
        }],
      }],
    };
  }
}

/**
 * Use claude -p to categorize and summarize a wine list.
 */
function summarizeWineListWithClaude(rawText: string, maxItems: number): {
  title: string;
  description: string | null;
  sections: Array<{
    title: string | null;
    items: Array<{
      title: string;
      description: string | null;
      variants: Array<{ price: string }>;
    }>;
  }>;
} {
  const prompt = `You are a wine list curator. Given the following raw text extracted from a wine list PDF, create a curated summary.

Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "title": "Wine List",
  "description": null,
  "sections": [
    {
      "title": "Category (e.g. Sparkling, White, Red, Rose, Dessert)",
      "items": [
        {
          "title": "Wine Name, Region, Year",
          "description": "Brief tasting note or grape variety",
          "variants": [{"price": "$XX"}]
        }
      ]
    }
  ]
}

Rules:
- Categorize wines into standard sections (Sparkling, White, Red, Rose, Dessert, etc.)
- Pick up to ${maxItems} highlight wines per section — choose a range of price points
- Include the wine name, region/appellation, and vintage year in the title
- Keep descriptions brief (grape variety, tasting character)
- Format prices with $ — use glass/bottle format if both exist (e.g. "$16/$64")
- If a section has fewer than ${maxItems} wines, include all of them

Raw wine list text:
${rawText}`;

  try {
    const result = execSync(
      `claude -p "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
      { encoding: 'utf-8', timeout: 60_000, maxBuffer: 1024 * 1024 },
    );

    let jsonStr = result.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    return JSON.parse(jsonStr);
  } catch (err) {
    return {
      title: 'Wine List',
      description: null,
      sections: [{
        title: null,
        items: [{
          title: 'Wine List',
          description: rawText.substring(0, 200),
          variants: [],
        }],
      }],
    };
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerOrchestrationTools(server: McpServer) {

  // ── sq_import_menu_from_url ────────────────────────────────────────────────
  server.registerTool('sq_import_menu_from_url', {
    description:
      'One-command menu import: fetch a restaurant website URL, find all PDF menus, parse them, ' +
      'and create a menu page with a menu block on the target Squarespace site. ' +
      'Finds PDF links by looking for .pdf hrefs and /s/*.pdf patterns. ' +
      'Each PDF becomes a tab in the menu block.',
    inputSchema: {
      url: z.string().describe('Restaurant website URL (e.g. https://www.seahorsenyc.com)'),
      siteId: z.string().describe('Target Squarespace site identifier'),
      pageSlug: z.string().optional().describe('Existing page slug to add menu to. Creates a new page if not provided.'),
      pageTitle: z.string().optional().describe('Title for new page (default: "Menus"). Ignored if pageSlug is provided.'),
    },
  }, async ({ url, siteId, pageSlug, pageTitle }) => {
    try {
      const steps: string[] = [];

      // Step 1: Fetch the restaurant website
      steps.push(`Fetching ${url}...`);
      const html = await fetchHtml(url);

      // Step 2: Find PDF links
      const pdfLinks = findPdfLinks(html, url);
      steps.push(`Found ${pdfLinks.length} PDF link(s): ${pdfLinks.map(l => l.label).join(', ')}`);

      if (pdfLinks.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'No PDF menu links found on the page',
              steps,
              suggestion: 'Try providing a direct URL to the menu page, or check if the restaurant uses inline menus instead of PDFs.',
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Step 3: Download and parse each PDF
      const { extractPdfText } = await import('../../services/pdf-extractor.js');
      const { parseMenuText } = await import('../../services/menu-parser.js');

      const menuTabs: Array<{
        title: string;
        description: string | null;
        sections: Array<{
          title: string | null;
          items: Array<{
            title: string;
            description: string | null;
            variants: Array<{ price: string }>;
          }>;
        }>;
      }> = [];

      for (const link of pdfLinks) {
        try {
          steps.push(`Downloading PDF: ${link.label} (${link.url})`);
          const pdfBuffer = await downloadBuffer(link.url);

          steps.push(`Extracting text from ${link.label}...`);
          const { text } = await extractPdfText(pdfBuffer);

          // Try the built-in parser first
          const parsed = parseMenuText(text);
          if (parsed.length > 0) {
            steps.push(`Built-in parser succeeded for ${link.label}: ${parsed.length} tab(s)`);
            menuTabs.push(...parsed);
          } else {
            // Fall back to Claude for structuring
            steps.push(`Using Claude to structure ${link.label}...`);
            const structured = structureMenuWithClaude(text, link.label);
            menuTabs.push(structured);
          }
        } catch (pdfErr) {
          steps.push(`Failed to process ${link.label}: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`);
        }
      }

      if (menuTabs.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: 'Could not parse any menu PDFs',
              steps,
            }, null, 2),
          }],
          isError: true,
        };
      }

      steps.push(`Parsed ${menuTabs.length} menu tab(s) total`);

      // Step 4: Create or resolve page
      const client = getClient(siteId);
      let resolvedSlug = pageSlug;

      if (!resolvedSlug) {
        const title = pageTitle || 'Menus';
        steps.push(`Creating new page: "${title}"...`);
        const createResult = await client.createPageViaApi(title, undefined, { navigation: 'mainNav' });
        if (!createResult.success) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: `Failed to create page: ${createResult.error}`,
                steps,
              }, null, 2),
            }],
            isError: true,
          };
        }
        resolvedSlug = createResult.urlId ?? 'menus';
        steps.push(`Created page with slug: ${resolvedSlug}`);
      }

      // Step 5: Resolve page IDs
      const ids = await resolvePageIds(siteId, resolvedSlug);
      if (!ids) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Could not resolve page "${resolvedSlug}" on site "${siteId}"`,
              steps,
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Step 6: Add a section with a text block (needed for menu block insertion)
      steps.push('Adding section to page...');
      const sectionResult = await client.addSectionWithBlocks(
        ids.pageSectionsId,
        ids.collectionId,
        [{ type: 'text', html: '<p>Menu</p>' }],
      );

      if (!sectionResult.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Failed to add section: ${sectionResult.error}`,
              steps,
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Step 7: Build menu text format and add menu block
      // We need the section index — it was appended, so it's the last section
      const pageData = await client.getPageSections(ids.pageSectionsId);
      const sectionIndex = pageData.sections.length - 1;

      steps.push(`Adding menu block to section ${sectionIndex}...`);

      // Build the plain-text menu format for the addMenuBlock API
      const menuTextParts: string[] = [];
      for (const tab of menuTabs) {
        menuTextParts.push(tab.title);
        menuTextParts.push('========');
        if (tab.description) {
          menuTextParts.push(tab.description);
        }
        menuTextParts.push('');
        for (const section of tab.sections) {
          if (section.title) {
            menuTextParts.push(section.title);
            menuTextParts.push('--------');
            menuTextParts.push('');
          }
          for (const item of section.items) {
            const pricePart = item.variants && item.variants.length > 0
              ? ` ${item.variants.map(v => v.price).join('/')}`
              : '';
            menuTextParts.push(`${item.title}${pricePart}`);
            if (item.description) {
              menuTextParts.push(item.description);
            }
            menuTextParts.push('');
          }
        }
      }
      const menuText = menuTextParts.join('\n');

      const menuResult = await client.addMenuBlock(
        ids.pageSectionsId,
        ids.collectionId,
        sectionIndex,
        menuText,
      );

      if (!menuResult.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Failed to add menu block: ${menuResult.error}`,
              steps,
            }, null, 2),
          }],
          isError: true,
        };
      }

      steps.push('Menu block created successfully');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            pageSlug: resolvedSlug,
            tabCount: menuTabs.length,
            tabNames: menuTabs.map(t => t.title),
            totalItems: menuTabs.reduce((sum, tab) =>
              sum + tab.sections.reduce((sSum, sec) => sSum + sec.items.length, 0), 0),
            blockId: menuResult.blockId,
            steps,
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

  // ── sq_bulk_operation ──────────────────────────────────────────────────────
  server.registerTool('sq_bulk_operation', {
    description:
      'Run the same operation across multiple Squarespace sites. ' +
      'Loops over siteIds, executes the operation for each, and returns aggregate results. ' +
      'Supported operations: "list_pages" (list all pages), "read_page" (read a page — requires params.pageSlug), ' +
      '"update_menu" (update menu block — requires params.pageSlug, params.searchText, params.menus).',
    inputSchema: {
      siteIds: z.array(z.string()).describe('List of site identifiers to operate on'),
      operation: z.enum(['list_pages', 'read_page', 'update_menu']).describe('Operation to run on each site'),
      params: z.record(z.unknown()).optional().describe('Parameters passed to each operation (e.g. { pageSlug: "menus", searchText: "Dinner" })'),
    },
  }, async ({ siteIds, operation, params }) => {
    const results: Array<{ siteId: string; status: 'success' | 'error'; data?: unknown; error?: string }> = [];

    for (const siteId of siteIds) {
      try {
        const client = getClient(siteId);

        switch (operation) {
          case 'list_pages': {
            const [collections, navResult] = await Promise.all([
              client.listCollections(),
              client.getNavigation(),
            ]);

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

            const pages = collections
              .filter((c: any) => !c.deleted)
              .map((c: any) => ({
                id: c.id,
                urlId: c.urlId,
                title: c.title,
                type: c.type,
                typeName: c.typeName,
                status: c.deleted ? 'deleted' : mainNavIds.has(c.id) ? 'mainNav' : 'notLinked',
              }));

            results.push({ siteId, status: 'success', data: { pageCount: pages.length, pages } });
            break;
          }

          case 'read_page': {
            const pageSlug = params?.pageSlug as string;
            if (!pageSlug) {
              results.push({ siteId, status: 'error', error: 'params.pageSlug is required for read_page' });
              break;
            }

            const ids = await resolvePageIds(siteId, pageSlug);
            if (!ids) {
              results.push({ siteId, status: 'error', error: `Could not resolve page "${pageSlug}"` });
              break;
            }

            const data = await client.getPageSections(ids.pageSectionsId);
            const summary = (data.sections ?? []).map((section: any, sIdx: number) => {
              const blocks = section.fluidEngineContext?.gridContents ?? [];
              return {
                sectionIndex: sIdx,
                sectionId: section.id,
                blockCount: blocks.length,
              };
            });

            results.push({ siteId, status: 'success', data: { sectionCount: summary.length, sections: summary } });
            break;
          }

          case 'update_menu': {
            const pageSlug = params?.pageSlug as string;
            const searchText = params?.searchText as string;
            const menus = params?.menus as any[];

            if (!pageSlug || !searchText || !menus) {
              results.push({
                siteId,
                status: 'error',
                error: 'params.pageSlug, params.searchText, and params.menus are required for update_menu',
              });
              break;
            }

            const ids = await resolvePageIds(siteId, pageSlug);
            if (!ids) {
              results.push({ siteId, status: 'error', error: `Could not resolve page "${pageSlug}"` });
              break;
            }

            const result = await client.updateMenuBlock(ids.pageSectionsId, ids.collectionId, searchText, menus);
            if (!result.success) {
              results.push({ siteId, status: 'error', error: result.error ?? 'Menu update failed' });
            } else {
              results.push({ siteId, status: 'success', data: result });
            }
            break;
          }
        }
      } catch (err) {
        results.push({
          siteId,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          summary: { total: siteIds.length, success: successCount, errors: errorCount },
          results,
        }, null, 2),
      }],
    };
  });

  // ── sq_auto_chunk_wine_list ────────────────────────────────────────────────
  server.registerTool('sq_auto_chunk_wine_list', {
    description:
      'Intelligently parse a wine list PDF and add it as a summarized menu tab. ' +
      'Downloads the PDF, uses Claude to categorize wines into sections (Sparkling, White, Red, etc.), ' +
      'picks highlights per section, and adds the result as a new tab in an existing menu block.',
    inputSchema: {
      pdfUrl: z.string().describe('URL to wine list PDF'),
      siteId: z.string().describe('Target Squarespace site identifier'),
      pageSlug: z.string().describe('Page slug containing the menu block'),
      searchText: z.string().describe('Text to find the existing menu block (e.g. tab name or item name)'),
      maxItems: z.number().optional().describe('Max items per section (default: 10)'),
    },
  }, async ({ pdfUrl, siteId, pageSlug, searchText, maxItems }) => {
    try {
      const effectiveMaxItems = maxItems ?? 10;
      const steps: string[] = [];

      // Step 1: Download the PDF
      steps.push(`Downloading wine list PDF: ${pdfUrl}`);
      const pdfBuffer = await downloadBuffer(pdfUrl);

      // Step 2: Extract text
      steps.push('Extracting text from PDF...');
      const { extractPdfText } = await import('../../services/pdf-extractor.js');
      const { text, numPages } = await extractPdfText(pdfBuffer);
      steps.push(`Extracted ${text.length} chars from ${numPages} page(s)`);

      // Step 3: Use Claude to categorize and summarize
      steps.push(`Summarizing wine list (max ${effectiveMaxItems} items per section)...`);
      const wineTab = summarizeWineListWithClaude(text, effectiveMaxItems);
      steps.push(`Structured into ${wineTab.sections.length} section(s)`);

      // Step 4: Resolve page and find menu block
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Could not resolve page "${pageSlug}" on site "${siteId}"`,
              steps,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const client = getClient(siteId);

      // Step 5: Read existing menu and add the wine tab
      steps.push('Reading existing menu block...');
      const existing = await client.getMenuBlock(ids.pageSectionsId, searchText);
      if (!existing.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Menu block not found: ${existing.error}`,
              steps,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const menus = [...(existing.menus || [])];
      menus.push(wineTab);

      // Step 6: Write back
      steps.push('Adding wine list tab to menu block...');
      const result = await client.updateMenuBlock(ids.pageSectionsId, ids.collectionId, searchText, menus);
      if (!result.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Menu update failed: ${result.error}`,
              steps,
            }, null, 2),
          }],
          isError: true,
        };
      }

      const totalItems = wineTab.sections.reduce((sum, sec) => sum + sec.items.length, 0);
      steps.push(`Wine list tab added with ${totalItems} items across ${wineTab.sections.length} sections`);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            tabTitle: wineTab.title,
            sectionCount: wineTab.sections.length,
            sectionNames: wineTab.sections.map(s => s.title).filter(Boolean),
            totalItems,
            tabIndex: menus.length - 1,
            steps,
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
