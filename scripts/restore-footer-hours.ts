/**
 * Restore Smyth Tavern footer content with updated hours.
 *
 * Usage: npx tsx scripts/restore-footer-hours.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { chromium } from 'playwright';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import * as fs from 'fs';
import * as path from 'path';

const SITE_SUBDOMAIN = 'grey-yellow-hbxc';
const SESSION_PATH = path.resolve('storage/auth/sqsp-session.json');
const SCREENSHOT_DIR = path.resolve('storage/screenshots');

async function main() {
  console.log('=== Restore Smyth Tavern Footer ===\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: SESSION_PATH,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    // Navigate to editor
    console.log('Step 1: Navigating to editor...');
    await page.goto(
      `https://${SITE_SUBDOMAIN}.squarespace.com/config/pages`,
      { waitUntil: 'networkidle', timeout: 30000 },
    );
    await page.waitForTimeout(3000);

    // Click a page
    for (const name of ['Private Dining', 'Wine List', 'Gallery']) {
      const link = page.locator(`a:has-text("${name}")`).first();
      if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
        await link.click({ force: true });
        await page.waitForTimeout(3000);
        break;
      }
    }

    // Enter edit mode
    const editBtn = page.locator('button:has-text("Edit")').first();
    if (await editBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(5000);
    }

    // Scroll to footer
    console.log('Step 2: Scrolling to footer...');
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(2000);

    let ss = path.join(SCREENSHOT_DIR, 'footer-restore-1.png');
    await page.screenshot({ path: ss });
    console.log(`Screenshot: ${ss}`);

    // Click EDIT SITE FOOTER through the iframe
    console.log('Step 3: Clicking EDIT SITE FOOTER...');
    const frame = page.frame({ name: 'sqs-site-frame' });
    if (!frame) throw new Error('No site iframe');

    // Use frame to find the button and click through the page
    const btnBox = await frame.locator('button:has-text("EDIT SITE FOOTER")').boundingBox();
    if (btnBox) {
      // Get iframe position on the page
      const iframeHandle = await page.$('iframe[name="sqs-site-frame"]');
      const iframeBox = iframeHandle ? await iframeHandle.boundingBox() : null;

      if (iframeBox) {
        const clickX = iframeBox.x + btnBox.x + btnBox.width / 2;
        const clickY = iframeBox.y + btnBox.y + btnBox.height / 2;
        await page.mouse.click(clickX, clickY);
        await page.waitForTimeout(3000);

        ss = path.join(SCREENSHOT_DIR, 'footer-restore-2-edit-mode.png');
        await page.screenshot({ path: ss });
        console.log(`Screenshot (edit mode): ${ss}`);
      }
    } else {
      console.log('EDIT SITE FOOTER button not found in iframe');
    }

    // Now we should be in footer edit mode
    // The footer text block has our broken text "Monday - Sunday | 12PM-12AM"
    // We need to find it, enter edit mode, and restore the full content

    // First, find the text in the footer
    console.log('Step 4: Finding footer text block...');
    const findResult = await executeAgentAction(page, {
      action: 'findText',
      text: 'Monday - Sunday',
    });
    console.log('Find result:', findResult.message);

    // Now use editTextBlock to replace it with full restored content
    // editTextBlock does Select All + retype, which is what we WANT here
    // because we need to replace the entire block
    console.log('Step 5: Restoring footer content...');
    const editResult = await executeAgentAction(page, {
      action: 'editTextBlock',
      searchText: 'Monday - Sunday',
      newText: 'GIFT CARDS\nPurchase a Gift Card\nINFO@SMYTHTAVERN.COM\nMonday - Sunday | 12PM-12AM\n(646) 813-9090\n85 West Broadway on the corner of Chambers Street',
    });
    console.log('Edit result:', editResult.message);

    // Save
    console.log('Step 6: Saving...');
    const saveResult = await executeAgentAction(page, { action: 'saveChanges' });
    console.log('Save result:', saveResult.message);
    await page.waitForTimeout(3000);

    // Final screenshot - scroll to footer
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1000);

    ss = path.join(SCREENSHOT_DIR, 'footer-restored-final.png');
    await page.screenshot({ path: ss });
    console.log(`\nFinal screenshot: ${ss}`);

    console.log('\n=== Done! ===');
  } catch (err) {
    console.error('Error:', err);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'footer-restore-error.png') }).catch(() => {});
  } finally {
    await browser.close();
  }
}

main();
