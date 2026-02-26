/**
 * Clean up orphaned pages using the new handleDeletePage compound action.
 * This tests the deletePage action while also cleaning up test artifacts.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';

const PAGES_TO_DELETE = [
  'New Page',
];

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Navigate to pages panel to see current state
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const items = page.locator('[data-test="pages-panel-item"]');
    const count = await items.count();
    console.log(`\nTotal pages: ${count}`);
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    // Find pages to delete
    const toDelete: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).innerText().catch(() => '');
      if (PAGES_TO_DELETE.includes(text.trim())) {
        toDelete.push(text.trim());
      }
    }

    console.log(`\nPages to delete: ${toDelete.length}`);
    if (toDelete.length === 0) {
      console.log('Nothing to clean up!');
      return;
    }

    // Delete each one using the compound action
    let deletedCount = 0;
    for (const name of toDelete) {
      console.log(`\n--- Deleting "${name}" via deletePage action ---`);
      const result = await executeAgentAction(page, { action: 'deletePage', title: name });
      console.log(`  Result: ${result.success ? '✅' : '❌'} ${result.message}`);
      if (result.success) deletedCount++;
    }

    // Final state
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const finalItems = page.locator('[data-test="pages-panel-item"]');
    const finalCount = await finalItems.count();
    console.log(`\nFinal pages: ${finalCount}`);
    for (let i = 0; i < finalCount; i++) {
      const text = await finalItems.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    console.log(`\nDeleted ${deletedCount}/${toDelete.length} pages.`);

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
