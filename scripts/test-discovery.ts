import dotenv from 'dotenv';
dotenv.config({ override: true });
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { discoverSites } from '../src/automation/site-discovery.js';

async function main() {
  const bm = getBrowserManager({ headless: true });
  await bm.initialize();
  await ensureLoggedIn(bm);

  const page = await bm.getPage();

  // First, let's inspect the DOM around the subdomain text
  await page.goto('https://account.squarespace.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(4000);

  const domInfo = await page.evaluate(() => {
    const allEls = document.querySelectorAll('*');
    const results: string[] = [];
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3) // TEXT_NODE
        .map((n) => (n.textContent || '').trim())
        .join('')
        .trim();

      if (directText.includes('squarespace.com') && !directText.includes('account.squarespace') && el.tagName !== 'SCRIPT') {
        results.push(`\nFound subdomain text in: <${el.tagName.toLowerCase()} class="${el.className}">`);
        results.push(`  Text: "${directText}"`);

        // Walk up and show all text content + children for each ancestor
        let p = el.parentElement;
        for (let j = 1; j <= 8 && p; j++) {
          const tag = p.tagName.toLowerCase();
          const cls = (p.className || '').toString().substring(0, 60);
          // Get all child elements with text
          const children = Array.from(p.children).map((c) => {
            const t = c.tagName.toLowerCase();
            const txt = (c.textContent || '').trim().substring(0, 80);
            return `<${t}>${txt}`;
          });
          results.push(`  [${j}] <${tag} class="${cls}">`);
          for (const child of children.slice(0, 8)) {
            results.push(`     child: ${child}`);
          }
          p = p.parentElement;
        }
      }
    }
    return results;
  });

  console.log('\n=== DOM STRUCTURE AROUND SUBDOMAIN TEXT ===');
  for (const line of domInfo) {
    console.log(line);
  }

  // Now test the actual discovery
  const { clearDiscoveredSitesCache } = await import('../src/automation/site-discovery.js');
  clearDiscoveredSitesCache();

  const sites = await discoverSites(page, { force: true });
  console.log('\n=== DISCOVERED SITES ===');
  for (const s of sites) {
    console.log(`  ${s.name} → ${s.subdomain} → ${s.adminUrl}`);
  }
  console.log(`\nTotal: ${sites.length} sites`);

  await bm.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
