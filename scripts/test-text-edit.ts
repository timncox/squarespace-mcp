/**
 * Focused test: try to edit a text block in the first project section.
 * Detailed logging to understand why the text editor isn't activating.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, clickThroughOverlay, dblclickThroughOverlay } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const SECTION_ID = '6998b6a09463047a8fb1c422'; // Section 0 — Menu Formatter

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

    const cpLink = page.locator('text=Coding Projects').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cpLink.click();
      await page.waitForTimeout(5000);
    }

    await enterEditMode(page);
    await page.waitForTimeout(3000);

    const sf = getSiteFrame(page);
    if (!sf) { console.log('No site frame!'); return; }

    const sectionSel = `.page-section[data-section-id="${SECTION_ID}"]`;
    const section = sf.locator(sectionSel);

    // Check initial state
    const textBlocks = section.locator('.sqs-block-html .sqs-block-content');
    const textCount = await textBlocks.count();
    console.log(`\nText blocks in section: ${textCount}`);
    for (let i = 0; i < textCount; i++) {
      const text = await textBlocks.nth(i).innerText().catch(() => '(error)');
      const box = await textBlocks.nth(i).boundingBox().catch(() => null);
      console.log(`  [${i}] text="${text.substring(0, 50)}" box=${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : 'null'}`);
    }

    // Step 1: Click section to select it
    console.log('\n=== Step 1: Click section ===');
    const r1 = await clickThroughOverlay(page, sectionSel);
    console.log(`click: ${r1.success ? '✓' : '✗'} ${r1.message}`);
    await page.waitForTimeout(800);
    await takeScreenshot(page, 'test-text-1-after-section-click');

    // Step 2: Double-click section to enter edit mode
    console.log('\n=== Step 2: Double-click section for edit mode ===');
    const r2 = await dblclickThroughOverlay(page, sectionSel);
    console.log(`dblclick: ${r2.success ? '✓' : '✗'} ${r2.message}`);
    await page.waitForTimeout(1500);

    const addBlockVis = await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`ADD BLOCK visible (edit mode): ${addBlockVis}`);
    await takeScreenshot(page, 'test-text-2-after-section-dblclick');

    // Step 3: Get text block coordinates AFTER entering edit mode
    console.log('\n=== Step 3: Get text block coordinates ===');
    const textBlock = textBlocks.nth(0);
    await textBlock.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);

    const textBox = await textBlock.boundingBox().catch(() => null);
    console.log(`Text block[0] box: ${textBox ? `${Math.round(textBox.x)},${Math.round(textBox.y)} ${Math.round(textBox.width)}x${Math.round(textBox.height)}` : 'null'}`);
    const viewport = page.viewportSize() || { width: 1440, height: 900 };
    console.log(`Viewport: ${viewport.width}x${viewport.height}`);

    if (!textBox) {
      console.log('⚠ No bounding box — trying to scroll section into view');
      await section.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      const textBox2 = await textBlock.boundingBox().catch(() => null);
      console.log(`After section scroll, text block box: ${textBox2 ? `${Math.round(textBox2.x)},${Math.round(textBox2.y)}` : 'null'}`);
    }

    const finalBox = await textBlock.boundingBox().catch(() => null);
    if (!finalBox) {
      console.log('⚠ Still no bounding box!');
      return;
    }

    // Step 4: Double-click the text block
    console.log(`\n=== Step 4: Double-click text block at (${Math.round(finalBox.x + finalBox.width / 2)}, ${Math.round(finalBox.y + finalBox.height / 2)}) ===`);
    await page.mouse.dblclick(finalBox.x + finalBox.width / 2, finalBox.y + finalBox.height / 2);
    await page.waitForTimeout(1500);
    await takeScreenshot(page, 'test-text-3-after-text-dblclick');

    // Check if editor is active
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    let hasEditor = false;
    let activeInfo = 'N/A';
    if (siteFrame) {
      hasEditor = await siteFrame.evaluate(() => {
        const active = document.activeElement;
        return active != null && (active as HTMLElement).isContentEditable;
      }).catch(() => false);

      activeInfo = await siteFrame.evaluate(() => {
        const active = document.activeElement;
        if (!active) return 'null';
        return `${active.tagName}.${active.className?.toString().substring(0, 50)} editable=${(active as HTMLElement).isContentEditable} text="${(active as HTMLElement).innerText?.substring(0, 40)}"`;
      }).catch(() => 'error');
    }
    console.log(`Active editor: ${hasEditor}`);
    console.log(`Active element: ${activeInfo}`);

    if (!hasEditor) {
      // Try single click first, then double-click
      console.log('\n=== Retry: Single click then double-click ===');
      await page.mouse.click(finalBox.x + finalBox.width / 2, finalBox.y + finalBox.height / 2);
      await page.waitForTimeout(500);
      await page.mouse.dblclick(finalBox.x + finalBox.width / 2, finalBox.y + finalBox.height / 2);
      await page.waitForTimeout(1500);

      if (siteFrame) {
        hasEditor = await siteFrame.evaluate(() => {
          const active = document.activeElement;
          return active != null && (active as HTMLElement).isContentEditable;
        }).catch(() => false);
        activeInfo = await siteFrame.evaluate(() => {
          const active = document.activeElement;
          if (!active) return 'null';
          return `${active.tagName}.${active.className?.toString().substring(0, 50)} editable=${(active as HTMLElement).isContentEditable} text="${(active as HTMLElement).innerText?.substring(0, 40)}"`;
        }).catch(() => 'error');
      }
      console.log(`After retry — Active editor: ${hasEditor}`);
      console.log(`After retry — Active element: ${activeInfo}`);
      await takeScreenshot(page, 'test-text-4-after-retry');
    }

    if (!hasEditor) {
      // Try triple-click
      console.log('\n=== Triple-click attempt ===');
      await page.mouse.click(finalBox.x + finalBox.width / 2, finalBox.y + finalBox.height / 2, { clickCount: 3 });
      await page.waitForTimeout(1500);

      if (siteFrame) {
        hasEditor = await siteFrame.evaluate(() => {
          const active = document.activeElement;
          return active != null && (active as HTMLElement).isContentEditable;
        }).catch(() => false);
        activeInfo = await siteFrame.evaluate(() => {
          const active = document.activeElement;
          if (!active) return 'null';
          return `${active.tagName}.${active.className?.toString().substring(0, 50)} editable=${(active as HTMLElement).isContentEditable} text="${(active as HTMLElement).innerText?.substring(0, 40)}"`;
        }).catch(() => 'error');
      }
      console.log(`After triple-click — Active editor: ${hasEditor}`);
      console.log(`After triple-click — Active element: ${activeInfo}`);
      await takeScreenshot(page, 'test-text-5-after-triple');
    }

    if (!hasEditor) {
      // Try Enter key
      console.log('\n=== Enter key attempt ===');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);

      if (siteFrame) {
        hasEditor = await siteFrame.evaluate(() => {
          const active = document.activeElement;
          return active != null && (active as HTMLElement).isContentEditable;
        }).catch(() => false);
        activeInfo = await siteFrame.evaluate(() => {
          const active = document.activeElement;
          if (!active) return 'null';
          return `${active.tagName}.${active.className?.toString().substring(0, 50)} editable=${(active as HTMLElement).isContentEditable} text="${(active as HTMLElement).innerText?.substring(0, 40)}"`;
        }).catch(() => 'error');
      }
      console.log(`After Enter — Active editor: ${hasEditor}`);
      console.log(`After Enter — Active element: ${activeInfo}`);
      await takeScreenshot(page, 'test-text-6-after-enter');
    }

    // Check if maybe the active element is in the MAIN frame, not iframe
    const mainActive = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active) return 'null';
      return `${active.tagName}#${active.id}.${active.className?.toString().substring(0, 50)} editable=${(active as HTMLElement).isContentEditable}`;
    }).catch(() => 'error');
    console.log(`Main frame active: ${mainActive}`);

    if (hasEditor) {
      console.log('\n=== TYPING TEST ===');
      await page.keyboard.press('Meta+a');
      await page.waitForTimeout(100);
      await page.keyboard.type('Menu Formatter', { delay: 20 });
      await page.waitForTimeout(500);
      await takeScreenshot(page, 'test-text-7-typed');
      console.log('✅ Typed "Menu Formatter"!');
    } else {
      console.log('\n⚠ Could not activate text editor');
    }

    console.log('\nDONE');
  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
