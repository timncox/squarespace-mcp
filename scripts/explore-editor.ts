import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { navigateToSite, navigateToPage, enterEditMode, resolveSite } from '../src/automation/site-navigator.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

/**
 * Exploration script to inspect the Squarespace editor DOM.
 * Use this to discover and update CSS selectors when the editor UI changes.
 *
 * Usage:
 *   npx tsx scripts/explore-editor.ts --site smyth-tavern --page menus
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  const siteId = flags.site;
  const pageSlug = flags.page;

  if (!siteId) {
    console.error('Usage: npx tsx scripts/explore-editor.ts --site <id> [--page <slug>]');
    process.exit(1);
  }

  const browserManager = getBrowserManager({ headless: false });

  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);

    const page = await browserManager.getPage();
    const client = await resolveSite(siteId, page);

    console.log(`\nNavigating to ${client.name}...`);
    await navigateToSite(page, client);

    if (pageSlug) {
      console.log(`Navigating to page: ${pageSlug}...`);
      await navigateToPage(page, client, pageSlug);
      await enterEditMode(page);
    }

    await takeScreenshot(page, 'explore-editor');

    // Dump interactive elements
    console.log('\n=== BUTTONS ===');
    const buttons = await page.locator('button').all();
    for (const btn of buttons) {
      const text = await btn.innerText().catch(() => '');
      const ariaLabel = await btn.getAttribute('aria-label');
      const dataTest = await btn.getAttribute('data-test');
      const classes = await btn.getAttribute('class');
      if (text || ariaLabel || dataTest) {
        console.log(`  Button: text="${text.trim()}" aria-label="${ariaLabel}" data-test="${dataTest}" class="${classes?.slice(0, 60)}"`);
      }
    }

    console.log('\n=== INPUTS ===');
    const inputs = await page.locator('input, textarea, [contenteditable="true"]').all();
    for (const input of inputs) {
      const type = await input.getAttribute('type');
      const name = await input.getAttribute('name');
      const placeholder = await input.getAttribute('placeholder');
      const ariaLabel = await input.getAttribute('aria-label');
      console.log(`  Input: type="${type}" name="${name}" placeholder="${placeholder}" aria-label="${ariaLabel}"`);
    }

    console.log('\n=== NAV LINKS ===');
    const navLinks = await page.locator('nav a, [role="navigation"] a').all();
    for (const link of navLinks) {
      const text = await link.innerText().catch(() => '');
      const href = await link.getAttribute('href');
      console.log(`  Link: text="${text.trim()}" href="${href}"`);
    }

    console.log('\nBrowser is open. Inspect manually, then press Ctrl+C to close.');
    await new Promise(() => {});
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    await browserManager.close();
    process.exit(1);
  }
}

main();
