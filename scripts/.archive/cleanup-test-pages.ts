/**
 * Clean up orphaned "New Page" entries created by test agents.
 * Also removes any pages named "Delete Test", "Image Test", "Button Test",
 * "Section Delete Test", "Image Upload Test", "Button URL Test".
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

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // List all pages
    const pageItems = page.locator('[data-test="pages-panel-item"]');
    const totalPages = await pageItems.count();
    console.log(`\nTotal pages in panel: ${totalPages}`);

    for (let i = 0; i < totalPages; i++) {
      const text = await pageItems.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    let deletedCount = 0;

    // Delete matching pages (go in reverse to avoid index shifts)
    for (const targetName of PAGES_TO_DELETE) {
      // Re-scan each time since DOM changes after deletion
      let found = true;
      while (found) {
        found = false;
        const items = page.locator('[data-test="pages-panel-item"]');
        const count = await items.count();

        for (let i = count - 1; i >= 0; i--) {
          const text = await items.nth(i).innerText().catch(() => '');
          if (text.trim() === targetName) {
            console.log(`\nDeleting "${targetName}" at index ${i}...`);

            // Click the page to select it
            await items.nth(i).click();
            await page.waitForTimeout(2000);

            // Look for settings/gear icon or the page settings panel
            // In Squarespace, clicking a page opens its preview.
            // To delete: click the "..." or gear icon next to the page name
            // Or use the page settings panel

            // Try: right-click for context menu
            // Actually, in Squarespace admin, we need to open page settings
            // The page item has a settings icon that appears on hover

            // Go back to pages panel
            await page.goto('https://tim-cox.squarespace.com/config/pages', {
              waitUntil: 'domcontentloaded', timeout: 30000,
            });
            await page.waitForTimeout(3000);

            // Hover over the page item to reveal the settings gear
            const freshItems = page.locator('[data-test="pages-panel-item"]');
            const freshCount = await freshItems.count();

            for (let j = freshCount - 1; j >= 0; j--) {
              const freshText = await freshItems.nth(j).innerText().catch(() => '');
              if (freshText.trim() === targetName) {
                // Hover to reveal gear icon
                await freshItems.nth(j).hover();
                await page.waitForTimeout(800);

                // The settings icon is a sibling or child button
                // Try various approaches to find it
                const settingsSelectors = [
                  // Gear icon near the hovered item
                  `[data-test="pages-panel-item"]:nth-child(${j + 1}) [aria-label="Settings"]`,
                  `[data-test="pages-panel-item"]:nth-child(${j + 1}) button`,
                ];

                // Simpler approach: use keyboard shortcut or the URL-based settings
                // Navigate to: /config/pages/<page-id>/settings
                // But we don't have the page ID easily

                // Alternative: Click the page item, then look for a Delete option
                await freshItems.nth(j).click();
                await page.waitForTimeout(2000);

                // Look for settings/delete in the current UI state
                // When a page is selected in the panel, there might be a "..." menu
                const menuBtn = page.locator('button[aria-label="More"], button[aria-label="Options"], [data-test="page-actions"]').first();
                if (await menuBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                  await menuBtn.click();
                  await page.waitForTimeout(800);

                  const deleteOpt = page.locator('text=Delete, text=DELETE, button:has-text("Delete")').first();
                  if (await deleteOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await deleteOpt.click();
                    await page.waitForTimeout(1000);

                    // Confirm
                    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("DELETE"), button:has-text("Yes"), button:has-text("Remove")').first();
                    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                      await confirmBtn.click();
                      console.log(`  ✅ Deleted "${targetName}"`);
                      deletedCount++;
                      found = true;
                      await page.waitForTimeout(2000);
                    }
                  }
                }

                // If menu approach didn't work, try Settings approach
                if (!found) {
                  // Navigate to pages panel with the page selected
                  // Look for a "Settings" or gear button in the page preview area
                  const settingsBtn = page.locator('button:has-text("Settings"), button[aria-label="Page Settings"], [data-test="page-settings"], button[aria-label="Settings"]').first();
                  if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await settingsBtn.click();
                    await page.waitForTimeout(1500);

                    // Scroll down in settings panel to find Delete
                    const deleteBtn = page.locator('button:has-text("Delete Page"), button:has-text("Delete"), text=DELETE PAGE').first();
                    if (await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                      await deleteBtn.click();
                      await page.waitForTimeout(1000);

                      const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("DELETE"), button:has-text("Yes")').first();
                      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await confirmBtn.click();
                        console.log(`  ✅ Deleted "${targetName}" via Settings`);
                        deletedCount++;
                        found = true;
                        await page.waitForTimeout(2000);
                      }
                    }
                  }
                }

                break; // Found the item, move to next iteration
              }
            }

            break; // Found a match, restart the scan
          }
        }
      }
    }

    // Navigate back and take final screenshot
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Final listing
    const finalItems = page.locator('[data-test="pages-panel-item"]');
    const finalCount = await finalItems.count();
    console.log(`\nFinal pages: ${finalCount}`);
    for (let i = 0; i < finalCount; i++) {
      const text = await finalItems.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    console.log(`\nDeleted ${deletedCount} pages.`);
    await takeScreenshot(page, 'cleanup-test-pages-done');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
