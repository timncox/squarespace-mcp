/**
 * Detailed inspect of Coding Projects page - check each section's blocks
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

    // Navigate directly to the Coding Projects page
    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const iframe = page.frameLocator('#sqs-site-frame');

    // Get all sections (skip header and overlay-nav)
    const sections = iframe.locator('section.page-section[data-section-id]');
    const secCount = await sections.count();
    console.log(`\nContent sections: ${secCount}`);

    for (let i = 0; i < secCount; i++) {
      const sec = sections.nth(i);
      const secId = await sec.getAttribute('data-section-id').catch(() => '');

      console.log(`\n═══ Section ${i} (id: ${secId}) ═══`);

      // Check for images
      const images = sec.locator('img');
      const imgCount = await images.count();
      for (let j = 0; j < imgCount; j++) {
        const src = await images.nth(j).getAttribute('src').catch(() => '');
        const alt = await images.nth(j).getAttribute('alt').catch(() => '');
        const srcPreview = src?.substring(0, 80) || '';
        console.log(`  IMG[${j}]: alt="${alt}" src="${srcPreview}..."`);
      }

      // Check for text content (h1, h2, h3, p)
      const headings = sec.locator('h1, h2, h3, h4');
      const hCount = await headings.count();
      for (let j = 0; j < hCount; j++) {
        const tag = await headings.nth(j).evaluate((e: Element) => e.tagName).catch(() => '');
        const text = await headings.nth(j).innerText().catch(() => '');
        console.log(`  ${tag}: "${text.trim().substring(0, 80)}"`);
      }

      const paragraphs = sec.locator('p');
      const pCount = await paragraphs.count();
      for (let j = 0; j < Math.min(pCount, 3); j++) {
        const text = await paragraphs.nth(j).innerText().catch(() => '');
        if (text.trim()) {
          console.log(`  P: "${text.trim().substring(0, 100)}"`);
        }
      }
      if (pCount > 3) console.log(`  ... and ${pCount - 3} more paragraphs`);

      // Check for buttons/links with button styling
      const buttons = sec.locator('a.sqs-block-button-element, a[class*="button"], .sqs-button-element--primary, .sqs-button-element--secondary, .sqs-editable-button');
      const btnCount = await buttons.count();
      console.log(`  Buttons: ${btnCount}`);
      for (let j = 0; j < btnCount; j++) {
        const text = await buttons.nth(j).innerText().catch(() => '');
        const href = await buttons.nth(j).getAttribute('href').catch(() => '');
        console.log(`    BTN[${j}]: "${text.trim()}" → ${href}`);
      }

      // Check for videos
      const videos = sec.locator('video, [data-block-type="52"], .sqs-video-wrapper');
      const vidCount = await videos.count();
      if (vidCount > 0) console.log(`  Videos: ${vidCount}`);
    }

    // Take screenshots scrolling through the page
    await takeScreenshot(page, 'coding-projects-detail-top');

    // Scroll through the page in the iframe
    for (let scroll = 1; scroll <= 8; scroll++) {
      await iframe.locator('body').evaluate((el: HTMLElement, amount: number) => {
        el.scrollTop += amount;
      }, 600);
      await page.waitForTimeout(500);
    }
    await takeScreenshot(page, 'coding-projects-detail-bottom');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
