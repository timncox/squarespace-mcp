/**
 * MCP Tools — Menu Parsing & Diffing
 *
 * sq_parse_pdf_menu: Download/read a PDF menu, extract text, use Claude AI to structure as menu JSON
 * sq_parse_menu_image: Extract menu items from an image using Claude's vision capabilities
 * sq_diff_menu: Compare current menu block content against new menu text and show changes
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds } from '../session.js';
import { parseMenuText } from '../../services/menu-parser.js';
import type { MenuTab } from '../../services/menu-parser.js';

// ── Shared prompt for structuring menu text into JSON ────────────────────────

const MENU_STRUCTURE_PROMPT = `You are a menu parser. Given the following raw text extracted from a restaurant menu, parse it into structured JSON.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "tabs": [
    {
      "title": "Tab Name (e.g. Lunch, Dinner, Drinks)",
      "description": null,
      "sections": [
        {
          "title": "Section Name (e.g. Appetizers, Mains)",
          "description": null,
          "items": [
            {
              "title": "Item Name",
              "description": "Item description or null",
              "price": "price as string without $ sign, or null if no price"
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- If there are no clear tab divisions, use a single tab with the restaurant name or "Menu" as the title.
- Group items into logical sections (appetizers, mains, desserts, drinks, etc.)
- Preserve all items, descriptions, and prices exactly as written.
- If an item has no price, set price to null.
- If an item has multiple price variants (e.g. small/large), use the format "12/18".
- Return ONLY the JSON object, nothing else.

Here is the menu text:
`;

// ── Helper: run claude -p to structure menu text ─────────────────────────────

function structureMenuWithClaude(rawText: string): { tabs: MenuTab[] } | null {
  try {
    const result = execSync(
      `claude -p --bare --model sonnet`,
      {
        input: MENU_STRUCTURE_PROMPT + rawText,
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      },
    );

    // Try to extract JSON from the response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.tabs || !Array.isArray(parsed.tabs)) return null;

    // Convert the simplified format to MenuTab[] format
    const tabs: MenuTab[] = parsed.tabs.map((tab: any) => ({
      title: tab.title || 'Menu',
      description: tab.description || null,
      sections: (tab.sections || []).map((section: any) => ({
        title: section.title || null,
        description: section.description || null,
        items: (section.items || []).map((item: any) => ({
          title: item.title || '',
          description: item.description || null,
          variants: item.price
            ? item.price.split('/').map((p: string) => ({ price: p.trim() }))
            : [],
        })),
      })),
    }));

    return { tabs };
  } catch {
    return null;
  }
}

// ── Helper: download file from URL ───────────────────────────────────────────

async function downloadToTemp(url: string, extension: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const tempPath = join(tmpdir(), `sq-menu-${Date.now()}${extension}`);
  writeFileSync(tempPath, buffer);
  return tempPath;
}

// ── Tool registration ────────────────────────────────────────────────────────

export function registerMenuParserTools(server: McpServer) {

  // ── sq_parse_pdf_menu ────────────────────────────────────────────────────────
  server.registerTool('sq_parse_pdf_menu', {
    description:
      'Parse a PDF menu file into structured menu JSON. Accepts a URL to download or a local file path. ' +
      'First attempts rule-based parsing; if that fails, uses Claude AI to structure the text. ' +
      'Returns MenuTab[] JSON ready for sq_update_menu.',
    inputSchema: {
      pdfUrl: z.string().optional().describe('URL to a PDF menu file (will be downloaded). Provide this OR filePath.'),
      filePath: z.string().optional().describe('Absolute path to a PDF file on disk. Provide this OR pdfUrl.'),
    },
  }, async ({ pdfUrl, filePath }) => {
    try {
      // Validate: at least one source required
      if (!pdfUrl && !filePath) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Provide either pdfUrl or filePath' }],
          isError: true,
        };
      }

      let buffer: Buffer;
      let tempPath: string | null = null;

      if (pdfUrl) {
        // Download PDF from URL
        tempPath = await downloadToTemp(pdfUrl, '.pdf');
        buffer = readFileSync(tempPath);
      } else {
        if (!existsSync(filePath!)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File does not exist: ${filePath}` }],
            isError: true,
          };
        }
        buffer = readFileSync(filePath!);
      }

      // Extract text from PDF
      const { extractPdfText } = await import('../../services/pdf-extractor.js');
      const { text, numPages } = await extractPdfText(buffer);

      // Clean up temp file
      if (tempPath) {
        try { unlinkSync(tempPath); } catch { /* best-effort */ }
      }

      // Step 1: Try rule-based parsing
      const menus = parseMenuText(text);
      if (menus.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ parsed: true, method: 'rule-based', menus, numPages }, null, 2),
          }],
        };
      }

      // Step 2: Fall back to Claude AI structuring
      const aiResult = structureMenuWithClaude(text);
      if (aiResult && aiResult.tabs.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ parsed: true, method: 'ai', menus: aiResult.tabs, numPages }, null, 2),
          }],
        };
      }

      // Step 3: Return raw text if all parsing fails
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ parsed: false, rawText: text, numPages }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_parse_menu_image ──────────────────────────────────────────────────────
  server.registerTool('sq_parse_menu_image', {
    description:
      'Extract menu items from an image using Claude AI vision. Downloads the image and uses ' +
      'Claude CLI to read and structure the menu content. Returns MenuTab[] JSON ready for sq_update_menu.',
    inputSchema: {
      imageUrl: z.string().describe('URL to a menu image (JPG, PNG, WebP). Will be downloaded and analyzed.'),
    },
  }, async ({ imageUrl }) => {
    try {
      // Determine extension from URL
      const urlPath = new URL(imageUrl).pathname.toLowerCase();
      let ext = '.jpg';
      if (urlPath.endsWith('.png')) ext = '.png';
      else if (urlPath.endsWith('.webp')) ext = '.webp';
      else if (urlPath.endsWith('.gif')) ext = '.gif';

      // Download image to temp file
      const tempPath = await downloadToTemp(imageUrl, ext);

      try {
        // Use Claude CLI with the image — pipe prompt via stdin and pass image via Read tool
        const prompt = `Look at this image of a restaurant menu. Extract ALL menu items with their names, descriptions, and prices.

Return ONLY valid JSON (no markdown fences, no explanation) with this exact structure:
{
  "tabs": [
    {
      "title": "Tab Name",
      "description": null,
      "sections": [
        {
          "title": "Section Name",
          "description": null,
          "items": [
            {
              "title": "Item Name",
              "description": "Description or null",
              "price": "price without $ sign, or null"
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- Read every item visible in the image.
- Group items into logical sections.
- Preserve exact names, descriptions, and prices.
- If no clear tab divisions exist, use a single tab titled "Menu".
- For multiple price variants use "12/18" format.
- Return ONLY the JSON.

The image is at: ${tempPath}
Please read and analyze it.`;

        // Shell out to claude CLI — it can read images via its Read tool
        const result = execSync(
          `claude -p --bare --model sonnet --allowedTools "Read"`,
          {
            input: prompt,
            encoding: 'utf-8',
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env },
          },
        );

        // Parse the JSON response
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ parsed: false, rawText: result.trim(), error: 'Could not extract JSON from AI response' }, null, 2),
            }],
          };
        }

        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.tabs || !Array.isArray(parsed.tabs)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ parsed: false, rawText: result.trim(), error: 'AI response did not contain tabs array' }, null, 2),
            }],
          };
        }

        // Convert to MenuTab[] format
        const tabs: MenuTab[] = parsed.tabs.map((tab: any) => ({
          title: tab.title || 'Menu',
          description: tab.description || null,
          sections: (tab.sections || []).map((section: any) => ({
            title: section.title || null,
            description: section.description || null,
            items: (section.items || []).map((item: any) => ({
              title: item.title || '',
              description: item.description || null,
              variants: item.price
                ? item.price.split('/').map((p: string) => ({ price: p.trim() }))
                : [],
            })),
          })),
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ parsed: true, method: 'vision-ai', menus: tabs }, null, 2),
          }],
        };
      } finally {
        // Clean up temp file
        try { unlinkSync(tempPath); } catch { /* best-effort */ }
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_diff_menu ─────────────────────────────────────────────────────────────
  server.registerTool('sq_diff_menu', {
    description:
      'Compare current menu block content on a Squarespace page against new menu text. ' +
      'Shows added items, removed items, and price changes. Useful for reviewing menu updates before applying them.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the menu'),
      searchText: z.string().describe('Text to find the menu block (e.g. menu item name or tab title)'),
      newMenuText: z.string().describe('New menu content in Squarespace text format (tabs with ========, sections with ------, items with $price)'),
    },
  }, async ({ siteId, pageSlug, searchText, newMenuText }) => {
    try {
      // Read current menu from the site
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return {
          content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }],
          isError: true,
        };
      }

      const client = getClient(siteId);
      const currentMenu = await client.getMenuBlock(ids.pageSectionsId, searchText);
      if (!currentMenu.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${currentMenu.error ?? 'Menu block not found'}` }],
          isError: true,
        };
      }

      // Build item maps from current menu
      const oldItems = flattenMenuItems(currentMenu.menus || []);
      // Parse the new menu text
      const newMenus = parseMenuText(newMenuText);
      const newItems = flattenMenuItems(newMenus);

      // Build lookup maps by normalized title
      const oldMap = new Map<string, FlatItem>();
      for (const item of oldItems) {
        oldMap.set(item.key, item);
      }
      const newMap = new Map<string, FlatItem>();
      for (const item of newItems) {
        newMap.set(item.key, item);
      }

      // Find differences
      const added: FlatItem[] = [];
      const removed: FlatItem[] = [];
      const priceChanged: Array<{ title: string; section: string; tab: string; oldPrice: string; newPrice: string }> = [];
      const unchanged: FlatItem[] = [];

      // Items in new but not in old = added
      for (const [key, item] of newMap) {
        if (!oldMap.has(key)) {
          added.push(item);
        }
      }

      // Items in old but not in new = removed
      for (const [key, item] of oldMap) {
        if (!newMap.has(key)) {
          removed.push(item);
        }
      }

      // Items in both — check for price changes
      for (const [key, newItem] of newMap) {
        const oldItem = oldMap.get(key);
        if (oldItem) {
          if (oldItem.price !== newItem.price) {
            priceChanged.push({
              title: newItem.title,
              section: newItem.section,
              tab: newItem.tab,
              oldPrice: oldItem.price || '(no price)',
              newPrice: newItem.price || '(no price)',
            });
          } else {
            unchanged.push(newItem);
          }
        }
      }

      const summary = {
        totalOldItems: oldItems.length,
        totalNewItems: newItems.length,
        added: added.map(i => ({ title: i.title, section: i.section, tab: i.tab, price: i.price })),
        removed: removed.map(i => ({ title: i.title, section: i.section, tab: i.tab, price: i.price })),
        priceChanged,
        unchangedCount: unchanged.length,
        oldTabs: (currentMenu.menus || []).map((t: any) => t.title),
        newTabs: newMenus.map(t => t.title),
      };

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(summary, null, 2),
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

// ── Menu diff helper types and functions ─────────────────────────────────────

interface FlatItem {
  key: string;      // normalized title for matching
  title: string;
  description: string | null;
  price: string;    // joined variant prices
  section: string;
  tab: string;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function flattenMenuItems(menus: MenuTab[]): FlatItem[] {
  const items: FlatItem[] = [];
  for (const tab of menus) {
    for (const section of tab.sections) {
      for (const item of section.items) {
        const price = (item.variants || []).map(v => v.price).join('/');
        items.push({
          key: normalizeTitle(item.title),
          title: item.title,
          description: item.description,
          price,
          section: section.title || '(untitled)',
          tab: tab.title,
        });
      }
    }
  }
  return items;
}
