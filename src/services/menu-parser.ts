/**
 * Menu parser service — parses Squarespace menu block plain-text format
 * into structured JSON, and serializes it back.
 *
 * The menu block (type 18) stores structured JSON:
 *   { menus: [{title, sections: [{title, items}]}], raw, menuStyle, currencySymbol }
 *
 * The plain-text format uses:
 *   Tab Name\n========\n    (creates tabs like Lunch, Dinner)
 *   Section Name\n-------\n  (creates section headers like Appetizers, Mains)
 *   Item Name\nDescription\n$Price  (menu items, separated by blank lines)
 *   + Option $Price                (item options/add-ons)
 *   +$5 Supplemental Fee           (supplemental fees)
 *
 * Extracted and refined from scripts/restore-menu.ts (battle-tested against
 * real Smyth Tavern menu with 7 tabs, ~100 items).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface MenuItem {
  title: string;
  description: string | null;
  variants: Array<{ price: string }>;
}

export interface MenuSection {
  title: string | null;
  description: string | null;
  items: MenuItem[];
}

export interface MenuTab {
  title: string;
  description: string | null;
  sections: MenuSection[];
}

// ── Private helpers ──────────────────────────────────────────────────────────

function findNextNonEmpty(lines: string[], startIdx: number): string | null {
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim() !== '') return lines[i].trim();
  }
  return null;
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a Squarespace menu block's plain-text format into structured MenuTab[].
 *
 * Handles: tab headers (========), section headers (-------), item prices ($),
 * multi-variant prices ($24/46), add-ons (+ prefix), supplemental fees (+$),
 * inline prices (Power Lunch $28), tab descriptions, multi-line descriptions.
 */
