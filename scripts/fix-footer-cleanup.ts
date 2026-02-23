/**
 * Cleanup: Remove content accidentally added to the footer section,
 * then add Menu Formatter content as a proper page section.
 *
 * The footer (index 10, id: 64496f98) accidentally got the Menu Formatter
 * content. We need to:
 * 1. Enter footer edit mode and delete all blocks added there
 * 2. Then use addSection to create a PROPER content section (which goes
 *    before the footer) and add content there
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
 * Scroll a section into the viewport, then click/double-click to enter edit mode.
 */
async function scrollAndEnterEditMode(page: any, sectionId: string): Promise<boolean> {
  const iframe = page.frameLocator('#sqs-site-frame');
  const sec = iframe.locator(`section.page-section[data-section-id="${sectionId}"]`);

  await sec.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const secBox = await sec.boundingBox().catch(() => null);
  if (!secBox) {
    console.log('    ❌ Could not get section bounding box');
    return false;
  }

  const cx = secBox.x + secBox.width / 2;
  const cy = secBox.y + Math.min(secBox.height / 2, 200);
  console.log(`    Click target: (${cx.toFixed(0)}, ${cy.toFixed(0)})`);

  // Single click
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(1500);

  // Check for "EDIT SECTION" button
  const editSectionBtn = page.getByRole('button', { name: /edit section/i });
  if (await editSectionBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await editSectionBtn.first().click();
    await page.waitForTimeout(2000);
    const addBlock = page.getByRole('button', { name: /add block/i });
    if (await addBlock.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('    ✅ In edit mode (via Edit Section)');
      return true;
    }
  }

  // Double-click
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(2000);
  const addBlock = page.getByRole('button', { name: /add block/i });
  if (await addBlock.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('    ✅ In edit mode (via double-click)');
    return true;
  }

  // Second attempt with Edit Section
  if (await editSectionBtn.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    await editSectionBtn.first().click();
    await page.waitForTimeout(2000);
    if (await addBlock.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('    ✅ In edit mode (Edit Section after dblclick)');
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
    // STEP 1: Diagnose — list all sections and their content
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══ Diagnosing Current State ═══\n');

    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const editBtn = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
    if (await editBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(3000);
    }

    const iframe = page.frameLocator('#sqs-site-frame');
    const allSecs = iframe.locator('section.page-section[data-section-id]');
    const secCount = await allSecs.count();
    console.log(`Total sections: ${secCount}\n`);

    // Identify the footer section and any sections with our accidentally-added content
    let footerSectionId = '';
    const sectionInfo: { index: number; id: string; text: string; isFooter: boolean; hasMenuContent: boolean }[] = [];

    for (let i = 0; i < secCount; i++) {
      const sec = allSecs.nth(i);
      const secId = await sec.getAttribute('data-section-id').catch(() => '') || '';
      const text = (await sec.innerText().catch(() => '')).trim();
      const isFooter = await sec.locator('[data-test="footer"], footer, [class*="footer" i]').count() > 0
        || await sec.evaluate((el: Element) => el.className.includes('footer') || el.id.includes('footer')).catch(() => false);
      const hasMenuContent = text.includes('Menu Formatter');

      const info = {
        index: i,
        id: secId,
        text: text.substring(0, 100),
        isFooter,
        hasMenuContent,
      };
      sectionInfo.push(info);

      if (i >= secCount - 3 || hasMenuContent || isFooter) {
        console.log(`  Section ${i} (${secId.substring(0, 12)}): footer=${isFooter} menuContent=${hasMenuContent}`);
        console.log(`    text: "${text.substring(0, 120)}"`);
      }
    }

    // The footer is typically the LAST section
    // id: 64496f98 was identified as empty → that's likely the footer
    const footerCandidates = sectionInfo.filter(s => s.id.startsWith('64496f98'));
    if (footerCandidates.length > 0) {
      footerSectionId = footerCandidates[0].id;
      console.log(`\n  Footer section: index ${footerCandidates[0].index} (id: ${footerSectionId.substring(0, 12)})`);
    }

    // Also check: which sections have Menu Formatter content that shouldn't be there?
    const menuContentSections = sectionInfo.filter(s => s.hasMenuContent);
    console.log(`\n  Sections with Menu Formatter content: ${menuContentSections.length}`);
    menuContentSections.forEach(s => {
      console.log(`    Section ${s.index} (${s.id.substring(0, 12)}): "${s.text.substring(0, 80)}"`);
    });

    // ═══════════════════════════════════════════════════════════
    // STEP 2: Clean up footer — remove any blocks we added
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══ Cleaning Footer ═══\n');

    // We need to enter the footer section and delete all blocks
    // The footer section is at the end of the page
    if (footerSectionId) {
      console.log(`Entering footer section edit mode (${footerSectionId.substring(0, 12)})...`);
      const footerEdit = await scrollAndEnterEditMode(page, footerSectionId);

      if (footerEdit) {
        console.log('In footer edit mode — selecting and deleting all blocks...');

        // Select all blocks with Cmd+A, then delete
        await page.keyboard.press('Meta+a');
        await page.waitForTimeout(500);
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(1000);

        // Check for confirmation dialog
        const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Delete"), button:has-text("Yes")');
        if (await confirmBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirmBtn.first().click();
          console.log('  Confirmed block deletion');
          await page.waitForTimeout(1500);
        }

        // Click outside to deselect
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        console.log('  ✅ Footer cleanup attempted');
        results.push({ task: 'cleanFooter', success: true, msg: 'Attempted block deletion in footer' });
      } else {
        console.log('  ❌ Could not enter footer edit mode');
        results.push({ task: 'cleanFooter', success: false, msg: 'Could not enter footer edit mode' });
      }

      // Save after footer cleanup
      console.log('Saving footer cleanup...');
      const saveFooter = await executeAgentAction(page, { action: 'saveChanges' });
      console.log(`  ${saveFooter.success ? '✅' : '❌'} ${saveFooter.message}`);
    }

    // Also check if there are extra empty sections from failed addSection calls
    // and clean those up too
    console.log('\n═══ Checking for extra empty sections from previous runs ═══\n');

    // Reload page to see fresh state
    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    if (await editBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(3000);
    }

    const allSecs2 = iframe.locator('section.page-section[data-section-id]');
    const secCount2 = await allSecs2.count();
    console.log(`Sections after footer cleanup: ${secCount2}`);

    for (let i = 0; i < secCount2; i++) {
      const sec = allSecs2.nth(i);
      const secId = await sec.getAttribute('data-section-id').catch(() => '') || '';
      const text = (await sec.innerText().catch(() => '')).trim();
      const imgCount = await sec.locator('img').count();
      console.log(`  [${i}] (${secId.substring(0, 12)}): text="${text.substring(0, 60)}" imgs=${imgCount}`);
    }

    await takeScreenshot(page, 'after-footer-cleanup');

    // ═══════════════════════════════════════════════════════════
    // STEP 3: Add Menu Formatter as a proper section
    // The addSection compound action creates a section BEFORE the footer,
    // so we need to make sure we work with the right one.
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══ Adding Menu Formatter as Proper Section ═══\n');

    // Use addSection — it should create a content section before the footer
    console.log('Step 1: addSection');
    const r1 = await executeAgentAction(page, { action: 'addSection' });
    console.log(`  ${r1.success ? '✅' : '❌'} ${r1.message}`);
    results.push({ task: 'addSection', success: r1.success, msg: r1.message });

    if (!r1.success) {
      console.log('  ABORT: Could not add section');
    } else {
      await page.waitForTimeout(2000);

      // Parse the new section ID from the message
      const idMatch = r1.message.match(/data-section-id: ([a-f0-9]+)/);
      const indexMatch = r1.message.match(/index (\d+)/);
      const newSectionId = idMatch ? idMatch[1] : '';
      const newSectionIndex = indexMatch ? parseInt(indexMatch[1]) : -1;
      console.log(`  New section: index=${newSectionIndex}, id=${newSectionId.substring(0, 12)}`);

      // Verify this is NOT the footer
      if (newSectionId === footerSectionId || newSectionId.startsWith('64496f98')) {
        console.log('  ⚠️ WARNING: New section appears to be the footer! Aborting.');
        results.push({ task: 'sectionValidation', success: false, msg: 'New section is the footer' });
      } else {
        console.log(`  ✅ New section is NOT the footer`);

        // Check if we're already in edit mode from addSection
        const addBlockVisible = await page.getByRole('button', { name: /add block/i })
          .first().isVisible({ timeout: 3000 }).catch(() => false);

        let inEditMode = addBlockVisible;
        if (!inEditMode && newSectionId) {
          console.log('  Re-entering edit mode...');
          inEditMode = await scrollAndEnterEditMode(page, newSectionId);
        }

        if (inEditMode) {
          // Add image
          console.log('\nStep 2: addImageBlock');
          const imgR = await executeAgentAction(page, {
            action: 'addImageBlock',
            imagePath: MENU_BLOCK.screenshotPath,
            altText: `${MENU_BLOCK.title} screenshot`,
          });
          console.log(`  ${imgR.success ? '✅' : '❌'} ${imgR.message}`);
          results.push({ task: 'addImage', success: imgR.success, msg: imgR.message });
          await page.waitForTimeout(2000);

          // Re-enter for title
          console.log('\nStep 3: Re-enter + add title');
          if (await scrollAndEnterEditMode(page, newSectionId)) {
            const titleR = await executeAgentAction(page, {
              action: 'addBlockToSection',
              blockType: 'Text',
              content: MENU_BLOCK.title,
            });
            console.log(`  ${titleR.success ? '✅' : '❌'} ${titleR.message}`);
            results.push({ task: 'addTitle', success: titleR.success, msg: titleR.message });
          }
          await page.waitForTimeout(2000);

          // Re-enter for description
          console.log('\nStep 4: Re-enter + add description');
          if (await scrollAndEnterEditMode(page, newSectionId)) {
            const descR = await executeAgentAction(page, {
              action: 'addBlockToSection',
              blockType: 'Text',
              content: MENU_BLOCK.description,
            });
            console.log(`  ${descR.success ? '✅' : '❌'} ${descR.message}`);
            results.push({ task: 'addDescription', success: descR.success, msg: descR.message });
          }
          await page.waitForTimeout(2000);

          // Re-enter for button
          console.log('\nStep 5: Re-enter + add button');
          if (await scrollAndEnterEditMode(page, newSectionId)) {
            const btnR = await executeAgentAction(page, {
              action: 'addBlockToSection',
              blockType: 'Button',
            });
            console.log(`  ${btnR.success ? '✅' : '❌'} ${btnR.message}`);
            results.push({ task: 'addButton', success: btnR.success, msg: btnR.message });

            if (btnR.success) {
              await page.waitForTimeout(2000);
              // Re-enter for button edit
              console.log('\nStep 6: Re-enter + edit button');
              if (await scrollAndEnterEditMode(page, newSectionId)) {
                const editR = await executeAgentAction(page, {
                  action: 'editButtonBlock',
                  searchText: 'Button',
                  newLabel: 'View Project',
                  url: MENU_BLOCK.url,
                });
                console.log(`  ${editR.success ? '✅' : '❌'} ${editR.message}`);
                results.push({ task: 'editButton', success: editR.success, msg: editR.message });
              }
            }
          }
        } else {
          console.log('  ❌ Could not enter edit mode for new section');
          results.push({ task: 'enterEditMode', success: false, msg: 'Failed' });
        }
      }
    }

    // Save
    console.log('\nSaving...');
    const saveR = await executeAgentAction(page, { action: 'saveChanges' });
    console.log(`  ${saveR.success ? '✅' : '❌'} ${saveR.message}`);
    await takeScreenshot(page, 'menu-block-final');

    // ═══════════════════════════════════════════════════════════
    // Task 3: Add screenshot to PoolTogether Explorer
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
    const secCount3 = await secs2.count();
    let ptSectionId = '';
    for (let i = 0; i < secCount3; i++) {
      const text = await secs2.nth(i).innerText().catch(() => '');
      if (text.includes('PoolTogether Explorer')) {
        ptSectionId = await secs2.nth(i).getAttribute('data-section-id').catch(() => '') || '';
        console.log(`  Found PT Explorer at index ${i} (id: ${ptSectionId.substring(0, 12)})`);
        break;
      }
    }

    if (!ptSectionId) {
      console.log('  ❌ PoolTogether Explorer section not found');
      results.push({ task: 'PT-find', success: false, msg: 'Not found' });
    } else {
      console.log('Step 1: Enter edit mode');
      const ptEdit = await scrollAndEnterEditMode(page, ptSectionId);
      results.push({ task: 'PT-enterEdit', success: ptEdit, msg: ptEdit ? 'Success' : 'Failed' });

      if (ptEdit) {
        console.log('Step 2: addImageBlock');
        const ptImg = await executeAgentAction(page, {
          action: 'addImageBlock',
          imagePath: PT_SCREENSHOT,
          altText: 'PoolTogether Explorer screenshot',
        });
        console.log(`  ${ptImg.success ? '✅' : '❌'} ${ptImg.message}`);
        results.push({ task: 'PT-addImage', success: ptImg.success, msg: ptImg.message });

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
