/**
 * Diagnose image upload flow on a clean Squarespace page.
 * 1. Add a section on empty page
 * 2. Enter edit mode
 * 3. Click ADD BLOCK → Image
 * 4. Observe what happens — look for file inputs, filechooser events, panels
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
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 500 }).catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function dumpInputs(page: Page, label: string) {
  const c = await page.locator('input[type="file"]').count();
  console.log(`[${label}] Main file inputs: ${c}`);
  for (let i = 0; i < c; i++) {
    const info = await page.locator('input[type="file"]').nth(i).evaluate((e: HTMLInputElement) => ({
      accept: e.accept, display: getComputedStyle(e).display,
      parent: e.parentElement?.className?.substring(0, 80),
    })).catch(() => 'error');
    console.log(`  [${i}] ${JSON.stringify(info)}`);
  }
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
    console.log('=== Adding section ===');
    const r = await executeAgentAction(page, { action: 'addSection' });
    console.log(`addSection: ${r.success ? '✓' : '✗'} ${r.message?.substring(0, 100)}`);
    await page.waitForTimeout(1500);

    // Step 2: Enter edit mode
    const inEdit = await waitForEditMode(page, 3000);
    console.log(`Already in edit mode: ${inEdit}`);
    if (!inEdit) {
      // Try via action
      const er = await executeAgentAction(page, { action: 'enterSectionEditMode', sectionIndex: 'last' });
      console.log(`enterSectionEditMode: ${er.success ? '✓' : '✗'} ${er.message?.substring(0, 100)}`);
    }

    const editOk = await waitForEditMode(page, 3000);
    console.log(`Edit mode confirmed: ${editOk}`);
    if (!editOk) { console.log('CANNOT ENTER EDIT MODE'); return; }

    await dumpInputs(page, 'before-addblock');
    await takeScreenshot(page, 'imgflow-0-edit-mode');

    // Step 3: Click ADD BLOCK
    console.log('\n=== Clicking ADD BLOCK ===');
    await page.getByRole('button', { name: /add block/i }).first().click({ timeout: 3000 });
    await page.waitForTimeout(1500);
    await takeScreenshot(page, 'imgflow-1-block-picker');
    await dumpInputs(page, 'after-addblock');

    // Step 4: Click Image tile
    console.log('\n=== Clicking Image tile ===');
    // Search for it
    const search = page.locator('input[placeholder*="earch"]').first();
    if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {
      await search.fill('Image');
      await page.waitForTimeout(800);
    }

    // Find and log all "Image" text
    const imageTexts = page.getByText('Image', { exact: true });
    const count = await imageTexts.count();
    console.log(`"Image" text count: ${count}`);

    let clickedTile = false;
    for (let i = 0; i < count; i++) {
      const el = imageTexts.nth(i);
      const vis = await el.isVisible({ timeout: 500 }).catch(() => false);
      if (vis) {
        const info = await el.evaluate((e: Element) => ({
          tag: e.tagName,
          x: Math.round(e.getBoundingClientRect().x),
          y: Math.round(e.getBoundingClientRect().y),
          parent: e.parentElement?.className?.toString().substring(0, 50),
        })).catch(() => ({}));
        console.log(`  [${i}] visible ${JSON.stringify(info)}`);
        if (!clickedTile) {
          await el.click();
          clickedTile = true;
          console.log(`  → Clicked`);
        }
      }
    }

    // Wait for the image block to be created
    console.log('\nWaiting 3s for image block creation...');
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'imgflow-2-after-image-click');
    await dumpInputs(page, 'after-image-click');

    // Step 5: Check for image block and its state
    console.log('\n=== Image block state ===');
    const sf = getSiteFrame(page);
    if (sf) {
      const imgBlocks = await sf.locator('.sqs-block-image').count();
      console.log(`Image blocks: ${imgBlocks}`);

      if (imgBlocks > 0) {
        const last = sf.locator('.sqs-block-image').last();
        const inner = await last.evaluate((e: Element) => {
          return {
            html: e.innerHTML.substring(0, 600),
            classes: e.className,
            children: Array.from(e.children).map(c => `${c.tagName}.${c.className.substring(0, 30)}`),
          };
        }).catch(() => ({ html: 'error', classes: '', children: [] }));
        console.log(`  innerHTML: ${inner.html}`);
        console.log(`  classes: ${inner.classes}`);
        console.log(`  children: ${JSON.stringify(inner.children)}`);

        // Scroll into view
        await last.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        const box = await last.boundingBox().catch(() => null);
        console.log(`  box: ${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : 'null'}`);

        if (box) {
          // Step 6: Click on it
          console.log('\n=== Clicking image block ===');
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(1500);
          await takeScreenshot(page, 'imgflow-3-clicked-block');
          await dumpInputs(page, 'after-click-block');

          // Step 7: Double-click
          console.log('\n=== Double-clicking image block ===');
          await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(2000);
          await takeScreenshot(page, 'imgflow-4-dblclicked');
          await dumpInputs(page, 'after-dblclick-block');

          // Step 8: Look for editor panel that opened
          console.log('\n=== Checking for editor panel ===');
          const allBtns = page.getByRole('button');
          const btnCount = await allBtns.count();
          console.log(`Total buttons: ${btnCount}`);
          const visibleBtns: string[] = [];
          for (let i = 0; i < btnCount; i++) {
            const b = allBtns.nth(i);
            if (await b.isVisible({ timeout: 200 }).catch(() => false)) {
              const text = await b.textContent().catch(() => '');
              const label = await b.getAttribute('aria-label').catch(() => '');
              const combined = `${text?.trim().substring(0, 30)}${label ? ` [${label.substring(0, 30)}]` : ''}`;
              if (combined.trim()) visibleBtns.push(combined);
            }
          }
          console.log(`Visible buttons: ${visibleBtns.join(', ')}`);

          // Step 9: Try filechooser with triple-click
          console.log('\n=== Filechooser test ===');
          const fcPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
          // Try clicking the image block area
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          const fc = await fcPromise;
          if (fc) {
            console.log('✅ Got filechooser!');
            await fc.setFiles('/Users/timcox/squarespace helper/storage/uploads/project-screenshots/menu-block-lovable-app.png');
            console.log('Uploaded via filechooser!');
            await page.waitForTimeout(3000);
            await takeScreenshot(page, 'imgflow-5-uploaded');
          } else {
            console.log('No filechooser. Looking for upload mechanisms...');

            // Check for drag-and-drop target
            const dropZones = page.locator('[class*="dropzone"], [class*="drop-zone"], [class*="DropZone"], [class*="upload-target"]');
            const dzCount = await dropZones.count();
            console.log(`  Drop zones: ${dzCount}`);

            // Check for any buttons with "upload" or similar
            for (const name of ['Upload', 'Replace', 'Browse', 'Choose', 'Add Image']) {
              const btn = page.getByRole('button', { name: new RegExp(name, 'i') });
              const c2 = await btn.count();
              if (c2 > 0) {
                const vis = await btn.first().isVisible({ timeout: 500 }).catch(() => false);
                console.log(`  Button "${name}": count=${c2} visible=${vis}`);
              }
            }

            // Look inside iframe for the upload trigger
            if (sf) {
              const iframeInputs = await sf.locator('input[type="file"]').count();
              console.log(`  Iframe file inputs: ${iframeInputs}`);

              // Try clicking with filechooser listener on the image empty state
              console.log('\n  Trying filechooser on image block in iframe...');
              const fc2 = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
              const imgBlock = sf.locator('.sqs-block-image').last();
              await imgBlock.click({ timeout: 3000 }).catch(() => {});
              const chooser = await fc2;
              if (chooser) {
                console.log('  ✅ Got filechooser from iframe click!');
              } else {
                console.log('  No filechooser from iframe click either');
              }
            }
          }
        }
      } else {
        console.log('  No image blocks found — Image may not have been added');
      }
    }

    console.log('\nDONE');
    await takeScreenshot(page, 'imgflow-final');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
