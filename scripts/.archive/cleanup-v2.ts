/**
 * Cleanup v2: Remove blank sections using Squarespace's keyboard shortcut or the
 * REMOVE button with proper confirmation handling.
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

    let totalSections = await siteFrame.locator('.page-section').count();
    console.log(`Total sections: ${totalSections}`);

    // List all sections with their content
    for (let i = 0; i < totalSections; i++) {
      const section = siteFrame.locator('.page-section').nth(i);
      const id = await section.getAttribute('data-section-id').catch(() => '?');
      const text = await section.textContent().catch(() => '');
      const trimmed = text?.replace(/\s+/g, ' ').trim().substring(0, 80) || '(empty)';
      console.log(`  [${i}] id=${id}: "${trimmed}"`);
    }

    // Identify which sections to keep:
    // - First section (hero with "BIG IDEAS") - keep
    // - Last section (footer) - keep
    // - Everything else that's blank or from test runs - remove

    // Get IDs of sections to remove (everything except first and last)
    const sectionsToRemove: string[] = [];
    for (let i = 1; i < totalSections - 1; i++) {
      const section = siteFrame.locator('.page-section').nth(i);
      const id = await section.getAttribute('data-section-id').catch(() => null);
      const text = await section.textContent().catch(() => '');
      const content = text?.replace(/\s+/g, ' ').trim() || '';

      // Keep sections with real content (like "BIG IDEAS" or existing projects)
      if (content.includes('BIG IDEAS') || content.includes('REAL IMPACT')) {
        console.log(`  Keeping section ${i} (hero content)`);
        continue;
      }

      if (id) sectionsToRemove.push(id);
    }

    console.log(`\nSections to remove: ${sectionsToRemove.length}`);
    if (sectionsToRemove.length === 0) {
      console.log('Nothing to remove!');
      await browserManager.close();
      return;
    }

    // Remove sections one at a time from bottom to top
    let removedCount = 0;
    for (let ri = sectionsToRemove.length - 1; ri >= 0; ri--) {
      const sectionId = sectionsToRemove[ri];
      console.log(`\nRemoving section id=${sectionId}...`);

      // Click the section
      const element = siteFrame.locator(`.page-section[data-section-id="${sectionId}"]`).first();
      await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      const box = await element.boundingBox();
      if (!box) { console.log('  No bounding box'); continue; }

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1000);

      // Take screenshot to see current state
      await takeScreenshot(page, `cleanup-before-remove-${ri}`);

      // Look for REMOVE button in the section toolbar
      const removeBtn = page.locator('text=/^REMOVE$/').first();
      const removeVisible = await removeBtn.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`  REMOVE visible: ${removeVisible}`);

      if (removeVisible) {
        await removeBtn.click();
        await page.waitForTimeout(1000);

        // Take screenshot to see if there's a confirmation dialog
        await takeScreenshot(page, `cleanup-after-remove-click-${ri}`);

        // Check for any confirmation dialog
        // Squarespace may show: "Are you sure?" or just remove immediately
        const confirmSelectors = [
          'button:has-text("Confirm")',
          'button:has-text("Yes")',
          'button:has-text("OK")',
          'button:has-text("Delete")',
          'button:has-text("Remove")', // Might be a second "Remove" in dialog
        ];
        for (const sel of confirmSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
            console.log(`  Clicking confirm: ${sel}`);
            await btn.click();
            await page.waitForTimeout(1000);
            break;
          }
        }

        removedCount++;
        const newCount = await siteFrame.locator('.page-section').count();
        console.log(`  Sections after removal: ${newCount}`);
      } else {
        console.log('  REMOVE not found — trying getByRole');
        const rmByRole = page.getByRole('button', { name: /remove/i });
        if (await rmByRole.first().isVisible({ timeout: 1000 }).catch(() => false)) {
          await rmByRole.first().click();
          await page.waitForTimeout(2000);
          removedCount++;
        } else {
          console.log('  Could not find REMOVE — skipping');
        }
      }
    }

    console.log(`\nDone! Removed ${removedCount} sections.`);
    const finalCount = await siteFrame.locator('.page-section').count();
    console.log(`Final section count: ${finalCount}`);

    if (removedCount > 0) {
      console.log('Saving...');
      const saveResult = await saveChanges(page);
      console.log(saveResult.success ? 'Saved!' : `Save: ${saveResult.message}`);
    }

    await takeScreenshot(page, 'cleanup-final');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
