/**
 * Test: Button URL editing automation pattern.
 *
 * 1. Create a blank test page "Button Test" (slug: button-test)
 * 2. Add a section with a Button block
 * 3. Set the button's label to "Visit Site"
 * 4. Set the button's URL to "https://example.com"
 * 5. Verify both label and URL were set correctly
 * 6. Save changes
 * 7. Cleanup — delete the test page
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import {
  getSiteFrame,
  clickThroughOverlay,
  saveChanges,
} from '../src/automation/editor-actions.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const SITE_URL = 'https://tim-cox.squarespace.com';
const PAGE_TITLE = 'Button Test';

async function main() {
  const bm = getBrowserManager({ headless: false });
  let pageCreated = false;
  let buttonAdded = false;
  let labelSet = false;
  let urlSet = false;
  let labelVerified = false;
  let urlVerified = false;
  let labelSelector = '';
  let urlSelector = '';
  const screenshots: string[] = [];

  async function screenshot(page: any, name: string) {
    const path = await takeScreenshot(page, name);
    if (path) screenshots.push(name);
    return path;
  }

  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: Create a new blank test page
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n========== PHASE 1: Create test page ==========');

    await page.goto(`${SITE_URL}/config/pages`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);
    await screenshot(page, 'btn-test-01-pages-panel');

    // Hover over "Main Navigation" to reveal the + button
    const mainNavHeader = page.locator('text=Main Navigation').first();
    if (await mainNavHeader.isVisible({ timeout: 5000 }).catch(() => false)) {
      await mainNavHeader.hover();
      await page.waitForTimeout(800);
      console.log('Hovered over Main Navigation');
    } else {
      console.log('Main Navigation header not found — trying alternative');
      // Try "NOT LINKED" or other sections
      const notLinked = page.locator('text=Not Linked').first();
      if (await notLinked.isVisible({ timeout: 3000 }).catch(() => false)) {
        await notLinked.hover();
        await page.waitForTimeout(800);
        console.log('Hovered over Not Linked');
      }
    }

    // Click the "Add page" button
    const addPageSelectors = [
      'button[aria-label="Add page"]',
      'button[aria-label="Add Page"]',
      'button[aria-label="Add page to Main Navigation"]',
      '[data-test="add-page"]',
    ];

    let addPageClicked = false;
    for (const sel of addPageSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        addPageClicked = true;
        console.log(`Clicked add page via: ${sel}`);
        break;
      }
    }

    if (!addPageClicked) {
      // Fallback: find any + button near "Main Navigation"
      const plusBtns = page.locator('button svg, button:has(svg)');
      const count = await plusBtns.count();
      console.log(`Found ${count} buttons with SVG icons`);
      // Try to find the add button by its position near Main Navigation
      for (let i = 0; i < count; i++) {
        const btn = plusBtns.nth(i);
        const text = await btn.textContent().catch(() => '');
        const label = await btn.getAttribute('aria-label').catch(() => '');
        if (
          label?.toLowerCase().includes('add') ||
          text?.includes('+')
        ) {
          await btn.click();
          addPageClicked = true;
          console.log(`Clicked add page via button ${i}: label="${label}"`);
          break;
        }
      }
    }

    if (!addPageClicked) {
      throw new Error('Could not find Add Page button');
    }

    await page.waitForTimeout(2000);
    await screenshot(page, 'btn-test-02-add-page-dialog');

    // Click "Blank" template
    const blankBtn = page.locator('button:has-text("Blank")').first();
    if (await blankBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await blankBtn.click();
      console.log('Clicked Blank template');
    } else {
      // Try other patterns for blank page selection
      const blankSelectors = [
        'text=Blank',
        '[data-test="blank-page"]',
        'button:has-text("Blank Page")',
      ];
      for (const sel of blankSelectors) {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          await el.click();
          console.log(`Clicked blank via: ${sel}`);
          break;
        }
      }
    }

    await page.waitForTimeout(2000);
    await screenshot(page, 'btn-test-03-blank-selected');

    // Fill in the page title
    const titleSelectors = [
      'input[placeholder*="Page Title"]',
      'input[placeholder*="Title"]',
      'input[placeholder*="page title"]',
      'input[placeholder*="title"]',
      'input[data-test="page-title"]',
    ];

    let titleFilled = false;
    for (const sel of titleSelectors) {
      const inp = page.locator(sel).first();
      if (await inp.isVisible({ timeout: 2000 }).catch(() => false)) {
        await inp.click();
        await inp.fill(PAGE_TITLE);
        await page.waitForTimeout(300);
        titleFilled = true;
        console.log(`Title filled via: ${sel}`);
        break;
      }
    }

    if (!titleFilled) {
      // The title field might already be focused, or it might be an editable div
      console.log('Standard title input not found — scanning all inputs');
      const allInputs = page.locator('input[type="text"], input:not([type])');
      const inputCount = await allInputs.count();
      for (let i = 0; i < inputCount; i++) {
        const inp = allInputs.nth(i);
        const vis = await inp.isVisible().catch(() => false);
        if (vis) {
          const placeholder = await inp.getAttribute('placeholder').catch(() => '');
          const val = await inp.inputValue().catch(() => '');
          console.log(`  Input ${i}: placeholder="${placeholder}" value="${val}"`);
          if (!val || placeholder?.toLowerCase().includes('title') || placeholder?.toLowerCase().includes('name')) {
            await inp.click();
            await inp.fill(PAGE_TITLE);
            titleFilled = true;
            console.log(`  -> Filled title in input ${i}`);
            break;
          }
        }
      }
    }

    // Press Enter or click Save/Done to create the page
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    await screenshot(page, 'btn-test-04-page-created');
    pageCreated = true;
    console.log('Page created (or creation triggered)');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2: Navigate to the new page and enter edit mode
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n========== PHASE 2: Navigate & enter edit mode ==========');

    // The page might already be showing after creation, or we need to click it
    // Try clicking "Button Test" in the pages panel
    await page.waitForTimeout(2000);

    // Check if we need to navigate back to pages panel
    const currentUrl = page.url();
    if (!currentUrl.includes('button-test') && !currentUrl.includes('Button')) {
      // Try to find and click the page in the list
      const pageItem = page.locator(`text=${PAGE_TITLE}`).first();
      if (await pageItem.isVisible({ timeout: 5000 }).catch(() => false)) {
        await pageItem.click();
        console.log('Clicked Button Test in pages list');
        await page.waitForTimeout(4000);
      } else {
        // Navigate directly
        await page.goto(`${SITE_URL}/config/pages`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await page.waitForTimeout(4000);

        // Click via JS evaluation for reliability
        const clicked = await page.evaluate((title: string) => {
          const items = document.querySelectorAll('[data-test="pages-panel-item"]');
          for (const item of items) {
            if (item.textContent?.toLowerCase().includes(title.toLowerCase())) {
              (item as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, PAGE_TITLE);
        console.log(`Clicked page via JS: ${clicked}`);
        await page.waitForTimeout(4000);
      }
    }

    await screenshot(page, 'btn-test-05-on-page');

    // Enter edit mode
    await enterEditMode(page);
    await page.waitForTimeout(3000);
    await screenshot(page, 'btn-test-06-edit-mode');
    console.log('Edit mode entered');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 3: Add a section, then add a Button block
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n========== PHASE 3: Add section + Button block ==========');

    // Add a new section
    console.log('--- Adding section ---');
    const addSectionResult = await executeAgentAction(page, { action: 'addSection' });
    console.log(`addSection: ${addSectionResult.success ? 'OK' : 'FAIL'} — ${addSectionResult.message?.substring(0, 120)}`);
    await page.waitForTimeout(1500);
    await screenshot(page, 'btn-test-07-section-added');

    if (!addSectionResult.success) {
      console.log('Section add failed — trying manual approach');
      // The blank page might already have a section. Try entering section edit mode.
      const sf = getSiteFrame(page);
      if (sf) {
        const sectionCount = await sf.locator('.page-section').count().catch(() => 0);
        console.log(`Existing sections: ${sectionCount}`);
        if (sectionCount > 0) {
          // Click the first section
          const firstSection = sf.locator('.page-section').first();
          const box = await firstSection.boundingBox().catch(() => null);
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(1000);
          }
        }
      }
    }

    // Enter section edit mode
    console.log('--- Entering section edit mode ---');
    const editSectionResult = await executeAgentAction(page, {
      action: 'enterSectionEditMode',
      sectionIndex: 'last',
    });
    console.log(`enterSectionEditMode: ${editSectionResult.success ? 'OK' : 'FAIL'} — ${editSectionResult.message?.substring(0, 120)}`);
    await page.waitForTimeout(1500);
    await screenshot(page, 'btn-test-08-section-edit-mode');

    // Check if we're in section edit mode (ADD BLOCK visible)
    const addBlockVisible = await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`ADD BLOCK visible: ${addBlockVisible}`);

    if (!addBlockVisible) {
      // Try clicking EDIT SECTION / EDIT CONTENT manually
      const editBtnSelectors = [
        'button:has-text("EDIT SECTION")',
        'button:has-text("EDIT CONTENT")',
        'button:has-text("Edit Section")',
        'button:has-text("Edit Content")',
      ];
      for (const sel of editBtnSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          console.log(`Clicked: ${sel}`);
          await page.waitForTimeout(1500);
          break;
        }
      }
    }

    // Add Button block using addBlockToSection
    console.log('--- Adding Button block ---');
    const addBlockResult = await executeAgentAction(page, {
      action: 'addBlockToSection',
      blockType: 'Button',
    });
    console.log(`addBlockToSection(Button): ${addBlockResult.success ? 'OK' : 'FAIL'} — ${addBlockResult.message?.substring(0, 120)}`);
    await page.waitForTimeout(2000);
    await screenshot(page, 'btn-test-09-button-added');

    if (addBlockResult.success) {
      buttonAdded = true;
      console.log('Button block added successfully');
    } else {
      console.log('addBlockToSection failed, attempting manual button block addition');

      // Manual fallback: click ADD BLOCK and select Button
      const addBlockBtn = page.getByRole('button', { name: /add block/i }).first();
      if (await addBlockBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await addBlockBtn.click();
        await page.waitForTimeout(1500);

        // Search for "Button" in block picker
        const searchInput = page.locator('input[placeholder*="Search"]').first();
        if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await searchInput.fill('Button');
          await page.waitForTimeout(800);
        }

        // Click Button tile in the picker (renders in iframe)
        const frame = page.frame({ name: 'sqs-site-frame' });
        if (frame) {
          const clicked = await frame.evaluate(() => {
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
              const text = (el as HTMLElement).innerText?.trim();
              if (text === 'Button' && el.children.length <= 3) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  (el as HTMLElement).click();
                  return true;
                }
              }
            }
            return false;
          });
          console.log(`Manual button tile click: ${clicked}`);
          if (clicked) {
            buttonAdded = true;
            await page.waitForTimeout(2000);
          }
        }
      }
      await screenshot(page, 'btn-test-09b-manual-button');
    }

    // Close any open panels before proceeding
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 4: Set button label and URL using editButtonBlock
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n========== PHASE 4: Set button label + URL ==========');

    // First, find what the default button text is
    const checkFrame = page.frame({ name: 'sqs-site-frame' });
    let defaultButtonText = 'Button';
    if (checkFrame) {
      const btnText = await checkFrame.evaluate(() => {
        const btns = document.querySelectorAll(
          '.sqs-block-button-element, .sqs-block-button a, ' +
          'a.sqs-block-button-element--medium, .sqs-block-button span'
        );
        for (const btn of btns) {
          const text = (btn as HTMLElement).innerText?.trim();
          if (text) return text;
        }
        return null;
      }).catch(() => null);
      if (btnText) {
        defaultButtonText = btnText;
        console.log(`Default button text found: "${defaultButtonText}"`);
      } else {
        console.log('Could not find default button text in iframe — using "Button"');
      }
    }

    // Use the editButtonBlock action to set label and URL
    console.log(`--- Editing button (searchText: "${defaultButtonText}") ---`);
    const editResult = await executeAgentAction(page, {
      action: 'editButtonBlock',
      searchText: defaultButtonText,
      newLabel: 'Visit Site',
      url: 'https://example.com',
    });
    console.log(`editButtonBlock: ${editResult.success ? 'OK' : 'FAIL'} — ${editResult.message}`);
    await screenshot(page, 'btn-test-10-edit-result');

    // Parse the result message to determine what succeeded
    if (editResult.message?.includes('label')) {
      labelSet = true;
      if (editResult.message.includes('label changed') || editResult.message.includes('label set')) {
        labelSelector = 'editButtonBlock (TEXT input)';
      }
    }
    if (editResult.message?.includes('URL set')) {
      urlSet = true;
      urlSelector = 'editButtonBlock (ATTACH LINK -> URL input)';
    }

    // If editButtonBlock failed entirely, try manual approach
    if (!editResult.success) {
      console.log('editButtonBlock failed — trying manual approach');

      // Click on the button block in the iframe
      const sf = getSiteFrame(page);
      if (sf) {
        const btnBlock = sf.locator('.sqs-block-button').first();
        const btnBox = await btnBlock.boundingBox().catch(() => null);

        if (btnBox) {
          // First click — select the block
          await page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
          await page.waitForTimeout(1000);
          console.log('First click on button block');

          // Second click — open editor panel
          const btnBox2 = await btnBlock.boundingBox().catch(() => null);
          if (btnBox2) {
            await page.mouse.click(btnBox2.x + btnBox2.width / 2, btnBox2.y + btnBox2.height / 2);
            await page.waitForTimeout(1500);
            console.log('Second click on button block');
          }

          await screenshot(page, 'btn-test-10b-manual-panel');

          // Check for panel
          let panelOpen = false;
          for (const sel of ['text=TEXT', 'text=LINK', 'button:has-text("ATTACH LINK")']) {
            if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
              panelOpen = true;
              console.log(`Panel detected via: ${sel}`);
              break;
            }
          }

          if (!panelOpen) {
            // Third click attempt
            const btnBox3 = await btnBlock.boundingBox().catch(() => null);
            if (btnBox3) {
              await page.mouse.click(btnBox3.x + btnBox3.width / 2, btnBox3.y + btnBox3.height / 2);
              await page.waitForTimeout(1500);
              console.log('Third click attempt');
            }
          }

          // Try to set the label manually
          const allInputs = page.locator('input[type="text"], input:not([type="search"]):not([type="hidden"]):not([type="checkbox"])');
          const inputCount = await allInputs.count();
          console.log(`Visible inputs in main frame: ${inputCount}`);
          for (let i = 0; i < inputCount; i++) {
            const inp = allInputs.nth(i);
            const vis = await inp.isVisible().catch(() => false);
            if (vis) {
              const val = await inp.inputValue().catch(() => '');
              const placeholder = await inp.getAttribute('placeholder').catch(() => '');
              console.log(`  Input ${i}: value="${val}" placeholder="${placeholder}"`);
              // If the input contains button-like text, it's likely the TEXT input
              if (val && (val.toLowerCase().includes('button') || val.toLowerCase().includes('shop') || val.toLowerCase().includes('click'))) {
                await inp.click();
                await inp.fill('Visit Site');
                await page.keyboard.press('Tab');
                await page.waitForTimeout(500);
                labelSet = true;
                labelSelector = `Manual input[${i}] value="${val}"`;
                console.log(`  -> Set label via input ${i}`);
                break;
              }
            }
          }

          // Try to set the URL manually
          const attachLink = page.locator('button:has-text("ATTACH LINK"), button:has-text("Attach Link"), button:has-text("EDIT LINK")').first();
          if (await attachLink.isVisible({ timeout: 2000 }).catch(() => false)) {
            await attachLink.click();
            await page.waitForTimeout(1000);

            const urlInputSelectors = [
              'input[placeholder*="link"]',
              'input[placeholder*="Link"]',
              'input[placeholder*="search"]',
              'input[placeholder*="Enter link"]',
              'input[placeholder*="URL"]',
              'input[placeholder*="url"]',
            ];

            for (const sel of urlInputSelectors) {
              const el = page.locator(sel).first();
              if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
                await el.click();
                await el.fill('https://example.com');
                await page.waitForTimeout(500);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(1000);
                urlSet = true;
                urlSelector = `Manual ${sel}`;
                console.log(`  -> Set URL via: ${sel}`);
                break;
              }
            }
          }

          await screenshot(page, 'btn-test-10c-manual-result');
        }
      }
    }

    // Close any open panels
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    // Click away from the block
    await page.mouse.click(600, 500);
    await page.waitForTimeout(1000);

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 5: Verify label and URL
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n========== PHASE 5: Verify ==========');

    const verifyFrame = page.frame({ name: 'sqs-site-frame' });
    if (verifyFrame) {
      // Verify label
      labelVerified = await verifyFrame.evaluate(() => {
        const buttons = document.querySelectorAll(
          '.sqs-block-button a, .sqs-block-button-element, ' +
          'a.sqs-block-button-element--medium, .sqs-block-button span'
        );
        for (const btn of buttons) {
          if ((btn as HTMLElement).innerText?.trim().includes('Visit Site')) return true;
        }
        // Also check all links
        const links = document.querySelectorAll('a');
        for (const link of links) {
          if (link.innerText?.trim().includes('Visit Site')) return true;
        }
        return false;
      }).catch(() => false);
      console.log(labelVerified ? 'PASS: Label "Visit Site" verified' : 'FAIL: Label "Visit Site" not found');

      // Verify URL
      urlVerified = await verifyFrame.evaluate(() => {
        const links = document.querySelectorAll(
          '.sqs-block-button a, a.sqs-block-button-element--medium, .sqs-block-button-element a'
        );
        for (const link of links) {
          const href = (link as HTMLAnchorElement).href || '';
          if (href.includes('example.com')) return true;
        }
        // Also check all links
        const allLinks = document.querySelectorAll('a');
        for (const link of allLinks) {
          if (link.href?.includes('example.com')) return true;
        }
        return false;
      }).catch(() => false);
      console.log(urlVerified ? 'PASS: URL "https://example.com" verified' : 'FAIL: URL not found');

      // Log all button elements for debugging
      const buttonInfo = await verifyFrame.evaluate(() => {
        const results: string[] = [];
        const btns = document.querySelectorAll(
          '.sqs-block-button a, .sqs-block-button-element, ' +
          'a.sqs-block-button-element--medium'
        );
        for (const btn of btns) {
          const text = (btn as HTMLElement).innerText?.trim();
          const href = (btn as HTMLAnchorElement).href || 'none';
          results.push(`text="${text}" href="${href}"`);
        }
        return results;
      }).catch(() => []);
      console.log('Button elements found:', buttonInfo);
    }

    await screenshot(page, 'btn-test-11-verified');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 6: Save changes
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n========== PHASE 6: Save changes ==========');
    const saveResult = await saveChanges(page);
    console.log(`Save: ${saveResult.message}`);
    await screenshot(page, 'btn-test-12-saved');

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 7: Cleanup — delete the test page
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n========== PHASE 7: Cleanup — delete test page ==========');

    // Navigate to pages panel
    await page.goto(`${SITE_URL}/config/pages`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Find and right-click "Button Test" to get the context menu, or click gear icon
    // First, find the page item
    const pageItemFound = await page.evaluate((title: string) => {
      const items = document.querySelectorAll('[data-test="pages-panel-item"]');
      for (const item of items) {
        if (item.textContent?.toLowerCase().includes(title.toLowerCase())) {
          return true;
        }
      }
      return false;
    }, PAGE_TITLE);
    console.log(`Page "${PAGE_TITLE}" found in list: ${pageItemFound}`);

    if (pageItemFound) {
      // Click the page to select it, then look for settings/gear/delete option
      const clicked = await page.evaluate((title: string) => {
        const items = document.querySelectorAll('[data-test="pages-panel-item"]');
        for (const item of items) {
          if (item.textContent?.toLowerCase().includes(title.toLowerCase())) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, PAGE_TITLE);
      console.log(`Clicked page item: ${clicked}`);
      await page.waitForTimeout(2000);

      // Look for gear/settings icon
      const gearSelectors = [
        'button[aria-label="Settings"]',
        'button[aria-label="Page Settings"]',
        'button[aria-label="settings"]',
        '[data-test="page-settings"]',
        'button svg[data-icon="gear"]',
        'button:has-text("Settings")',
      ];

      let settingsClicked = false;
      for (const sel of gearSelectors) {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click();
          settingsClicked = true;
          console.log(`Settings opened via: ${sel}`);
          break;
        }
      }

      if (!settingsClicked) {
        // Try right-clicking the page item for context menu
        const pageItemEl = page.locator(`text=${PAGE_TITLE}`).first();
        if (await pageItemEl.isVisible({ timeout: 2000 }).catch(() => false)) {
          await pageItemEl.click({ button: 'right' });
          await page.waitForTimeout(1000);
          console.log('Right-clicked page item');

          // Look for Delete option in context menu
          const deleteOpt = page.locator('text=Delete, text=Remove, button:has-text("Delete")').first();
          if (await deleteOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
            await deleteOpt.click();
            settingsClicked = true;
            console.log('Clicked Delete from context menu');
          }
        }
      }

      if (settingsClicked) {
        await page.waitForTimeout(2000);
        await screenshot(page, 'btn-test-13-settings');

        // In page settings, scroll down to find Delete/Remove option
        const deleteSelectors = [
          'button:has-text("Delete")',
          'button:has-text("DELETE")',
          'button:has-text("Delete Page")',
          'button:has-text("Remove")',
          'text=Delete',
          '[data-test="delete-page"]',
        ];

        let deleteClicked = false;
        for (const sel of deleteSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btn.click();
            deleteClicked = true;
            console.log(`Delete clicked via: ${sel}`);
            break;
          }
        }

        if (!deleteClicked) {
          // Scroll down in the settings panel to find delete
          await page.keyboard.press('End');
          await page.waitForTimeout(1000);
          for (const sel of deleteSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await btn.click();
              deleteClicked = true;
              console.log(`Delete clicked after scroll via: ${sel}`);
              break;
            }
          }
        }

        if (deleteClicked) {
          await page.waitForTimeout(1500);

          // Confirm deletion if prompted
          const confirmSelectors = [
            'button:has-text("Confirm")',
            'button:has-text("CONFIRM")',
            'button:has-text("Yes")',
            'button:has-text("Delete")',
            'button:has-text("DELETE")',
          ];

          for (const sel of confirmSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await btn.click();
              console.log(`Confirmed deletion via: ${sel}`);
              break;
            }
          }
          await page.waitForTimeout(2000);
          console.log('Page deletion complete');
        } else {
          console.log('WARNING: Could not find Delete button in settings');
        }
      } else {
        console.log('WARNING: Could not open settings for page deletion');
      }
    } else {
      console.log('WARNING: Page not found in list for cleanup');
    }

    await screenshot(page, 'btn-test-14-cleanup-done');

    // ═══════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n\n========================================');
    console.log('         TEST SUMMARY');
    console.log('========================================');
    console.log(`Page created:       ${pageCreated ? 'YES' : 'NO'}`);
    console.log(`Button added:       ${buttonAdded ? 'YES' : 'NO'}`);
    console.log(`Label set:          ${labelSet ? 'YES' : 'NO'}${labelSelector ? ` (via: ${labelSelector})` : ''}`);
    console.log(`URL set:            ${urlSet ? 'YES' : 'NO'}${urlSelector ? ` (via: ${urlSelector})` : ''}`);
    console.log(`Label verified:     ${labelVerified ? 'PASS' : 'FAIL'}`);
    console.log(`URL verified:       ${urlVerified ? 'PASS' : 'FAIL'}`);
    console.log(`Screenshots taken:  ${screenshots.length}`);
    screenshots.forEach(s => console.log(`  - ${s}`));
    console.log('========================================\n');

  } catch (err) {
    console.error('FATAL ERROR:', (err as Error).message);
    console.error((err as Error).stack);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
