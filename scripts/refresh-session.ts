import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Refresh Squarespace session cookies interactively.
 *
 * Opens a visible Chrome browser. Log into Squarespace manually,
 * then navigate to your site admin. The script detects when you're
 * logged in, visits each site to capture crumb cookies, and saves
 * the full cookie jar to storage/auth/sqsp-session.json.
 *
 * Usage: npx tsx scripts/refresh-session.ts
 */

const SESSION_PATH = join(process.cwd(), 'storage', 'auth', 'sqsp-session.json');

// Sites to visit after login to capture per-site crumb cookies
const SITES = [
  { name: 'Smyth Tavern', adminUrl: 'https://grey-yellow-hbxc.squarespace.com/config' },
  { name: 'Tim Cox', adminUrl: 'https://tim-cox.squarespace.com/config' },
];

async function main(): Promise<void> {
  console.log('=== Squarespace Session Refresh ===\n');
  console.log('A browser window will open. Log into Squarespace if needed.');
  console.log('The script will detect login and save cookies automatically.\n');

  // Reuse existing session if available (may still be logged in)
  const launchOpts: Parameters<typeof chromium.launch>[0] = { headless: false };
  const contextOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {};

  if (existsSync(SESSION_PATH)) {
    console.log('Found existing session file — reusing cookies (may skip login).\n');
    const { readFileSync } = await import('fs');
    contextOpts.storageState = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
  }

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  // Navigate to Squarespace account page
  console.log('Navigating to Squarespace...');
  await page.goto('https://account.squarespace.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Wait for login — either already logged in or user logs in manually
  console.log('Waiting for login (if redirected to login page, log in manually)...');
  try {
    await page.waitForURL('**/account.**', { timeout: 120000 });
    console.log('Logged in!\n');
  } catch {
    // Check if we're on the account page already
    if (!page.url().includes('account.squarespace.com')) {
      console.error('Timed out waiting for login. Please try again.');
      await browser.close();
      process.exit(1);
    }
  }

  // Visit each site admin to get fresh crumb cookies
  for (const site of SITES) {
    console.log(`Visiting ${site.name} admin to capture crumb...`);
    try {
      await page.goto(site.adminUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      // Wait for editor to set crumb cookie
      await page.waitForTimeout(3000);
      console.log(`  ✓ ${site.name} loaded: ${page.url()}`);
    } catch (err) {
      console.warn(`  ✗ ${site.name} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Save storage state
  const dir = dirname(SESSION_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await context.storageState({ path: SESSION_PATH });
  console.log(`\nSession saved to ${SESSION_PATH}`);

  // Verify crumb cookies
  const cookies = await context.cookies();
  const crumbs = cookies.filter(c => c.name === 'crumb');
  console.log(`\nCrumb cookies found: ${crumbs.length}`);
  for (const c of crumbs) {
    const domain = c.domain.replace(/^\./, '');
    console.log(`  ${domain}: ${c.value.slice(0, 30)}...`);
  }

  if (crumbs.length === 0) {
    console.warn('\n⚠ No crumb cookies found — API calls will fail with 401.');
    console.warn('  Make sure you visited the site admin pages while logged in.');
  } else {
    console.log('\n✓ Session refresh complete. MCP server will use new cookies on next restart.');
  }

  await browser.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
