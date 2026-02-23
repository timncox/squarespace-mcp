/**
 * Test: Section Creation and Deletion Flow via Compound Actions
 *
 * Uses executeAgentAction() for all Squarespace interactions:
 * 1. Create a test page (createPage)
 * 2. Switch to it and enter edit mode (switchPage)
 * 3. Add 2 sections (addSection)
 * 4. Add content to a section (enterSectionEditMode + addBlockToSection)
 * 5. Delete a section (clickThroughOverlay + deleteSelectedBlock)
 * 6. Save changes (saveChanges)
 * 7. Cleanup — delete the test page
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { getSiteFrame, clickThroughOverlay, deleteSelectedBlock, saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Step 1: Create a test page using the createPage compound action
    console.log('\n=== Step 1: Create test page ===');
    await page.goto('https://tim-cox.squarespace.com/config/pages', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const createResult = await executeAgentAction(page, { action: 'createPage', title: 'Section Delete Test', slug: 'section-delete-test' });
    console.log('createPage:', createResult.message);
    if (!createResult.success) { console.log('FAIL: Failed to create page'); return; }
    await takeScreenshot(page, 'sdt-01-page-created');

    // Step 2: Navigate to the new page and enter edit mode
    console.log('\n=== Step 2: Navigate to page ===');
    const switchResult = await executeAgentAction(page, { action: 'switchPage', pageSlug: 'section-delete-test' });
    console.log('switchPage:', switchResult.message);

    await enterEditMode(page);
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'sdt-02-edit-mode');

    // Step 3: Add 2 sections using addSection compound action
    console.log('\n=== Step 3: Add sections ===');
    const add1 = await executeAgentAction(page, { action: 'addSection' });
    console.log('addSection 1:', add1.message);
    await takeScreenshot(page, 'sdt-03-section1-added');
    await page.waitForTimeout(2000);

    const add2 = await executeAgentAction(page, { action: 'addSection' });
    console.log('addSection 2:', add2.message);
    await takeScreenshot(page, 'sdt-04-section2-added');
    await page.waitForTimeout(2000);

    // Count sections
    const sf = getSiteFrame(page);
    const beforeCount = sf ? await sf.locator('.page-section').count() : 0;
    console.log(`\nSections before deletion: ${beforeCount}`);

    // Step 4: Enter section edit mode for the first section, add a text block so we have content
    console.log('\n=== Step 4: Add content to first section ===');
    const enterEdit1 = await executeAgentAction(page, { action: 'enterSectionEditMode', sectionIndex: 0 });
    console.log('enterSectionEditMode:', enterEdit1.message);

    if (enterEdit1.success) {
      const addText = await executeAgentAction(page, { action: 'addBlockToSection', blockType: 'Text', content: 'DELETE ME - Test Section' });
      console.log('addBlockToSection:', addText.message);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await takeScreenshot(page, 'sdt-05-content-added');

    // Step 5: Delete the section containing "DELETE ME"
    console.log('\n=== Step 5: Delete section ===');
    // Click the section to select it
    const clickResult = await clickThroughOverlay(page, 'text=DELETE ME');
    console.log('clickThroughOverlay:', clickResult.message);
    await page.waitForTimeout(1000);
    await takeScreenshot(page, 'sdt-06-section-selected');

    // Delete it
    await deleteSelectedBlock(page);
    await page.waitForTimeout(2000);

    const afterCount = sf ? await sf.locator('.page-section').count() : 0;
    console.log(`Sections after deletion: ${afterCount}`);
    console.log(afterCount < beforeCount ? 'PASS: Section deleted successfully!' : 'FAIL: Deletion may have failed');
    await takeScreenshot(page, 'sdt-07-after-delete');

    // Step 6: Save
    console.log('\n=== Step 6: Save ===');
    const saveResult = await executeAgentAction(page, { action: 'saveChanges' });
    console.log('saveChanges:', saveResult.message);
    await takeScreenshot(page, 'sdt-08-saved');

    // Step 7: Cleanup - delete the test page
    console.log('\n=== Step 7: Cleanup ===');
    // Navigate to pages panel and try to delete the page
    await page.goto('https://tim-cox.squarespace.com/config/pages', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Find and click the test page to get into its settings
    const pageItem = page.locator('text=Section Delete Test').first();
    if (await pageItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await pageItem.click();
      await page.waitForTimeout(2000);

      // Look for settings button
      const settingsSelectors = [
        'button[aria-label="Settings"]',
        'button[aria-label="Page Settings"]',
        'button:has-text("Settings")',
        '[data-test="page-settings"]',
        'button[aria-label="More"]',
      ];

      let settingsOpened = false;
      for (const sel of settingsSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click({ timeout: 3000 });
            settingsOpened = true;
            console.log(`Opened page settings via: ${sel}`);
            break;
          }
        } catch { /* next */ }
      }

      if (settingsOpened) {
        await page.waitForTimeout(2000);

        // Scroll the settings panel to reveal Delete button at bottom
        const settingsPanel = page.locator('[class*="settings"], [class*="Settings"], [role="dialog"]').first();
        if (await settingsPanel.isVisible({ timeout: 1000 }).catch(() => false)) {
          await settingsPanel.evaluate((el: Element) => el.scrollTo(0, el.scrollHeight));
          await page.waitForTimeout(500);
        }

        // Look for delete button
        const deleteSelectors = [
          'button:has-text("Delete")',
          'button:has-text("DELETE")',
          'button:has-text("Delete Page")',
          '[data-test="delete-page"]',
        ];

        let deleteClicked = false;
        for (const sel of deleteSelectors) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await btn.click({ timeout: 3000 });
              deleteClicked = true;
              console.log(`Clicked delete via: ${sel}`);
              break;
            }
          } catch { /* next */ }
        }

        if (deleteClicked) {
          await page.waitForTimeout(1500);

          // Confirm deletion
          const confirmSelectors = [
            'button:has-text("Confirm")',
            'button:has-text("CONFIRM")',
            'button:has-text("Yes")',
            'button:has-text("OK")',
          ];
          for (const sel of confirmSelectors) {
            try {
              const btn = page.locator(sel).first();
              if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btn.click({ timeout: 3000 });
                console.log('PASS: Test page deleted');
                break;
              }
            } catch { /* next */ }
          }
        } else {
          console.log('Delete button not found — may need manual cleanup');
        }
      } else {
        console.log('Could not open page settings — may need manual cleanup');
      }
    } else {
      console.log('Test page not found in pages list — may have already been cleaned up');
    }
    await takeScreenshot(page, 'sdt-09-cleanup');

    console.log('\n=== DONE ===');
  } catch (err) {
    console.error('Error:', (err as Error).message);
    const page = await bm.getPage().catch(() => null);
    if (page) await takeScreenshot(page, 'sdt-error').catch(() => {});
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
