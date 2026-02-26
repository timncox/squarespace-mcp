/**
 * Diagnostic script: investigate the Squarespace "Create Page" UI flow.
 *
 * Goal: determine whether Squarespace shows a title input during page creation,
 * or if clicking "Blank" immediately creates a page called "New Page".
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const PAGES_URL = 'https://tim-cox.squarespace.com/config/pages';

async function main() {
  const browserManager = getBrowserManager({ headless: false });

  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    // ── Navigate to pages panel ──────────────────────────────────────────
    console.log('\n=== Step 1: Navigate to pages panel ===');
    await page.goto(PAGES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Screenshot BEFORE clicking Add Page
    const shot1 = await takeScreenshot(page, 'diag-create-page-01-pages-panel');
    console.log(`Screenshot 1 (pages panel): ${shot1}`);

    // ── List current pages for comparison later ──────────────────────────
    const pagesBefore = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-test="pages-panel-item"]');
      return Array.from(items).map(el => el.textContent?.trim().substring(0, 80) || '(empty)');
    });
    console.log(`Pages before: ${JSON.stringify(pagesBefore)}`);

    // ── Hover over "Main Navigation" to reveal + button ──────────────────
    console.log('\n=== Step 2: Hover to reveal + button ===');

    // Try several possible section header texts
    const sectionHeaders = [
      'Main Navigation',
      'MAIN NAVIGATION',
      'Not Linked',
      'NOT LINKED',
    ];

    let hovered = false;
    for (const headerText of sectionHeaders) {
      const header = page.locator(`text="${headerText}"`).first();
      const vis = await header.isVisible({ timeout: 2000 }).catch(() => false);
      if (vis) {
        console.log(`  Found header: "${headerText}" — hovering`);
        await header.hover();
        await page.waitForTimeout(1000);
        hovered = true;
        break;
      }
    }

    if (!hovered) {
      // Try a broader approach: look for any section heading in the pages panel
      const anyHeader = page.locator('[class*="section-header"], [class*="SectionHeader"], [data-test*="section"]').first();
      if (await anyHeader.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log('  Hovering over a section header element');
        await anyHeader.hover();
        await page.waitForTimeout(1000);
        hovered = true;
      }
    }

    const shot2 = await takeScreenshot(page, 'diag-create-page-02-after-hover');
    console.log(`Screenshot 2 (after hover): ${shot2}`);

    // ── Look for + / "Add Page" buttons ──────────────────────────────────
    console.log('\n=== Step 3: Find and click Add Page button ===');

    const addPageSelectors = [
      'button[aria-label="Add page"]',
      'button[aria-label="Add Page"]',
      'button[aria-label="add page"]',
      '[data-test="add-page"]',
      '[data-test="pages-add-page"]',
      'button:has-text("Add Page")',
      '[class*="pages"] button[aria-label="Add"]',
      '[class*="Pages"] button:has-text("+")',
      'button[aria-label="Add"]',
      // Try any visible "+" button in the panel
      'button:has-text("+")',
    ];

    let addClicked = false;
    for (const selector of addPageSelectors) {
      try {
        const btn = page.locator(selector).first();
        const visible = await btn.isVisible({ timeout: 1500 }).catch(() => false);
        if (visible) {
          console.log(`  Found add button: ${selector}`);
          // Take screenshot showing the button before clicking
          const shot2b = await takeScreenshot(page, 'diag-create-page-02b-add-btn-visible');
          console.log(`Screenshot 2b (add button visible): ${shot2b}`);
          await btn.click({ timeout: 3000 });
          addClicked = true;
          console.log(`  Clicked!`);
          break;
        }
      } catch { /* Try next */ }
    }

    if (!addClicked) {
      console.log('  WARNING: Add page button not found by selectors — trying aria role search');
      // Brute force: look for any button with "add" in its accessible name
      const allBtns = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        return Array.from(btns).map(b => ({
          text: b.textContent?.trim().substring(0, 50),
          ariaLabel: b.getAttribute('aria-label'),
          classes: b.className?.toString().substring(0, 80),
          visible: b.offsetParent !== null,
        })).filter(b => b.visible);
      });
      console.log(`  All visible buttons:\n${JSON.stringify(allBtns, null, 2)}`);
    }

    await page.waitForTimeout(2000);

    // ── Screenshot whatever dialog/panel appears ─────────────────────────
    console.log('\n=== Step 4: Screenshot dialog/panel after clicking Add Page ===');
    const shot3 = await takeScreenshot(page, 'diag-create-page-03-after-add-click');
    console.log(`Screenshot 3 (after add page click): ${shot3}`);

    // ── Inspect what's on screen ─────────────────────────────────────────
    console.log('\n=== Step 5: Inspect visible inputs ===');
    const visibleInputs = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"]');
      return Array.from(inputs)
        .filter(el => (el as HTMLElement).offsetParent !== null)
        .map(el => ({
          tag: el.tagName,
          type: (el as HTMLInputElement).type || '',
          name: (el as HTMLInputElement).name || '',
          placeholder: (el as HTMLInputElement).placeholder || '',
          value: (el as HTMLInputElement).value?.substring(0, 100) || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          classes: el.className?.toString().substring(0, 100) || '',
          contentEditable: el.getAttribute('contenteditable'),
          id: el.id || '',
        }));
    });
    console.log(`  Visible inputs: ${JSON.stringify(visibleInputs, null, 2)}`);

    // ── Look for template options ────────────────────────────────────────
    console.log('\n=== Step 6: Look for template/layout picker ===');
    const templateKeywords = ['Blank', 'blank', 'BLANK', 'Template', 'Layout', 'Page Type'];
    for (const kw of templateKeywords) {
      const els = page.locator(`text="${kw}"`);
      const count = await els.count().catch(() => 0);
      if (count > 0) {
        const vis = await els.first().isVisible({ timeout: 1000 }).catch(() => false);
        console.log(`  "${kw}": count=${count}, firstVisible=${vis}`);
      }
    }

    // Also look for dialog/modal elements
    const dialogInfo = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"], [class*="overlay"], [class*="Overlay"], [class*="panel"], [class*="Panel"]');
      return Array.from(dialogs)
        .filter(el => (el as HTMLElement).offsetParent !== null)
        .map(el => ({
          tag: el.tagName,
          role: el.getAttribute('role'),
          classes: el.className?.toString().substring(0, 120),
          textPreview: el.textContent?.trim().substring(0, 200),
        }));
    });
    console.log(`  Visible dialogs/panels: ${JSON.stringify(dialogInfo, null, 2)}`);

    // ── If there's a "Blank" option, click it ────────────────────────────
    console.log('\n=== Step 7: Click "Add Blank" if visible ===');

    // First, dump all clickable elements inside the dialog for debugging
    const dialogClickables = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return [];
      const els = dialog.querySelectorAll('a, button, [role="button"], [tabindex], [class*="option"], [class*="Option"], [class*="item"], [class*="Item"]');
      return Array.from(els)
        .filter(el => (el as HTMLElement).offsetParent !== null)
        .map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 60),
          ariaLabel: el.getAttribute('aria-label') || '',
          role: el.getAttribute('role') || '',
          classes: el.className?.toString().substring(0, 100) || '',
          href: (el as HTMLAnchorElement).href || '',
          dataTest: el.getAttribute('data-test') || '',
        }));
    });
    console.log(`  Dialog clickable elements:\n${JSON.stringify(dialogClickables, null, 2)}`);

    // Now try to click "Add Blank" with updated selectors
    const blankSelectors = [
      // Exact match for "Add Blank" text
      'text="Add Blank"',
      'button:has-text("Add Blank")',
      'a:has-text("Add Blank")',
      '[role="dialog"] :text("Add Blank")',
      // Also try partial matches
      'button:has-text("Blank")',
      '[role="dialog"] button:has-text("Blank")',
      // Generic Blank
      'text="Blank"',
    ];

    let blankClicked = false;
    for (const selector of blankSelectors) {
      try {
        const btn = page.locator(selector).first();
        const visible = await btn.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          const btnText = await btn.textContent().catch(() => '(unknown)');
          console.log(`  Found Blank option: ${selector} — text: "${btnText}" — clicking`);
          await btn.click({ timeout: 3000 });
          blankClicked = true;
          break;
        }
      } catch (e) {
        console.log(`  Selector ${selector} error: ${e}`);
      }
    }

    if (!blankClicked) {
      console.log('  No "Blank" option found — maybe page was created immediately');
    }

    await page.waitForTimeout(2000);

    const shot4 = await takeScreenshot(page, 'diag-create-page-04-after-blank-click');
    console.log(`\nScreenshot 4 (after blank click): ${shot4}`);

    // ── Wait and take another screenshot ─────────────────────────────────
    console.log('\n=== Step 8: Wait 3 seconds and screenshot ===');
    await page.waitForTimeout(3000);

    const shot5 = await takeScreenshot(page, 'diag-create-page-05-after-wait');
    console.log(`Screenshot 5 (after wait): ${shot5}`);

    // ── Inspect current URL ──────────────────────────────────────────────
    console.log(`\n=== Current URL: ${page.url()} ===`);

    // ── Inspect ALL visible inputs again ─────────────────────────────────
    console.log('\n=== Step 9: Inspect all visible inputs (post-creation) ===');
    const inputsAfter = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"]');
      return Array.from(inputs)
        .filter(el => (el as HTMLElement).offsetParent !== null)
        .map(el => ({
          tag: el.tagName,
          type: (el as HTMLInputElement).type || '',
          name: (el as HTMLInputElement).name || '',
          placeholder: (el as HTMLInputElement).placeholder || '',
          value: (el as HTMLInputElement).value?.substring(0, 100) || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          classes: el.className?.toString().substring(0, 100) || '',
          contentEditable: el.getAttribute('contenteditable'),
          id: el.id || '',
          rect: JSON.stringify((el as HTMLElement).getBoundingClientRect()),
        }));
    });
    console.log(`  Visible inputs after: ${JSON.stringify(inputsAfter, null, 2)}`);

    // ── Check if we're on a page editor now ──────────────────────────────
    console.log('\n=== Step 10: Check for page editor elements ===');
    const editorElements = await page.evaluate(() => {
      const results: Record<string, boolean> = {};
      // Look for common editor indicators
      const selectors: Record<string, string> = {
        'iframe[title*="site"]': 'iframe[title*="site"]',
        '[class*="editor"]': '[class*="editor"]',
        '[class*="Editor"]': '[class*="Editor"]',
        '[data-test*="edit"]': '[data-test*="edit"]',
        'button:has-text("Done")': 'n/a',
        '[class*="page-title"]': '[class*="page-title"]',
        '[class*="PageTitle"]': '[class*="PageTitle"]',
      };
      for (const [label, sel] of Object.entries(selectors)) {
        if (sel === 'n/a') continue;
        const el = document.querySelector(sel);
        results[label] = el !== null && (el as HTMLElement).offsetParent !== null;
      }
      return results;
    });
    console.log(`  Editor elements: ${JSON.stringify(editorElements, null, 2)}`);

    // ── Navigate back to pages panel to see if a new page appeared ──────
    console.log('\n=== Step 11: Navigate back to pages panel ===');
    await page.goto(PAGES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const shot6 = await takeScreenshot(page, 'diag-create-page-06-pages-after');
    console.log(`Screenshot 6 (pages panel after): ${shot6}`);

    const pagesAfter = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-test="pages-panel-item"]');
      return Array.from(items).map(el => el.textContent?.trim().substring(0, 80) || '(empty)');
    });
    console.log(`Pages after: ${JSON.stringify(pagesAfter)}`);

    // Compare
    const newPages = pagesAfter.filter(p => !pagesBefore.includes(p));
    console.log(`\n=== NEW PAGES CREATED: ${JSON.stringify(newPages)} ===`);

    // ── Look for the new page and check its settings ─────────────────────
    // Even if no "new" pages detected by name comparison, look for "New Page" entries
    const pagesToCheck = newPages.length > 0 ? newPages : ['New Page'];
    console.log(`\n=== Step 12: Check page settings for rename option (checking: ${JSON.stringify(pagesToCheck)}) ===`);

    for (const targetName of pagesToCheck) {
      const trimmedName = targetName.substring(0, 30);
      const pageItem = page.locator(`[data-test="pages-panel-item"]:has-text("${trimmedName}")`).first();
      if (await pageItem.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`  Found page "${trimmedName}" — hovering to reveal gear`);
        await pageItem.hover();
        await page.waitForTimeout(800);

        const shot7hover = await takeScreenshot(page, 'diag-create-page-07-hover-page');
        console.log(`Screenshot 7 (hovering page): ${shot7hover}`);

        // Try clicking the gear/settings icon
        const gearBtn = pageItem.locator('button').first();
        if (await gearBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log('  Found gear button — clicking');
          await gearBtn.click();
          await page.waitForTimeout(2000);

          const shot8 = await takeScreenshot(page, 'diag-create-page-08-page-settings');
          console.log(`Screenshot 8 (page settings): ${shot8}`);
          console.log(`  URL in settings: ${page.url()}`);

          // Check for title/name inputs in settings
          const settingsInputs = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input, textarea');
            return Array.from(inputs)
              .filter(el => (el as HTMLElement).offsetParent !== null)
              .map(el => ({
                tag: el.tagName,
                type: (el as HTMLInputElement).type || '',
                name: (el as HTMLInputElement).name || '',
                placeholder: (el as HTMLInputElement).placeholder || '',
                value: (el as HTMLInputElement).value?.substring(0, 100) || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                id: el.id || '',
                classes: el.className?.toString().substring(0, 80) || '',
              }));
          });
          console.log(`  Settings inputs: ${JSON.stringify(settingsInputs, null, 2)}`);

          // Also look for labels near inputs
          const labelsAndHeaders = await page.evaluate(() => {
            const labels = document.querySelectorAll('label, [class*="field-label"], [class*="FieldLabel"], h2, h3, h4');
            return Array.from(labels)
              .filter(el => (el as HTMLElement).offsetParent !== null)
              .map(el => ({
                tag: el.tagName,
                text: el.textContent?.trim().substring(0, 80),
                forAttr: (el as HTMLLabelElement).htmlFor || '',
              }));
          });
          console.log(`  Labels/headers in settings: ${JSON.stringify(labelsAndHeaders, null, 2)}`);

          // Look for "General" or "SEO" tabs in settings
          const settingsText = await page.evaluate(() => {
            const panel = document.querySelector('[class*="settings"], [class*="Settings"], [role="dialog"]');
            return panel?.textContent?.trim().substring(0, 500) || '(no settings panel found)';
          });
          console.log(`  Settings panel text preview: ${settingsText.substring(0, 300)}`);

          break; // Only check one page
        } else {
          console.log(`  No gear button visible — clicking page item directly`);
          await pageItem.click();
          await page.waitForTimeout(3000);
          const shot7b = await takeScreenshot(page, 'diag-create-page-07b-page-clicked');
          console.log(`Screenshot 7b (page clicked): ${shot7b}`);
          console.log(`  URL after click: ${page.url()}`);
          break;
        }
      }
    }

    // ── CLEANUP: Delete the test page we just created ────────────────────
    console.log('\n=== CLEANUP: Deleting test page ===');
    // Navigate back to pages panel
    await page.goto(PAGES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    for (const newPageName of newPages) {
      const trimmedName = newPageName.substring(0, 30);
      console.log(`  Looking for "${trimmedName}" to delete...`);

      // Hover over the page to reveal the settings gear
      const pageItem = page.locator(`[data-test="pages-panel-item"]:has-text("${trimmedName}")`).first();
      if (await pageItem.isVisible({ timeout: 2000 }).catch(() => false)) {
        await pageItem.hover();
        await page.waitForTimeout(500);

        // Look for the settings/gear button
        const gearBtn = pageItem.locator('button').first();
        if (await gearBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await gearBtn.click();
          await page.waitForTimeout(1500);

          // Look for delete button in the settings panel
          const deleteBtn = page.locator('button:has-text("Delete"), button:has-text("DELETE")').first();
          if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await deleteBtn.click();
            await page.waitForTimeout(1000);

            // Confirm delete
            const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("CONFIRM"), button:has-text("Delete"), button:has-text("Yes")').first();
            if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await confirmBtn.click();
              console.log(`  Deleted "${trimmedName}"`);
              await page.waitForTimeout(2000);
            }
          }
        }
      }
    }

    console.log('\n=== DONE ===');

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await browserManager.close();
  }
}

main();
