import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

/**
 * Test script to verify Squarespace login works.
 *
 * Usage:
 *   npx tsx scripts/test-login.ts
 *
 * This will:
 * 1. Launch a visible browser
 * 2. Log into Squarespace (or verify existing session)
 * 3. Take a screenshot of the account dashboard
 * 4. Keep the browser open for manual inspection
 */

async function main(): Promise<void> {
  console.log('Squarespace Login Test');
  console.log('======================\n');

  if (!process.env.SQSP_EMAIL || !process.env.SQSP_PASSWORD) {
    console.error('Error: SQSP_EMAIL and SQSP_PASSWORD must be set in .env');
    console.error('Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }

  const browserManager = getBrowserManager({ headless: false });

  try {
    console.log('Launching browser...');
    await browserManager.initialize();

    console.log('Checking login status...');
    await ensureLoggedIn(browserManager);

    console.log('Login successful!');

    const page = await browserManager.getPage();
    const screenshotPath = await takeScreenshot(page, 'login-test-success');
    console.log(`Screenshot: ${screenshotPath}`);

    console.log(`\nCurrent URL: ${page.url()}`);
    console.log('\nBrowser is open. Inspect the page, then press Ctrl+C to close.');

    await new Promise(() => {}); // Wait indefinitely
  } catch (err) {
    console.error('Login failed:', err instanceof Error ? err.message : err);

    try {
      const page = await browserManager.getPage();
      const screenshotPath = await takeScreenshot(page, 'login-test-failed');
      console.log(`Error screenshot: ${screenshotPath}`);
    } catch {
      // Can't take screenshot
    }

    await browserManager.close();
    process.exit(1);
  }
}

main();
