/**
 * Quick diagnostic: find where the "ADD SECTION" button is on an empty page
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame } from '../src/automation/editor-actions.js';

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

    // Check main frame
    console.log('=== Main Frame ===');
    const mainAddSection = page.getByRole('button', { name: /add section/i });
    console.log(`getByRole count: ${await mainAddSection.count()}`);
    if (await mainAddSection.count() > 0) {
      const vis = await mainAddSection.first().isVisible().catch(() => false);
      console.log(`  first visible: ${vis}`);
      if (vis) {
        const info = await mainAddSection.first().evaluate((e: Element) => ({
          tag: e.tagName, class: e.className?.toString().substring(0, 100),
          rect: JSON.stringify(e.getBoundingClientRect()),
          text: e.textContent?.trim().substring(0, 50),
        })).catch(() => null);
        console.log(`  info:`, JSON.stringify(info));
      }
    }

    // Text selectors
    for (const sel of ['text=ADD SECTION', 'text="ADD SECTION"', 'button:has-text("ADD SECTION")']) {
      const c = await page.locator(sel).count().catch(() => -1);
      const v = c > 0 ? await page.locator(sel).first().isVisible().catch(() => false) : false;
      console.log(`  '${sel}': count=${c}, vis=${v}`);
    }

    // Check iframe
    console.log('\n=== Iframe ===');
    const siteFrame = getSiteFrame(page);
    if (siteFrame) {
      for (const sel of ['button:has-text("ADD SECTION")', ':has-text("ADD SECTION")', ':has-text("Add Page Content")']) {
        const c = await siteFrame.locator(sel).count().catch(() => -1);
        console.log(`  iframe '${sel}': count=${c}`);
      }

      // Check if the "Add Page Content" area is inside the iframe
      const addPageContent = await siteFrame.locator(':has-text("Add Page Content")').first().isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`  iframe 'Add Page Content' visible: ${addPageContent}`);

      // Get iframe's ADD SECTION button info
      const iframeAddSection = siteFrame.locator('button:has-text("ADD SECTION")').first();
      if (await iframeAddSection.count().catch(() => 0) > 0) {
        const box = await iframeAddSection.boundingBox().catch(() => null);
        console.log(`  iframe ADD SECTION boundingBox: ${JSON.stringify(box)}`);
      }
    }

    // Raw DOM search in main frame
    console.log('\n=== Raw DOM ===');
    const found = await page.evaluate(() => {
      const results: string[] = [];
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const text = btn.textContent?.trim() || '';
        if (text.includes('ADD SECTION') || text.includes('Add Section')) {
          const r = btn.getBoundingClientRect();
          const s = getComputedStyle(btn);
          results.push(`<${btn.tagName}> text="${text.substring(0, 40)}" vis=${s.visibility} display=${s.display} rect=${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return results;
    });
    found.forEach(f => console.log(`  ${f}`));

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
