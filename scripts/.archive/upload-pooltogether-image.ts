/**
 * Fix Section 5 (PoolTogether Explorer) image.
 *
 * The section currently has a broken PNG in the video/media slot.
 * We need to:
 * 1. Delete the incorrectly uploaded PNG from the media slot
 * 2. Figure out how other sections display their project screenshots
 * 3. Apply the same approach for this section
 *
 * First: inspect a working section (Section 0 — Menu Formatter) to see how it shows its image.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import path from 'path';
import { Page } from 'playwright';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, clickThroughOverlay, saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const TARGET_SECTION_ID = '6998b7ab9a433a09563d2d60'; // PoolTogether Explorer
const WORKING_SECTION_ID = '6998b6a09463047a8fb1c422'; // Menu Formatter (has working image)
const IMAGE_PATH = path.resolve('/Users/timcox/squarespace helper/storage/uploads/project-screenshots/timalytics2-netlify-app.png');

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Navigate to Coding Projects
    console.log('=== Navigate to Coding Projects ===');
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(5000);

    const cpLink = page.locator('text="Coding Projects"').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cpLink.click();
      await page.waitForTimeout(5000);
    }

    await enterEditMode(page);
    await page.waitForTimeout(3000);

    // ===== PHASE 1: Inspect the working section =====
    console.log('\n=== Phase 1: Inspect working section (Menu Formatter) ===');
    await clickThroughOverlay(page, `.page-section[data-section-id="${WORKING_SECTION_ID}"]`);
    await page.waitForTimeout(1500);

    // Click Edit
    const editBtn1 = page.getByRole('button', { name: /^edit$/i }).first();
    if (await editBtn1.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editBtn1.click();
      console.log('  Opened working section editor');
      await page.waitForTimeout(2000);
    }
    await takeScreenshot(page, 'upload-pt-working-section');

    // Check the working section's content panel
    const sf = getSiteFrame(page);
    if (sf) {
      const workingSection = sf.locator(`.page-section[data-section-id="${WORKING_SECTION_ID}"]`);

      // Check for image blocks
      const imgBlocks = await workingSection.locator('.sqs-block-image').count();
      const allImgs = await workingSection.locator('img').count();
      const bgImgs = await workingSection.evaluate((el: Element) => {
        const style = getComputedStyle(el);
        return style.backgroundImage || 'none';
      }).catch(() => 'error');

      console.log(`  Working section: imgBlocks=${imgBlocks}, imgs=${allImgs}, bgImage=${bgImgs?.substring(0, 80)}`);

      // Check all images in the section
      for (let i = 0; i < Math.min(allImgs, 5); i++) {
        const img = workingSection.locator('img').nth(i);
        const src = await img.getAttribute('src').catch(() => '');
        const alt = await img.getAttribute('alt').catch(() => '');
        const parentClass = await img.evaluate((el: Element) => el.parentElement?.className?.substring(0, 60) || '').catch(() => '');
        console.log(`    img[${i}]: src="${(src || '').substring(0, 80)}" alt="${alt}" parentClass="${parentClass}"`);
      }
    }

    // Close the editor panel
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // ===== PHASE 2: Now fix the target section =====
    console.log('\n=== Phase 2: Fix PoolTogether section ===');

    // First, undo the broken upload — click section, edit, delete the PNG from content
    await clickThroughOverlay(page, `.page-section[data-section-id="${TARGET_SECTION_ID}"]`);
    await page.waitForTimeout(1500);

    const editBtn2 = page.getByRole('button', { name: /^edit$/i }).first();
    if (await editBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editBtn2.click();
      console.log('  Opened target section editor');
      await page.waitForTimeout(2000);
    }
    await takeScreenshot(page, 'upload-pt-target-current');

    // Look for delete/trash button next to the image content
    const trashBtn = page.locator('button[aria-label="Delete"], button[aria-label="Remove"], button svg[data-icon="trash"]').first();
    const trashVisible = await trashBtn.isVisible({ timeout: 1500 }).catch(() => false);
    console.log(`  Trash/delete button visible: ${trashVisible}`);

    // Try the trash icon near REPLACE
    const allTrashBtns = page.locator('[class*="delete"], [class*="remove"], [class*="trash"], [aria-label*="elete"], [aria-label*="emove"]');
    const trashCount = await allTrashBtns.count();
    console.log(`  Delete/remove elements: ${trashCount}`);
    for (let i = 0; i < trashCount; i++) {
      const el = allTrashBtns.nth(i);
      const tag = await el.evaluate((e: Element) => e.tagName).catch(() => '');
      const ariaLabel = await el.getAttribute('aria-label').catch(() => '');
      const cls = await el.getAttribute('class').catch(() => '');
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        console.log(`    [${i}] tag=${tag} aria="${ariaLabel}" class="${(cls || '').substring(0, 40)}" visible=${visible}`);
      }
    }

    // Check for a trash icon button next to the REPLACE button
    // In the screenshot I saw a trash icon to the right of REPLACE
    const trashIcon = page.locator('button:near(button:has-text("REPLACE"))').last();
    const trashIconVisible = await trashIcon.isVisible({ timeout: 1000 }).catch(() => false);
    console.log(`  Trash icon near REPLACE: ${trashIconVisible}`);

    // Let's try to find it more specifically - look at all buttons in the Content panel area
    const panelButtons = page.locator('button:visible');
    const panelBtnCount = await panelButtons.count();
    console.log(`  All visible buttons: ${panelBtnCount}`);
    for (let i = 0; i < panelBtnCount; i++) {
      const btn = panelButtons.nth(i);
      const text = await btn.innerText().catch(() => '');
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
      const box = await btn.boundingBox().catch(() => null);
      // Only show buttons on the right side panel (x > 900)
      if (box && box.x > 900) {
        console.log(`    btn[${i}]: text="${text.trim().substring(0, 20)}" aria="${ariaLabel}" at (${Math.round(box.x)},${Math.round(box.y)}) ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }

    // Click the trash/delete icon to remove the broken PNG
    // From the screenshot, it appears to be at the right of "REPLACE" row
    // Let's find the button with trash SVG
    const svgTrash = page.locator('svg').filter({ has: page.locator('path') });
    // Instead, let's just look for any button after REPLACE
    const replaceEl = page.locator('text="REPLACE"').first();
    const replaceBox = await replaceEl.boundingBox().catch(() => null);
    if (replaceBox) {
      console.log(`  REPLACE at: (${Math.round(replaceBox.x)}, ${Math.round(replaceBox.y)})`);
      // Click the trash icon which should be to the right of REPLACE text
      // It appeared as a trash icon at the far right of the REPLACE row
      await page.mouse.click(replaceBox.x + replaceBox.width + 50, replaceBox.y + replaceBox.height / 2);
      console.log('  Clicked to the right of REPLACE (trash icon area)');
      await page.waitForTimeout(1500);
    }

    await takeScreenshot(page, 'upload-pt-after-delete');

    // Now the content slot should be empty. We need to upload the image properly.
    // Click REPLACE or the upload area
    const replaceBtn2 = page.locator('button:has-text("REPLACE"), button:has-text("Replace")').first();
    if (await replaceBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
      await replaceBtn2.click();
      console.log('  Clicked REPLACE to upload new image');
      await page.waitForTimeout(2000);
    }

    // Upload
    const fi = await page.locator('input[type="file"]').count();
    console.log(`  File inputs: ${fi}`);
    if (fi > 0) {
      await page.evaluate(() => {
        document.querySelectorAll('input[type="file"]').forEach(el => {
          (el as HTMLElement).style.display = 'block';
        });
      });
      await page.locator('input[type="file"]').first().setInputFiles(IMAGE_PATH);
      console.log('  Uploaded image');
      await page.waitForTimeout(8000);
    }

    await takeScreenshot(page, 'upload-pt-after-reupload');

    // Save
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const saveResult = await saveChanges(page);
    console.log(`  Save: ${saveResult.message}`);
    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'upload-pt-final');

    console.log('\n=== DONE ===');
  } catch (err) {
    console.error('Script error:', (err as Error).message);
    try {
      const page = await bm.getPage();
      await takeScreenshot(page, 'upload-pt-error');
    } catch {}
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
