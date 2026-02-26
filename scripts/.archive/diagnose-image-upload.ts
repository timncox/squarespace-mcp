/**
 * Diagnose why addImageBlock step 5 fails on the 2nd call.
 * Adds a section, uploads one image, re-enters edit mode, tries a second image.
 * Logs every DOM detail at each step.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { join } from 'path';
import { Page } from 'playwright';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { getSiteFrame, saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const IMG_DIR = join(process.cwd(), 'storage', 'uploads', 'project-screenshots');

async function logFileInputs(page: Page, label: string) {
  // Check main frame
  const mainCount = await page.locator('input[type="file"]').count();
  console.log(`  [${label}] Main frame input[type="file"]: ${mainCount}`);
  for (let i = 0; i < mainCount; i++) {
    const el = page.locator('input[type="file"]').nth(i);
    try {
      const info = await el.evaluate((e: HTMLInputElement) => ({
        id: e.id, name: e.name, accept: e.accept, multiple: e.multiple,
        display: getComputedStyle(e).display, visibility: getComputedStyle(e).visibility,
        rect: (() => { const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; })(),
        parentTag: e.parentElement?.tagName, parentClass: e.parentElement?.className?.substring(0, 60),
      }));
      console.log(`    [${i}] ${JSON.stringify(info)}`);
    } catch (err) {
      console.log(`    [${i}] ERROR: ${(err as Error).message.substring(0, 80)}`);
    }
  }

  // Check iframe
  const siteFrame = getSiteFrame(page);
  if (siteFrame) {
    const iframeCount = await siteFrame.locator('input[type="file"]').count();
    console.log(`  [${label}] Iframe input[type="file"]: ${iframeCount}`);
    for (let i = 0; i < iframeCount; i++) {
      const el = siteFrame.locator('input[type="file"]').nth(i);
      try {
        const info = await el.evaluate((e: HTMLInputElement) => ({
          id: e.id, name: e.name, accept: e.accept,
          display: getComputedStyle(e).display, visibility: getComputedStyle(e).visibility,
        }));
        console.log(`    [${i}] ${JSON.stringify(info)}`);
      } catch (err) {
        console.log(`    [${i}] ERROR: ${(err as Error).message.substring(0, 80)}`);
      }
    }
  }
}

async function logImagePanelState(page: Page, label: string) {
  // Check for image editor panels, library panels, etc.
  const panelSelectors = [
    '[class*="ImageEditor"]', '[class*="image-editor"]',
    '[class*="MediaEditor"]', '[class*="media-editor"]',
    '[class*="AssetPicker"]', '[class*="asset-picker"]',
    '[class*="ImageLibrary"]', '[class*="image-library"]',
    '[class*="UploadPanel"]', '[class*="upload-panel"]',
    'button:has-text("Upload")', 'button:has-text("Replace")',
    '[role="dialog"]',
  ];
  console.log(`  [${label}] Panel state:`);
  for (const sel of panelSelectors) {
    const count = await page.locator(sel).count();
    if (count > 0) {
      const visible = await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false);
      console.log(`    ${sel}: count=${count} visible=${visible}`);
    }
  }
}

async function waitForEditMode(page: Page, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const visible = await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 500 }).catch(() => false);
    if (visible) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function enterSectionEdit(page: Page): Promise<boolean> {
  if (await waitForEditMode(page, 1500)) return true;
  const siteFrame = getSiteFrame(page);
  if (!siteFrame) return false;
  const sections = await siteFrame.locator('.page-section').count();
  if (sections === 0) return false;
  const lastContentIdx = Math.max(0, sections - 2);
  const section = siteFrame.locator('.page-section').nth(lastContentIdx);
  await section.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const box = await section.boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(800);
  const editBtn = page.getByRole('button', { name: /edit (section|content)/i });
  if (await editBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await editBtn.first().click();
    await page.waitForTimeout(1500);
    return await waitForEditMode(page, 3000);
  }
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1500);
  return await waitForEditMode(page, 3000);
}

async function main() {
  const browserManager = getBrowserManager({ headless: false });
  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

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

    // Check initial state
    console.log('\n=== Initial State ===');
    await logFileInputs(page, 'initial');
    await logImagePanelState(page, 'initial');

    // Add a section first
    console.log('\n=== Adding Section ===');
    const r1 = await executeAgentAction(page, { action: 'addSection' });
    console.log(`  addSection: ${r1.success ? '✓' : '✗'} ${r1.message?.substring(0, 100)}`);
    await page.waitForTimeout(1500);

    // Enter edit mode
    const edit1 = await enterSectionEdit(page);
    console.log(`  Edit mode: ${edit1}`);

    // ── First addImageBlock ──
    console.log('\n=== First addImageBlock ===');
    await logFileInputs(page, 'before-img1');

    const img1 = join(IMG_DIR, 'menu-block-lovable-app.png');
    const r2 = await executeAgentAction(page, { action: 'addImageBlock', imagePath: img1, altText: 'Menu Formatter screenshot' });
    console.log(`  addImageBlock 1: ${r2.success ? '✓' : '✗'} ${r2.message?.substring(0, 120)}`);

    await page.waitForTimeout(2000);
    await logFileInputs(page, 'after-img1');
    await logImagePanelState(page, 'after-img1');
    await takeScreenshot(page, 'diag-after-img1');

    // ── Now re-enter edit mode for second image ──
    console.log('\n=== Re-entering edit mode ===');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const edit2 = await enterSectionEdit(page);
    console.log(`  Edit mode re-entry: ${edit2}`);
    await logFileInputs(page, 'after-reenter');

    // ── Second addImageBlock ── (different section or same section)
    console.log('\n=== Second addImageBlock ===');

    // First add a new section for the 2nd image
    const r3 = await executeAgentAction(page, { action: 'addSection' });
    console.log(`  addSection 2: ${r3.success ? '✓' : '✗'} ${r3.message?.substring(0, 100)}`);
    await page.waitForTimeout(1500);

    const edit3 = await enterSectionEdit(page);
    console.log(`  Edit mode for section 2: ${edit3}`);
    await logFileInputs(page, 'before-img2');

    // Now try the second image block
    console.log('\n  --- Step-by-step addImageBlock 2 ---');

    // Step 2: ADD BLOCK
    let addBlockClicked = false;
    try {
      await page.getByRole('button', { name: /add block/i }).first().click({ timeout: 3000 });
      addBlockClicked = true;
      console.log('  Step 2: ADD BLOCK ✓');
    } catch { console.log('  Step 2: ADD BLOCK ✗ (getByRole failed)'); }
    await page.waitForTimeout(1000);
    await logFileInputs(page, 'after-ADD-BLOCK');

    // Step 3: Search "Image" and click
    const searchInput = page.locator('input[placeholder*="Search"], input[type="search"]').first();
    if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await searchInput.click();
      await searchInput.fill('Image');
      console.log('  Step 3: Typed "Image" in search');
      await page.waitForTimeout(800);
    }

    // Click Image tile
    const imageTile = page.locator('text="Image"').first();
    if (await imageTile.isVisible({ timeout: 2000 }).catch(() => false)) {
      await imageTile.click();
      console.log('  Step 3: Clicked Image tile ✓');
    } else {
      console.log('  Step 3: Image tile NOT visible ✗');
    }
    await page.waitForTimeout(2000);

    // Step 4: Check what happened
    console.log('\n  --- After clicking Image tile ---');
    await logFileInputs(page, 'after-image-tile');
    await logImagePanelState(page, 'after-image-tile');
    await takeScreenshot(page, 'diag-after-image-tile-2');

    // Check the iframe for empty image blocks
    const siteFrame = getSiteFrame(page);
    if (siteFrame) {
      const imgBlocks = await siteFrame.locator('.sqs-block-image').count();
      console.log(`  Image blocks in iframe: ${imgBlocks}`);
      for (let i = 0; i < imgBlocks; i++) {
        const block = siteFrame.locator('.sqs-block-image').nth(i);
        const hasSrc = await block.locator('img[src]').count();
        const hasPlaceholder = await block.locator('[class*="placeholder"], [class*="empty"]').count();
        console.log(`    [${i}] hasSrc=${hasSrc} hasPlaceholder=${hasPlaceholder}`);
      }

      // Try clicking the last image block (which should be the empty one)
      const lastImgBlock = siteFrame.locator('.sqs-block-image').last();
      const imgBox = await lastImgBlock.boundingBox().catch(() => null);
      if (imgBox) {
        console.log(`  Last image block box: ${Math.round(imgBox.x)},${Math.round(imgBox.y)} ${Math.round(imgBox.width)}x${Math.round(imgBox.height)}`);

        // Double-click it
        await page.mouse.dblclick(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
        console.log('  Double-clicked last image block');
        await page.waitForTimeout(2000);

        await logFileInputs(page, 'after-dblclick-img-block');
        await logImagePanelState(page, 'after-dblclick-img-block');
        await takeScreenshot(page, 'diag-after-dblclick-img-2');
      }
    }

    // Try explicit image block click via evaluate
    if (siteFrame) {
      const clickResult = await siteFrame.evaluate(() => {
        const blocks = document.querySelectorAll('.sqs-block-image');
        const last = blocks[blocks.length - 1];
        if (last) {
          (last as HTMLElement).click();
          // Also try clicking the content within
          const inner = last.querySelector('.sqs-block-content, .image-block-wrapper, .sqs-image-content');
          if (inner) (inner as HTMLElement).click();
          return `clicked block + inner (${inner?.className?.substring(0, 40) || 'none'})`;
        }
        return 'no blocks found';
      }).catch((e: Error) => `error: ${e.message.substring(0, 60)}`);
      console.log(`  JS click on last image block: ${clickResult}`);
      await page.waitForTimeout(1500);
      await logFileInputs(page, 'after-js-click');
    }

    // Final step: try the full addImageBlock action to see its exact error
    console.log('\n=== Full addImageBlock call (2nd time) ===');
    // Re-enter edit mode
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const edit4 = await enterSectionEdit(page);
    console.log(`  Edit mode: ${edit4}`);

    const img2 = join(IMG_DIR, 'webscrapetool-lovable-app.png');
    const r4 = await executeAgentAction(page, { action: 'addImageBlock', imagePath: img2, altText: 'Web Scraper screenshot' });
    console.log(`  addImageBlock 2 (full): ${r4.success ? '✓' : '✗'} ${r4.message}`);

    await takeScreenshot(page, 'diag-final');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
