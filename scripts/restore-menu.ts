/**
 * Restore the Smyth Tavern menu block with the complete menu from /tmp/menu-content.txt.
 *
 * The menu block (type 18) stores structured JSON: { menus: [{title, sections: [{title, items}]}], raw, menuStyle, currencySymbol }
 * This script parses the plain-text menu format into that structure and saves via Content Save API.
 */

import { ContentSaveClient } from '../src/services/content-save.js';
import { readFileSync } from 'fs';

const subdomain = 'grey-yellow-hbxc';
const PAGES_SECTIONS_ID = '6993497ab23b0453e46b656b';

// ── Parse the plain-text menu format ────────────────────────────────────────

interface MenuItem {
  title: string;
  description: string | null;
  variants: Array<{ price: string }>;
}

interface MenuSection {
  title: string | null;
  description: string | null;
  items: MenuItem[];
}

interface MenuTab {
  title: string;
  description: string | null;
  sections: MenuSection[];
}

function findNextNonEmpty(lines: string[], startIdx: number): string | null {
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim() !== '') return lines[i].trim();
  }
  return null;
}

function parseMenuText(text: string): MenuTab[] {
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

      // Extract title — might include price like "Power Lunch $28"
      let tabTitle = line.trim();

      currentTab = { title: tabTitle, description: null, sections: [] };
      tabs.push(currentTab);
      i += 2; // skip the === line

      // Check if next non-empty line is a tab description (not a section header or item)
      // Tab descriptions are things like "Offered Monday thru Friday" or "3pm To 6:30 Daily"
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
            // Check if next line is a price or empty then price (item pattern)
            // If it looks like a standalone descriptive line (not followed by a price), it's a description
            const lineAfterBlanks = findNextNonEmpty(lines, i + 1);
            if (lineAfterBlanks && lineAfterBlanks.match(/^\$/)) {
              // Next meaningful line is a price — this is an item, not description
              // Don't consume as description
            } else {
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

    // Option/add-on line: starts with +
    if (line.trim().startsWith('+')) {
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
      currentItem = {
        title: line.trim(),
        description: null,
        variants: [],
      };
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Read the desired menu content
  const menuText = readFileSync('/tmp/menu-content.txt', 'utf-8');
  // Skip the first line which is the instruction text
  const menuContentStart = menuText.indexOf('Breakfast\n========');
  if (menuContentStart === -1) {
    console.error('Could not find menu start marker in /tmp/menu-content.txt');
    return;
  }
  const cleanMenuText = menuText.substring(menuContentStart);

  // Parse into structured format
  const menus = parseMenuText(cleanMenuText);
  console.log(`Parsed ${menus.length} menu tabs:`);
  for (const tab of menus) {
    const itemCount = tab.sections.reduce((sum, s) => sum + s.items.length, 0);
    console.log(`  ${tab.title}: ${tab.sections.length} sections, ${itemCount} items`);
  }

  // Connect to API
  const client = new ContentSaveClient(subdomain);
  client.loadSessionCookies();

  // Read current sections
  const data = await client.getPageSections(PAGES_SECTIONS_ID);
  const sections = data.sections || [];
  console.log(`\nFetched ${sections.length} sections`);

  // Find the menu block (type 18) in fluidEngineContext
  const section = sections[0] as any;
  const gridContents = section?.fluidEngineContext?.gridContents;
  if (!gridContents) {
    console.error('No gridContents found in section');
    return;
  }

  let menuBlockIndex = -1;
  for (let i = 0; i < gridContents.length; i++) {
    if (gridContents[i].content?.value?.type === 18) {
      menuBlockIndex = i;
      break;
    }
  }

  if (menuBlockIndex === -1) {
    console.error('Menu block (type 18) not found');
    return;
  }

  const menuBlock = gridContents[menuBlockIndex];
  const currentValue = menuBlock.content.value.value;
  console.log(`\nCurrent menu: ${currentValue.menus?.length || 0} tabs`);
  console.log('menuStyle:', currentValue.menuStyle);
  console.log('currencySymbol:', currentValue.currencySymbol);

  // Preserve existing style/currency settings, update menus
  const updatedValue = {
    ...currentValue,
    menus,
  };

  // Update the block value
  menuBlock.content.value.value = updatedValue;

  // Also update the 'raw' field if it exists (plain text representation)
  // The raw field helps Squarespace render the menu
  // We'll set it to null and let Squarespace regenerate it

  console.log(`\nUpdating menu block with ${menus.length} tabs...`);

  // Get the collection ID for saving
  const collectionId = data.collectionId || '6993497ab23b0453e46b656c';
  console.log('Collection ID:', collectionId);

  // Save
  const result = await client.savePageSections(PAGES_SECTIONS_ID, collectionId, sections);
  console.log('Save result:', result);

  if (result.success) {
    console.log('\n✅ Menu restored successfully!');
    console.log(`Updated with ${menus.length} tabs:`);
    for (const tab of menus) {
      const itemCount = tab.sections.reduce((sum, s) => sum + s.items.length, 0);
      console.log(`  ${tab.title}: ${tab.sections.length} sections, ${itemCount} items`);
    }
  } else {
    console.error('\n❌ Save failed:', result.error);
  }
}

main().catch(e => {
  console.error('Error:', e.message);
  console.error(e.stack);
});
