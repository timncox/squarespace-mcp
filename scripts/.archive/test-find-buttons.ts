/**
 * Diagnostic: find all buttons/elements with "ADD BLOCK" or "EDIT SECTION" text
 * to understand why Playwright can't see them.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, clickThroughOverlay } from '../src/automation/editor-actions.js';

async function main() {
  const browserManager = getBrowserManager({ headless: false });

  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const cpLink = page.locator('text=Coding Projects').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cpLink.click();
      await page.waitForTimeout(4000);
    }

    await enterEditMode(page);
    await page.waitForTimeout(2000);

    // Click on the first section to select it
    const siteFrame = getSiteFrame(page);
    if (!siteFrame) { console.log('No site frame'); return; }

    // Click on the second-to-last section (a content section, not footer)
    const sectionCount = await siteFrame.locator('.page-section').count();
    console.log(`Total sections: ${sectionCount}`);
    const targetIdx = sectionCount - 2;

    // Get its data-section-id
    const sectionId = await siteFrame.locator('.page-section').nth(targetIdx)
      .getAttribute('data-section-id').catch(() => 'unknown');
    console.log(`Target section index ${targetIdx}, id: ${sectionId}`);

    // Click through overlay
    const clickResult = await clickThroughOverlay(page, `.page-section[data-section-id="${sectionId}"]`);
    console.log(`Click result: ${JSON.stringify(clickResult)}`);
    await page.waitForTimeout(2000);

    // Now check what's visible
    console.log('\n=== Checking button visibility ===');

    // Check main frame
    const selectors = [
      'button:has-text("ADD BLOCK")',
      'button:has-text("EDIT SECTION")',
      'button:has-text("EDIT CONTENT")',
      ':has-text("ADD BLOCK")',
      ':has-text("EDIT SECTION")',
      '[class*="fluid-engine"]',
      '[class*="FluidEngine"]',
      '[data-test*="add-block"]',
      '[aria-label*="Add Block"]',
      '[aria-label*="add block"]',
    ];

    for (const sel of selectors) {
      try {
        const count = await page.locator(sel).count();
        const firstVisible = count > 0 ? await page.locator(sel).first().isVisible().catch(() => false) : false;
        console.log(`  main frame "${sel}": count=${count}, firstVisible=${firstVisible}`);
      } catch (e) {
        console.log(`  main frame "${sel}": ERROR ${(e as Error).message.substring(0, 80)}`);
      }
    }

    // Check iframe
    console.log('\n=== Checking iframe ===');
    for (const sel of selectors) {
      try {
        const count = await siteFrame.locator(sel).count();
        console.log(`  iframe "${sel}": count=${count}`);
      } catch (e) {
        console.log(`  iframe "${sel}": ERROR ${(e as Error).message.substring(0, 80)}`);
      }
    }

    // Use page.evaluate to find ALL elements with text containing "ADD BLOCK" or "EDIT"
    console.log('\n=== Raw DOM search ===');
    const results = await page.evaluate(() => {
      const findings: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim() || '';
        if (text.includes('ADD BLOCK') || text === 'EDIT SECTION' || text === 'EDIT CONTENT') {
          const parent = node.parentElement;
          findings.push(`text="${text}" tag=${parent?.tagName} class="${parent?.className?.substring(0, 80)}" visible=${parent?.offsetParent !== null}`);
        }
      }
      return findings;
    });
    console.log('Main frame text nodes:');
    results.forEach(r => console.log(`  ${r}`));

    // Deeper inspection: get actual HTML of one "ADD BLOCK" button element
    console.log('\n=== Deep inspection of ADD BLOCK buttons ===');
    const btnInfo = await page.evaluate(() => {
      // Use querySelectorAll to find buttons with textContent containing ADD BLOCK
      const buttons = Array.from(document.querySelectorAll('button'));
      const matching = buttons.filter(b => b.textContent?.includes('ADD BLOCK'));
      return matching.slice(0, 3).map((b, i) => ({
        index: i,
        outerHTML: b.outerHTML.substring(0, 300),
        textContent: b.textContent?.trim().substring(0, 50),
        offsetWidth: b.offsetWidth,
        offsetHeight: b.offsetHeight,
        offsetParent: b.offsetParent?.tagName || 'null',
        display: getComputedStyle(b).display,
        visibility: getComputedStyle(b).visibility,
        opacity: getComputedStyle(b).opacity,
        pointerEvents: getComputedStyle(b).pointerEvents,
        rect: JSON.stringify(b.getBoundingClientRect()),
      }));
    });
    btnInfo.forEach(b => console.log(JSON.stringify(b, null, 2)));

    // Also check `:has-text("ADD BLOCK")` — find first VISIBLE one and get its details
    console.log('\n=== First visible :has-text("ADD BLOCK") ===');
    const visibleEl = page.locator(':has-text("ADD BLOCK"):visible').first();
    const visCount = await page.locator(':has-text("ADD BLOCK"):visible').count().catch(() => -1);
    console.log(`Visible :has-text("ADD BLOCK") count: ${visCount}`);
    if (visCount > 0) {
      const tag = await visibleEl.evaluate(el => el.tagName).catch(() => 'unknown');
      const cls = await visibleEl.evaluate(el => el.className?.toString().substring(0, 100)).catch(() => 'unknown');
      const html = await visibleEl.evaluate(el => el.outerHTML.substring(0, 300)).catch(() => 'unknown');
      console.log(`  tag=${tag}, class=${cls}`);
      console.log(`  html=${html}`);
    }

    // Check with text= selector
    console.log('\n=== text= selector checks ===');
    for (const sel of ['text="ADD BLOCK"', 'text="EDIT SECTION"', 'text=/ADD BLOCK/i']) {
      const cnt = await page.locator(sel).count().catch(() => -1);
      const vis = cnt > 0 ? await page.locator(sel).first().isVisible().catch(() => false) : false;
      console.log(`  '${sel}': count=${cnt}, firstVisible=${vis}`);
    }

    // Find shadow hosts — use string eval to avoid tsx compilation issues
    console.log('\n=== Shadow DOM search ===');
    const shadowInfo = await page.evaluate(`
      (function() {
        var results = [];
        function search(root, depth) {
          var els = root.querySelectorAll('*');
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.shadowRoot) {
              var sr = el.shadowRoot;
              var txt = (sr.textContent || '').substring(0, 200);
              if (txt.indexOf('ADD BLOCK') >= 0 || txt.indexOf('EDIT SECTION') >= 0) {
                results.push('depth=' + depth + ' host=<' + el.tagName + '> class="' + (el.className || '').toString().substring(0, 60) + '"');
                var innerEls = sr.querySelectorAll('button, [role="button"], span, div');
                for (var j = 0; j < innerEls.length; j++) {
                  var inner = innerEls[j];
                  var it = (inner.textContent || '').trim();
                  if (it.indexOf('ADD BLOCK') >= 0 || it === 'EDIT SECTION') {
                    var r = inner.getBoundingClientRect();
                    var s = getComputedStyle(inner);
                    results.push('  -> <' + inner.tagName + '> text="' + it.substring(0, 30) + '" display=' + s.display + ' vis=' + s.visibility + ' opacity=' + s.opacity + ' rect=' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + 'x' + Math.round(r.height));
                  }
                }
              }
              search(sr, depth + 1);
            }
          }
        }
        search(document, 0);
        return results;
      })()
    `) as string[];
    shadowInfo.forEach((s: string) => console.log(`  ${s}`));

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
