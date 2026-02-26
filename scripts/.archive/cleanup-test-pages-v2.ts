/**
 * Cleanup v2: Delete orphaned "New Page" entries via page settings.
 * Strategy: hover page item → gear icon → settings panel → scroll to Delete → confirm.
 * Uses scrollIntoViewIfNeeded + bounding box clicks for reliability.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const PAGES_TO_DELETE = [
  'New Page',
  'Delete Test',
  'Image Test',
  'Button Test',
  'Section Delete Test',
  'Image Upload Test',
  'Button URL Test',
];

async function listPages(page: any): Promise<string[]> {
  const items = page.locator('[data-test="pages-panel-item"]');
  const count = await items.count();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await items.nth(i).innerText().catch(() => '');
    names.push(text.trim());
  }
  return names;
}

async function deletePage(page: any, targetName: string): Promise<boolean> {
  // Navigate to pages panel fresh
  await page.goto('https://tim-cox.squarespace.com/config/pages', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(4000);

  const items = page.locator('[data-test="pages-panel-item"]');
  const count = await items.count();

  // Find the target page (search from bottom)
  let targetIndex = -1;
  for (let i = count - 1; i >= 0; i--) {
    const text = await items.nth(i).innerText().catch(() => '');
    if (text.trim() === targetName) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) {
    console.log(`  "${targetName}" not found in pages panel`);
    return false;
  }

  console.log(`  Found "${targetName}" at index ${targetIndex}`);
  const targetItem = items.nth(targetIndex);

  // Scroll the item into view
  await targetItem.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  // Hover to reveal the gear/settings icon
  await targetItem.hover();
  await page.waitForTimeout(1000);

  // The settings gear icon appears on hover — find it relative to the hovered item
  // Strategy 1: Find the gear icon button that appeared after hover
  const gearSelectors = [
    'button[aria-label="Settings"]',
    'button[data-testid="settings-icon"]',
    '[data-testid="settings-icon"]',
    'button[aria-label="Page Settings"]',
  ];

  let settingsOpened = false;

  for (const sel of gearSelectors) {
    try {
      // Get ALL matching buttons — pick the one nearest to our hovered item
      const gearBtns = page.locator(sel);
      const gearCount = await gearBtns.count();

      if (gearCount === 0) continue;

      // Get the target item's bounding box for proximity check
      const targetBox = await targetItem.boundingBox();
      if (!targetBox) continue;

      let bestBtn = null;
      let bestDist = Infinity;

      for (let g = 0; g < gearCount; g++) {
        const btn = gearBtns.nth(g);
        const box = await btn.boundingBox().catch(() => null);
        if (!box) continue;

        // Check if this gear button is on the same Y row as our target
        const yDist = Math.abs((box.y + box.height / 2) - (targetBox.y + targetBox.height / 2));
        if (yDist < 30 && yDist < bestDist) {
          bestDist = yDist;
          bestBtn = btn;
        }
      }

      if (bestBtn) {
        // Scroll into view and click
        await bestBtn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);

        const box = await bestBtn.boundingBox();
        if (box) {
          // Use mouse.click at the center of the bounding box to bypass overlay issues
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          console.log(`  Clicked settings gear via ${sel} at y=${box.y.toFixed(0)}`);
          settingsOpened = true;
          break;
        }
      }
    } catch { /* Try next selector */ }
  }

  if (!settingsOpened) {
    // Fallback: Try clicking the item first, then look for settings in the panel
    await targetItem.click();
    await page.waitForTimeout(2000);
    await takeScreenshot(page, `cleanup-fallback-${targetIndex}`);
    console.log(`  Could not find settings gear for "${targetName}"`);
    return false;
  }

  await page.waitForTimeout(2000);

  // Now we should be in the page settings panel
  // Take a screenshot to see what's there
  await takeScreenshot(page, `cleanup-settings-${targetIndex}`);

  // Look for "Delete" at the bottom of the settings panel
  // We may need to scroll down in the settings panel
  const deleteSelectors = [
    'button:has-text("Delete")',
    'button:has-text("DELETE")',
    'button:has-text("Delete Page")',
    'text=DELETE',
  ];

  let deleteFound = false;
  for (const sel of deleteSelectors) {
    try {
      const btn = page.locator(sel).first();
      // Scroll it into view if it exists
      const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await btn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await btn.click({ timeout: 3000 });
        console.log(`  Clicked Delete button via ${sel}`);
        deleteFound = true;
        break;
      }
    } catch { /* Try next */ }
  }

  if (!deleteFound) {
    // Try scrolling the settings panel to find Delete
    // The settings panel is usually a scrollable div
    const settingsPanel = page.locator('[class*="settings"], [class*="Settings"], [role="dialog"]').first();
    if (await settingsPanel.isVisible({ timeout: 1000 }).catch(() => false)) {
      // Scroll down in the panel
      for (let scroll = 0; scroll < 5; scroll++) {
        await settingsPanel.evaluate((el: HTMLElement) => el.scrollTop += 300);
        await page.waitForTimeout(500);

        for (const sel of deleteSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            await btn.click({ timeout: 3000 });
            console.log(`  Found Delete after scrolling`);
            deleteFound = true;
            break;
          }
        }
        if (deleteFound) break;
      }
    }
  }

  if (!deleteFound) {
    console.log(`  Could not find Delete button in settings`);
    await takeScreenshot(page, `cleanup-no-delete-${targetIndex}`);
    return false;
  }

  await page.waitForTimeout(1500);

  // Confirm deletion dialog
  const confirmSelectors = [
    'button:has-text("Confirm")',
    'button:has-text("CONFIRM")',
    'button:has-text("Delete")',
    'button:has-text("DELETE")',
    'button:has-text("Yes")',
    'button:has-text("Remove")',
  ];

  for (const sel of confirmSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click({ timeout: 3000 });
        console.log(`  Confirmed deletion via ${sel}`);
        break;
      }
    } catch { /* Try next */ }
  }

  await page.waitForTimeout(3000);
  return true;
}

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Initial page listing
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const initialPages = await listPages(page);
    console.log(`\nInitial pages (${initialPages.length}):`);
    initialPages.forEach((name, i) => console.log(`  [${i}] "${name}"`));

    // Find pages to delete
    const toDelete: string[] = [];
    for (const name of initialPages) {
      if (PAGES_TO_DELETE.includes(name)) {
        toDelete.push(name);
      }
    }

    if (toDelete.length === 0) {
      console.log('\nNo pages to delete!');
      await bm.close();
      return;
    }

    console.log(`\nPages to delete: ${toDelete.length}`);
    toDelete.forEach(name => console.log(`  - "${name}"`));

    let deletedCount = 0;
    for (const name of toDelete) {
      console.log(`\n--- Deleting "${name}" ---`);
      const success = await deletePage(page, name);
      if (success) {
        deletedCount++;
        console.log(`  ✅ Successfully deleted "${name}"`);
      } else {
        console.log(`  ❌ Failed to delete "${name}"`);
      }
    }

    // Final listing
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const finalPages = await listPages(page);
    console.log(`\nFinal pages (${finalPages.length}):`);
    finalPages.forEach((name, i) => console.log(`  [${i}] "${name}"`));

    console.log(`\nDeleted ${deletedCount}/${toDelete.length} pages.`);
    await takeScreenshot(page, 'cleanup-v2-done');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
