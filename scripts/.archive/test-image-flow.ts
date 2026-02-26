import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { getSiteFrame } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';
import path from 'path';

const IMAGE_PATH = path.resolve('/Users/timcox/squarespace helper/storage/uploads/project-screenshots/menu-block-lovable-app.png');

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Step 1: Create a test page
    console.log('\n=== Step 1: Create test page ===');
    await page.goto('https://tim-cox.squarespace.com/config/pages', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const createResult = await executeAgentAction(page, { action: 'createPage', title: 'Image Upload Test', slug: 'image-upload-test' });
    console.log('createPage:', createResult.message);
    if (!createResult.success) { console.log('FAILED to create page'); return; }
    await takeScreenshot(page, 'img-01-page-created');

    // Step 2: Navigate to the new page and enter edit mode
    console.log('\n=== Step 2: Navigate to page ===');
    const switchResult = await executeAgentAction(page, { action: 'switchPage', pageSlug: 'image-upload-test' });
    console.log('switchPage:', switchResult.message);

    await enterEditMode(page);
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'img-02-edit-mode');

    // Step 3: Add a section
    console.log('\n=== Step 3: Add section ===');
    const addSec = await executeAgentAction(page, { action: 'addSection' });
    console.log('addSection:', addSec.message);
    await takeScreenshot(page, 'img-03-section-added');
    await page.waitForTimeout(2000);

    // Step 4: Enter section edit mode
    console.log('\n=== Step 4: Enter section edit mode ===');
    const enterEdit = await executeAgentAction(page, { action: 'enterSectionEditMode', sectionIndex: 'last' });
    console.log('enterSectionEditMode:', enterEdit.message);
    await takeScreenshot(page, 'img-04-section-edit-mode');

    // Step 5: Add image block using the compound action
    console.log('\n=== Step 5: Add image block ===');
    const addImg = await executeAgentAction(page, { action: 'addImageBlock', imagePath: IMAGE_PATH, altText: 'Menu Formatter Screenshot' });
    console.log('addImageBlock:', addImg.message);
    await takeScreenshot(page, 'img-05-image-added');

    // Step 6: Verify image was uploaded
    console.log('\n=== Step 6: Verify ===');
    const sf = getSiteFrame(page);
    if (sf) {
      const cdnImages = await sf.locator('img[src*="squarespace-cdn"], img[src*="images.squarespace"]').count().catch(() => 0);
      console.log(`CDN images found: ${cdnImages}`);
      console.log(cdnImages > 0 ? 'SUCCESS: Image uploaded successfully!' : 'FAIL: Image not detected');
    } else {
      console.log('WARN: Could not get site frame for verification');
    }

    // Step 7: Save
    console.log('\n=== Step 7: Save ===');
    // Press Escape first to exit any editor panels
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const saveResult = await executeAgentAction(page, { action: 'saveChanges' });
    console.log('saveChanges:', saveResult.message);
    await takeScreenshot(page, 'img-06-saved');

    // Step 8: Cleanup - delete the test page
    console.log('\n=== Step 8: Cleanup ===');
    await page.goto('https://tim-cox.squarespace.com/config/pages', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const pageItem = page.locator('text=Image Upload Test').first();
    if (await pageItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await pageItem.hover();
      await page.waitForTimeout(500);
      const settingsBtn = page.locator('[aria-label="Settings"], [aria-label="Page Settings"], [data-test="page-settings"]').first();
      if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await settingsBtn.click();
        await page.waitForTimeout(1500);
        const deleteBtn = page.locator('button:has-text("Delete"), text=Delete Page').first();
        if (await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await deleteBtn.click();
          await page.waitForTimeout(1000);
          const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("DELETE"), button:has-text("Yes")').first();
          if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await confirmBtn.click();
            console.log('Test page deleted');
          }
        }
      }
    }
    await takeScreenshot(page, 'img-07-cleanup');

    console.log('\n=== DONE ===');
  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
