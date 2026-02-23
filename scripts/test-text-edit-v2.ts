/**
 * Focused test v2: try to edit a text block by clicking it directly.
 * Uses clickThroughOverlay on the text block, not the section.
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

    // Get the specific section's first text block
    const sectionSel = `.page-section[data-section-id="${SECTION_ID}"]`;
    const section = sf.locator(sectionSel);
    const textBlocks = section.locator('.sqs-block-html');
    const textCount = await textBlocks.count();
    console.log(`\nText blocks (.sqs-block-html) in section: ${textCount}`);

    if (textCount === 0) {
      console.log('⚠ No text blocks! Section might not have loaded.');
      // List all sections
      const allSections = sf.locator('.page-section');
      const allCount = await allSections.count();
      console.log(`Total sections: ${allCount}`);
      for (let i = 0; i < allCount; i++) {
        const sid = await allSections.nth(i).getAttribute('data-section-id').catch(() => '?');
        console.log(`  Section ${i}: ${sid}`);
      }
      return;
    }

    // Target the first text block
    const firstTextBlock = textBlocks.first();
    const blockContent = await firstTextBlock.locator('.sqs-block-content').first().innerText().catch(() => '');
    console.log(`First text block content: "${blockContent.substring(0, 60)}"`);

    // Method: Use the iframe selector directly with clickThroughOverlay/dblclickThroughOverlay
    // This is how editTextBlock does it — target the text element WITHIN the section
    const textSelector = `${sectionSel} .sqs-block-html:first-of-type .sqs-block-content`;

    console.log(`\n=== Step 1: Click text block directly ===`);
    console.log(`Selector: ${textSelector}`);
    const r1 = await clickThroughOverlay(page, textSelector);
    console.log(`click: ${r1.success ? '✓' : '✗'} ${r1.message}`);
    await page.waitForTimeout(1000);
    await takeScreenshot(page, 'test-text-v2-1-after-click');

    // Check if Fluid Engine edit mode activated
    const addBlockVis = await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`ADD BLOCK visible: ${addBlockVis}`);

    // Check for EDIT CONTENT or similar buttons
    const editBtns = ['Edit Section', 'EDIT', 'Edit Content', 'Edit'];
    for (const btnText of editBtns) {
      const btn = page.getByRole('button', { name: new RegExp(btnText, 'i') }).first();
      const vis = await btn.isVisible({ timeout: 500 }).catch(() => false);
      if (vis) console.log(`  Found button: "${btnText}"`);
    }

    console.log(`\n=== Step 2: Double-click text block directly ===`);
    const r2 = await dblclickThroughOverlay(page, textSelector);
    console.log(`dblclick: ${r2.success ? '✓' : '✗'} ${r2.message}`);
    await page.waitForTimeout(1500);
    await takeScreenshot(page, 'test-text-v2-2-after-dblclick');

    // Check for active editor
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

    const addBlockVis2 = await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`ADD BLOCK visible after dblclick: ${addBlockVis2}`);

    if (!hasEditor && addBlockVis2) {
      // We're in Fluid Engine edit mode. Now we need to double-click the TEXT BLOCK
      // specifically to activate the inline editor
      console.log('\n=== Step 3: In edit mode — now double-click text block again ===');

      // Re-get the bounding box (may have changed)
      const tBox = await firstTextBlock.locator('.sqs-block-content').first().boundingBox().catch(() => null);
      console.log(`Text block content box: ${tBox ? `${Math.round(tBox.x)},${Math.round(tBox.y)} ${Math.round(tBox.width)}x${Math.round(tBox.height)}` : 'null'}`);

      if (tBox) {
        await page.mouse.dblclick(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
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
        console.log(`After 2nd dblclick — Active editor: ${hasEditor}`);
        console.log(`After 2nd dblclick — Active element: ${activeInfo}`);
        await takeScreenshot(page, 'test-text-v2-3-after-2nd-dblclick');
      }
    }

    if (!hasEditor) {
      // Try the approach that works for addBlockToSection:
      // Get boundingBox of the text block and use page.mouse directly
      console.log('\n=== Step 4: Get text content box and mouse.dblclick ===');
      const allTextContent = sf.locator(`${sectionSel} .sqs-block-html .sqs-block-content`);
      const cnt = await allTextContent.count();
      console.log(`Text content blocks: ${cnt}`);
      for (let i = 0; i < cnt; i++) {
        const tb = allTextContent.nth(i);
        const txt = await tb.innerText().catch(() => '');
        const box = await tb.boundingBox().catch(() => null);
        console.log(`  [${i}] "${txt.substring(0, 30)}" box=${box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : 'null'}`);
      }
    }

    if (hasEditor) {
      console.log('\n=== TYPING TEST ===');
      await page.keyboard.press('Meta+a');
      await page.waitForTimeout(100);
      await page.keyboard.type('Menu Formatter', { delay: 20 });
      await page.waitForTimeout(500);
      await takeScreenshot(page, 'test-text-v2-typed');
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
