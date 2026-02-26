/**
 * Diagnostic: check what boundingBox() returns for iframe elements
 * before and after scrollIntoViewIfNeeded().
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

    const siteFrame = getSiteFrame(page);
    if (!siteFrame) { console.log('No site frame'); return; }

    const sectionCount = await siteFrame.locator('.page-section').count();
    console.log(`Sections: ${sectionCount}`);

    // Check the iframe element itself
    const iframeEl = page.locator('#sqs-site-frame');
    const iframeBox = await iframeEl.boundingBox();
    console.log(`\nIframe box: ${JSON.stringify(iframeBox)}`);

    // Test first section (should be near top)
    const firstSection = siteFrame.locator('.page-section').nth(0);
    const box0Before = await firstSection.boundingBox();
    console.log(`\nSection 0 (before scroll): ${JSON.stringify(box0Before)}`);

    // Test a deep section (near bottom)
    const deepIdx = sectionCount - 2;
    const deepSection = siteFrame.locator('.page-section').nth(deepIdx);
    const boxDeepBefore = await deepSection.boundingBox();
    console.log(`Section ${deepIdx} (before scroll): ${JSON.stringify(boxDeepBefore)}`);

    // Now scroll that deep section into view
    await deepSection.scrollIntoViewIfNeeded({ timeout: 5000 });
    await page.waitForTimeout(500);
    const boxDeepAfter = await deepSection.boundingBox();
    console.log(`Section ${deepIdx} (AFTER scrollIntoView): ${JSON.stringify(boxDeepAfter)}`);

    // Also check with the page's scrollY
    const scrollY = await page.evaluate(() => window.scrollY);
    console.log(`\nPage scrollY: ${scrollY}`);

    // Get viewport size
    const viewport = page.viewportSize();
    console.log(`Viewport: ${JSON.stringify(viewport)}`);

    // Check if the element is actually visible by its coords
    if (boxDeepAfter) {
      const centerY = boxDeepAfter.y + boxDeepAfter.height / 2;
      console.log(`\nDeep section center Y: ${centerY}`);
      console.log(`In viewport (0-${viewport?.height}): ${centerY >= 0 && centerY <= (viewport?.height || 900)}`);
    }

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