export function parseMenuText(text: string): MenuTab[] {
  if (!text || text.trim() === '') return [];

  const lines = text.split('\n');
  const tabs: MenuTab[] = [];
  let currentTab: MenuTab | null = null;
  let currentSection: MenuSection | null = null;
  let currentItem: MenuItem | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();
    const nextLine = i + 1 < lines.length ? lines[i + 1].trimEnd() : '';

    // Tab header: line followed by ======== (or =======)
    if (nextLine.match(/^={3,}$/)) {
      // Save any pending item
      if (currentItem && currentSection) {
        currentSection.items.push(currentItem);
        currentItem = null;
      }
      // Save pending section
      if (currentSection && currentTab) {
        currentTab.sections.push(currentSection);
        currentSection = null;
      }

      const tabTitle = line.trim();

      currentTab = { title: tabTitle, description: null, sections: [] };
      tabs.push(currentTab);
      i += 2; // skip the === line

      // Check if next non-empty line is a tab description (not a section header or item)
      while (i < lines.length && lines[i].trim() === '') i++;
      if (i < lines.length) {
        const peekLine = lines[i].trim();
        const peekNext = i + 1 < lines.length ? lines[i + 1].trimEnd() : '';
        // It's a section header if followed by -------
        const isNextSectionHeader = peekNext.match(/^-{3,}$/);
        // It's a tab header if followed by =======
        const isNextTabHeader = peekNext.match(/^={3,}$/);
        // It's a price line if starts with $
        const isPriceLine = peekLine.match(/^\$/);

        if (!isNextSectionHeader && !isNextTabHeader && !isPriceLine) {
          // Could be a description or could be an item title
          // Check if 2 lines ahead is ------- (meaning this line is a section header name)
          const peekNextNext = i + 2 < lines.length ? lines[i + 2].trimEnd() : '';
          if (!peekNextNext.match(/^-{3,}$/)) {
            // Check if a price line ($) appears within the next few non-empty lines.
            // If so, this line is an item title (part of title/description/$price pattern),
            // not a tab description. Tab descriptions are standalone lines not followed by prices.
            let hasPriceNearby = false;
            let searchIdx = i + 1;
            let nonEmptyCount = 0;
            while (searchIdx < lines.length && nonEmptyCount < 3) {
              const searchLine = lines[searchIdx].trim();
              if (searchLine !== '') {
                nonEmptyCount++;
                if (searchLine.match(/^\$/)) {
                  hasPriceNearby = true;
                  break;
                }
                // Stop if we hit a section/tab separator
                if (searchLine.match(/^[=-]{3,}$/)) break;
              }
              searchIdx++;
            }
            // Also check for inline price on the line itself
            if (peekLine.match(/\$\d+/)) {
              hasPriceNearby = true;
            }
            if (!hasPriceNearby) {
              currentTab.description = peekLine;
              i++;
            }
          }
        }
      }
      continue;
    }

    // Section header: line followed by -------
    if (nextLine.match(/^-{3,}$/)) {
      // Save pending item
      if (currentItem && currentSection) {
        currentSection.items.push(currentItem);
        currentItem = null;
      }
      // Save pending section
      if (currentSection && currentTab) {
        currentTab.sections.push(currentSection);
      }

      currentSection = { title: line.trim(), description: null, items: [] };
      i += 2; // skip the --- line
      continue;
    }

    // Empty line — might separate items
    if (line.trim() === '') {
      if (currentItem) {
        // Ensure we have a section to put this item in
        if (!currentSection && currentTab) {
          currentSection = { title: null, description: null, items: [] };
        }
        if (currentSection) {
          currentSection.items.push(currentItem);
          currentItem = null;
        }
      }
      i++;
      continue;
    }

    // Ensure we have a section for items that appear without a section header
    // (e.g., Kids Menu items or Happy Hour food items before "Cocktails" section)
    if (!currentSection && currentTab) {
      currentSection = { title: null, description: null, items: [] };
    }

    // Price line: starts with $ — handles "$24", "$24/46", "$2 Each", "$15/20/24"
    if (line.trim().match(/^\$[\d,.\/]+(\s+\w+)?$/)) {
      if (currentItem) {
        // Strip "$" and any trailing word like "Each"
        const priceStr = line.trim().replace(/^\$/, '').replace(/\s+\w+$/, '');
        // Handle $24/46 or $24/$46 or $15/20/24 format
        const prices = priceStr.split('/').map(p => p.replace('$', '').trim());
        currentItem.variants = prices.map(p => ({ price: p }));
      }
      i++;
      continue;
    }

    // Option/add-on line: starts with + (but not +$)
    if (line.trim().startsWith('+') && !line.trim().match(/^\+\$/)) {
      // These are add-on items like "+ Add Smoked Salmon $8" or "+ Double $7"
      // Parse as a separate item within the same section
      if (currentItem && currentSection) {
        currentSection.items.push(currentItem);
        currentItem = null;
      }

      const addOnText = line.trim().substring(1).trim(); // remove +
      const priceMatch = addOnText.match(/\$(\d+(?:\/\$?\d+)?)$/);
      if (priceMatch) {
        const itemTitle = addOnText.substring(0, addOnText.lastIndexOf('$')).trim();
        const prices = priceMatch[1].split('/').map(p => p.replace('$', '').trim());
        currentItem = {
          title: '+ ' + itemTitle,
          description: null,
          variants: prices.map(p => ({ price: p })),
        };
      } else {
        // No price, just a modifier text
        currentItem = {
          title: '+ ' + addOnText,
          description: null,
          variants: [],
        };
      }
      i++;
      continue;
    }

    // Supplemental fee line like "+$5 Supplemental Fee"
    if (line.trim().match(/^\+\$/)) {
      if (currentItem && currentSection) {
        currentSection.items.push(currentItem);
        currentItem = null;
      }
      const text = line.trim();
      const priceMatch = text.match(/\+\$(\d+)/);
      currentItem = {
        title: text,
        description: null,
        variants: priceMatch ? [{ price: priceMatch[1] }] : [],
      };
      i++;
      continue;
    }

    // Regular content line — could be an item title or description
    if (currentItem === null) {
      // New item — this line is the title
      // Check if the price is on the same line like "Power Lunch $28"
      // But only at the END of the line
      const inlinePriceMatch = line.trim().match(/^(.+?)\s+\$(\d+(?:\/\$?\d+)?)$/);
      if (inlinePriceMatch) {
        currentItem = {
          title: inlinePriceMatch[1].trim(),
          description: null,
          variants: inlinePriceMatch[2].split('/').map(p => ({ price: p.replace('$', '').trim() })),
        };
      } else {
        currentItem = {
          title: line.trim(),
          description: null,
          variants: [],
        };
      }
    } else if (currentItem.variants.length === 0) {
      // This line comes after the title but before a price — it's a description
      if (currentItem.description) {
        currentItem.description += ' ' + line.trim();
      } else {
        currentItem.description = line.trim();
      }
    } else {
      // Already have variants — this must be a new item
      if (currentSection) {
        currentSection.items.push(currentItem);
      }
      // Check for inline price on this new item too
      const newInlinePriceMatch = line.trim().match(/^(.+?)\s+\$(\d+(?:\/\$?\d+)?)$/);
      if (newInlinePriceMatch) {
        currentItem = {
          title: newInlinePriceMatch[1].trim(),
          description: null,
          variants: newInlinePriceMatch[2].split('/').map(p => ({ price: p.replace('$', '').trim() })),
        };
      } else {
        currentItem = {
          title: line.trim(),
          description: null,
          variants: [],
        };
      }
    }

    i++;
  }

  // Save any remaining items/sections
  if (currentItem && currentSection) {
    currentSection.items.push(currentItem);
  }
  if (currentSection && currentTab) {
    currentTab.sections.push(currentSection);
  }

  return tabs;
}

