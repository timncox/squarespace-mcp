/**
 * End-to-end test: Create a page with a custom title → verify → delete it → verify.
 * Tests both the rewritten handleCreatePage and handleDeletePage compound actions.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const TEST_PAGE_TITLE = 'E2E Test Page';
const TEST_PAGE_SLUG = 'e2e-test-page';

async function listPages(page: any): Promise<string[]> {
  await page.goto('https://tim-cox.squarespace.com/config/pages', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(4000);

  const items = page.locator('[data-test="pages-panel-item"]');
  const count = await items.count();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await items.nth(i).innerText().catch(() => '');
    names.push(text.trim());
  }
  return names;
}

async function main() {
  const bm = getBrowserManager({ headless: false });
  const results: { step: string; success: boolean; message: string }[] = [];

  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // ── Step 0: Baseline — list current pages ──
    console.log('\n════════════════════════════════════════');
    console.log('  E2E TEST: createPage → deletePage');
    console.log('════════════════════════════════════════\n');

    const before = await listPages(page);
    console.log(`Baseline pages (${before.length}):`);
    before.forEach((n, i) => console.log(`  [${i}] "${n}"`));

    // Ensure no leftover test page
    if (before.includes(TEST_PAGE_TITLE)) {
      console.log(`\n⚠️  "${TEST_PAGE_TITLE}" already exists — deleting first...`);
      const cleanup = await executeAgentAction(page, { action: 'deletePage', title: TEST_PAGE_TITLE });
      console.log(`  Cleanup: ${cleanup.success ? '✅' : '❌'} ${cleanup.message}`);
      await page.waitForTimeout(2000);
    }

    // ── Step 1: Create page ──
    console.log(`\n── Step 1: Create page "${TEST_PAGE_TITLE}" ──`);
    const createResult = await executeAgentAction(page, {
      action: 'createPage',
      title: TEST_PAGE_TITLE,
      slug: TEST_PAGE_SLUG,
    });
    console.log(`  Result: ${createResult.success ? '✅' : '❌'} ${createResult.message}`);
    results.push({ step: 'createPage', success: createResult.success, message: createResult.message });
    await takeScreenshot(page, 'e2e-after-create');

    // ── Step 2: Verify page exists ──
    console.log(`\n── Step 2: Verify "${TEST_PAGE_TITLE}" exists ──`);
    const afterCreate = await listPages(page);
    console.log(`Pages after create (${afterCreate.length}):`);
    afterCreate.forEach((n, i) => console.log(`  [${i}] "${n}"`));

    const pageExists = afterCreate.includes(TEST_PAGE_TITLE);
    console.log(`  "${TEST_PAGE_TITLE}" found: ${pageExists ? '✅ YES' : '❌ NO'}`);
    results.push({
      step: 'verify-create',
      success: pageExists,
      message: pageExists ? `Page "${TEST_PAGE_TITLE}" found in pages list` : `Page "${TEST_PAGE_TITLE}" NOT found`,
    });

    if (!pageExists) {
      console.log('\n❌ Create verification failed — skipping delete test');
      // Check if it's there under "New Page" (title wasn't set)
      const newPageCount = afterCreate.filter(n => n === 'New Page').length;
      const beforeNewPageCount = before.filter(n => n === 'New Page').length;
      if (newPageCount > beforeNewPageCount) {
        console.log(`  ⚠️  Found ${newPageCount - beforeNewPageCount} new "New Page" entries — title may not have been set`);
        console.log('  Cleaning up...');
        await executeAgentAction(page, { action: 'deletePage', title: 'New Page' });
      }
    }

    // ── Step 3: Delete page ──
    if (pageExists) {
      console.log(`\n── Step 3: Delete page "${TEST_PAGE_TITLE}" ──`);
      const deleteResult = await executeAgentAction(page, {
        action: 'deletePage',
        title: TEST_PAGE_TITLE,
      });
      console.log(`  Result: ${deleteResult.success ? '✅' : '❌'} ${deleteResult.message}`);
      results.push({ step: 'deletePage', success: deleteResult.success, message: deleteResult.message });
      await takeScreenshot(page, 'e2e-after-delete');

      // ── Step 4: Verify page is gone ──
      console.log(`\n── Step 4: Verify "${TEST_PAGE_TITLE}" is gone ──`);
      const afterDelete = await listPages(page);
      console.log(`Pages after delete (${afterDelete.length}):`);
      afterDelete.forEach((n, i) => console.log(`  [${i}] "${n}"`));

      const pageGone = !afterDelete.includes(TEST_PAGE_TITLE);
      console.log(`  "${TEST_PAGE_TITLE}" gone: ${pageGone ? '✅ YES' : '❌ NO'}`);
      results.push({
        step: 'verify-delete',
        success: pageGone,
        message: pageGone ? `Page "${TEST_PAGE_TITLE}" successfully removed` : `Page "${TEST_PAGE_TITLE}" still exists!`,
      });

      // Confirm page count matches baseline
      const countMatch = afterDelete.length === before.length;
      console.log(`  Page count: ${before.length} → ${afterCreate.length} → ${afterDelete.length} ${countMatch ? '✅' : '⚠️'}`);
    }

    // ── Summary ──
    console.log('\n════════════════════════════════════════');
    console.log('  E2E TEST RESULTS');
    console.log('════════════════════════════════════════');
    let allPassed = true;
    for (const r of results) {
      console.log(`  ${r.success ? '✅' : '❌'} ${r.step}: ${r.message}`);
      if (!r.success) allPassed = false;
    }
    console.log(`\n  Overall: ${allPassed ? '✅ ALL PASSED' : '❌ SOME FAILED'}`);
    console.log('════════════════════════════════════════\n');

  } catch (err) {
    console.error('Fatal error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
