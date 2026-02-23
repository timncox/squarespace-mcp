/**
 * Diagnose why the SECOND addImageBlock fails.
 * Add two sections, add image block to each. After the first succeeds,
 * carefully examine what happens with the second.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { join } from 'path';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { getSiteFrame } from '../src/automation/editor-actions.js';
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

    // ========== FIRST SECTION + IMAGE (known to work) ==========
    console.log('========== FIRST SECTION + IMAGE ==========');
    const r1 = await executeAgentAction(page, { action: 'addSection' });
    console.log(`addSection 1: ${r1.success ? '✓' : '✗'} ${r1.message?.substring(0, 100)}`);
    await page.waitForTimeout(1500);

    const imgPath1 = join(IMG_DIR, 'menu-block-lovable-app.png');
    const r2 = await executeAgentAction(page, {
      action: 'addImageBlock',
      imagePath: imgPath1,
      altText: 'Menu Formatter screenshot',
    });
    console.log(`addImageBlock 1: ${r2.success ? '✓' : '✗'} ${r2.message?.substring(0, 150)}`);
    await takeScreenshot(page, 'diag2-1-after-first-image');

    if (!r2.success) {
      console.log('FIRST IMAGE FAILED — aborting');
      return;
    }

    // ========== TRANSITION TO SECOND SECTION ==========
    console.log('\n========== PREPARING FOR SECOND SECTION ==========');

    // Check current state
    const sf = getSiteFrame(page);
    if (sf) {
      const imgBlocks = await sf.locator('.sqs-block-image').count();
      console.log(`Image blocks in iframe: ${imgBlocks}`);
      for (let i = 0; i < imgBlocks; i++) {
        const block = sf.locator('.sqs-block-image').nth(i);
        const hasCdn = await block.locator('img[src*="squarespace-cdn"], img[src*="images.squarespace"]').count().catch(() => 0);
        console.log(`  block[${i}]: hasCdnImage=${hasCdn > 0}`);
      }
    }

    // Escape out of any current state
    console.log('\nEscaping current state...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await takeScreenshot(page, 'diag2-2-after-escape');

    // Check if ADD BLOCK is visible (still in edit mode?)
    const addBlockVis = await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`ADD BLOCK visible after escape: ${addBlockVis}`);

    // Check if ADD SECTION is visible
    const addSectionVis = await page.getByRole('button', { name: /add section/i }).first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`ADD SECTION visible: ${addSectionVis}`);

    // ========== ADD SECOND SECTION ==========
    console.log('\n========== ADDING SECOND SECTION ==========');
    const r3 = await executeAgentAction(page, { action: 'addSection' });
    console.log(`addSection 2: ${r3.success ? '✓' : '✗'} ${r3.message?.substring(0, 100)}`);
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'diag2-3-after-second-section');

    // Check state after adding second section
    const addBlockVis2 = await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`ADD BLOCK visible after addSection 2: ${addBlockVis2}`);

    if (!addBlockVis2) {
      console.log('Not in edit mode — trying enterSectionEditMode');
      const er = await executeAgentAction(page, { action: 'enterSectionEditMode', sectionIndex: 'last' });
      console.log(`enterSectionEditMode: ${er.success ? '✓' : '✗'} ${er.message?.substring(0, 100)}`);
      await page.waitForTimeout(1500);
    }

    // ========== ADD SECOND IMAGE (manually, step by step) ==========
    console.log('\n========== SECOND IMAGE BLOCK — MANUAL STEPS ==========');

    // Step 2: Click ADD BLOCK
    console.log('\nStep 2: Click ADD BLOCK');
    await page.getByRole('button', { name: /add block/i }).first().click({ timeout: 3000 });
    await page.waitForTimeout(1500);
    await takeScreenshot(page, 'diag2-4-block-picker');

    // Step 3: Click Image tile
    console.log('\nStep 3: Click Image tile in iframe');
    const sf2 = getSiteFrame(page);
    if (sf2) {
      const imgText = sf2.getByText('Image', { exact: true }).first();
      const imgBox = await imgText.boundingBox().catch(() => null);
      console.log(`  Image tile box: ${imgBox ? `${Math.round(imgBox.x)},${Math.round(imgBox.y)}` : 'null'}`);
      if (imgBox) {
        await page.mouse.click(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
        console.log('  Clicked Image tile');
      } else {
        console.log('  Image tile NOT FOUND in iframe');
        // Try main frame
        const mainImg = page.getByText('Image', { exact: true }).first();
        const mainVis = await mainImg.isVisible({ timeout: 1500 }).catch(() => false);
        console.log(`  Main frame "Image" visible: ${mainVis}`);
      }
    }

    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'diag2-5-after-image-click');

    // Step 4: Check what we have
    console.log('\nStep 4: Check state after clicking Image');
    const sf3 = getSiteFrame(page);
    if (sf3) {
      const allImgBlocks = sf3.locator('.sqs-block-image');
      const blockCount = await allImgBlocks.count();
      console.log(`  Image blocks: ${blockCount}`);
      for (let i = 0; i < blockCount; i++) {
        const block = allImgBlocks.nth(i);
        const hasCdn = await block.locator('img[src*="squarespace-cdn"], img[src*="images.squarespace"]').count().catch(() => 0);
        const box = await block.boundingBox().catch(() => null);
        console.log(`  block[${i}]: hasCdnImage=${hasCdn > 0} box=${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : 'null'}`);
      }

      // Find empty one
      let emptyIdx = -1;
      for (let i = blockCount - 1; i >= 0; i--) {
        const block = allImgBlocks.nth(i);
        const hasCdn = await block.locator('img[src*="squarespace-cdn"], img[src*="images.squarespace"]').count().catch(() => 0);
        if (hasCdn === 0) {
          emptyIdx = i;
          break;
        }
      }
      console.log(`  Empty block index: ${emptyIdx}`);

      if (emptyIdx >= 0) {
        const emptyBlock = allImgBlocks.nth(emptyIdx);
        await emptyBlock.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        const emptyBox = await emptyBlock.boundingBox().catch(() => null);
        console.log(`  Empty block box: ${emptyBox ? `${Math.round(emptyBox.x)},${Math.round(emptyBox.y)} ${Math.round(emptyBox.width)}x${Math.round(emptyBox.height)}` : 'null'}`);

        if (emptyBox) {
          // Check file inputs BEFORE double-click
          const mainFI = await page.locator('input[type="file"]').count();
          const iframeFI = sf3 ? await sf3.locator('input[type="file"]').count() : 0;
          console.log(`\n  BEFORE double-click: mainFI=${mainFI} iframeFI=${iframeFI}`);

          // Single click first
          console.log('  Single-clicking empty block...');
          await page.mouse.click(emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height / 2);
          await page.waitForTimeout(1500);
          const mainFI2 = await page.locator('input[type="file"]').count();
          const iframeFI2 = sf3 ? await sf3.locator('input[type="file"]').count() : 0;
          console.log(`  After single-click: mainFI=${mainFI2} iframeFI=${iframeFI2}`);
          await takeScreenshot(page, 'diag2-6-single-click');

          // Double click
          console.log('  Double-clicking empty block...');
          await page.mouse.dblclick(emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height / 2);
          await page.waitForTimeout(2000);
          const mainFI3 = await page.locator('input[type="file"]').count();
          const iframeFI3 = sf3 ? await sf3.locator('input[type="file"]').count() : 0;
          console.log(`  After double-click: mainFI=${mainFI3} iframeFI=${iframeFI3}`);
          await takeScreenshot(page, 'diag2-7-double-click');

          // Dump file inputs
          for (let i = 0; i < mainFI3; i++) {
            const info = await page.locator('input[type="file"]').nth(i).evaluate((e: HTMLInputElement) => ({
              accept: e.accept, vis: getComputedStyle(e).visibility,
              display: getComputedStyle(e).display,
              parent: e.parentElement?.className?.substring(0, 80),
            })).catch(() => 'error');
            console.log(`  main[${i}]: ${JSON.stringify(info)}`);
          }
          for (let i = 0; i < iframeFI3; i++) {
            const info = await sf3.locator('input[type="file"]').nth(i).evaluate((e: HTMLInputElement) => ({
              accept: e.accept, vis: getComputedStyle(e).visibility,
              display: getComputedStyle(e).display,
              parent: e.parentElement?.className?.substring(0, 80),
            })).catch(() => 'error');
            console.log(`  iframe[${i}]: ${JSON.stringify(info)}`);
          }

          // If no file input, try filechooser
          if (mainFI3 + iframeFI3 === 0) {
            console.log('\n  Trying filechooser approach...');
            const fc = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
            await page.mouse.click(emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height / 2);
            const chooser = await fc;
            if (chooser) {
              console.log('  ✅ Got filechooser!');
              const imgPath2 = join(IMG_DIR, 'webscrapetool-lovable-app.png');
              await chooser.setFiles(imgPath2);
              console.log('  Uploaded!');
              await page.waitForTimeout(3000);
              await takeScreenshot(page, 'diag2-8-uploaded');
            } else {
              console.log('  No filechooser');

              // Try triple-click
              console.log('  Trying triple-click...');
              await page.mouse.click(emptyBox.x + emptyBox.width / 2, emptyBox.y + emptyBox.height / 2, { clickCount: 3 });
              await page.waitForTimeout(2000);
              const mainFI4 = await page.locator('input[type="file"]').count();
              const iframeFI4 = sf3 ? await sf3.locator('input[type="file"]').count() : 0;
              console.log(`  After triple-click: mainFI=${mainFI4} iframeFI=${iframeFI4}`);
              await takeScreenshot(page, 'diag2-8-triple-click');
            }
          } else {
            // Upload via the file input that was found
            console.log('\n  Uploading via file input...');
            const imgPath2 = join(IMG_DIR, 'webscrapetool-lovable-app.png');
            let uploaded = false;
            // Try iframe first
            for (let i = 0; i < iframeFI3 && !uploaded; i++) {
              try {
                await sf3.locator('input[type="file"]').nth(i).setInputFiles(imgPath2);
                uploaded = true;
                console.log(`  ✅ Uploaded via iframe[${i}]`);
              } catch (e) {
                console.log(`  iframe[${i}] failed: ${(e as Error).message.substring(0, 80)}`);
              }
            }
            // Then main
            for (let i = 0; i < mainFI3 && !uploaded; i++) {
              try {
                await page.locator('input[type="file"]').nth(i).setInputFiles(imgPath2);
                uploaded = true;
                console.log(`  ✅ Uploaded via main[${i}]`);
              } catch (e) {
                console.log(`  main[${i}] failed: ${(e as Error).message.substring(0, 80)}`);
              }
            }
            await page.waitForTimeout(3000);
            await takeScreenshot(page, 'diag2-8-uploaded');
          }
        }
      }
    }

    console.log('\nDONE');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
