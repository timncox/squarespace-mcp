/**
 * Phase 2: Edit Squarespace Coding Projects page.
 * Screenshots already captured. Content pre-generated.
 *
 * Tasks:
 * A. Remove "Test Title" leftover section
 * B. Add "Menu Formatter" section (screenshot + title + description + button)
 * C. Add screenshot to PoolTogether Explorer section (missing image)
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import path from 'path';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const UPLOAD_DIR = path.resolve('storage/uploads');

const MENU_BLOCK_PROJECT = {
  url: 'https://menu-block.lovable.app/',
  title: 'Menu Formatter',
  description: 'Paste raw menu text and instantly get clean, Squarespace-ready formatted output. Powered by AI for fast, accurate menu formatting.',
  screenshotPath: path.join(UPLOAD_DIR, 'project-menu-block.png'),
};

const PT_SCREENSHOT_PATH = path.join(UPLOAD_DIR, 'project-pooltogether-explorer.png');

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Phase 2: Edit Squarespace Coding Projects   ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // ═══════════════════════════════════════════════════════════
    // Task A: Remove "Test Title" leftover section
    // ═══════════════════════════════════════════════════════════
    console.log('\n══ Task A: Remove "Test Title" section ══');
    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Enter edit mode
    const editBtn = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
    if (await editBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(3000);
      console.log('  Entered edit mode');
    }

    // Find and click the "Test Title" section
    const iframe = page.frameLocator('#sqs-site-frame');
    const sections = iframe.locator('section.page-section[data-section-id]');
    const secCount = await sections.count();
    console.log(`  Content sections: ${secCount}`);

    let testSectionDeleted = false;
    for (let i = 0; i < secCount; i++) {
      const text = await sections.nth(i).innerText().catch(() => '');
      if (text.includes('Test Title') || text.includes('SHOP NOW')) {
        console.log(`  Found test section at index ${i}`);

        // Scroll into view within iframe
        await sections.nth(i).scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);

        // Get coordinates for clicking in main frame
        const secBox = await sections.nth(i).boundingBox();
        const iframeEl = page.locator('#sqs-site-frame');
        const iframeBox = await iframeEl.boundingBox();

        if (secBox && iframeBox) {
          const absX = iframeBox.x + secBox.x + secBox.width / 2;
          const absY = iframeBox.y + secBox.y + 30;
          await page.mouse.click(absX, absY);
          await page.waitForTimeout(2000);
          await takeScreenshot(page, 'task-a-test-section-clicked');

          // After clicking a section in edit mode, a toolbar appears
          // Look for a delete/trash button in the toolbar area
          // The toolbar is typically a floating bar near the selected section
          // Let's enumerate ALL visible buttons to find the delete one
          const allBtns = page.locator('button');
          const btnCount = await allBtns.count();
          const toolbarBtns: { index: number; text: string; aria: string; dataTest: string; y: number }[] = [];

          for (let b = 0; b < btnCount; b++) {
            const btn = allBtns.nth(b);
            const vis = await btn.isVisible().catch(() => false);
            if (!vis) continue;
            const ariaLabel = await btn.getAttribute('aria-label').catch(() => '') || '';
            const dataTest = await btn.getAttribute('data-test').catch(() => '') || '';
            const btnText = await btn.innerText().catch(() => '');
            const box = await btn.boundingBox().catch(() => null);
            if (box) {
              toolbarBtns.push({ index: b, text: btnText.trim(), aria: ariaLabel, dataTest, y: box.y });
            }
          }

          // Sort by Y position and show what's near the section
          const sectionAbsY = iframeBox.y + secBox.y;
          const nearbyBtns = toolbarBtns
            .filter(b => Math.abs(b.y - sectionAbsY) < 200 || b.aria.toLowerCase().includes('delete') || b.dataTest.includes('delete'))
            .slice(0, 20);

          console.log(`  Nearby/relevant buttons (${nearbyBtns.length}):`);
          nearbyBtns.forEach(b => {
            console.log(`    [${b.index}] y=${b.y.toFixed(0)} text="${b.text.substring(0, 30)}" aria="${b.aria}" data-test="${b.dataTest}"`);
          });

          // Try known selectors for section delete
          const deleteSelectors = [
            'button[aria-label="Delete section"]',
            'button[aria-label="Delete Section"]',
            'button[aria-label="Remove section"]',
            'button[data-test="section-action-delete"]',
            'button[data-test="delete-section"]',
            'button[data-test="section-delete"]',
            // Squarespace uses a trash icon — may have no text/aria
          ];

          for (const sel of deleteSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
              await btn.click();
              console.log(`  Clicked delete via ${sel}`);
              await page.waitForTimeout(1500);

              const confirm = page.locator('button:has-text("Confirm"), button:has-text("Delete"), button:has-text("Yes"), button:has-text("Remove")').first();
              if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
                await confirm.click();
                testSectionDeleted = true;
                console.log('  ✅ Deleted "Test Title" section');
              }
              break;
            }
          }

          if (!testSectionDeleted) {
            // Try: the section toolbar may have an icon-only button
            // Look for SVG trash icon or similar
            console.log('  Trying keyboard shortcut (Delete/Backspace)...');
            await page.keyboard.press('Delete');
            await page.waitForTimeout(1500);
            const confirm = page.locator('button:has-text("Confirm"), button:has-text("Delete"), button:has-text("Remove")').first();
            if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
              await confirm.click();
              testSectionDeleted = true;
              console.log('  ✅ Deleted via keyboard');
            }
          }

          if (!testSectionDeleted) {
            console.log('  ⚠️ Could not auto-delete — will skip');
            await takeScreenshot(page, 'task-a-could-not-delete');
          }
        }
        break;
      }
    }

    if (!testSectionDeleted) {
      // Check if it's already gone
      const freshSec = iframe.locator('section.page-section[data-section-id]');
      const freshCount = await freshSec.count();
      let found = false;
      for (let i = 0; i < freshCount; i++) {
        const text = await freshSec.nth(i).innerText().catch(() => '');
        if (text.includes('Test Title')) { found = true; break; }
      }
      if (!found) console.log('  "Test Title" section not found (already removed?)');
    }

    // Save
    const saveBtn = page.locator('button:has-text("SAVE")').first();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
      console.log('  Saved');
    }

    // ═══════════════════════════════════════════════════════════
    // Task B: Add "Menu Formatter" section
    // ═══════════════════════════════════════════════════════════
    console.log(`\n══ Task B: Add "${MENU_BLOCK_PROJECT.title}" section ══`);

    // Re-navigate fresh
    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);

    // Enter edit mode
    const editBtn2 = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
    if (await editBtn2.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn2.click();
      await page.waitForTimeout(3000);
      console.log('  Entered edit mode');
    }

    // Step 1: Add a new blank section
    console.log('  Step 1: Adding new section...');
    const addResult = await executeAgentAction(page, { action: 'addSection' });
    console.log(`    ${addResult.success ? '✅' : '❌'} ${addResult.message}`);

    if (addResult.success) {
      await page.waitForTimeout(2000);
      await takeScreenshot(page, 'task-b-section-added');

      // Step 2: Enter the new section's edit mode
      // The new section should be the last content section (before footer)
      // Try using sectionIndex with a high number, or search for blank section
      console.log('  Step 2: Entering new section edit mode...');

      // After addSection, we might already be in the section
      // Check if "ADD BLOCK" is visible (sign we're in edit mode)
      const addBlockVisible = await page.locator('button:has-text("ADD BLOCK")').first()
        .isVisible({ timeout: 3000 }).catch(() => false);

      let inEditMode = addBlockVisible;
      if (!inEditMode) {
        // Try entering the last section
        const freshSecs = iframe.locator('section.page-section[data-section-id]');
        const freshCount = await freshSecs.count();
        console.log(`    Sections: ${freshCount}, trying last content section...`);

        // The new section should be the one with least content
        const enterResult = await executeAgentAction(page, {
          action: 'enterSectionEditMode',
          sectionIndex: freshCount - 1, // Last section
        });
        console.log(`    ${enterResult.success ? '✅' : '❌'} ${enterResult.message}`);
        inEditMode = enterResult.success;
      } else {
        console.log('    Already in section edit mode (ADD BLOCK visible)');
      }

      if (inEditMode) {
        // Step 3: Add image block
        console.log(`  Step 3: Adding image (${MENU_BLOCK_PROJECT.screenshotPath})...`);
        const imgResult = await executeAgentAction(page, {
          action: 'addImageBlock',
          imagePath: MENU_BLOCK_PROJECT.screenshotPath,
          altText: `${MENU_BLOCK_PROJECT.title} screenshot`,
        });
        console.log(`    ${imgResult.success ? '✅' : '❌'} ${imgResult.message}`);
        await takeScreenshot(page, 'task-b-image-added');

        // Step 4: Add title text
        console.log(`  Step 4: Adding title "${MENU_BLOCK_PROJECT.title}"...`);
        const titleResult = await executeAgentAction(page, {
          action: 'addBlockToSection',
          blockType: 'Text',
          content: MENU_BLOCK_PROJECT.title,
        });
        console.log(`    ${titleResult.success ? '✅' : '❌'} ${titleResult.message}`);

        // Step 5: Add description text
        console.log(`  Step 5: Adding description...`);
        const descResult = await executeAgentAction(page, {
          action: 'addBlockToSection',
          blockType: 'Text',
          content: MENU_BLOCK_PROJECT.description,
        });
        console.log(`    ${descResult.success ? '✅' : '❌'} ${descResult.message}`);

        // Step 6: Add button
        console.log(`  Step 6: Adding button...`);
        const btnResult = await executeAgentAction(page, {
          action: 'addBlockToSection',
          blockType: 'Button',
        });
        console.log(`    ${btnResult.success ? '✅' : '❌'} ${btnResult.message}`);

        // Step 7: Set button text and URL
        if (btnResult.success) {
          await page.waitForTimeout(1000);
          console.log(`  Step 7: Setting button URL → ${MENU_BLOCK_PROJECT.url}`);
          const editBtnResult = await executeAgentAction(page, {
            action: 'editButtonBlock',
            searchText: 'Button',
            newLabel: 'View Project',
            url: MENU_BLOCK_PROJECT.url,
          });
          console.log(`    ${editBtnResult.success ? '✅' : '❌'} ${editBtnResult.message}`);
        }

        await takeScreenshot(page, 'task-b-complete');
      }

      // Save
      const saveResult = await executeAgentAction(page, { action: 'saveChanges' });
      console.log(`  Save: ${saveResult.success ? '✅' : '❌'} ${saveResult.message}`);
    }

    // ═══════════════════════════════════════════════════════════
    // Task C: Add screenshot to PoolTogether Explorer
    // ═══════════════════════════════════════════════════════════
    console.log('\n══ Task C: Add screenshot to PoolTogether Explorer ══');

    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const editBtn3 = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
    if (await editBtn3.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn3.click();
      await page.waitForTimeout(3000);
      console.log('  Entered edit mode');
    }

    console.log('  Entering PoolTogether Explorer section...');
    const enterPT = await executeAgentAction(page, {
      action: 'enterSectionEditMode',
      searchText: 'PoolTogether Explorer',
    });
    console.log(`  ${enterPT.success ? '✅' : '❌'} ${enterPT.message}`);

    if (enterPT.success) {
      console.log(`  Adding image (${PT_SCREENSHOT_PATH})...`);
      const imgResult = await executeAgentAction(page, {
        action: 'addImageBlock',
        imagePath: PT_SCREENSHOT_PATH,
        altText: 'PoolTogether Explorer screenshot',
      });
      console.log(`  ${imgResult.success ? '✅' : '❌'} ${imgResult.message}`);
    }

    const saveResult3 = await executeAgentAction(page, { action: 'saveChanges' });
    console.log(`  Save: ${saveResult3.success ? '✅' : '❌'} ${saveResult3.message}`);

    // ═══════════════════════════════════════════════════════════
    // Final verification
    // ═══════════════════════════════════════════════════════════
    console.log('\n══ Final Verification ══');
    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'coding-projects-final-top');

    // Scroll down to see all sections
    const finalIframe = page.frameLocator('#sqs-site-frame');
    const finalSections = finalIframe.locator('section.page-section[data-section-id]');
    const finalCount = await finalSections.count();
    console.log(`\nFinal sections: ${finalCount}`);
    for (let i = 0; i < finalCount; i++) {
      const text = await finalSections.nth(i).innerText().catch(() => '');
      const hasImg = await finalSections.nth(i).locator('img').count() > 0;
      const hasBtn = await finalSections.nth(i).locator('a[class*="button"], .sqs-block-button-element').count() > 0;
      const preview = text.trim().substring(0, 50).replace(/\n/g, ' | ');
      console.log(`  [${i}] ${hasImg ? '🖼️' : '  '} ${hasBtn ? '🔘' : '  '} "${preview}"`);
    }

  } catch (err) {
    console.error('Fatal error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
