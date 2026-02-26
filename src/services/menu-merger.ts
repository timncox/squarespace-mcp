/**
 * Menu content merger — uses Claude to intelligently merge menu changes
 * into an existing Squarespace menu block.
 *
 * The menu block format uses:
 *   Page Tab\n========\n  (creates tabs like Lunch, Dinner, etc.)
 *   Section\n-------\n    (creates section headers like Appetizers, Mains)
 *   Item Name\nDescription\n$Price  (menu items, separated by blank lines)
 *   + Option $Price              (item options/add-ons)
 */

import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_SONNET } from '../config/models.js';
import { logger } from '../utils/logger.js';
import type { MenuTab, MenuSection, MenuItem } from './menu-parser.js';
import { parseMenuText } from './menu-parser.js';

/**
 * Merge new menu content into an existing menu block.
 *
 * @param currentMenu  The full text of the existing menu block (all tabs)
 * @param updates      The new content to merge — could be raw PDF text, formatted menu text,
 *                     or instructions like "add a Breakfast tab with these items"
 * @returns            The complete merged menu text, ready to paste into the menu block
 */
export async function mergeMenuContent(
  currentMenu: string,
  updates: string,
): Promise<string> {
  logger.info(
    { currentMenuLength: currentMenu.length, updatesLength: updates.length },
    'Merging menu content via Claude',
  );

  const response = await getAnthropicClient().messages.create({
    model: MODEL_SONNET,
    max_tokens: 16384,
    system: MENU_MERGE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `## Current Menu Block Content\n\n${currentMenu}\n\n## Updates To Apply\n\n${updates}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const merged = textBlock?.type === 'text' ? textBlock.text : '';

  // Extract just the menu content if Claude wrapped it in markdown
  const cleaned = extractMenuFromResponse(merged);

  logger.info(
    { mergedLength: cleaned.length, inputLength: currentMenu.length },
    'Menu content merged',
  );

  return cleaned;
}

export function extractMenuFromResponse(response: string): string {
  // If wrapped in ```...```, extract the inner content
  const codeBlockMatch = response.match(/```(?:text|menu)?\s*\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // If the response starts with explanation text before the actual menu,
  // find where the menu content begins (first line with ========)
  const lines = response.split('\n');
  let menuStart = 0;

  // Look for the first menu page header (word followed by ========)
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 < lines.length && lines[i + 1].match(/^={3,}/)) {
      menuStart = i;
      break;
    }
  }

  if (menuStart > 0) {
    return lines.slice(menuStart).join('\n').trim();
  }

  return response.trim();
}

// ── Structured merge (deterministic, no LLM) ─────────────────────────────────

/**
 * Deterministic structured merge — no LLM needed.
 * Matches tabs/sections/items by title (case-insensitive).
 * Unmatched items from updates are appended.
 * For matched items, update values override current values (with null fallback to current).
 *
 * Deep clones all inputs — mutations don't affect originals.
 */
export function mergeMenuStructured(
  current: MenuTab[],
  updates: MenuTab[],
): MenuTab[] {
  // Deep clone to avoid mutation
  const result: MenuTab[] = structuredClone(current);

  for (const updateTab of updates) {
    const existingTab = result.find(
      t => t.title.toLowerCase() === updateTab.title.toLowerCase()
    );

    if (existingTab) {
      // Merge into existing tab
      // Update tab description if provided
      if (updateTab.description !== null) {
        existingTab.description = updateTab.description;
      }
      mergeSections(existingTab.sections, updateTab.sections);
    } else {
      // Append new tab
      result.push(structuredClone(updateTab));
    }
  }

  return result;
}

function mergeSections(current: MenuSection[], updates: MenuSection[]): void {
  for (const updateSection of updates) {
    const existingSection = current.find(
      s => (s.title ?? '').toLowerCase() === (updateSection.title ?? '').toLowerCase()
    );

    if (existingSection) {
      // Update section description if provided
      if (updateSection.description !== null) {
        existingSection.description = updateSection.description;
      }
      mergeItems(existingSection.items, updateSection.items);
    } else {
      // Append new section
      current.push(structuredClone(updateSection));
    }
  }
}

function mergeItems(current: MenuItem[], updates: MenuItem[]): void {
  for (const updateItem of updates) {
    const existingItem = current.find(
      i => i.title.toLowerCase() === updateItem.title.toLowerCase()
    );

    if (existingItem) {
      // Update description if provided, keep current if update is null
      if (updateItem.description !== null) {
        existingItem.description = updateItem.description;
      }
      // Update variants if provided
      if (updateItem.variants.length > 0) {
        existingItem.variants = structuredClone(updateItem.variants);
      }
    } else {
      // Append new item
      current.push(structuredClone(updateItem));
    }
  }
}

/**
 * Parse text updates into structured format, then merge with current menus.
 * Convenience wrapper around parseMenuText + mergeMenuStructured.
 */
export function mergeMenuFromText(
  currentMenus: MenuTab[],
  updateText: string,
): MenuTab[] {
  const updates = parseMenuText(updateText);
  return mergeMenuStructured(currentMenus, updates);
}

// ── System prompt ─────────────────────────────────────────────────────────────

const MENU_MERGE_SYSTEM_PROMPT = `You are a menu content merger for a Squarespace menu block. Your job is to take an existing menu and apply updates to produce the complete merged menu.

## Squarespace Menu Block Format

The menu block uses plain text with these conventions:

### Menu Pages (tabs)
Page names followed by a line of "=" create tabs:
\`\`\`
Lunch
========
Optional page description
\`\`\`

### Sections
Section names followed by a line of "-" create section headers:
\`\`\`
Appetizers
-------
Optional section description
\`\`\`

### Menu Items
Items have a title, optional description, and optional price. Separate items with a blank line:
\`\`\`
Grilled Salmon
Fresh Atlantic salmon with seasonal vegetables.
$28

Wagyu Burger
8oz patty with truffle aioli.
$24
+ Add Bacon $3
+ Add Egg $2
\`\`\`

## Your Task

Given the CURRENT menu block content and UPDATES to apply:

1. **Preserve** everything in the current menu that is NOT being changed
2. **Replace** sections/items that have updated versions in the updates
3. **Add** new sections/items/tabs that don't exist in the current menu
4. **Remove** only items/sections explicitly marked for removal in the updates
5. **Maintain** the exact formatting (=== for tabs, --- for sections, blank lines between items, + for options)

## Rules

- Output ONLY the complete merged menu text — no explanations, no markdown fences, no commentary
- Preserve the exact tab order unless the updates specify a different order
- Match items by name for replacement (case-insensitive)
- If the updates provide a complete replacement for a tab/section, replace the entire tab/section
- If the updates provide a complete menu (multiple tabs with ========), replace the entire menu
- Keep all pricing exactly as specified (from updates if changed, from current if not)
- Preserve all item options (+ lines) unless explicitly changed
- The output must be valid Squarespace menu block format`;
