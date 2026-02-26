/**
 * Minimal diagnostic: inspect the "ADD BLOCK" elements found by Playwright
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

    // Click a section to select it
    const siteFrame = getSiteFrame(page);
    if (!siteFrame) { console.log('No site frame'); return; }

    const sectionCount = await siteFrame.locator('.page-section').count();
    const targetIdx = sectionCount - 2;
    const sectionId = await siteFrame.locator('.page-section').nth(targetIdx)
      .getAttribute('data-section-id').catch(() => 'unknown');
    console.log(`Clicking section ${targetIdx}, id: ${sectionId}`);

    await clickThroughOverlay(page, `.page-section[data-section-id="${sectionId}"]`);
    await page.waitForTimeout(2000);

    // Inspect the text=/ADD BLOCK/i elements
    console.log('\n=== Inspecting text=/ADD BLOCK/i elements ===');
    const regexLocator = page.locator('text=/ADD BLOCK/i');
    const count = await regexLocator.count();
    console.log(`Count: ${count}`);

    for (let i = 0; i < Math.min(count, 3); i++) {
      const el = regexLocator.nth(i);
      try {
        const info = await el.evaluate((e: Element) => {
          const r = e.getBoundingClientRect();
          const s = getComputedStyle(e);
          return {
            tag: e.tagName,
            text: e.textContent?.trim().substring(0, 50),
            outerHTML: e.outerHTML.substring(0, 200),
            display: s.display,
            visibility: s.visibility,
            opacity: s.opacity,
            width: r.width,
            height: r.height,
            x: Math.round(r.x),
            y: Math.round(r.y),
            offsetParent: (e as HTMLElement).offsetParent?.tagName || 'null',
          };
        });
        console.log(`  [${i}]:`, JSON.stringify(info, null, 4));
      } catch (err) {
        console.log(`  [${i}]: ERROR ${(err as Error).message.substring(0, 100)}`);
      }
    }

    // Also try: locate by role
    console.log('\n=== getByRole checks ===');
    const byRole = page.getByRole('button', { name: /add block/i });
    const roleCount = await byRole.count();
    console.log(`getByRole('button', {name: /add block/i}): count=${roleCount}`);
    if (roleCount > 0) {
      const vis = await byRole.first().isVisible().catch(() => false);
      console.log(`  firstVisible=${vis}`);
    }

    // Try getByText
    const byText = page.getByText('ADD BLOCK', { exact: true });
    const textCount = await byText.count();
    console.log(`getByText('ADD BLOCK', exact): count=${textCount}`);
    if (textCount > 0) {
      const vis = await byText.first().isVisible().catch(() => false);
      console.log(`  firstVisible=${vis}`);
      if (textCount > 0) {
        const info = await byText.first().evaluate((e: Element) => ({
          tag: e.tagName,
          class: e.className?.toString().substring(0, 80),
          html: e.outerHTML.substring(0, 200),
          rect: JSON.stringify(e.getBoundingClientRect()),
        })).catch(() => null);
        console.log(`  info:`, JSON.stringify(info, null, 4));
      }
    }

    // Screenshot for reference
    const { takeScreenshot } = await import('../src/utils/screenshot.js');
    await takeScreenshot(page, 'btn-inspect');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
