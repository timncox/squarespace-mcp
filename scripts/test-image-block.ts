/**
 * Test the fixed addImageBlock: add section, enter edit mode, add image block.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { join } from 'path';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const IMG_DIR = join(process.cwd(), 'storage', 'uploads', 'project-screenshots');

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

    const cpLink = page.locator('text=Coding Projects').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cpLink.click();
      await page.waitForTimeout(4000);
    }

    await enterEditMode(page);
    await page.waitForTimeout(2000);

    // Add section
    console.log('=== Adding section ===');
    const r1 = await executeAgentAction(page, { action: 'addSection' });
    console.log(`addSection: ${r1.success ? '✓' : '✗'} ${r1.message?.substring(0, 100)}`);
    await page.waitForTimeout(1500);

    // Add image block
    console.log('\n=== Adding image block ===');
    const imgPath = join(IMG_DIR, 'menu-block-lovable-app.png');
    const r2 = await executeAgentAction(page, {
      action: 'addImageBlock',
      imagePath: imgPath,
      altText: 'Menu Formatter screenshot',
    });
    console.log(`addImageBlock: ${r2.success ? '✓' : '✗'} ${r2.message?.substring(0, 150)}`);
    await takeScreenshot(page, 'test-img-1');

    if (r2.success) {
      // Test a second image block in a new section
      console.log('\n=== Adding second section + image ===');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);

      const r3 = await executeAgentAction(page, { action: 'addSection' });
      console.log(`addSection 2: ${r3.success ? '✓' : '✗'} ${r3.message?.substring(0, 100)}`);
      await page.waitForTimeout(1500);

      // Check if already in edit mode
      const inEdit = await page.getByRole('button', { name: /add block/i }).first()
        .isVisible({ timeout: 2000 }).catch(() => false);
      if (!inEdit) {
        const er = await executeAgentAction(page, { action: 'enterSectionEditMode', sectionIndex: 'last' });
        console.log(`enterSectionEditMode: ${er.success ? '✓' : '✗'} ${er.message?.substring(0, 100)}`);
      }

      const imgPath2 = join(IMG_DIR, 'webscrapetool-lovable-app.png');
      const r4 = await executeAgentAction(page, {
        action: 'addImageBlock',
        imagePath: imgPath2,
        altText: 'Web Scraper screenshot',
      });
      console.log(`addImageBlock 2: ${r4.success ? '✓' : '✗'} ${r4.message?.substring(0, 150)}`);
      await takeScreenshot(page, 'test-img-2');
    }

    // Save
    const sr = await saveChanges(page);
    console.log(`\nSave: ${sr.message}`);
    await takeScreenshot(page, 'test-img-final');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
