/**
 * Add Menu Formatter project section to Coding Projects page.
 * Also adds missing screenshot to PoolTogether Explorer section.
 *
 * Strategy: After addImageBlock closes its panel (which exits edit mode),
 * scroll the target section into the viewport, then click on it via
 * page coordinates (iframe offset + section bounding box after scroll).
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import path from 'path';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const UPLOAD_DIR = path.resolve('storage/uploads');

const MENU_BLOCK = {
  url: 'https://menu-block.lovable.app/',
  title: 'Menu Formatter',
  description: 'Paste raw menu text and instantly get clean, Squarespace-ready formatted output. Powered by AI for fast, accurate menu formatting.',
  screenshotPath: path.join(UPLOAD_DIR, 'project-menu-block.png'),
};

const PT_SCREENSHOT = path.join(UPLOAD_DIR, 'project-pooltogether-explorer.png');

/**
 * Scroll a section into the viewport (within the iframe), then click + double-click
 * on it to enter Fluid Engine edit mode. Returns true if ADD BLOCK button appears.
 */
async function scrollAndEnterEditMode(page: any, sectionId: string): Promise<boolean> {
  const iframe = page.frameLocator('#sqs-site-frame');
  const sec = iframe.locator(`section.page-section[data-section-id="${sectionId}"]`);

  // 1. Scroll the section into view inside the iframe
  console.log(`    Scrolling section ${sectionId.substring(0, 8)}... into view`);
  await sec.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // 2. Get the iframe element's position on the page
  const iframeEl = page.locator('#sqs-site-frame');
  const iframeBox = await iframeEl.boundingBox().catch(() => null);
  if (!iframeBox) {
    console.log('    ❌ Could not get iframe bounding box');
    return false;
  }

  // 3. Get section's bounding box (after scroll, should be within viewport)
  const secBox = await sec.boundingBox().catch(() => null);
  if (!secBox) {
    console.log('    ❌ Could not get section bounding box');
    return false;
  }

  // The bounding box from a frameLocator element is already in page coordinates
  // (Playwright handles the iframe offset internally for frameLocator)
  const cx = secBox.x + secBox.width / 2;
  const cy = secBox.y + Math.min(secBox.height / 2, 200); // Click near top to avoid going below viewport
  console.log(`    Section box: x=${secBox.x.toFixed(0)} y=${secBox.y.toFixed(0)} w=${secBox.width.toFixed(0)} h=${secBox.height.toFixed(0)}`);
  console.log(`    Click target: (${cx.toFixed(0)}, ${cy.toFixed(0)})`);

  // 4. Single click to select the section
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(1500);

  // Check for "EDIT SECTION" button
  const editSectionBtn = page.getByRole('button', { name: /edit section/i });
  const editVisible = await editSectionBtn.first().isVisible({ timeout: 2000 }).catch(() => false);
  if (editVisible) {
    console.log('    Found "Edit Section" button, clicking...');
    await editSectionBtn.first().click();
    await page.waitForTimeout(2000);
    const addBlock = page.getByRole('button', { name: /add block/i });
    if (await addBlock.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('    ✅ In edit mode (via Edit Section)');
      return true;
    }
  }

  // 5. Double-click to enter edit mode directly
  console.log('    Trying double-click...');
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(2000);

  const addBlock = page.getByRole('button', { name: /add block/i });
  if (await addBlock.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('    ✅ In edit mode (via double-click)');
    return true;
  }

  // 6. Try clicking the "EDIT SECTION" button again (sometimes appears after double-click)
  const editVisible2 = await editSectionBtn.first().isVisible({ timeout: 1500 }).catch(() => false);
  if (editVisible2) {
    console.log('    Found "Edit Section" after double-click, clicking...');
    await editSectionBtn.first().click();
    await page.waitForTimeout(2000);
    if (await addBlock.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('    ✅ In edit mode (Edit Section after double-click)');
      return true;
    }
  }

  console.log('    ❌ Could not enter edit mode');
  return false;
}

