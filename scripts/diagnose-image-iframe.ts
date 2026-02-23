/**
 * Confirm: block picker + image upload is inside the iframe.
 * Add section first, enter edit mode, click ADD BLOCK, then find Image.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { getSiteFrame } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

async function waitForEditMode(page: Page, ms = 5000): Promise<boolean> {
  const sf = getSiteFrame(page);
  const start = Date.now();
  while (Date.now() - start < ms) {
    // Check main frame
    if (await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 500 }).catch(() => false)) return true;
    // Check iframe
    if (sf) {
      const iBtn = sf.getByRole('button', { name: /add block/i }).first();
      const iBox = await iBtn.boundingBox().catch(() => null);
      if (iBox) return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

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

    // Step 1: Add a section
    console.log('=== Step 1: Add section ===');
    const r = await executeAgentAction(page, { action: 'addSection' });
    console.log(`addSection: ${r.success ? '✓' : '✗'} ${r.message?.substring(0, 100)}`);
    await page.waitForTimeout(2000);

    const sf = getSiteFrame(page);
    if (!sf) { console.log('No site frame'); return; }

    // Step 2: Check where ADD BLOCK is
    console.log('\n=== Step 2: Where is ADD BLOCK? ===');
    const mainAB = await page.getByRole('button', { name: /add block/i }).count();
    const iframeAB = await sf.getByRole('button', { name: /add block/i }).count();
    console.log(`ADD BLOCK: main=${mainAB} iframe=${iframeAB}`);

    // Check visibility & bounding box
    if (mainAB > 0) {
      const vis = await page.getByRole('button', { name: /add block/i }).first().isVisible().catch(() => false);
      console.log(`  main visible: ${vis}`);
    }
    if (iframeAB > 0) {
      const box = await sf.getByRole('button', { name: /add block/i }).first().boundingBox().catch(() => null);
      console.log(`  iframe box: ${box ? `${Math.round(box.x)},${Math.round(box.y)}` : 'null'}`);
    }

    // Click ADD BLOCK in the right context
    console.log('\n=== Step 3: Click ADD BLOCK ===');
    let addBlockClicked = false;

    // Try main frame first
    if (mainAB > 0) {
      const vis = await page.getByRole('button', { name: /add block/i }).first().isVisible().catch(() => false);
      if (vis) {
        await page.getByRole('button', { name: /add block/i }).first().click();
        addBlockClicked = true;
        console.log('Clicked ADD BLOCK in main frame');
      }
    }

    // Try iframe
    if (!addBlockClicked && iframeAB > 0) {
      const box = await sf.getByRole('button', { name: /add block/i }).first().boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        addBlockClicked = true;
        console.log(`Clicked ADD BLOCK in iframe at ${Math.round(box.x)},${Math.round(box.y)}`);
      }
    }

    if (!addBlockClicked) {
      console.log('Could not click ADD BLOCK');
      await takeScreenshot(page, 'iframe-no-addblock');
      return;
    }

    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'iframe-2-block-picker');

    // Step 4: Check where block picker content is
    console.log('\n=== Step 4: Where is block picker? ===');
    for (const text of ['Image', 'Text', 'Button', 'Video']) {
      const mainC = await page.getByText(text, { exact: true }).count();
      const iframeC = await sf.getByText(text, { exact: true }).count();
      console.log(`  "${text}": main=${mainC} iframe=${iframeC}`);
    }

    // Search input
    const searchMain = await page.locator('input[placeholder*="earch"]').count();
    const searchIframe = await sf.locator('input[placeholder*="earch"]').count();
    console.log(`  Search input: main=${searchMain} iframe=${searchIframe}`);

    // Step 5: Click "Image" in the correct frame
    console.log('\n=== Step 5: Click Image ===');

    // Try iframe first (based on previous findings)
    const iframeImageText = sf.getByText('Image', { exact: true });
    const iframeImageCount = await iframeImageText.count();
    if (iframeImageCount > 0) {
      const box = await iframeImageText.first().boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        console.log(`Clicked Image in iframe at ${Math.round(box.x)},${Math.round(box.y)}`);
      } else {
        // Try clicking via frame JS
        const frame = page.frame({ name: 'sqs-site-frame' });
        if (frame) {
          const clicked = await frame.evaluate(() => {
            const all = document.querySelectorAll('*');
            for (const el of all) {
              if ((el as HTMLElement).innerText?.trim() === 'Image' && el.children.length <= 3) {
                (el as HTMLElement).click();
                return `clicked at ${el.tagName}.${el.className}`;
              }
            }
            return false;
          });
          console.log(`Clicked Image via iframe JS: ${clicked}`);
        }
      }
    } else {
      // Try main frame
      const mainImageText = page.getByText('Image', { exact: true });
      const mainImageCount = await mainImageText.count();
      if (mainImageCount > 0) {
        await mainImageText.first().click();
        console.log('Clicked Image in main frame');
      } else {
        console.log('Image text NOT FOUND in either frame!');
      }
    }

    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'iframe-3-after-image');

    // Step 6: Check for image block & file inputs
    console.log('\n=== Step 6: After clicking Image ===');
    const imgBlocks = await sf.locator('.sqs-block-image').count();
    console.log(`Image blocks: ${imgBlocks}`);

    const mainFI = await page.locator('input[type="file"]').count();
    const iframeFI = await sf.locator('input[type="file"]').count();
    console.log(`File inputs: main=${mainFI} iframe=${iframeFI}`);

    // Step 7: Try interacting with the image block
    if (imgBlocks > 0) {
      console.log('\n=== Step 7: Interact with image block ===');
      const block = sf.locator('.sqs-block-image').last();
      await block.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      const blockBox = await block.boundingBox().catch(() => null);
      console.log(`Block box: ${blockBox ? `${Math.round(blockBox.x)},${Math.round(blockBox.y)} ${Math.round(blockBox.width)}x${Math.round(blockBox.height)}` : 'null'}`);

      if (blockBox) {
        // Single click
        await page.mouse.click(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
        await page.waitForTimeout(1500);
        console.log('Single-clicked image block');
        let fi = await page.locator('input[type="file"]').count();
        let fii = await sf.locator('input[type="file"]').count();
        console.log(`  File inputs: main=${fi} iframe=${fii}`);
        await takeScreenshot(page, 'iframe-4-clicked');

        // Double click
        await page.mouse.dblclick(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
        await page.waitForTimeout(2000);
        console.log('Double-clicked image block');
        fi = await page.locator('input[type="file"]').count();
        fii = await sf.locator('input[type="file"]').count();
        console.log(`  File inputs: main=${fi} iframe=${fii}`);
        await takeScreenshot(page, 'iframe-5-dblclicked');

        // Dump file input details
        for (let i = 0; i < fi; i++) {
          const info = await page.locator('input[type="file"]').nth(i).evaluate((e: HTMLInputElement) => ({
            accept: e.accept, parent: e.parentElement?.className?.substring(0, 60),
          })).catch(() => 'error');
          console.log(`  main [${i}] ${JSON.stringify(info)}`);
        }
        for (let i = 0; i < fii; i++) {
          const info = await sf.locator('input[type="file"]').nth(i).evaluate((e: HTMLInputElement) => ({
            accept: e.accept, parent: e.parentElement?.className?.substring(0, 60),
          })).catch(() => 'error');
          console.log(`  iframe [${i}] ${JSON.stringify(info)}`);
        }

        // Test filechooser
        console.log('\n  Testing filechooser...');
        const fc = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
        await page.mouse.click(blockBox.x + blockBox.width / 2, blockBox.y + blockBox.height / 2);
        const chooser = await fc;
        if (chooser) {
          console.log('  ✅ GOT FILECHOOSER!');
          await chooser.setFiles('/Users/timcox/squarespace helper/storage/uploads/project-screenshots/menu-block-lovable-app.png');
          console.log('  Uploaded!');
          await page.waitForTimeout(3000);
          await takeScreenshot(page, 'iframe-6-uploaded');
        } else {
          console.log('  No filechooser');

          // Try setInputFiles on iframe file inputs
          if (fii > 0) {
            console.log(`\n  Trying setInputFiles on iframe input[type="file"]...`);
            for (let i = 0; i < fii; i++) {
              try {
                await sf.locator('input[type="file"]').nth(i).setInputFiles('/Users/timcox/squarespace helper/storage/uploads/project-screenshots/menu-block-lovable-app.png');
                console.log(`  ✅ Uploaded via iframe file input [${i}]!`);
                await page.waitForTimeout(3000);
                await takeScreenshot(page, 'iframe-6-uploaded');
                break;
              } catch (err) {
                console.log(`  iframe [${i}] failed: ${(err as Error).message.substring(0, 80)}`);
              }
            }
          }
        }
      }
    }

    console.log('\nDONE');
    await takeScreenshot(page, 'iframe-final');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
