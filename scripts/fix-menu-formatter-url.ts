/**
 * Fix the Menu Formatter button URL (section 6998b6a09463047a8fb1c422).
 * This section failed in the main script because it couldn't be found.
 *
 * Diagnostic: scroll to top, list all section IDs, then try to click.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, clickThroughOverlay, saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const TARGET_SECTION_ID = '6998b6a09463047a8fb1c422';
const TARGET_URL = 'https://menu-block.lovable.app';

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Navigate to Coding Projects page
    console.log('Navigating to Coding Projects page...');
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const cpLink = page.locator('text=Coding Projects').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cpLink.click();
      console.log('Clicked Coding Projects link');
      await page.waitForTimeout(4000);
    }

    await enterEditMode(page);
    await page.waitForTimeout(3000);

    const sf = getSiteFrame(page);
    if (!sf) { console.log('No site frame'); return; }

    // List all section IDs
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (!siteFrame) { console.log('No sqs-site-frame'); return; }

    // Scroll to top
    await siteFrame.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    const sectionIds = await siteFrame.evaluate(() => {
      const sections = document.querySelectorAll('.page-section');
      return Array.from(sections).map((s, i) => ({
        index: i,
        id: s.getAttribute('data-section-id') || 'unknown',
        text: (s as HTMLElement).innerText?.substring(0, 50).replace(/\n/g, ' ') || '',
      }));
    });

    console.log('\nAll sections on page:');
    for (const s of sectionIds) {
      const match = s.id === TARGET_SECTION_ID ? ' <-- TARGET' : '';
      console.log(`  [${s.index}] ${s.id} "${s.text}"${match}`);
    }

    // Check if the target section exists
    const targetExists = sectionIds.some(s => s.id === TARGET_SECTION_ID);
    if (!targetExists) {
      console.log(`\nTarget section ${TARGET_SECTION_ID} NOT found in DOM.`);
      console.log('Looking for the Menu Formatter section by text content...');

      const menuFormatterSection = sectionIds.find(s =>
        s.text.toLowerCase().includes('menu formatter')
      );
      if (menuFormatterSection) {
        console.log(`Found Menu Formatter at index ${menuFormatterSection.index} with ID: ${menuFormatterSection.id}`);
        console.log('Will use this ID instead.');

        // Try to set URL on this section
        const sectionSel = `.page-section[data-section-id="${menuFormatterSection.id}"]`;
        const clickR = await clickThroughOverlay(page, sectionSel);
        console.log(`Click section: ${clickR.success ? 'OK' : clickR.message}`);

        if (clickR.success) {
          await page.waitForTimeout(1200);

          // Click button block
          const section = sf.locator(sectionSel);
          const btnBlock = section.locator('.sqs-block-button').first();
          await btnBlock.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(400);

          const box = await btnBlock.boundingBox().catch(() => null);
          if (box) {
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;

            // Click twice to select button and open toolbar
            await page.mouse.click(cx, cy);
            await page.waitForTimeout(1000);
            await page.mouse.click(cx, cy);
            await page.waitForTimeout(1500);

            // Click the "Open link editor popover" button
            const linkBtn = page.locator('button[aria-label="Open link editor popover"]').first();
            const linkVis = await linkBtn.isVisible({ timeout: 2000 }).catch(() => false);
            if (linkVis) {
              await linkBtn.click();
              console.log('Clicked link editor popover button');
              await page.waitForTimeout(1000);

              // Fill URL
              const urlInputSelectors = [
                'input[placeholder*="link"]',
                'input[placeholder*="Link"]',
                'input[placeholder*="search"]',
                'input[placeholder*="Enter link"]',
                'input[placeholder*="URL"]',
              ];
              for (const sel of urlInputSelectors) {
                const el = page.locator(sel).first();
                const vis = await el.isVisible({ timeout: 1500 }).catch(() => false);
                if (vis) {
                  await el.click();
                  await page.waitForTimeout(200);
                  await el.fill(TARGET_URL);
                  await page.waitForTimeout(500);
                  await page.keyboard.press('Enter');
                  await page.waitForTimeout(800);
                  console.log(`URL set to ${TARGET_URL}`);
                  break;
                }
              }

              // Close
              await page.keyboard.press('Escape');
              await page.waitForTimeout(500);
              await page.mouse.click(100, 100);
              await page.waitForTimeout(500);
            } else {
              console.log('Link editor popover button not visible');
              await takeScreenshot(page, 'menu-formatter-no-link-btn');
            }
          }
        }
      } else {
        console.log('Menu Formatter section not found by text either.');
      }
    } else {
      console.log(`\nTarget section ${TARGET_SECTION_ID} found! Trying to click...`);

      // Scroll to the target section first
      await siteFrame.evaluate((id: string) => {
        const section = document.querySelector(`.page-section[data-section-id="${id}"]`);
        if (section) section.scrollIntoView({ behavior: 'instant', block: 'center' });
      }, TARGET_SECTION_ID);
      await page.waitForTimeout(1000);

      const sectionSel = `.page-section[data-section-id="${TARGET_SECTION_ID}"]`;
      const clickR = await clickThroughOverlay(page, sectionSel);
      console.log(`Click section: ${clickR.success ? 'OK' : clickR.message}`);

      if (clickR.success) {
        await page.waitForTimeout(1200);

        const section = sf.locator(sectionSel);
        const btnBlock = section.locator('.sqs-block-button').first();
        await btnBlock.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(400);

        const box = await btnBlock.boundingBox().catch(() => null);
        if (box) {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;

          await page.mouse.click(cx, cy);
          await page.waitForTimeout(1000);
          await page.mouse.click(cx, cy);
          await page.waitForTimeout(1500);

          const linkBtn = page.locator('button[aria-label="Open link editor popover"]').first();
          const linkVis = await linkBtn.isVisible({ timeout: 2000 }).catch(() => false);
          if (linkVis) {
            await linkBtn.click();
            console.log('Clicked link editor popover button');
            await page.waitForTimeout(1000);

            const urlInputSelectors = [
              'input[placeholder*="link"]',
              'input[placeholder*="Link"]',
              'input[placeholder*="search"]',
              'input[placeholder*="Enter link"]',
              'input[placeholder*="URL"]',
            ];
            for (const sel of urlInputSelectors) {
              const el = page.locator(sel).first();
              const vis = await el.isVisible({ timeout: 1500 }).catch(() => false);
              if (vis) {
                await el.click();
                await page.waitForTimeout(200);
                await el.fill(TARGET_URL);
                await page.waitForTimeout(500);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(800);
                console.log(`URL set to ${TARGET_URL}`);
                break;
              }
            }

            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
            await page.mouse.click(100, 100);
            await page.waitForTimeout(500);
          } else {
            console.log('Link editor popover button not visible');
            await takeScreenshot(page, 'menu-formatter-no-link-btn');
          }
        } else {
          console.log('Could not get button block bounding box');
        }
      }
    }

    // Save
    console.log('\nSaving...');
    const sr = await saveChanges(page);
    console.log(`Save: ${sr.message}`);
    await takeScreenshot(page, 'menu-formatter-fix-done');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