async function main() {
  const bm = getBrowserManager({ headless: false });
  const results: { task: string; success: boolean; msg: string }[] = [];

  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // ═══════════════════════════════════════════════════════════
    // Task 1: Complete the Menu Formatter section
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══ Completing Menu Formatter Section ═══\n');

    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Enter page edit mode
    const editBtn = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
    if (await editBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(3000);
    }

    // First: take a diagnostic screenshot to see current state
    await takeScreenshot(page, 'diag-before-edit');

    // List all sections to find the one with just the image
    const iframe = page.frameLocator('#sqs-site-frame');
    const allSecs = iframe.locator('section.page-section[data-section-id]');
    const secCount = await allSecs.count();
    console.log(`Total sections: ${secCount}`);

    // Find the section that needs completing (has image, no title/desc)
    let menuSectionId = '';
    let menuSectionIndex = -1;
    for (let i = 0; i < secCount; i++) {
      const sec = allSecs.nth(i);
      const secId = await sec.getAttribute('data-section-id').catch(() => '') || '';
      const text = (await sec.innerText().catch(() => '')).trim();
      const imgCount = await sec.locator('img').count();

      if (text.length < 30) {
        console.log(`  Section ${i} (${secId.substring(0, 8)}): text="${text.substring(0, 50)}" imgs=${imgCount}`);
      }
    }

    // Look for sections with the menu-block image (has image from squarespace-cdn but no "Menu Formatter" text)
    for (let i = secCount - 1; i >= 0; i--) {
      const sec = allSecs.nth(i);
      const text = (await sec.innerText().catch(() => '')).trim();
      const hasSquarespaceImg = await sec.locator('img[src*="squarespace-cdn"]').count() > 0;

      // Section should have the image we uploaded but not a full project setup yet
      if (hasSquarespaceImg && text.length < 50 && !text.includes('View Project')) {
        menuSectionId = await sec.getAttribute('data-section-id').catch(() => '') || '';
        menuSectionIndex = i;
        console.log(`\n  ✅ Found incomplete section at index ${i} (${menuSectionId.substring(0, 8)})`);
        break;
      }
    }

    // Fallback: find empty sections (no image, no text)
    if (menuSectionIndex === -1) {
      for (let i = secCount - 1; i >= 0; i--) {
        const text = (await allSecs.nth(i).innerText().catch(() => '')).trim();
        if (text.length < 10) {
          menuSectionId = await allSecs.nth(i).getAttribute('data-section-id').catch(() => '') || '';
          menuSectionIndex = i;
          console.log(`\n  Using empty section at index ${i} (${menuSectionId.substring(0, 8)})`);
          break;
        }
      }
    }

    if (menuSectionIndex === -1) {
      console.log('\n❌ No suitable section found for Menu Formatter');
      results.push({ task: 'findSection', success: false, msg: 'No section found' });
    } else {
      // Enter edit mode for this section
      console.log(`\nStep 1: Enter edit mode for section ${menuSectionIndex}`);
      const inEditMode = await scrollAndEnterEditMode(page, menuSectionId);
      results.push({ task: 'enterEditMode', success: inEditMode, msg: inEditMode ? 'Success' : 'Failed' });

      if (inEditMode) {
        // Check if image is already there — if not, add it
        const hasImg = await iframe.locator(`section[data-section-id="${menuSectionId}"] img[src*="squarespace-cdn"]`).count() > 0;
        if (!hasImg) {
          console.log('\nStep 1b: Adding image (not yet present)');
          const imgR = await executeAgentAction(page, {
            action: 'addImageBlock',
            imagePath: MENU_BLOCK.screenshotPath,
            altText: `${MENU_BLOCK.title} screenshot`,
          });
          console.log(`  ${imgR.success ? '✅' : '❌'} ${imgR.message}`);
          results.push({ task: 'addImage', success: imgR.success, msg: imgR.message });
          await page.waitForTimeout(2000);

          // Re-enter edit mode after image panel closes
          console.log('\n  Re-entering edit mode after image...');
          const reEnter = await scrollAndEnterEditMode(page, menuSectionId);
          if (!reEnter) {
            console.log('  ❌ Could not re-enter edit mode after image');
            results.push({ task: 'reEnterAfterImage', success: false, msg: 'Failed' });
          }
        } else {
          console.log('  Image already present ✅');
        }

        // Add title
        const addBlockBtn = page.getByRole('button', { name: /add block/i });
        if (await addBlockBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log(`\nStep 2: addBlockToSection(Text, "${MENU_BLOCK.title}")`);
          const r2 = await executeAgentAction(page, {
            action: 'addBlockToSection',
            blockType: 'Text',
            content: MENU_BLOCK.title,
          });
          console.log(`  ${r2.success ? '✅' : '❌'} ${r2.message}`);
          results.push({ task: 'addTitle', success: r2.success, msg: r2.message });
          await page.waitForTimeout(2000);

          // Re-enter for description
          console.log('\nStep 3: Re-enter for description');
          if (await scrollAndEnterEditMode(page, menuSectionId)) {
            console.log('Step 3b: addBlockToSection(Text, description)');
            const r3 = await executeAgentAction(page, {
              action: 'addBlockToSection',
              blockType: 'Text',
              content: MENU_BLOCK.description,
            });
            console.log(`  ${r3.success ? '✅' : '❌'} ${r3.message}`);
            results.push({ task: 'addDescription', success: r3.success, msg: r3.message });
          } else {
            results.push({ task: 'addDescription', success: false, msg: 'Could not re-enter edit mode' });
          }
          await page.waitForTimeout(2000);

          // Re-enter for button
          console.log('\nStep 4: Re-enter for button');
          if (await scrollAndEnterEditMode(page, menuSectionId)) {
            console.log('Step 4b: addBlockToSection(Button)');
            const r4 = await executeAgentAction(page, {
              action: 'addBlockToSection',
              blockType: 'Button',
            });
            console.log(`  ${r4.success ? '✅' : '❌'} ${r4.message}`);
            results.push({ task: 'addButton', success: r4.success, msg: r4.message });

            if (r4.success) {
              await page.waitForTimeout(2000);
              // Re-enter for button edit
              console.log('\nStep 5: Re-enter for button edit');
              if (await scrollAndEnterEditMode(page, menuSectionId)) {
                console.log(`Step 5b: editButtonBlock → "${MENU_BLOCK.url}"`);
                const r5 = await executeAgentAction(page, {
                  action: 'editButtonBlock',
                  searchText: 'Button',
                  newLabel: 'View Project',
                  url: MENU_BLOCK.url,
                });
                console.log(`  ${r5.success ? '✅' : '❌'} ${r5.message}`);
                results.push({ task: 'editButton', success: r5.success, msg: r5.message });
              }
            }
          } else {
            results.push({ task: 'addButton', success: false, msg: 'Could not re-enter edit mode' });
          }
        } else {
          console.log('  ❌ Not in edit mode — ADD BLOCK not visible');
          results.push({ task: 'addTitle', success: false, msg: 'Not in edit mode' });
        }
      }
    }

    // Save
    console.log('\nSaving...');
    await page.waitForTimeout(1000);
    const saveR = await executeAgentAction(page, { action: 'saveChanges' });
    console.log(`  ${saveR.success ? '✅' : '❌'} ${saveR.message}`);
    await takeScreenshot(page, 'menu-block-after-task1');

    // ═══════════════════════════════════════════════════════════
    // Task 2: Add screenshot to PoolTogether Explorer
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══ Adding PoolTogether Explorer Screenshot ═══\n');

    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const editBtn2 = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
    if (await editBtn2.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn2.click();
      await page.waitForTimeout(3000);
    }

    const iframe2 = page.frameLocator('#sqs-site-frame');
    const secs2 = iframe2.locator('section.page-section[data-section-id]');
    const secCount2 = await secs2.count();
    let ptSectionId = '';
    for (let i = 0; i < secCount2; i++) {
      const text = await secs2.nth(i).innerText().catch(() => '');
      if (text.includes('PoolTogether Explorer')) {
        ptSectionId = await secs2.nth(i).getAttribute('data-section-id').catch(() => '') || '';
        console.log(`  Found PT Explorer at index ${i} (id: ${ptSectionId.substring(0, 8)})`);
        break;
      }
    }

    if (!ptSectionId) {
      console.log('  ❌ Could not find PoolTogether Explorer section');
      results.push({ task: 'PT-findSection', success: false, msg: 'Not found' });
    } else {
      console.log('Step 1: Enter edit mode');
      const ptEdit = await scrollAndEnterEditMode(page, ptSectionId);
      results.push({ task: 'PT-enterSection', success: ptEdit, msg: ptEdit ? 'Success' : 'Failed' });

      if (ptEdit) {
        console.log('Step 2: addImageBlock');
        const ptImg = await executeAgentAction(page, {
          action: 'addImageBlock',
          imagePath: PT_SCREENSHOT,
          altText: 'PoolTogether Explorer screenshot',
        });
        console.log(`  ${ptImg.success ? '✅' : '❌'} ${ptImg.message}`);
        results.push({ task: 'PT-addImage', success: ptImg.success, msg: ptImg.message });

        console.log('Saving...');
        const ptSave = await executeAgentAction(page, { action: 'saveChanges' });
        console.log(`  Save: ${ptSave.success ? '✅' : '❌'}`);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════');
    console.log('  RESULTS');
    console.log('═══════════════════════════════════');
    let allPassed = true;
    for (const r of results) {
      console.log(`  ${r.success ? '✅' : '❌'} ${r.task}: ${r.msg.substring(0, 80)}`);
      if (!r.success) allPassed = false;
    }
    console.log(`\n  Overall: ${allPassed ? '✅ ALL PASSED' : '⚠️ SOME ISSUES'}`);
    console.log('═══════════════════════════════════\n');

    // Final screenshot
    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'coding-projects-final');

  } catch (err) {
    console.error('Fatal error:', (err as Error).message);
    console.error((err as Error).stack);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
