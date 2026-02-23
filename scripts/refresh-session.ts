import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';

/**
 * Refresh the Squarespace session cookies (including site crumb) and exit.
 * Usage: npx tsx scripts/refresh-session.ts
 */
async function main(): Promise<void> {
  console.log('Refreshing Squarespace session...\n');

  if (!process.env.SQSP_EMAIL || !process.env.SQSP_PASSWORD) {
    console.error('Error: SQSP_EMAIL and SQSP_PASSWORD must be set in .env');
    process.exit(1);
  }

  const browserManager = getBrowserManager({ headless: true });

  try {
    await browserManager.initialize();
    console.log('Checking login status...');
    await ensureLoggedIn(browserManager);
    console.log('Logged in.');

    // Navigate to the site editor to get a fresh crumb cookie
    const page = await browserManager.getPage();
    console.log('Navigating to site editor to refresh crumb...');
    await page.goto('https://grey-yellow-hbxc.squarespace.com/config', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // Wait for the editor to set the crumb cookie
    await page.waitForTimeout(3000);
    console.log('Editor loaded at:', page.url());

    // Save session with fresh cookies
    await browserManager.saveSession();
    console.log('Session saved to storage/auth/sqsp-session.json');

    // Show the crumb we got
    const cookies = await page.context().cookies();
    const crumb = cookies.find(c => c.name === 'crumb' && c.domain.includes('grey-yellow'));
    console.log('Crumb:', crumb?.value?.slice(0, 30) + '...');
  } catch (err) {
    console.error('Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await browserManager.close();
  }
}

main();
