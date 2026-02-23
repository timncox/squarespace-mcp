/**
 * Diagnose the block picker: find how the "Image" tile is structured in the DOM.
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

    // Enter edit mode (should already be from addSection)
    const addBlock = page.getByRole('button', { name: /add block/i }).first();
    if (await addBlock.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('Already in edit mode');
    } else {
      // Try clicking section
      const sf = getSiteFrame(page);
      if (sf) {
        const sec = sf.locator('.page-section').first();
        const box = await sec.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.dblclick(box.x + box.width / 2, box.y + 50);
          await page.waitForTimeout(2000);
        }
      }
    }

    // Click ADD BLOCK
    console.log('Clicking ADD BLOCK...');
    await page.getByRole('button', { name: /add block/i }).first().click({ timeout: 3000 });
    await page.waitForTimeout(2000);

    // Now dump the block picker DOM
    console.log('\n=== Block picker analysis ===\n');

    // 1. Check getByText with various options
    for (const text of ['Image', 'image', 'Text', 'Button']) {
      const exact = await page.getByText(text, { exact: true }).count();
      const partial = await page.getByText(text).count();
      console.log(`getByText("${text}"): exact=${exact} partial=${partial}`);
    }

    // 2. Check in iframe
    const sf = getSiteFrame(page);
    if (sf) {
      for (const text of ['Image', 'image', 'Text', 'Button']) {
        const exact = await sf.getByText(text, { exact: true }).count();
        const partial = await sf.getByText(text).count();
        console.log(`iframe getByText("${text}"): exact=${exact} partial=${partial}`);
      }
    }

    // 3. Look for the block picker container
    console.log('\n--- Block picker container ---');
    const pickerSelectors = [
      '[class*="block-picker"]', '[class*="BlockPicker"]',
      '[class*="block-type"]', '[class*="BlockType"]',
      '[class*="add-block-menu"]', '[class*="AddBlock"]',
      '[class*="content-type"]', '[class*="ContentType"]',
      '[class*="block-list"]', '[class*="BlockList"]',
      'nav', '[role="menu"]', '[role="listbox"]',
    ];
    for (const sel of pickerSelectors) {
      const c = await page.locator(sel).count();
      if (c > 0) {
        const vis = await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false);
        console.log(`  ${sel}: count=${c} visible=${vis}`);
      }
    }

    // 4. Dump ALL visible text in the left panel region (x < 200)
    console.log('\n--- All visible elements with text in left panel ---');
    const allElements = await page.evaluate(() => {
      const results: any[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node: Node | null = walker.nextNode();
      while (node) {
        const el = node as HTMLElement;
        const rect = el.getBoundingClientRect();
        // Only elements in the left panel area
        if (rect.x < 250 && rect.y > 80 && rect.y < 400 && rect.width > 0 && rect.height > 0) {
          const text = el.innerText?.trim();
          if (text && text.length < 50 && text.length > 0) {
            results.push({
              tag: el.tagName,
              text: text.substring(0, 40),
              class: el.className?.toString().substring(0, 60),
              role: el.getAttribute('role'),
              x: Math.round(rect.x), y: Math.round(rect.y),
              w: Math.round(rect.width), h: Math.round(rect.height),
            });
          }
        }
        node = walker.nextNode();
      }
      return results.slice(0, 30);
    });
    for (const el of allElements) {
      console.log(`  ${el.tag} "${el.text}" class="${el.class}" role=${el.role} @${el.x},${el.y} ${el.w}x${el.h}`);
    }

    // 5. Specifically find the Image tile
    console.log('\n--- Finding Image tile specifically ---');
    const imageResult = await page.evaluate(() => {
      // Find element containing exactly "Image" text
      const all = document.querySelectorAll('*');
      const results: any[] = [];
      for (const el of all) {
        const text = (el as HTMLElement).textContent?.trim();
        if (text === 'Image' || (text && /^Image$/.test(text))) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            results.push({
              tag: el.tagName,
              text: (el as HTMLElement).innerText?.trim().substring(0, 30),
              class: el.className?.toString().substring(0, 60),
              role: el.getAttribute('role'),
              x: Math.round(rect.x), y: Math.round(rect.y),
              w: Math.round(rect.width), h: Math.round(rect.height),
              parentTag: el.parentElement?.tagName,
              parentClass: el.parentElement?.className?.toString().substring(0, 60),
              parentRole: el.parentElement?.getAttribute('role'),
            });
          }
        }
      }
      return results;
    });
    console.log(`  Found ${imageResult.length} elements with textContent="Image":`);
    for (const r of imageResult) {
      console.log(`    ${JSON.stringify(r)}`);
    }

    // 6. Try using Playwright locator with :has-text
    console.log('\n--- Playwright locators ---');
    const locators = [
      { label: ':has-text("Image")', loc: page.locator(':has-text("Image")') },
      { label: 'button:has-text("Image")', loc: page.locator('button:has-text("Image")') },
      { label: 'text=Image', loc: page.locator('text=Image') },
      { label: 'text="Image"', loc: page.locator('text="Image"') },
      { label: '[role="button"]:has-text("Image")', loc: page.locator('[role="button"]:has-text("Image")') },
    ];

    for (const { label, loc } of locators) {
      const c = await loc.count();
      let visCount = 0;
      for (let i = 0; i < Math.min(c, 5); i++) {
        const vis = await loc.nth(i).isVisible({ timeout: 300 }).catch(() => false);
        if (vis) visCount++;
      }
      console.log(`  ${label}: count=${c} visible=${visCount}`);
    }

    // 7. Try clicking text=Image
    console.log('\n--- Attempting click ---');
    const textImage = page.locator('text=Image').first();
    if (await textImage.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('text=Image is visible — clicking');
      await textImage.click();
      await page.waitForTimeout(2000);

      // Check what happened
      const inputs = await page.locator('input[type="file"]').count();
      console.log(`File inputs after click: ${inputs}`);

      // Check for image block
      if (sf) {
        const imgBlocks = await sf.locator('.sqs-block-image').count();
        console.log(`Image blocks in iframe: ${imgBlocks}`);
      }

      await takeScreenshot(page, 'imgflow-after-click');
    } else {
      console.log('text=Image NOT visible');
    }

    console.log('\nDONE');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
