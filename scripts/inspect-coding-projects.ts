/**
 * Quick inspect: What does the Coding Projects page look like currently?
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

    // Navigate to Coding Projects page
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Click on Coding Projects
    const items = page.locator('[data-test="pages-panel-item"]');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).innerText().catch(() => '');
      if (text.trim() === 'Coding Projects') {
        await items.nth(i).click();
        console.log(`Clicked "Coding Projects" at index ${i}`);
        break;
      }
    }
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'coding-projects-preview');

    // Now check the page URL and content
    console.log(`\nCurrent URL: ${page.url()}`);

    // Take a full-page screenshot by scrolling
    // First check if there's an iframe
    const iframe = page.frameLocator('#sqs-site-frame');

    // Get page content from the preview
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const relevantLines = bodyText.split('\n').filter(l => l.trim()).slice(0, 50);
    console.log('\nPage text (first 50 non-empty lines):');
    relevantLines.forEach((l, i) => console.log(`  [${i}] ${l.trim().substring(0, 80)}`));

    // Check what sections exist
    console.log('\n--- Checking sections in iframe ---');
    try {
      const sections = iframe.locator('section, [data-section-id]');
      const secCount = await sections.count();
      console.log(`Sections found: ${secCount}`);
      for (let i = 0; i < secCount; i++) {
        const sec = sections.nth(i);
        const id = await sec.getAttribute('data-section-id').catch(() => '');
        const text = await sec.innerText().catch(() => '');
        const preview = text.trim().substring(0, 100).replace(/\n/g, ' | ');
        console.log(`  [${i}] id="${id}" text="${preview}"`);
      }
    } catch (e) {
      console.log('Could not access iframe sections:', (e as Error).message);
    }

    // Enter edit mode to see the full structure
    const editBtn = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
    if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await editBtn.click();
      console.log('\nClicked EDIT button');
      await page.waitForTimeout(3000);
      await takeScreenshot(page, 'coding-projects-edit-mode');

      // Check sections again in edit mode
      try {
        const sections = iframe.locator('section, [data-section-id]');
        const secCount = await sections.count();
        console.log(`\nSections in edit mode: ${secCount}`);
        for (let i = 0; i < secCount; i++) {
          const sec = sections.nth(i);
          const id = await sec.getAttribute('data-section-id').catch(() => '');
          const className = await sec.getAttribute('class').catch(() => '');
          const text = await sec.innerText().catch(() => '');
          const preview = text.trim().substring(0, 120).replace(/\n/g, ' | ');
          console.log(`  [${i}] id="${id}" class="${className?.substring(0, 60)}" text="${preview}"`);
        }
      } catch (e) {
        console.log('Could not access iframe sections in edit mode:', (e as Error).message);
      }
    }

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
