/**
 * Test that addBlockToSection actually types content into Text and Button blocks.
 * Adds one section with a Text block + Button block, both with content.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { join } from 'path';
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

    // Navigate to Coding Projects page
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

    // Step 1: Add a new section
    console.log('\n=== Step 1: Add Section ===');
    const r1 = await executeAgentAction(page, { action: 'addSection' });
    console.log(`addSection: ${r1.success ? '✓' : '✗'} ${r1.message?.substring(0, 100)}`);
    await page.waitForTimeout(1500);

    // Step 2: Add text block with content
    console.log('\n=== Step 2: Add Text Block with Content ===');
    const r2 = await executeAgentAction(page, {
      action: 'addBlockToSection',
      blockType: 'Text',
      content: 'Test Title\nThis is a test description to verify content typing works.',
    });
    console.log(`addText: ${r2.success ? '✓' : '✗'} ${r2.message?.substring(0, 150)}`);
    await takeScreenshot(page, 'test-typing-after-text');
    await page.waitForTimeout(1000);

    // Step 3: Re-enter edit mode for the section
    console.log('\n=== Step 3: Re-enter edit mode ===');
    // Escape first
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Check if ADD BLOCK is visible
    const addBlockVis = await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`ADD BLOCK visible: ${addBlockVis}`);

    if (!addBlockVis) {
      const er = await executeAgentAction(page, { action: 'enterSectionEditMode', sectionIndex: 'last' });
      console.log(`enterSectionEditMode: ${er.success ? '✓' : '✗'} ${er.message?.substring(0, 100)}`);
      await page.waitForTimeout(1500);
    }

    // Step 4: Add button block with label
    console.log('\n=== Step 4: Add Button Block with Label ===');
    const r3 = await executeAgentAction(page, {
      action: 'addBlockToSection',
      blockType: 'Button',
      content: 'View Project',
    });
    console.log(`addButton: ${r3.success ? '✓' : '✗'} ${r3.message?.substring(0, 150)}`);
    await takeScreenshot(page, 'test-typing-after-button');
    await page.waitForTimeout(1000);

    // Check what we got
    console.log('\n=== Verification ===');
    const sf = getSiteFrame(page);
    if (sf) {
      // Check text blocks
      const textBlocks = sf.locator('.sqs-block-html .sqs-block-content');
      const textCount = await textBlocks.count().catch(() => 0);
      console.log(`Text blocks: ${textCount}`);
      for (let i = 0; i < textCount; i++) {
        const text = await textBlocks.nth(i).innerText().catch(() => '(error)');
        console.log(`  text[${i}]: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
      }

      // Check button blocks
      const btnBlocks = sf.locator('.sqs-block-button');
      const btnCount = await btnBlocks.count().catch(() => 0);
      console.log(`Button blocks: ${btnCount}`);
      for (let i = 0; i < btnCount; i++) {
        const btnText = await btnBlocks.nth(i).innerText().catch(() => '(error)');
        console.log(`  btn[${i}]: "${btnText.trim()}"`);
      }
    }

    // Save
    console.log('\n=== Save ===');
    // Escape out of edit mode first
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const sr = await saveChanges(page);
    console.log(`Save: ${sr.success ? '✓' : '✗'} ${sr.message}`);
    await takeScreenshot(page, 'test-typing-final');

    console.log('\n✅ Done!');
  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
