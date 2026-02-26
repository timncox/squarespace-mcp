/**
 * Quick test: addSection + enterSectionEditMode combo.
 * Verifies the fix for targeting the correct section (skipping footer).
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

async function main() {
  const browserManager = getBrowserManager({ headless: false });

  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    // Navigate to the Coding Projects page
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Click "Coding Projects" in the sidebar
    const cpLink = page.locator('text=Coding Projects').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cpLink.click();
      console.log('Clicked Coding Projects');
      await page.waitForTimeout(4000);
    } else {
      console.log('Sidebar link not found, navigating directly');
      await page.goto('https://tim-cox.squarespace.com/coding-projects', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await page.waitForTimeout(3000);
    }

    // Verify we're on the right page
    const pageTitle = await page.locator('text=Coding Projects').first().isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`On Coding Projects page: ${pageTitle}`);

    await enterEditMode(page);
    await page.waitForTimeout(2000);

    // Step 1: addSection
    console.log('\n=== Step 1: addSection ===');
    const addResult = await executeAgentAction(page, { action: 'addSection' });
    console.log('addSection result:', JSON.stringify(addResult, null, 2));
    await takeScreenshot(page, 'test-after-addsection');

    if (!addResult.success) {
      console.log('addSection failed — stopping');
      return;
    }

    // Step 2: enterSectionEditMode with sectionIndex:"last"
    console.log('\n=== Step 2: enterSectionEditMode (sectionIndex:"last") ===');
    const editResult = await executeAgentAction(page, {
      action: 'enterSectionEditMode',
      sectionIndex: 'last',
    });
    console.log('enterSectionEditMode result:', JSON.stringify(editResult, null, 2));
    await takeScreenshot(page, 'test-after-enter-edit-mode');

    if (!editResult.success) {
      console.log('enterSectionEditMode failed — stopping');
      return;
    }

    // Step 3: try addBlockToSection with text
    console.log('\n=== Step 3: addBlockToSection (Text) ===');
    const blockResult = await executeAgentAction(page, {
      action: 'addBlockToSection',
      blockType: 'Text',
      content: 'Test Project Title\nThis is a test description for the project.',
    });
    console.log('addBlockToSection result:', JSON.stringify(blockResult, null, 2));
    await takeScreenshot(page, 'test-after-add-block');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
