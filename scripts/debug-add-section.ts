/**
 * Debug script: navigate to Squarespace, enter edit mode on Coding Projects,
 * and inspect the "ADD SECTION" button to figure out why clicks don't work.
 *
 * Usage: npx tsx scripts/debug-add-section.ts
 */
import { chromium, Page } from 'playwright';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  // Connect to the existing browser session
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();

  // Use first available page
  const page = pages[0] || await context.newPage();
  console.log('Using page:', page.url());

  // Navigate to the Squarespace editor
  console.log('\nNavigating to Squarespace editor...');
  await page.goto('https://tim-cox.squarespace.com/config/pages', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Click Coding Projects
  console.log('Looking for Coding Projects page...');
  const codingProject = page.locator('div:has-text("Coding Projects")').first();
  await codingProject.click();
  await page.waitForTimeout(2000);

  // Click Edit button
  console.log('Clicking Edit...');
  const editBtn = page.locator('[data-test="frameToolbarEdit"], button:has-text("Edit"), button:has-text("EDIT")').first();
  await editBtn.click({ timeout: 5000 }).catch(() => {
    console.log('Edit button click failed, trying text match...');
  });
  await page.waitForTimeout(3000);

  console.log('Current URL:', page.url());
  console.log('');

  // ===== INSPECTION =====

  // 1. Check ALL frames
  console.log('=== ALL FRAMES ===');
  const frames = page.frames();
  console.log(`Total frames: ${frames.length}`);
  for (const frame of frames) {
    const name = frame.name() || '(unnamed)';
    const url = frame.url().substring(0, 100);

    const addSectionBtn = await frame.locator('button').filter({ hasText: 'ADD SECTION' }).count().catch(() => -1);
    const addSectionText = await frame.locator('text=ADD SECTION').count().catch(() => -1);
    const addPageContent = await frame.locator('text=Add Page Content').count().catch(() => -1);

    if (addSectionBtn > 0 || addSectionText > 0 || addPageContent > 0) {
      console.log(`  ✅ Frame "${name}" (${url})`);
      console.log(`     buttons=${addSectionBtn}, text=${addSectionText}, addPageContent=${addPageContent}`);

      // Get the actual button element details
      if (addSectionBtn > 0) {
        const btnHtml = await frame.locator('button').filter({ hasText: 'ADD SECTION' }).first().evaluate(el => ({
          outerHTML: el.outerHTML.substring(0, 300),
          tagName: el.tagName,
          className: el.className,
          id: el.id,
          rect: el.getBoundingClientRect(),
          parentTag: el.parentElement?.tagName,
          parentClass: el.parentElement?.className?.substring(0, 100),
          computedDisplay: window.getComputedStyle(el).display,
          computedPointerEvents: window.getComputedStyle(el).pointerEvents,
          computedVisibility: window.getComputedStyle(el).visibility,
          computedZIndex: window.getComputedStyle(el).zIndex,
        })).catch(e => `Error: ${e}`);
        console.log('     Button details:', JSON.stringify(btnHtml, null, 6));
      }

      // Also check for text="Add Page Content"
      if (addPageContent > 0) {
        const contentHtml = await frame.locator('text=Add Page Content').first().evaluate(el => ({
          outerHTML: el.outerHTML.substring(0, 500),
          parentHTML: el.parentElement?.outerHTML?.substring(0, 500),
        })).catch(e => `Error: ${e}`);
        console.log('     Add Page Content details:', JSON.stringify(contentHtml, null, 6));
      }
    } else {
      console.log(`  ❌ Frame "${name}" (${url}): no ADD SECTION found`);
    }
  }

  // 2. Check overlays on main page
  console.log('\n=== OVERLAY ANALYSIS ===');
  const overlayInfo = await page.evaluate(() => {
    // Find any element that might be intercepting clicks
    const interesting = document.querySelectorAll('[class*="overlay"], [class*="Overlay"], [class*="editing"], [class*="fluid-engine"], [id*="overlay"], [id*="editor"]');
    return Array.from(interesting).slice(0, 10).map(el => ({
      tag: el.tagName,
      id: el.id,
      class: (el.className || '').toString().substring(0, 80),
      pointerEvents: window.getComputedStyle(el).pointerEvents,
      zIndex: window.getComputedStyle(el).zIndex,
      position: window.getComputedStyle(el).position,
      rect: {
        x: Math.round(el.getBoundingClientRect().x),
        y: Math.round(el.getBoundingClientRect().y),
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height),
      },
    }));
  });
  for (const ov of overlayInfo) {
    console.log(`  ${ov.tag}#${ov.id} .${ov.class}`);
    console.log(`    pointer-events: ${ov.pointerEvents}, z-index: ${ov.zIndex}, position: ${ov.position}`);
    console.log(`    rect: ${JSON.stringify(ov.rect)}`);
  }

  // 3. Try different click strategies
  console.log('\n=== CLICK STRATEGIES ===');

  // Strategy A: Direct frame.click()
  console.log('Strategy A: frame.locator().click() on the iframe frame...');
  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  if (siteFrame) {
    try {
      const btn = siteFrame.locator('button').filter({ hasText: 'ADD SECTION' }).first();
      const isVisible = await btn.isVisible();
      console.log(`  Button visible in sqs-site-frame: ${isVisible}`);
      if (isVisible) {
        const box = await btn.boundingBox();
        console.log(`  Button bounding box: ${JSON.stringify(box)}`);

        // Try clicking with frame.locator
        await btn.click({ timeout: 3000, force: true });
        console.log('  ✅ frame.click(force:true) succeeded!');
        await page.waitForTimeout(2000);

        // Screenshot to see if anything changed
        await page.screenshot({ path: '/Users/timcox/squarespace helper/storage/screenshots/debug-after-click.png' });
        console.log('  Screenshot saved: debug-after-click.png');
      }
    } catch (e) {
      console.log(`  ❌ Strategy A failed: ${e}`);
    }
  }

  // Strategy B: JavaScript click via frame.evaluate
  console.log('\nStrategy B: JavaScript click via frame.evaluate...');
  if (siteFrame) {
    try {
      const result = await siteFrame.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.includes('ADD SECTION')) {
            btn.click();
            return { found: true, text: btn.textContent, className: btn.className };
          }
        }
        return { found: false };
      });
      console.log(`  Result: ${JSON.stringify(result)}`);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: '/Users/timcox/squarespace helper/storage/screenshots/debug-after-jsclick.png' });
      console.log('  Screenshot saved: debug-after-jsclick.png');
    } catch (e) {
      console.log(`  ❌ Strategy B failed: ${e}`);
    }
  }

  // Strategy C: Dispatch pointer events
  console.log('\nStrategy C: Dispatch pointer/mouse events...');
  if (siteFrame) {
    try {
      const result = await siteFrame.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.includes('ADD SECTION')) {
            const rect = btn.getBoundingClientRect();
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;

            // Dispatch full event sequence
            for (const eventType of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              const event = new MouseEvent(eventType, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: cx,
                clientY: cy,
              });
              btn.dispatchEvent(event);
            }
            return { found: true, cx, cy };
          }
        }
        return { found: false };
      });
      console.log(`  Result: ${JSON.stringify(result)}`);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: '/Users/timcox/squarespace helper/storage/screenshots/debug-after-dispatch.png' });
      console.log('  Screenshot saved: debug-after-dispatch.png');
    } catch (e) {
      console.log(`  ❌ Strategy C failed: ${e}`);
    }
  }

  // Strategy D: Check if the button is actually in the MAIN frame, not the iframe
  console.log('\nStrategy D: Check main frame for the button...');
  try {
    const mainBtn = page.locator('button').filter({ hasText: 'ADD SECTION' }).first();
    const mainVisible = await mainBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`  Button visible in main frame: ${mainVisible}`);
    if (mainVisible) {
      const box = await mainBtn.boundingBox();
      console.log(`  Main frame button box: ${JSON.stringify(box)}`);
      await mainBtn.click({ force: true, timeout: 3000 });
      console.log('  ✅ Main frame click succeeded!');
      await page.waitForTimeout(2000);
      await page.screenshot({ path: '/Users/timcox/squarespace helper/storage/screenshots/debug-after-mainclick.png' });
    }
  } catch (e) {
    console.log(`  ❌ Strategy D failed: ${e}`);
  }

  console.log('\nDone! Check screenshots in storage/screenshots/debug-*.png');
  await browser.close();
}

main().catch(console.error);
