/**
 * Clean footer fix via UI — enter footer edit mode, replace entire text block.
 *
 * Usage: npx tsx scripts/restore-footer-api.ts
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { chromium } from 'playwright';
import * as path from 'path';

const SITE_SUBDOMAIN = 'grey-yellow-hbxc';
const SESSION_PATH = path.resolve('storage/auth/sqsp-session.json');
const SCREENSHOT_DIR = path.resolve('storage/screenshots');

async function main() {
  console.log('=== Clean Footer Fix ===\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: SESSION_PATH,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    // Step 1: Navigate to editor
    console.log('Step 1: Navigate to editor...');
    await page.goto(
      `https://${SITE_SUBDOMAIN}.squarespace.com/config/pages`,
      { waitUntil: 'networkidle', timeout: 30000 },
    );
    await page.waitForTimeout(3000);

    for (const name of ['Private Dining', 'Wine List', 'Gallery']) {
      const link = page.locator(`a:has-text("${name}")`).first();
      if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
        await link.click({ force: true });
        await page.waitForTimeout(3000);
        break;
      }
    }

    const editBtn = page.locator('button:has-text("Edit")').first();
    if (await editBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(5000);
    }

    // Step 2: Scroll to footer and click EDIT SITE FOOTER
    console.log('Step 2: Entering footer edit mode...');
    const frame = page.frame({ name: 'sqs-site-frame' });
    if (!frame) throw new Error('No iframe');

    // Scroll in the iframe to get to the footer
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(2000);

    // Click EDIT SITE FOOTER
    const footerBtn = frame.locator('button:has-text("EDIT SITE FOOTER"), a:has-text("EDIT SITE FOOTER")').first();
    const footerBtnBox = await footerBtn.boundingBox();
    if (footerBtnBox) {
      const ih = await page.$('iframe[name="sqs-site-frame"]');
      const iBox = ih ? await ih.boundingBox() : null;
      if (iBox) {
        await page.mouse.click(
          iBox.x + footerBtnBox.x + footerBtnBox.width / 2,
          iBox.y + footerBtnBox.y + footerBtnBox.height / 2,
        );
        await page.waitForTimeout(3000);
      }
    }

    let ss = path.join(SCREENSHOT_DIR, 'footer-fix-1.png');
    await page.screenshot({ path: ss });
    console.log(`Screenshot: ${ss}`);

    // Step 3: Scroll down again to see the footer text
    console.log('Step 3: Scrolling to footer text...');
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1000);

    ss = path.join(SCREENSHOT_DIR, 'footer-fix-2.png');
    await page.screenshot({ path: ss });
    console.log(`Screenshot: ${ss}`);

    // Step 4: Click on the footer text to select the section
    console.log('Step 4: Clicking footer text block...');
    const giftCardsEl = frame.locator('text=GIFT CARDS').first();
    const gcBox = await giftCardsEl.boundingBox();
    if (gcBox) {
      const ih = await page.$('iframe[name="sqs-site-frame"]');
      const iBox = ih ? await ih.boundingBox() : null;
      if (iBox) {
        const x = iBox.x + gcBox.x + gcBox.width / 2;
        const y = iBox.y + gcBox.y + gcBox.height / 2;

        // Click to select section
        await page.mouse.click(x, y);
        await page.waitForTimeout(1500);

        ss = path.join(SCREENSHOT_DIR, 'footer-fix-3-clicked.png');
        await page.screenshot({ path: ss });
        console.log(`Screenshot: ${ss}`);

        // Look for EDIT CONTENT button
        const editContent = page.locator('button:has-text("EDIT CONTENT")').first();
        const ecVis = await editContent.isVisible({ timeout: 3000 }).catch(() => false);
        if (ecVis) {
          console.log('  Clicking EDIT CONTENT...');
          await editContent.click();
          await page.waitForTimeout(2000);
        }

        // Double-click the text to enter inline edit mode
        console.log('Step 5: Double-clicking to enter edit mode...');
        await page.mouse.dblclick(x, y);
        await page.waitForTimeout(1500);

        ss = path.join(SCREENSHOT_DIR, 'footer-fix-4-editing.png');
        await page.screenshot({ path: ss });
        console.log(`Screenshot: ${ss}`);

        // Check if we're in contenteditable mode
        const isEditable = await frame.evaluate(() => {
          const active = document.activeElement;
          const editable = document.querySelector('[contenteditable="true"]');
          return {
            hasEditable: !!editable,
            activeTag: active?.tagName,
            editableText: editable?.textContent?.substring(0, 100),
          };
        });
        console.log('Editable state:', isEditable);

        // Select ALL content in the text block
        console.log('Step 6: Selecting all and replacing...');
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(500);

        // Delete the selected content
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(500);

        // Type the correct content line by line
        const lines = [
          'GIFT CARDS',
          'Purchase a Gift Card',
          'INFO@SMYTHTAVERN.COM',
          'Monday - Sunday | 12PM-12AM',
          '(646) 813-9090',
          '85 West Broadway on the corner of Chambers Street',
        ];

        for (let i = 0; i < lines.length; i++) {
          await page.keyboard.type(lines[i], { delay: 10 });
          if (i < lines.length - 1) {
            await page.keyboard.press('Enter');
            await page.waitForTimeout(100);
          }
        }

        await page.waitForTimeout(1000);

        // Click away to deselect
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);

        ss = path.join(SCREENSHOT_DIR, 'footer-fix-5-typed.png');
        await page.screenshot({ path: ss });
        console.log(`Screenshot: ${ss}`);

        // Save
        console.log('Step 7: Saving...');
        // Use Cmd+S
        await page.keyboard.press('Meta+s');
        await page.waitForTimeout(3000);

        // Also try the SAVE button
        const saveBtn = page.getByRole('button', { name: /^save$/i });
        if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await saveBtn.click();
          await page.waitForTimeout(3000);
        }

        console.log('Saved!');
      }
    } else {
      console.log('Could not find GIFT CARDS text in footer');
    }

    // Final screenshot - scroll to footer
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1000);

    ss = path.join(SCREENSHOT_DIR, 'footer-final-fixed.png');
    await page.screenshot({ path: ss });
    console.log(`\nFinal screenshot: ${ss}`);

    console.log('\n=== Done! ===');
  } catch (err) {
    console.error('Error:', err);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'footer-fix-error.png') }).catch(() => {});
  } finally {
    await browser.close();
  }
}

main();
