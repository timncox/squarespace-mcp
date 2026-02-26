/**
 * Clean up extra blank sections from test runs on the Coding Projects page.
 * Removes all sections except the first one (hero) and the last one (footer).
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

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

    const siteFrame = getSiteFrame(page);
    if (!siteFrame) { console.log('No site frame'); return; }

    // Count sections
    let totalSections = await siteFrame.locator('.page-section').count();
    console.log(`Total sections before cleanup: ${totalSections}`);

    // The page should have: section 0 (hero with "BIG IDEAS, REAL IMPACT") and section last (footer).
    // Everything between that's blank should be removed.
    // We'll identify blank sections by checking if they have minimal content.

    // Strategy: Use Squarespace's REMOVE button. Click each blank section, then click REMOVE.
    // Work from bottom to top (skip first and last).

    let removedCount = 0;

    while (totalSections > 2) {
      // Target the second-to-last section (just before footer)
      const targetIdx = totalSections - 2;
      const sectionId = await siteFrame.locator('.page-section').nth(targetIdx)
        .getAttribute('data-section-id').catch(() => null);

      if (!sectionId) {
        console.log(`Could not get section ID for index ${targetIdx}`);
        break;
      }

      // Check if this section has meaningful content (hero section has "BIG IDEAS")
      const sectionText = await siteFrame.locator(`.page-section[data-section-id="${sectionId}"]`)
        .textContent().catch(() => '');

      if (sectionText?.includes('BIG IDEAS') || sectionText?.includes('REAL IMPACT')) {
        console.log(`Section ${targetIdx} is the hero — stopping cleanup`);
        break;
      }

      console.log(`Removing section ${targetIdx} (id: ${sectionId}), text: "${sectionText?.trim().substring(0, 50) || '(empty)'}"`);

      // Click the section through overlay to select it
      const element = siteFrame.locator(`.page-section[data-section-id="${sectionId}"]`).first();
      await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      const box = await element.boundingBox();
      if (!box) { console.log('  Could not get bounding box'); break; }

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(800);

      // Click REMOVE button (in the section context menu)
      const removeBtn = page.getByRole('button', { name: /remove/i });
      const removeVisible = await removeBtn.first().isVisible({ timeout: 2000 }).catch(() => false);
      if (!removeVisible) {
        console.log('  REMOVE button not visible — trying text selector');
        const removeFallback = page.locator('button:has-text("REMOVE"), button:has-text("Remove")').first();
        if (await removeFallback.isVisible({ timeout: 1000 }).catch(() => false)) {
          await removeFallback.click();
        } else {
          console.log('  Could not find REMOVE button — skipping');
          break;
        }
      } else {
        await removeBtn.first().click();
      }
      await page.waitForTimeout(500);

      // Confirm removal (there may be a confirmation dialog)
      const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Yes"), button:has-text("OK"), button:has-text("Delete")').first();
      if (await confirmBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(1000);
      }

      removedCount++;
      totalSections = await siteFrame.locator('.page-section').count();
      console.log(`  Removed! Sections remaining: ${totalSections}`);
    }

    console.log(`\nCleanup complete. Removed ${removedCount} sections. Total now: ${totalSections}`);

    if (removedCount > 0) {
      console.log('Saving...');
      const saveResult = await saveChanges(page);
      console.log(saveResult.success ? 'Saved!' : `Save issue: ${saveResult.message}`);
    }

    await takeScreenshot(page, 'after-cleanup');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
