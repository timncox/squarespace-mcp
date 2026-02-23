/**
 * Diagnostic: After creating page, type title inline and press Enter.
 * Key discovery: page goes to Main Navigation with inline edit active.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Navigate to pages panel
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Count before
    const beforeItems = page.locator('[data-test="pages-panel-item"]');
    const beforeCount = await beforeItems.count();
    console.log(`Before: ${beforeCount} pages`);

    // Click + → Add Blank → Page
    await page.locator('[data-test="add-page"]').first().click();
    await page.waitForTimeout(1500);

    await page.locator('[data-test="add-blank-options-button"]').first().click();
    await page.waitForTimeout(1500);

    // Use data-test selector for the Page option
    const pageOption = page.locator('[data-test="blank-page-option"]').first();
    if (await pageOption.isVisible({ timeout: 3000 })) {
      await pageOption.click();
      console.log('✅ Clicked [data-test="blank-page-option"]');
    } else {
      // Fallback to text matching
      const textPage = page.locator('text="Page"').first();
      await textPage.click();
      console.log('✅ Clicked text="Page" fallback');
    }

    await page.waitForTimeout(2000);
    await takeScreenshot(page, 'diag-inline-after-create');

    // Now: the title should be editable inline
    // Look for the focused/active input or editable element
    console.log('\n── Focused element info ──');
    const focusedInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return 'No active element';
      return {
        tag: el.tagName,
        type: (el as HTMLInputElement).type || '',
        value: (el as HTMLInputElement).value || '',
        text: el.textContent?.substring(0, 50) || '',
        className: el.className?.substring(0, 100) || '',
        role: el.getAttribute('role') || '',
        contentEditable: el.getAttribute('contenteditable') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        dataTest: el.getAttribute('data-test') || '',
        placeholder: (el as HTMLInputElement).placeholder || '',
      };
    });
    console.log(JSON.stringify(focusedInfo, null, 2));

    // Look for input elements that are visible and near the top (Main Navigation area)
    console.log('\n── Visible inputs ──');
    const inputs = page.locator('input');
    const inputCount = await inputs.count();
    for (let i = 0; i < inputCount; i++) {
      const inp = inputs.nth(i);
      const visible = await inp.isVisible().catch(() => false);
      if (!visible) continue;
      const value = await inp.inputValue().catch(() => '');
      const placeholder = await inp.getAttribute('placeholder').catch(() => '');
      const ariaLabel = await inp.getAttribute('aria-label').catch(() => '');
      const type = await inp.getAttribute('type').catch(() => '');
      const box = await inp.boundingBox().catch(() => null);
      console.log(`  input[${i}]: type="${type}" value="${value}" placeholder="${placeholder}" aria="${ariaLabel}" y=${box?.y?.toFixed(0) || '?'}`);
    }

    // Also check contenteditable elements
    console.log('\n── Contenteditable elements ──');
    const editables = page.locator('[contenteditable="true"]');
    const editCount = await editables.count();
    for (let i = 0; i < editCount; i++) {
      const el = editables.nth(i);
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      const text = await el.innerText().catch(() => '');
      const box = await el.boundingBox().catch(() => null);
      console.log(`  editable[${i}]: text="${text.trim().substring(0, 40)}" y=${box?.y?.toFixed(0) || '?'}`);
    }

    // Strategy: type the title and press Enter
    console.log('\n── Typing title ──');
    // Select all text first (Ctrl+A), then type new title
    await page.keyboard.press('Meta+a');
    await page.waitForTimeout(200);
    await page.keyboard.type('E2E Test Page', { delay: 50 });
    await page.waitForTimeout(500);
    await takeScreenshot(page, 'diag-inline-after-typing');

    // Press Enter to confirm
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'diag-inline-after-enter');

    // Check current state
    console.log('\n── After typing + Enter ──');
    const allItems = page.locator('[data-test="pages-panel-item"]');
    const afterCount = await allItems.count();
    console.log(`Page items: ${afterCount}`);
    for (let i = 0; i < afterCount; i++) {
      const text = await allItems.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    // Also check the "Main Navigation" section by looking for text
    const bodyText = await page.locator('body').innerText();
    if (bodyText.includes('E2E Test Page')) {
      console.log('\n✅ "E2E Test Page" text found on page!');
    } else if (bodyText.includes('New Page')) {
      console.log('\n⚠️  "New Page" text found but not "E2E Test Page"');
    } else {
      console.log('\n❌ Neither "E2E Test Page" nor "New Page" found');
    }

    // Check URL
    console.log(`\nCurrent URL: ${page.url()}`);

    // Navigate back to pages to see full state
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);
    await takeScreenshot(page, 'diag-inline-final');

    const finalItems = page.locator('[data-test="pages-panel-item"]');
    const finalCount = await finalItems.count();
    console.log(`\n── Final state (after re-navigating) ──`);
    console.log(`Pages: ${finalCount}`);
    for (let i = 0; i < finalCount; i++) {
      const text = await finalItems.nth(i).innerText().catch(() => '');
      console.log(`  [${i}] "${text.trim()}"`);
    }

    console.log(`\nCount change: ${beforeCount} → ${finalCount} (diff: ${finalCount - beforeCount})`);

    // Cleanup if we created something
    if (finalCount > beforeCount) {
      console.log('\n── Cleanup ──');
      // Look for our test page or "New Page"
      for (let i = finalCount - 1; i >= 0; i--) {
        const text = await finalItems.nth(i).innerText().catch(() => '');
        if (text.trim() === 'E2E Test Page' || text.trim() === 'New Page') {
          console.log(`  Deleting "${text.trim()}" at index ${i}`);
          const item = finalItems.nth(i);
          await item.scrollIntoViewIfNeeded();
          const box = await item.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(1000);

            const delBtns = page.locator('[data-test="delete-item"]');
            const dCount = await delBtns.count();
            for (let d = 0; d < dCount; d++) {
              const dBox = await delBtns.nth(d).boundingBox().catch(() => null);
              if (!dBox) continue;
              const yDist = Math.abs((dBox.y + dBox.height / 2) - (box.y + box.height / 2));
              if (yDist < 30) {
                await page.mouse.click(dBox.x + dBox.width / 2, dBox.y + dBox.height / 2);
                await page.waitForTimeout(1500);
                const confirm = page.locator('button:has-text("Confirm")').first();
                if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
                  await confirm.click();
                  console.log('  ✅ Cleaned up');
                }
                break;
              }
            }
          }
          break;
        }
      }
    }

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