// ── Serializer ───────────────────────────────────────────────────────────────

/**
 * Serialize structured MenuTab[] back into the Squarespace plain-text menu format.
 *
 * Inverse of parseMenuText. Generates:
 *   - Tab headers: `Title\n========`
 *   - Tab descriptions on next line after ========
 *   - Section headers: `Title\n-------`
 *   - Items: `Title\nDescription\n$price` (separated by blank lines)
 *   - Multi-variant prices: `$24/46` format
 *   - Add-ons: `+ Title $price`
 *   - Supplemental fees: `+$N Description`
 *   - Items without section headers appear before any section headers in their tab
 */
export function serializeMenu(menus: MenuTab[]): string {
  if (!menus || menus.length === 0) return '';

  const parts: string[] = [];

  for (let tabIdx = 0; tabIdx < menus.length; tabIdx++) {
    const tab = menus[tabIdx];

    // Blank line between tabs (not before the first)
    if (tabIdx > 0) {
      parts.push('');
    }

    // Tab header
    parts.push(tab.title);
    parts.push('========');

    // Tab description
    if (tab.description) {
      parts.push(tab.description);
    }

    for (const section of (tab.sections || [])) {
      // Section header (skip for null-title sections — their items just appear directly)
      if (section.title !== null) {
        parts.push('');
        parts.push(section.title);
        parts.push('-------');
      }

      const items = section.items || [];
      for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx];
        const title = item.title || '';
        const variants = item.variants || [];

        // Blank line between items (and before the first item in a section)
        // But add-ons (+ prefix) are attached to the previous item — no blank line
        const isAddOn = title.startsWith('+ ');
        const isSupplemental = title.match(/^\+\$/);

        if (!isAddOn && !isSupplemental) {
          parts.push('');
        }

        // Supplemental fee: "+$5 Supplemental Fee" format — title is the full text
        if (isSupplemental) {
          parts.push(title);
          continue;
        }

        // Add-on item: "+ Title $price" on a single line
        if (isAddOn) {
          const titleWithoutPrefix = title.substring(2); // remove "+ "
          if (variants.length > 0) {
            const priceStr = '$' + variants.map(v => v.price).join('/');
            parts.push(`+ ${titleWithoutPrefix} ${priceStr}`);
          } else {
            parts.push(`+ ${titleWithoutPrefix}`);
          }
          continue;
        }

        // Regular item
        parts.push(title);

        // Description
        if (item.description) {
          parts.push(item.description);
        }

        // Price line
        if (variants.length > 0) {
          const priceStr = '$' + variants.map(v => v.price).join('/');
          parts.push(priceStr);
        }
      }
    }
  }

  return parts.join('\n');
}
