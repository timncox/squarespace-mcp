/**
 * Test: Section Deletion Automation Pattern
 *
 * 1. Create a new blank test page called "Delete Test" (slug: delete-test)
 * 2. Enter edit mode and add 2-3 sections
 * 3. Delete one section using deleteSelectedBlock()
 * 4. Verify the section was removed
 * 5. Save changes
 * 6. Clean up — delete the test page
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import {
  getSiteFrame,
  clickThroughOverlay,
  deleteSelectedBlock,
  saveChanges,
  hoverBetweenSectionsInIframe,
  forceClickHiddenAddSection,
} from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const SITE_BASE = 'https://tim-cox.squarespace.com';
const PAGE_TITLE = 'Delete Test';

async function main() {
  const browserManager = getBrowserManager({ headless: false });

  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    // ─── Phase 1: Create the test page ───────────────────────────────────
    console.log('\n=== Phase 1: Creating test page ===');
    await page.goto(`${SITE_BASE}/config/pages`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for pages panel to load
    try {
      await page.locator('[data-test="pages-panel-item"]').first().waitFor({
        state: 'visible',
        timeout: 15000,
      });
      console.log('Pages panel loaded');
    } catch {
      console.log('Pages panel items not detected — waiting 5s');
      await page.waitForTimeout(5000);
    }

    // Check if "Delete Test" already exists (from a previous failed run)
    const alreadyExists = await page.evaluate((title: string) => {
      const items = document.querySelectorAll('[data-test="pages-panel-item"]');
      for (const item of items) {
        if (item.textContent?.toLowerCase().includes(title.toLowerCase())) {
          return true;
        }
      }
      return false;
    }, PAGE_TITLE);

    if (alreadyExists) {
      console.log('Page "Delete Test" already exists — skipping creation, will clean up at end');
    } else {
      // Hover over "Not Linked" or "Main Navigation" to reveal the + button
      console.log('Looking for Add Page button...');

      const addPageSelectors = [
        'button[aria-label="Add page"]',
        'button[aria-label="Add Page"]',
        'button[aria-label="add page"]',
        '[data-test="add-page"]',
        '[data-test="pages-add-page"]',
        'button:has-text("Add Page")',
      ];

      let addClicked = false;
      for (const selector of addPageSelectors) {
        try {
          const btn = page.locator(selector).first();
          const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
          if (visible) {
            await btn.click({ timeout: 3000 });
            addClicked = true;
            console.log(`Clicked add page via: ${selector}`);
            break;
          }
        } catch { /* next */ }
      }

      // Fallback: hover over section headers to reveal +
      if (!addClicked) {
        for (const headerText of ['Not Linked', 'Main Navigation', 'Pages']) {
          const header = page.locator(`text=${headerText}`).first();
          if (await header.isVisible({ timeout: 2000 }).catch(() => false)) {
            await header.hover();
            await page.waitForTimeout(1000);
            console.log(`Hovered over "${headerText}" header`);

            for (const selector of addPageSelectors) {
              try {
                const btn = page.locator(selector).first();
                const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
                if (visible) {
                  await btn.click({ timeout: 3000 });
                  addClicked = true;
                  console.log(`Clicked add page via: ${selector} (after hover)`);
                  break;
                }
              } catch { /* next */ }
            }
            if (addClicked) break;
          }
        }
      }

      if (!addClicked) {
        console.error('Could not find Add Page button. Taking screenshot...');
        await takeScreenshot(page, 'add-page-not-found');
        throw new Error('Add Page button not found');
      }

      await page.waitForTimeout(2000);
      await takeScreenshot(page, 'after-add-page-click');

      // Select "Add Blank" — in the template picker dialog
      // Squarespace shows "Add Blank" as a link at the top of the template picker
      console.log('Looking for Add Blank option...');
      const blankSelectors = [
        'text=Add Blank',
        'button:has-text("Add Blank")',
        'a:has-text("Add Blank")',
        'button:has-text("Blank")',
        'a:has-text("Blank")',
        '[data-test="blank-page"]',
      ];
      let blankClicked = false;
      for (const selector of blankSelectors) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btn.click({ timeout: 3000 });
            blankClicked = true;
            console.log(`Selected blank via: ${selector}`);
            break;
          }
        } catch { /* next */ }
      }
      if (!blankClicked) {
        console.log('Could not find Add Blank — taking screenshot');
        await takeScreenshot(page, 'blank-not-found');
      }
      await page.waitForTimeout(2000);

      // After clicking "Add Blank", a "New Page" should appear in the pages list.
      // We need to rename it. The page title may be editable inline or we need
      // to find the title input.
      console.log('Looking for page title input to rename...');

      // First check if there's a title input visible
      const titleSelectors = [
        'input[placeholder*="Page Title"]',
        'input[placeholder*="page title"]',
        'input[placeholder*="Title"]',
        'input[name*="title"]',
        'input[data-test="page-title"]',
        // Squarespace might show the title in an inline-edit on the page item
        'input[value="New Page"]',
      ];
      let titleFilled = false;
      for (const selector of titleSelectors) {
        try {
          const input = page.locator(selector).first();
          if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
            await input.fill('');
            await input.fill(PAGE_TITLE);
            titleFilled = true;
            console.log(`Filled title via: ${selector}`);
            break;
          }
        } catch { /* next */ }
      }

      if (!titleFilled) {
        // The page was created as "New Page" — we'll try to rename via page settings
        // First, let's try to find an editable inline element
        console.log('No title input found — trying inline rename...');

        // Look for any focused/editable input
        const focused = page.locator('input:focus, [contenteditable="true"]:focus');
        if (await focused.count() > 0) {
          await focused.first().fill(PAGE_TITLE);
          console.log('Filled focused input');
          titleFilled = true;
        }
      }

      if (!titleFilled) {
        console.log('Could not rename page — will continue with whatever name was created');
        await takeScreenshot(page, 'title-not-filled');
      }

      // Press Enter to confirm
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);

      // Verify page was created — look for "Delete Test" or "New Page"
      await page.goto(`${SITE_BASE}/config/pages`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(4000);

      const pageCreated = await page.evaluate((title: string) => {
        const items = document.querySelectorAll('[data-test="pages-panel-item"]');
        for (const item of items) {
          if (item.textContent?.toLowerCase().includes(title.toLowerCase())) {
            return true;
          }
        }
        return false;
      }, PAGE_TITLE);

      if (pageCreated) {
        console.log(`Page "${PAGE_TITLE}" created successfully`);
      } else {
        // The page might have been created as "New Page" — use that instead
        const newPageExists = await page.evaluate(() => {
          const items = document.querySelectorAll('[data-test="pages-panel-item"]');
          for (const item of items) {
            if (item.textContent?.trim() === 'New Page') {
              return true;
            }
          }
          return false;
        });
        if (newPageExists) {
          console.log('Page was created as "New Page" — will use that');
        } else {
          console.log('Page creation status unclear');
          await takeScreenshot(page, 'page-creation-check');
        }
      }
    }

    // ─── Phase 2: Navigate to the page and enter edit mode ───────────────
    console.log('\n=== Phase 2: Navigating to page and entering edit mode ===');

    // Make sure we're on pages panel
    await page.goto(`${SITE_BASE}/config/pages`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Click on "Delete Test" page (or "New Page" as fallback)
    let testPageName = PAGE_TITLE;
    const pageClicked = await page.evaluate((title: string) => {
      const items = document.querySelectorAll('[data-test="pages-panel-item"]');
      // First try exact match for "Delete Test"
      for (const item of items) {
        if (item.textContent?.toLowerCase().includes(title.toLowerCase())) {
          (item as HTMLElement).click();
          return title;
        }
      }
      // Fallback: use the last "New Page" item
      const allItems = Array.from(items);
      const newPageItems = allItems.filter(item => item.textContent?.trim() === 'New Page');
      if (newPageItems.length > 0) {
        (newPageItems[newPageItems.length - 1] as HTMLElement).click();
        return 'New Page';
      }
      return null;
    }, PAGE_TITLE);

    if (!pageClicked) {
      console.error(`Could not find "${PAGE_TITLE}" or "New Page" in pages list`);
      await takeScreenshot(page, 'page-not-in-list');
      throw new Error(`Page not found in pages list`);
    }
    testPageName = pageClicked;
    console.log(`Clicked on page: "${testPageName}"`);
    await page.waitForTimeout(3000);

    // Enter edit mode
    await enterEditMode(page);
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'delete-test-edit-mode');

    // ─── Phase 3: Add sections ───────────────────────────────────────────
    console.log('\n=== Phase 3: Adding sections ===');

    const siteFrame = getSiteFrame(page);
    if (!siteFrame) {
      throw new Error('Site frame not found');
    }

    const initialSections = await siteFrame.locator('.page-section').count();
    console.log(`Initial section count: ${initialSections}`);

    // Add 2 sections
    const sectionsToAdd = 2;
    let sectionsAdded = 0;

    for (let i = 0; i < sectionsToAdd; i++) {
      console.log(`\nAdding section ${i + 1}/${sectionsToAdd}...`);

      // Try hover-based approach first
      const hoverResult = await hoverBetweenSectionsInIframe(page);
      let addSectionVisible = hoverResult.success;

      if (!addSectionVisible) {
        console.log('Hover did not reveal ADD SECTION — trying force-click...');
        const forceResult = await forceClickHiddenAddSection(page);
        if (forceResult.success) {
          console.log('Force-clicked ADD SECTION');
          await page.waitForTimeout(2000);
          // Check if section picker appeared
          const pickerVisible = await page.locator('[class*="section-picker"], [class*="SectionPicker"], [data-test*="section"]').first().isVisible({ timeout: 3000 }).catch(() => false);
          if (pickerVisible) {
            addSectionVisible = true;
          } else {
            // The force-click may have directly added a blank section
            const currentCount = await siteFrame.locator('.page-section').count();
            if (currentCount > initialSections + sectionsAdded) {
              sectionsAdded++;
              console.log(`Section added (direct) — count now: ${initialSections + sectionsAdded}`);
              continue;
            }
          }
        }
      }

      if (addSectionVisible && hoverResult.success) {
        // Click the ADD SECTION button
        const addSectionSelectors = [
          'button:has-text("ADD SECTION")',
          'button:has-text("Add Section")',
          '[aria-label="Add Section"]',
          'button[aria-label="Add section"]',
        ];
        for (const sel of addSectionSelectors) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
              await btn.click();
              console.log(`Clicked: ${sel}`);
              break;
            }
          } catch { /* next */ }
        }
        await page.waitForTimeout(2000);
      }

      // In the section picker, click the first available template/option
      // Look for section template thumbnails or items
      const templateSelectors = [
        '[class*="section-template"], [class*="SectionTemplate"]',
        '[data-test*="section-template"]',
        '[class*="layout-option"], [class*="LayoutOption"]',
        // Generic: first button inside the section picker
        '[class*="section-picker"] button, [class*="SectionPicker"] button',
      ];

      let templateClicked = false;
      for (const sel of templateSelectors) {
        try {
          const templates = page.locator(sel);
          const count = await templates.count();
          if (count > 0) {
            // Click the first template
            await templates.first().click();
            templateClicked = true;
            console.log(`Clicked template via: ${sel} (${count} options available)`);
            break;
          }
        } catch { /* next */ }
      }

      if (!templateClicked) {
        // Try clicking any visible button in a dialog/picker
        console.log('Looking for any clickable option in section picker...');
        await takeScreenshot(page, `section-picker-${i}`);

        // Try pressing Escape and re-attempting
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      }

      await page.waitForTimeout(2000);

      const currentCount = await siteFrame.locator('.page-section').count();
      if (currentCount > initialSections + sectionsAdded) {
        sectionsAdded = currentCount - initialSections;
        console.log(`Section added — total sections: ${currentCount}`);
      } else {
        console.log(`Section may not have been added — count still: ${currentCount}`);
      }
    }

    const preDeleteCount = await siteFrame.locator('.page-section').count();
    console.log(`\nSections before deletion: ${preDeleteCount}`);
    await takeScreenshot(page, 'before-deletion');

    // ─── Phase 4: Delete a section ───────────────────────────────────────
    console.log('\n=== Phase 4: Deleting a section ===');

    if (preDeleteCount === 0) {
      console.log('No sections to delete. The page might be truly blank.');
      console.log('Skipping deletion test — will proceed to cleanup.');
    } else {
      // Select the first section by clicking through the overlay
      const firstSection = siteFrame.locator('.page-section').first();
      const sectionId = await firstSection.getAttribute('data-section-id').catch(() => null);
      console.log(`Targeting first section (data-section-id: ${sectionId})`);

      let clickResult;
      if (sectionId) {
        clickResult = await clickThroughOverlay(page, `.page-section[data-section-id="${sectionId}"]`);
      } else {
        clickResult = await clickThroughOverlay(page, '.page-section');
      }

      if (!clickResult.success) {
        console.error(`Click to select section failed: ${clickResult.message}`);
        await takeScreenshot(page, 'section-select-failed');
      } else {
        console.log('Section selected. Waiting for toolbar...');
        await page.waitForTimeout(1500);
        await takeScreenshot(page, 'section-selected');

        // Delete the selected section
        console.log('Calling deleteSelectedBlock()...');
        await deleteSelectedBlock(page);
        await page.waitForTimeout(2000);

        // Verify deletion
        const postDeleteCount = await siteFrame.locator('.page-section').count();
        console.log(`Sections after deletion: ${postDeleteCount}`);

        if (postDeleteCount < preDeleteCount) {
          console.log(`SUCCESS: Section deleted (${preDeleteCount} -> ${postDeleteCount})`);
        } else {
          console.log(`WARNING: Section count unchanged (${preDeleteCount} -> ${postDeleteCount})`);
          await takeScreenshot(page, 'deletion-may-have-failed');
        }
      }

      // ─── Phase 5: Save changes ──────────────────────────────────────────
      console.log('\n=== Phase 5: Saving changes ===');
      const saveResult = await saveChanges(page);
      console.log(`Save result: ${saveResult.message}`);
      await takeScreenshot(page, 'after-save');
    }

    // ─── Phase 6: Cleanup — delete the test page ─────────────────────────
    console.log('\n=== Phase 6: Cleaning up — deleting test page ===');

    // Exit edit mode first
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    // Navigate back to pages panel
    await page.goto(`${SITE_BASE}/config/pages`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Delete the test page (and any leftover "New Page" entries)
    // We'll try to delete all pages matching our test page name, plus "New Page" leftovers
    const pagesToDelete = [testPageName];
    // Also clean up any leftover "New Page" entries from previous failed runs
    if (testPageName !== 'New Page') {
      pagesToDelete.push('New Page');
    }

    for (const pageNameToDelete of pagesToDelete) {
      // Re-navigate to pages panel for each deletion
      await page.goto(`${SITE_BASE}/config/pages`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(4000);

      const deletePageClicked = await page.evaluate((title: string) => {
        const items = document.querySelectorAll('[data-test="pages-panel-item"]');
        for (const item of items) {
          if (item.textContent?.trim().toLowerCase() === title.toLowerCase()) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, pageNameToDelete);

      if (!deletePageClicked) {
        console.log(`No page named "${pageNameToDelete}" found — skipping cleanup for this name`);
        continue;
      }
      console.log(`Selected page "${pageNameToDelete}" for deletion`);
      await page.waitForTimeout(2000);

      // Look for a settings gear icon or "..." menu button near the page item
      const settingsSelectors = [
        'button[aria-label="Settings"]',
        'button[aria-label="Page Settings"]',
        'button:has-text("Settings")',
        '[data-test="page-settings"]',
        'button[aria-label="More"]',
      ];

      let settingsOpened = false;
      for (const selector of settingsSelectors) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click({ timeout: 3000 });
            settingsOpened = true;
            console.log(`Opened page settings via: ${selector}`);
            break;
          }
        } catch { /* next */ }
      }

      if (!settingsOpened) {
        console.log(`Could not open settings for "${pageNameToDelete}" — may need manual cleanup`);
        await takeScreenshot(page, 'settings-not-found');
        continue;
      }

      await page.waitForTimeout(2000);

      // Scroll down in settings panel to find Delete button (it's usually at the bottom)
      // Try scrolling a settings/dialog panel
      const settingsPanel = page.locator('[class*="settings"], [class*="Settings"], [role="dialog"]').first();
      if (await settingsPanel.isVisible({ timeout: 1000 }).catch(() => false)) {
        await settingsPanel.evaluate((el: Element) => el.scrollTo(0, el.scrollHeight));
        await page.waitForTimeout(500);
      }

      // Look for delete option in settings panel
      const deleteSelectors = [
        'button:has-text("Delete")',
        'button:has-text("DELETE")',
        'button:has-text("Delete Page")',
        '[data-test="delete-page"]',
      ];

      let deleteFound = false;
      for (const selector of deleteSelectors) {
        try {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click({ timeout: 3000 });
            deleteFound = true;
            console.log(`Clicked delete via: ${selector}`);
            break;
          }
        } catch { /* next */ }
      }

      if (deleteFound) {
        await page.waitForTimeout(1500);

        // Handle confirmation dialog
        const confirmSelectors = [
          'button:has-text("Confirm")',
          'button:has-text("CONFIRM")',
          'button:has-text("Yes")',
          'button:has-text("OK")',
        ];
        for (const selector of confirmSelectors) {
          try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await btn.click({ timeout: 3000 });
              console.log(`Confirmed delete via: ${selector}`);
              break;
            }
          } catch { /* next */ }
        }
        await page.waitForTimeout(2000);
        console.log(`Page "${pageNameToDelete}" deleted`);
      } else {
        console.log(`Delete button not found for "${pageNameToDelete}" — may need manual cleanup`);
        await takeScreenshot(page, 'delete-not-found');
      }
    } // end for pagesToDelete

    console.log('\n=== Test Complete ===');

  } catch (err) {
    console.error('Error:', (err as Error).message);
    const page = await browserManager.getPage().catch(() => null);
    if (page) await takeScreenshot(page, 'test-error').catch(() => {});
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
