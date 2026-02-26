/**
 * Diagnostic: What happens after clicking Add Blank → Page?
 * Takes screenshots at each step and lists ALL sections in the pages panel.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Navigate to pages panel
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);
    await takeScreenshot(page, 'diag-step0-pages-panel');

    // List ALL page items across ALL sections
    console.log('\n── Before: All page items ──');
    const allItems = page.locator('[data-test="pages-panel-item"]');
    const beforeCount = await allItems.count();
    for (let i = 0; i < beforeCount; i++) {
      const text = await allItems.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    // Step 1: Click + button
    const addBtn = page.locator('[data-test="add-page"]').first();
    if (await addBtn.isVisible({ timeout: 3000 })) {
      await addBtn.click();
      console.log('\n✅ Clicked [data-test="add-page"]');
    } else {
      // Try the + next to "Not Linked"
      const plusBtns = page.locator('button').filter({ hasText: '' });
      console.log('add-page not found, looking for + buttons...');
    }
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'diag-step1-after-plus');

    // Step 2: Click "Add Blank"
    const addBlank = page.locator('[data-test="add-blank-options-button"]').first();
    if (await addBlank.isVisible({ timeout: 3000 })) {
      await addBlank.click();
      console.log('✅ Clicked Add Blank');
    } else {
      console.log('❌ Add Blank not visible');
    }
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'diag-step2-after-add-blank');

    // Log what's visible now
    console.log('\n── After Add Blank: visible text elements ──');
    const menuItems = page.locator('a, button, [role="menuitem"]');
    const menuCount = await menuItems.count();
    for (let i = 0; i < menuCount; i++) {
      const el = menuItems.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const text = await el.innerText().catch(() => '');
      const tag = await el.evaluate((e: Element) => e.tagName).catch(() => '?');
      const dataTest = await el.getAttribute('data-test').catch(() => '');
      if (text.trim()) {
        console.log(`  [${i}] <${tag}> "${text.trim().substring(0, 40)}" data-test="${dataTest}"`);
      }
    }

    // Step 3: Click "Page" in sub-menu
    // Be specific: look for exact match "Page", not "Add Page" etc.
    const pageLinks = page.locator('a, button, [role="menuitem"]');
    const plCount = await pageLinks.count();
    let clickedPage = false;
    for (let i = 0; i < plCount; i++) {
      const el = pageLinks.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const text = await el.innerText().catch(() => '');
      if (text.trim() === 'Page') {
        await el.click();
        console.log(`\n✅ Clicked "Page" at index ${i}`);
        clickedPage = true;
        break;
      }
    }
    if (!clickedPage) {
      console.log('\n❌ Could not find "Page" text in sub-menu');
    }

    // Wait and see where we end up
    await page.waitForTimeout(5000);
    await takeScreenshot(page, 'diag-step3-after-page-click');

    // Log current URL
    console.log(`\nCurrent URL after clicking Page: ${page.url()}`);

    // Now navigate back to pages panel
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);
    await takeScreenshot(page, 'diag-step4-back-to-pages');

    // List ALL page items again
    console.log('\n── After: All page items ──');
    const allItemsAfter = page.locator('[data-test="pages-panel-item"]');
    const afterCount = await allItemsAfter.count();
    for (let i = 0; i < afterCount; i++) {
      const text = await allItemsAfter.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    console.log(`\nPage count: ${beforeCount} → ${afterCount} (diff: ${afterCount - beforeCount})`);

    // Also check Main Navigation specifically
    console.log('\n── Main Navigation section ──');
    const mainNavItems = page.locator('[data-test="main-navigation"] [data-test="pages-panel-item"]');
    const mainNavCount = await mainNavItems.count();
    console.log(`Main Navigation items: ${mainNavCount}`);
    for (let i = 0; i < mainNavCount; i++) {
      const text = await mainNavItems.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    // Check "Not Linked" section
    console.log('\n── Not Linked section ──');
    const notLinkedItems = page.locator('[data-test="not-linked-section"] [data-test="pages-panel-item"]');
    const notLinkedCount = await notLinkedItems.count();
    console.log(`Not Linked items: ${notLinkedCount}`);
    for (let i = 0; i < notLinkedCount; i++) {
      const text = await notLinkedItems.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    // Check if "New Page" exists somewhere we can't see
    const allText = await page.locator('body').innerText().catch(() => '');
    if (allText.includes('New Page')) {
      console.log('\n⚠️  "New Page" text found somewhere on the page');
    }

    // Clean up any "New Page" we just created
    if (afterCount > beforeCount) {
      console.log('\n── Cleanup: deleting newly created page ──');
      // Find and hover to delete
      for (let i = afterCount - 1; i >= 0; i--) {
        const text = await allItemsAfter.nth(i).innerText().catch(() => '');
        if (text.trim() === 'New Page') {
          const item = allItemsAfter.nth(i);
          await item.scrollIntoViewIfNeeded();
          const box = await item.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(1000);

            const deleteBtns = page.locator('[data-test="delete-item"]');
            const delCount = await deleteBtns.count();
            for (let d = 0; d < delCount; d++) {
              const dBox = await deleteBtns.nth(d).boundingBox().catch(() => null);
              if (!dBox) continue;
              const yDist = Math.abs((dBox.y + dBox.height / 2) - (box.y + box.height / 2));
              if (yDist < 30) {
                await page.mouse.click(dBox.x + dBox.width / 2, dBox.y + dBox.height / 2);
                console.log('  Clicked delete icon');
                await page.waitForTimeout(1500);

                // Confirm
                const confirmBtn = page.locator('button:has-text("Confirm")').first();
                if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                  await confirmBtn.click();
                  console.log('  Confirmed deletion');
                }
                break;
              }
            }
          }
          break;
        }
      }
      await page.waitForTimeout(2000);
    }

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
