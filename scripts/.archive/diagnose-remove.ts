/**
 * Quick diagnostic: what does getByRole('button', {name: /remove/i}) find?
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, clickThroughOverlay } from '../src/automation/editor-actions.js';

async function main() {
  const browserManager = getBrowserManager({ headless: false });
  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const cpLink = page.locator('text=Coding Projects').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cpLink.click();
      await page.waitForTimeout(4000);
    }

    await enterEditMode(page);
    await page.waitForTimeout(2000);

    // Click on a section to select it
    const siteFrame = getSiteFrame(page);
    if (!siteFrame) { console.log('No site frame'); return; }

    const sections = await siteFrame.locator('.page-section').count();
    console.log(`Sections: ${sections}`);

    // Click the second section (index 1, skip first as it has content from the hero run)
    const targetIdx = Math.min(1, sections - 1);
    const sectionId = await siteFrame.locator('.page-section').nth(targetIdx)
      .getAttribute('data-section-id').catch(() => '?');
    console.log(`Clicking section [${targetIdx}] id=${sectionId}`);

    await clickThroughOverlay(page, `.page-section[data-section-id="${sectionId}"]`);
    await page.waitForTimeout(1500);

    // Now check what getByRole finds for "remove"
    console.log('\n=== getByRole checks ===');
    const removeByRole = page.getByRole('button', { name: /remove/i });
    const removeCount = await removeByRole.count();
    console.log(`getByRole('button', {name: /remove/i}): count=${removeCount}`);

    for (let i = 0; i < Math.min(removeCount, 5); i++) {
      const el = removeByRole.nth(i);
      const vis = await el.isVisible().catch(() => false);
      try {
        const info = await el.evaluate((e: Element) => {
          const r = e.getBoundingClientRect();
          const s = getComputedStyle(e);
          return {
            tag: e.tagName, text: e.textContent?.trim().substring(0, 50),
            ariaLabel: e.getAttribute('aria-label'),
            class: e.className?.toString().substring(0, 80),
            vis: s.visibility, display: s.display, opacity: s.opacity,
            rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          };
        });
        console.log(`  [${i}] visible=${vis}`, JSON.stringify(info));
      } catch (err) {
        console.log(`  [${i}] visible=${vis} ERROR: ${(err as Error).message.substring(0, 100)}`);
      }
    }

    // Also check section toolbar buttons specifically
    console.log('\n=== Section toolbar buttons ===');
    const toolbarBtns = page.locator('[class*="section-actions"] button, [class*="SectionActions"] button, [class*="sectionToolbar"] button');
    const tbCount = await toolbarBtns.count();
    console.log(`Toolbar buttons: ${tbCount}`);

    // Check all buttons with "Remove" in aria-label
    console.log('\n=== Buttons with aria-label containing "remove" ===');
    const ariaRemove = page.locator('button[aria-label*="emove"]');
    const ariaCount = await ariaRemove.count();
    console.log(`button[aria-label*="emove"]: count=${ariaCount}`);
    for (let i = 0; i < Math.min(ariaCount, 5); i++) {
      const el = ariaRemove.nth(i);
      const vis = await el.isVisible().catch(() => false);
      const label = await el.getAttribute('aria-label').catch(() => '?');
      const text = await el.textContent().catch(() => '?');
      console.log(`  [${i}] visible=${vis} aria-label="${label}" text="${text?.trim().substring(0, 30)}"`);
    }

    // Screenshot
    const { takeScreenshot } = await import('../src/utils/screenshot.js');
    await takeScreenshot(page, 'diagnose-remove');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
