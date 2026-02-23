/**
 * Cleanup v3: Remove blank/test sections using getByRole for reliable button detection.
 * Uses the fixed deleteSelectedBlock from editor-actions (getByRole-based).
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, clickThroughOverlay, deleteSelectedBlock, saveChanges } from '../src/automation/editor-actions.js';
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

    // List all sections
    let totalSections = await siteFrame.locator('.page-section').count();
    console.log(`\nTotal sections: ${totalSections}`);
    for (let i = 0; i < totalSections; i++) {
      const section = siteFrame.locator('.page-section').nth(i);
      const id = await section.getAttribute('data-section-id').catch(() => '?');
      const text = await section.textContent().catch(() => '');
      const trimmed = text?.replace(/\s+/g, ' ').trim().substring(0, 100) || '(empty)';
      console.log(`  [${i}] id=${id}: "${trimmed}"`);
    }

    // Identify hero/footer to keep, remove everything else
    const keepIds = new Set<string>();
    for (let i = 0; i < totalSections; i++) {
      const section = siteFrame.locator('.page-section').nth(i);
      const text = await section.textContent().catch(() => '');
      const content = text?.replace(/\s+/g, ' ').trim() || '';
      if (content.includes('BIG IDEAS') || content.includes('REAL IMPACT')) {
        const id = await section.getAttribute('data-section-id').catch(() => null);
        if (id) keepIds.add(id);
        console.log(`\n  KEEPING section [${i}] (hero content)`);
      }
    }
    // Always keep the last section (footer)
    const footerId = await siteFrame.locator('.page-section').nth(totalSections - 1)
      .getAttribute('data-section-id').catch(() => null);
    if (footerId) {
      keepIds.add(footerId);
      console.log(`  KEEPING section [${totalSections - 1}] (footer)`);
    }

    // Build removal list (everything not in keepIds)
    const removeIds: string[] = [];
    for (let i = 0; i < totalSections; i++) {
      const id = await siteFrame.locator('.page-section').nth(i)
        .getAttribute('data-section-id').catch(() => null);
      if (id && !keepIds.has(id)) removeIds.push(id);
    }

    console.log(`\nSections to remove: ${removeIds.length}`);
    if (removeIds.length === 0) {
      console.log('Nothing to remove!');
      await browserManager.close();
      return;
    }

    // Remove from bottom to top to avoid index shifts
    let removedCount = 0;
    for (let ri = removeIds.length - 1; ri >= 0; ri--) {
      const sectionId = removeIds[ri];
      const selector = `.page-section[data-section-id="${sectionId}"]`;
      console.log(`\n[${removeIds.length - ri}/${removeIds.length}] Removing section id=${sectionId}...`);

      // Click through overlay to select the section
      const clickResult = await clickThroughOverlay(page, selector);
      if (!clickResult.success) {
        console.log(`  Click failed: ${clickResult.message} — skipping`);
        continue;
      }
      await page.waitForTimeout(1000);

      // Use the improved deleteSelectedBlock (getByRole-based)
      await deleteSelectedBlock(page);
      await page.waitForTimeout(500);

      const newCount = await siteFrame.locator('.page-section').count();
      const removed = newCount < totalSections;
      console.log(`  ${removed ? 'Removed!' : 'May not have removed'} Sections: ${totalSections} → ${newCount}`);
      if (removed) {
        removedCount++;
        totalSections = newCount;
      }
    }

    console.log(`\nDone! Removed ${removedCount} sections. Final count: ${totalSections}`);

    if (removedCount > 0) {
      console.log('Saving...');
      const saveResult = await saveChanges(page);
      console.log(saveResult.success ? `Saved: ${saveResult.message}` : `Save issue: ${saveResult.message}`);
    }

    await takeScreenshot(page, 'cleanup-v3-final');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
