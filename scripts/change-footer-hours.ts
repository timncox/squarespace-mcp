/**
 * Direct script to change Smyth Tavern footer hours on grey-yellow-hbxc.
 * Uses browser agent actions directly (no LLM needed).
 *
 * Usage: npx tsx scripts/change-footer-hours.ts
 */

import { chromium } from 'playwright';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import * as fs from 'fs';
import * as path from 'path';

const SITE_SUBDOMAIN = 'grey-yellow-hbxc';
const SESSION_PATH = path.resolve('storage/auth/sqsp-session.json');
const SCREENSHOT_DIR = path.resolve('storage/screenshots');

async function main() {
  console.log('=== Change Smyth Tavern Footer Hours ===\n');

  if (!fs.existsSync(SESSION_PATH)) {
    console.error('Session file not found. Run test-login first.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: SESSION_PATH,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    // Step 1: Navigate to config/pages
    console.log('Step 1: Navigating to site editor...');
    await page.goto(
      `https://${SITE_SUBDOMAIN}.squarespace.com/config/pages`,
      { waitUntil: 'networkidle', timeout: 30000 },
    );
    await page.waitForTimeout(3000);

    // Step 2: Click any page to load it (footer is global)
    console.log('Step 2: Selecting a page...');
    // Click the first visible page in Main Navigation
    for (const pageName of ['Private Dining', 'Wine List', 'Weekend Brunch', 'Gallery']) {
      const link = page.locator(`a:has-text("${pageName}")`).first();
      const vis = await link.isVisible({ timeout: 2000 }).catch(() => false);
      if (vis) {
        await link.click({ force: true });
        console.log(`  Clicked "${pageName}"`);
        await page.waitForTimeout(3000);
        break;
      }
    }

    // Step 3: Enter edit mode
    console.log('Step 3: Entering edit mode...');
    const editButton = page.locator('button:has-text("Edit")').first();
    const editVisible = await editButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (editVisible) {
      await editButton.click();
      await page.waitForTimeout(5000);
    }

    // Take a screenshot to see current state
    const ss1 = path.join(SCREENSHOT_DIR, 'footer-before.png');
    await page.screenshot({ path: ss1 });
    console.log(`Screenshot (before): ${ss1}`);

    // Step 4: Scroll to footer to see the hours
    console.log('Step 4: Scrolling to footer...');
    await executeAgentAction(page, {
      action: 'scroll',
      direction: 'down',
      amount: 3000,
    });
    await page.waitForTimeout(2000);

    const ss2 = path.join(SCREENSHOT_DIR, 'footer-visible.png');
    await page.screenshot({ path: ss2 });
    console.log(`Screenshot (footer visible): ${ss2}`);

    // Step 5: Find the current hours text in the footer
    console.log('Step 5: Finding current hours text...');
    const findResult = await executeAgentAction(page, {
      action: 'findText',
      text: 'Sunday - Wednesday',
    });
    console.log('Find result:', findResult.message);

    if (!findResult.success) {
      // Try alternate text
      const findResult2 = await executeAgentAction(page, {
        action: 'findText',
        text: '7AM-10PM',
      });
      console.log('Find result (alt):', findResult2.message);
    }

    // Step 6: Try to find and see the exact footer hours text
    // First let's check what the footer contains
    const frame = page.frame({ name: 'sqs-site-frame' });
    if (frame) {
      const footerText = await frame.evaluate(() => {
        const footer = document.querySelector('footer') || document.querySelector('[data-section-theme]');
        // Get all text nodes in the footer area (last dark section)
        const sections = document.querySelectorAll('section');
        const lastSection = sections[sections.length - 1];
        return lastSection ? lastSection.textContent?.trim() : 'No sections found';
      });
      console.log('Footer/last section text:', footerText);
    }

    // Step 7: Edit the hours text
    // The current text from the screenshot was: "Sunday - Wednesday | 7AM-10PM"
    console.log('Step 6: Editing footer hours...');
    const editResult = await executeAgentAction(page, {
      action: 'editTextBlock',
      searchText: 'Sunday - Wednesday',
      newText: 'Monday - Sunday | 12PM-12AM',
    });
    console.log('Edit result:', editResult.message);

    if (!editResult.success) {
      // Try the full line
      console.log('Trying full hours line...');
      const editResult2 = await executeAgentAction(page, {
        action: 'editTextBlock',
        searchText: '7AM-10PM',
        newText: 'Monday - Sunday | 12PM-12AM',
      });
      console.log('Edit result (alt):', editResult2.message);
    }

    // Step 8: Save changes
    console.log('Step 7: Saving changes...');
    const saveResult = await executeAgentAction(page, { action: 'saveChanges' });
    console.log('Save result:', saveResult.message);
    await page.waitForTimeout(3000);

    // Step 9: Take final screenshot
    const ss3 = path.join(SCREENSHOT_DIR, 'footer-after.png');
    await page.screenshot({ path: ss3 });
    console.log(`Screenshot (after): ${ss3}`);

    // Scroll to footer for final verification screenshot
    await executeAgentAction(page, {
      action: 'scroll',
      direction: 'down',
      amount: 3000,
    });
    await page.waitForTimeout(2000);
    const ss4 = path.join(SCREENSHOT_DIR, 'footer-after-scrolled.png');
    await page.screenshot({ path: ss4 });
    console.log(`Screenshot (after, scrolled to footer): ${ss4}`);

    console.log('\n=== Done! ===');
  } catch (err) {
    console.error('Error:', err);
    const ssErr = path.join(SCREENSHOT_DIR, 'footer-error.png');
    await page.screenshot({ path: ssErr }).catch(() => {});
  } finally {
    await browser.close();
  }
}

main();
