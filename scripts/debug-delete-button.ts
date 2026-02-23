/**
 * Debug: Open page settings and screenshot to find the Delete button.
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

    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Find and hover over "New Page" at the bottom
    const items = page.locator('[data-test="pages-panel-item"]');
    const count = await items.count();
    let targetIndex = -1;
    for (let i = count - 1; i >= 0; i--) {
      const text = await items.nth(i).innerText().catch(() => '');
      if (text.trim() === 'New Page') {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex === -1) {
      console.log('No "New Page" found');
      return;
    }

    console.log(`Found "New Page" at index ${targetIndex}`);
    const targetItem = items.nth(targetIndex);
    await targetItem.scrollIntoViewIfNeeded();
    await targetItem.hover();
    await page.waitForTimeout(1000);

    // Click gear icon
    const gearBtns = page.locator('button[data-testid="settings-icon"]');
    const gearCount = await gearBtns.count();
    console.log(`Gear buttons visible: ${gearCount}`);

    const targetBox = await targetItem.boundingBox();
    if (!targetBox) { console.log('No bounding box'); return; }

    for (let g = 0; g < gearCount; g++) {
      const box = await gearBtns.nth(g).boundingBox().catch(() => null);
      if (!box) continue;
      const yDist = Math.abs((box.y + box.height / 2) - (targetBox.y + targetBox.height / 2));
      if (yDist < 30) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        console.log(`Clicked gear at y=${box.y.toFixed(0)}`);
        break;
      }
    }

    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'debug-settings-panel-top');

    // Now inspect what's in the settings panel
    // Look for ALL buttons in the current view
    const allButtons = page.locator('button');
    const btnCount = await allButtons.count();
    console.log(`\nAll buttons on page: ${btnCount}`);
    for (let i = 0; i < btnCount; i++) {
      const btn = allButtons.nth(i);
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      const text = await btn.innerText().catch(() => '');
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
      const dataTest = await btn.getAttribute('data-test').catch(() => '');
      if (text.trim() || ariaLabel || dataTest) {
        console.log(`  btn[${i}]: text="${text.trim()}" aria="${ariaLabel}" data-test="${dataTest}"`);
      }
    }

    // Try scrolling down in all possible panel containers
    const panelSelectors = [
      '[class*="settings"]',
      '[class*="Settings"]',
      '[class*="panel"]',
      '[class*="Panel"]',
      '[role="dialog"]',
      '[class*="modal"]',
      '[class*="sidebar"]',
    ];

    for (const sel of panelSelectors) {
      const panels = page.locator(sel);
      const pCount = await panels.count();
      for (let p = 0; p < pCount; p++) {
        const panel = panels.nth(p);
        const visible = await panel.isVisible().catch(() => false);
        if (!visible) continue;
        const scrollHeight = await panel.evaluate((el: HTMLElement) => el.scrollHeight).catch(() => 0);
        const clientHeight = await panel.evaluate((el: HTMLElement) => el.clientHeight).catch(() => 0);
        if (scrollHeight > clientHeight + 50) {
          console.log(`\nScrollable panel: ${sel}[${p}] scrollHeight=${scrollHeight} clientHeight=${clientHeight}`);
          // Scroll to bottom
          await panel.evaluate((el: HTMLElement) => el.scrollTop = el.scrollHeight);
          await page.waitForTimeout(1000);
        }
      }
    }

    await takeScreenshot(page, 'debug-settings-panel-scrolled');

    // Check buttons again after scrolling
    console.log('\n--- Buttons after scrolling ---');
    const btnCount2 = await allButtons.count();
    for (let i = 0; i < btnCount2; i++) {
      const btn = allButtons.nth(i);
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      const text = await btn.innerText().catch(() => '');
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
      if (text.toLowerCase().includes('delete') || (ariaLabel && ariaLabel.toLowerCase().includes('delete'))) {
        console.log(`  FOUND DELETE: btn[${i}]: text="${text.trim()}" aria="${ariaLabel}"`);
      }
    }

    // Also check links and other elements for "delete"
    const deleteElements = page.locator('text=Delete, text=DELETE, text=delete');
    const delCount = await deleteElements.count();
    console.log(`\nElements with "delete" text: ${delCount}`);
    for (let i = 0; i < delCount; i++) {
      const el = deleteElements.nth(i);
      const visible = await el.isVisible().catch(() => false);
      const tag = await el.evaluate((e: Element) => e.tagName).catch(() => '?');
      const text = await el.innerText().catch(() => '');
      console.log(`  [${i}] tag=${tag} visible=${visible} text="${text.trim().substring(0, 50)}"`);
    }

    // Try the "Advanced" tab - Delete might be there
    const advancedTab = page.locator('text=Advanced').first();
    const advVisible = await advancedTab.isVisible({ timeout: 2000 }).catch(() => false);
    if (advVisible) {
      console.log('\nClicking "Advanced" tab...');
      await advancedTab.click();
      await page.waitForTimeout(1500);
      await takeScreenshot(page, 'debug-settings-advanced');

      // Check for delete button in advanced tab
      const advDeleteEls = page.locator('text=Delete, text=DELETE');
      const advDelCount = await advDeleteEls.count();
      console.log(`Delete elements in Advanced tab: ${advDelCount}`);
      for (let i = 0; i < advDelCount; i++) {
        const el = advDeleteEls.nth(i);
        const visible = await el.isVisible().catch(() => false);
        const tag = await el.evaluate((e: Element) => e.tagName).catch(() => '?');
        const text = await el.innerText().catch(() => '');
        console.log(`  [${i}] tag=${tag} visible=${visible} text="${text.trim().substring(0, 80)}"`);
      }
    }

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
