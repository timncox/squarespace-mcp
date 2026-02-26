/**
 * Test: Button block creation and URL editing flow using compound actions.
 *
 * Uses executeAgentAction() for all steps:
 * 1. createPage — create a test page
 * 2. switchPage — navigate to it
 * 3. addSection — add a blank section
 * 4. enterSectionEditMode — enter section edit mode
 * 5. addBlockToSection — add a Button block with initial label
 * 6. editButtonBlock — change label and set URL
 * 7. Verify label + URL in the DOM
 * 8. saveChanges
 * 9. Cleanup — delete the test page
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { getSiteFrame, saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

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

    const createResult = await executeAgentAction(page, { action: 'createPage', title: 'Button URL Test', slug: 'button-url-test' });
    console.log('createPage:', createResult.success ? 'OK' : 'FAIL', '—', createResult.message);
    if (!createResult.success) { console.log('ABORT: Failed to create page'); return; }
    await takeScreenshot(page, 'btn-01-page-created');

    // Step 2: Navigate to the new page and enter edit mode
    console.log('\n=== Step 2: Navigate to page ===');
    const switchResult = await executeAgentAction(page, { action: 'switchPage', pageSlug: 'button-url-test' });
    console.log('switchPage:', switchResult.success ? 'OK' : 'FAIL', '—', switchResult.message);

    await enterEditMode(page);
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'btn-02-edit-mode');

    // Step 3: Add a section
    console.log('\n=== Step 3: Add section ===');
    const addSec = await executeAgentAction(page, { action: 'addSection' });
    console.log('addSection:', addSec.success ? 'OK' : 'FAIL', '—', addSec.message);
    await takeScreenshot(page, 'btn-03-section-added');
    await page.waitForTimeout(2000);

    // Step 4: Enter section edit mode
    console.log('\n=== Step 4: Enter section edit mode ===');
    const enterEdit = await executeAgentAction(page, { action: 'enterSectionEditMode', sectionIndex: 'last' });
    console.log('enterSectionEditMode:', enterEdit.success ? 'OK' : 'FAIL', '—', enterEdit.message);
    await takeScreenshot(page, 'btn-04-section-edit-mode');

    // Step 5: Add a Button block with initial label
    console.log('\n=== Step 5: Add button block ===');
    const addBtn = await executeAgentAction(page, { action: 'addBlockToSection', blockType: 'Button', content: 'Click Me' });
    console.log('addBlockToSection:', addBtn.success ? 'OK' : 'FAIL', '—', addBtn.message);
    await takeScreenshot(page, 'btn-05-button-added');

    // Exit section edit mode / close panels
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    // Detect the actual button text before editing
    const checkFrame = page.frame({ name: 'sqs-site-frame' });
    let defaultButtonText = 'Click Me';
    if (checkFrame) {
      const btnText = await checkFrame.evaluate(() => {
        const btns = document.querySelectorAll(
          '.sqs-block-button-element, .sqs-block-button a, ' +
          'a.sqs-block-button-element--medium, .sqs-block-button span'
        );
        for (const btn of btns) {
          const text = (btn as HTMLElement).innerText?.trim();
          if (text) return text;
        }
        return null;
      }).catch(() => null);
      if (btnText) {
        defaultButtonText = btnText;
        console.log(`Detected button text: "${defaultButtonText}"`);
      } else {
        console.log('Could not detect button text, using "Click Me"');
      }
    }

    // Step 6: Edit the button — change label and set URL using editButtonBlock
    console.log('\n=== Step 6: Edit button (label + URL) ===');
    let editResult = await executeAgentAction(page, {
      action: 'editButtonBlock',
      searchText: defaultButtonText,
      newLabel: 'Visit Example',
      url: 'https://example.com',
    });

    if (!editResult.success) {
      console.log(`editButtonBlock with "${defaultButtonText}" failed, trying fallback texts...`);
      // Try common default button texts
      for (const fallbackText of ['SHOP NOW', 'Button', 'BUTTON', 'Click Here', 'Click Me']) {
        if (fallbackText === defaultButtonText) continue;
        editResult = await executeAgentAction(page, {
          action: 'editButtonBlock',
          searchText: fallbackText,
          newLabel: 'Visit Example',
          url: 'https://example.com',
        });
        if (editResult.success) {
          console.log(`Succeeded with fallback text: "${fallbackText}"`);
          break;
        }
      }
    }

    console.log('editButtonBlock:', editResult.success ? 'OK' : 'FAIL', '—', editResult.message);
    await takeScreenshot(page, 'btn-06-button-edited');

    // Step 7: Verify
    console.log('\n=== Step 7: Verify ===');
    const verifyFrame = page.frame({ name: 'sqs-site-frame' });

    if (verifyFrame) {
      const labelFound = await verifyFrame.evaluate(() => {
        const buttons = document.querySelectorAll('.sqs-block-button a, .sqs-block-button-element, a.sqs-block-button-element--medium');
        for (const btn of buttons) {
          if ((btn as HTMLElement).innerText?.trim().includes('Visit Example')) return true;
        }
        return false;
      }).catch(() => false);
      console.log(labelFound ? 'PASS: Label verified: "Visit Example"' : 'FAIL: Label not verified');

      const urlFound = await verifyFrame.evaluate(() => {
        const links = document.querySelectorAll('.sqs-block-button a, a.sqs-block-button-element--medium');
        for (const link of links) {
          if ((link as HTMLAnchorElement).href?.includes('example.com')) return true;
        }
        return false;
      }).catch(() => false);
      console.log(urlFound ? 'PASS: URL verified: "https://example.com"' : 'FAIL: URL not verified');

      // Debug: list all button elements
      const buttonInfo = await verifyFrame.evaluate(() => {
        const results: string[] = [];
        const btns = document.querySelectorAll(
          '.sqs-block-button a, .sqs-block-button-element, a.sqs-block-button-element--medium'
        );
        for (const btn of btns) {
          const text = (btn as HTMLElement).innerText?.trim();
          const href = (btn as HTMLAnchorElement).href || 'none';
          results.push(`text="${text}" href="${href}"`);
        }
        return results;
      }).catch(() => []);
      console.log('Button elements found:', buttonInfo);
    } else {
      console.log('FAIL: Could not access site iframe for verification');
    }
    await takeScreenshot(page, 'btn-07-verified');

    // Step 8: Save
    console.log('\n=== Step 8: Save ===');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const saveResult = await executeAgentAction(page, { action: 'saveChanges' });
    console.log('saveChanges:', saveResult.success ? 'OK' : 'FAIL', '—', saveResult.message);
    await takeScreenshot(page, 'btn-08-saved');

    // Step 9: Cleanup - delete the test page
    console.log('\n=== Step 9: Cleanup ===');
    await page.goto('https://tim-cox.squarespace.com/config/pages', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Find the test page in the pages panel
    const pageItemFound = await page.evaluate((title: string) => {
      const items = document.querySelectorAll('[data-test="pages-panel-item"]');
      for (const item of items) {
        if (item.textContent?.toLowerCase().includes(title.toLowerCase())) {
          (item as HTMLElement).click();
          return true;
        }
      }
      // Also try by text content generally
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        if ((el as HTMLElement).innerText?.trim() === title) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, 'Button URL Test');

    if (pageItemFound) {
      await page.waitForTimeout(2000);

      // Look for gear/settings icon
      const gearSelectors = [
        'button[aria-label="Settings"]',
        'button[aria-label="Page Settings"]',
        '[data-test="page-settings"]',
        'button:has-text("Settings")',
      ];

      let settingsClicked = false;
      for (const sel of gearSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          settingsClicked = true;
          console.log(`Settings opened via: ${sel}`);
          break;
        }
      }

      if (settingsClicked) {
        await page.waitForTimeout(2000);

        // Look for Delete
        const deleteSelectors = [
          'button:has-text("Delete")',
          'button:has-text("DELETE")',
          'button:has-text("Delete Page")',
          'text=Delete',
        ];

        let deleteClicked = false;
        // Scroll down first to reveal Delete
        await page.keyboard.press('End');
        await page.waitForTimeout(1000);

        for (const sel of deleteSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btn.click();
            deleteClicked = true;
            console.log(`Delete clicked via: ${sel}`);
            break;
          }
        }

        if (deleteClicked) {
          await page.waitForTimeout(1500);
          const confirmSelectors = [
            'button:has-text("Confirm")',
            'button:has-text("CONFIRM")',
            'button:has-text("Yes")',
            'button:has-text("DELETE")',
          ];
          for (const sel of confirmSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await btn.click();
              console.log(`Confirmed deletion via: ${sel}`);
              break;
            }
          }
          await page.waitForTimeout(2000);
          console.log('Test page deleted');
        } else {
          console.log('WARNING: Could not find Delete button');
        }
      } else {
        console.log('WARNING: Could not open page settings for cleanup');
      }
    } else {
      console.log('WARNING: Test page not found in pages list for cleanup');
    }

    await takeScreenshot(page, 'btn-09-cleanup');

    console.log('\n=== DONE ===');
  } catch (err) {
    console.error('FATAL ERROR:', (err as Error).message);
    console.error((err as Error).stack);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
