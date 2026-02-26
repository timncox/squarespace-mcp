/**
 * Delete the test section (data-section-id="6998ba46bc3c553b81eb8bdd")
 * from the Coding Projects page on tim-cox.squarespace.com.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, clickThroughOverlay, deleteSelectedBlock, saveChanges } from '../src/automation/editor-actions.js';

const TARGET_SECTION_ID = '6998ba46bc3c553b81eb8bdd';

async function main() {
  const browserManager = getBrowserManager({ headless: false });
  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    // Navigate to pages config
    console.log('Navigating to pages config...');
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Click Coding Projects
    const cpLink = page.locator('text=Coding Projects').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('Clicking Coding Projects...');
      await cpLink.click();
      await page.waitForTimeout(4000);
    } else {
      console.error('Could not find Coding Projects link');
      return;
    }

    // Enter edit mode
    console.log('Entering edit mode...');
    await enterEditMode(page);
    await page.waitForTimeout(2000);

    const siteFrame = getSiteFrame(page);
    if (!siteFrame) {
      console.error('No site frame found');
      return;
    }

    // Verify the target section exists
    const selector = `.page-section[data-section-id="${TARGET_SECTION_ID}"]`;
    const targetSection = siteFrame.locator(selector);
    const exists = await targetSection.count();
    if (exists === 0) {
      console.log(`Section ${TARGET_SECTION_ID} not found — may already be deleted.`);
      return;
    }

    const sectionsBefore = await siteFrame.locator('.page-section').count();
    console.log(`Sections before: ${sectionsBefore}`);
    console.log(`Target section found. Clicking to select...`);

    // Click through overlay to select the section
    const clickResult = await clickThroughOverlay(page, selector);
    if (!clickResult.success) {
      console.error(`Click failed: ${clickResult.message}`);
      return;
    }
    await page.waitForTimeout(1000);

    // Delete the selected section
    console.log('Deleting section...');
    await deleteSelectedBlock(page);
    await page.waitForTimeout(1000);

    // Verify deletion
    const sectionsAfter = await siteFrame.locator('.page-section').count();
    const removed = sectionsAfter < sectionsBefore;
    console.log(`Sections after: ${sectionsAfter} (was ${sectionsBefore})`);

    if (removed) {
      console.log('Section removed successfully. Saving...');
      const saveResult = await saveChanges(page);
      console.log(saveResult.success ? `Saved: ${saveResult.message}` : `Save issue: ${saveResult.message}`);
    } else {
      console.log('Section may not have been removed. Check manually.');
    }

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
