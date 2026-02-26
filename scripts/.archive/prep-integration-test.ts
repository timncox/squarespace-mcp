/**
 * Prep script for integration tests.
 * Launches browser, navigates to a Squarespace site editor,
 * waits for the editor to load, saves session state, and exits.
 *
 * Usage:
 *   npx tsx scripts/prep-integration-test.ts [site-subdomain] [page-slug]
 *   npx tsx scripts/prep-integration-test.ts smyth-tavern home
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SITE = process.argv[2] || 'smyth-tavern';
const PAGE = process.argv[3] || 'home';
const SESSION_INPUT = path.resolve('storage/auth/sqsp-session.json');
const SESSION_OUTPUT = path.resolve('storage/session-state.json');
const SCREENSHOT_DIR = path.resolve('storage/screenshots');

async function main() {
  console.log(`Prep integration test for ${SITE}/${PAGE}`);
  console.log('='.repeat(50));

  if (!fs.existsSync(SESSION_INPUT)) {
    console.error(`Session file not found: ${SESSION_INPUT}`);
    console.error('Run `npm run test-login` first.');
    process.exit(1);
  }

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: SESSION_INPUT,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    // Step 1: Navigate to the site's config/pages
    const configUrl = `https://${SITE}.squarespace.com/config/pages`;
    console.log(`Navigating to ${configUrl}...`);
    await page.goto(configUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Take a screenshot to see what loaded
    const ss1 = path.join(SCREENSHOT_DIR, `prep-step1-config-pages.png`);
    await page.screenshot({ path: ss1 });
    console.log(`Screenshot (config/pages): ${ss1}`);
    console.log(`Current URL: ${page.url()}`);

    // Step 2: The pages panel is open. Try clicking the target page,
    // or fall back to clicking EDIT if the home page is already selected.
    const pageTitle = PAGE === 'home' ? 'Home' : PAGE;
    console.log(`Looking for page "${pageTitle}" in the pages list...`);

    // Try clicking the page — use force:true to handle viewport issues
    let clicked = false;
    for (const selector of [
      `[data-test="page-item"] :text("${pageTitle}")`,
      `a:has-text("${pageTitle}")`,
      `[role="treeitem"] :text("${pageTitle}")`,
    ]) {
      const el = page.locator(selector).first();
      const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        console.log(`Found page with selector: ${selector}`);
        await el.click({ force: true, timeout: 5000 }).catch(() => {});
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      console.log('Page not found in sidebar or click failed. Proceeding with current page.');
    }

    await page.waitForTimeout(3000);

    const ss2 = path.join(SCREENSHOT_DIR, `prep-step2-page-selected.png`);
    await page.screenshot({ path: ss2 });
    console.log(`Screenshot (page selected): ${ss2}`);
    console.log(`Current URL: ${page.url()}`);

    // Step 3: Enter edit mode if needed
    const editButton = page.locator('button:has-text("Edit")').first();
    const editVisible = await editButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (editVisible) {
      console.log('Clicking Edit button...');
      await editButton.click();
      await page.waitForTimeout(5000);
    } else {
      console.log('No Edit button visible (may already be in editor)');
    }

    // Step 4: Wait for the site iframe to appear
    console.log('Waiting for site iframe...');
    const iframe = page.frame({ name: 'sqs-site-frame' });
    if (iframe) {
      console.log('Site iframe found!');
      // Wait for content to load in the iframe
      await page.waitForTimeout(3000);
    } else {
      console.log('WARNING: Site iframe not found. Editor may not have loaded.');
      // Try waiting a bit more
      await page.waitForTimeout(5000);
      const retryFrame = page.frame({ name: 'sqs-site-frame' });
      if (retryFrame) {
        console.log('Site iframe found on retry!');
      } else {
        console.log('Site iframe still not found. Tests may fail.');
      }
    }

    const ss3 = path.join(SCREENSHOT_DIR, `prep-step3-editor.png`);
    await page.screenshot({ path: ss3 });
    console.log(`Screenshot (editor): ${ss3}`);

    // Step 5: Save the session state with all cookies
    console.log(`Saving session state to ${SESSION_OUTPUT}...`);
    const state = await context.storageState();
    fs.writeFileSync(SESSION_OUTPUT, JSON.stringify(state, null, 2));
    console.log(`Session state saved (${state.cookies.length} cookies)`);

    // List squarespace cookies
    const sqspCookies = state.cookies.filter(c => c.domain.includes('squarespace'));
    console.log(`Squarespace cookies: ${sqspCookies.length}`);
    for (const c of sqspCookies.slice(0, 10)) {
      console.log(`  ${c.name} @ ${c.domain}`);
    }

    console.log('\nPrep complete! You can now run integration tests.');
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    const ssErr = path.join(SCREENSHOT_DIR, `prep-error.png`);
    await page.screenshot({ path: ssErr }).catch(() => {});
    console.log(`Error screenshot: ${ssErr}`);
  } finally {
    await browser.close();
  }
}

main();
