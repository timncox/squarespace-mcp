/**
 * Remove the "BIG IDEAS" text that was accidentally added to the footer.
 * The footer uses removeBlock to delete individual blocks, not deleteSelectedBlock.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { saveChanges, getSiteFrame } from '../src/automation/editor-actions.js';
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

    // Check if "BIG IDEAS" text exists in the footer
    const siteFrame = getSiteFrame(page);
    if (siteFrame) {
      const bigIdeas = await siteFrame.locator('text=BIG IDEAS').count();
      console.log(`"BIG IDEAS" text found: ${bigIdeas}`);

      if (bigIdeas > 0) {
        // Try to remove it via the removeBlock action
        const result = await executeAgentAction(page, {
          action: 'removeBlock',
          searchText: 'BIG IDEAS',
        });
        console.log(`removeBlock result: ${result.success} - ${result.message}`);

        if (result.success) {
          const saveResult = await saveChanges(page);
          console.log(`Save: ${saveResult.message}`);
        }
      } else {
        console.log('Footer is clean — no "BIG IDEAS" text found');
      }
    }

    await takeScreenshot(page, 'footer-fix');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
