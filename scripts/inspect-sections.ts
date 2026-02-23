/**
 * Inspect the current state of all sections on the Coding Projects page.
 * Reports what text, images, and buttons each section contains.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame } from '../src/automation/editor-actions.js';

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
    await page.waitForTimeout(3000);

    const sf = getSiteFrame(page);
    if (!sf) {
      console.log('No site frame found');
      return;
    }

    const sections = sf.locator('.page-section');
    const sectionCount = await sections.count();
    console.log(`\n=== ${sectionCount} sections found ===\n`);

    for (let i = 0; i < sectionCount; i++) {
      const section = sections.nth(i);
      const sectionId = await section.getAttribute('data-section-id').catch(() => '(unknown)');

      // Get images
      const images = section.locator('.sqs-block-image img');
      const imgCount = await images.count().catch(() => 0);
      const imgAlts: string[] = [];
      const imgSrcs: string[] = [];
      for (let j = 0; j < imgCount; j++) {
        const alt = await images.nth(j).getAttribute('alt').catch(() => '') || '';
        const src = await images.nth(j).getAttribute('src').catch(() => '') || '';
        if (src.includes('squarespace-cdn') || src.includes('images.squarespace')) {
          imgAlts.push(alt);
          imgSrcs.push(src.substring(0, 80));
        }
      }

      // Get text blocks
      const textBlocks = section.locator('.sqs-block-html .sqs-block-content');
      const textCount = await textBlocks.count().catch(() => 0);
      const texts: string[] = [];
      for (let j = 0; j < textCount; j++) {
        const text = await textBlocks.nth(j).innerText().catch(() => '');
        texts.push(text.trim().substring(0, 100));
      }

      // Get button blocks
      const buttons = section.locator('.sqs-block-button');
      const btnCount = await buttons.count().catch(() => 0);
      const btnTexts: string[] = [];
      for (let j = 0; j < btnCount; j++) {
        const btnText = await buttons.nth(j).innerText().catch(() => '');
        btnTexts.push(btnText.trim());
      }

      // Get empty blocks (no image, no real content)
      const emptyImgBlocks = section.locator('.sqs-block-image');
      const emptyImgCount = await emptyImgBlocks.count().catch(() => 0);
      let emptyImgs = 0;
      for (let j = 0; j < emptyImgCount; j++) {
        const hasCdn = await emptyImgBlocks.nth(j).locator('img[src*="squarespace-cdn"], img[src*="images.squarespace"]').count().catch(() => 0);
        if (hasCdn === 0) emptyImgs++;
      }

      console.log(`Section ${i} (${sectionId}):`);
      console.log(`  Images (cdn): ${imgAlts.length}${imgAlts.length > 0 ? ' — ' + imgAlts.join(', ') : ''}`);
      if (emptyImgs > 0) console.log(`  Empty image blocks: ${emptyImgs}`);
      console.log(`  Text blocks: ${textCount}${texts.length > 0 ? '\n    ' + texts.join('\n    ') : ''}`);
      console.log(`  Buttons: ${btnCount}${btnTexts.length > 0 ? ' — ' + btnTexts.join(', ') : ''}`);
      console.log('');
    }

    console.log('DONE');
  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
