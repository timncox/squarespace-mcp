/**
 * Debug: List all .page-section elements in the iframe to understand the DOM structure.
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

    // Navigate to the Coding Projects page
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const codingProjectsLink = page.locator('text=Coding Projects').first();
    const visible = await codingProjectsLink.isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) {
      await codingProjectsLink.click();
      await page.waitForTimeout(3000);
    }

    await enterEditMode(page);
    await page.waitForTimeout(2000);

    // List all sections
    const siteFrame = getSiteFrame(page);
    if (!siteFrame) {
      console.log('No site frame found');
      return;
    }

    const sectionCount = await siteFrame.locator('.page-section').count();
    console.log(`\n=== Found ${sectionCount} .page-section elements ===\n`);

    for (let i = 0; i < sectionCount; i++) {
      const section = siteFrame.locator('.page-section').nth(i);
      const id = await section.getAttribute('id').catch(() => '');
      const classes = await section.getAttribute('class').catch(() => '');
      const dataSection = await section.getAttribute('data-section-id').catch(() => '');
      const text = await section.innerText().catch(() => '');
      const box = await section.boundingBox().catch(() => null);

      console.log(`Section ${i}:`);
      console.log(`  id: ${id}`);
      console.log(`  data-section-id: ${dataSection}`);
      console.log(`  classes: ${classes?.substring(0, 100)}`);
      console.log(`  text: ${text?.substring(0, 80)}`);
      console.log(`  box: ${box ? `y=${Math.round(box.y)}, h=${Math.round(box.height)}` : 'null'}`);
      console.log('');
    }

    // Also check for content-specific sections
    const contentSections = await siteFrame.locator('[data-section-type="normal"]').count();
    console.log(`\n=== data-section-type="normal": ${contentSections} ===`);

    const blankSections = await siteFrame.locator('.page-section.content-collection').count();
    console.log(`=== .content-collection: ${blankSections} ===`);

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
