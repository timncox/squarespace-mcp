/**
 * Set the "View Project" button URLs for all 8 project sections
 * on the Coding Projects page.
 *
 * Each section has a button with text "View Project" that needs a URL.
 * Since all buttons have the same text, we target them by section ID.
 *
 * Approach: In Squarespace's Fluid Engine, clicking a button block shows
 * an inline toolbar with icons. The LINK icon (chain link) opens a URL
 * picker. We click that icon, fill in the URL, and press Enter.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, clickThroughOverlay, saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const SECTIONS = [
  { id: '6998b6a09463047a8fb1c422', name: 'Menu Formatter',              url: 'https://menu-block.lovable.app' },
  { id: '6998b6609463047a8fb1b68b', name: 'Web Scraper',                 url: 'https://webscrapetool.lovable.app' },
  { id: '6998b620b4fa3256a4bb03ac', name: 'InstaDownloader',             url: 'https://instadownload.lovable.app' },
  { id: '6998b6ee752c90721b757fd3', name: 'Community Care Map',          url: 'https://resourcemap.lovable.app' },
  { id: '6998b75325201324cd0c5528', name: 'Prayer Map',                  url: 'https://prayermap.lovable.app' },
  { id: '6998b7ab9a433a09563d2d60', name: 'PoolTogether Explorer',       url: 'https://timalytics2.netlify.app' },
  { id: '6998b7fa7503e854b6dd1142', name: 'Prize Staking Vault Factory', url: 'https://staking.timalytics.com' },
  { id: '6998b8543fd0b93b7177055f', name: 'Bodega',                      url: 'https://bodega.timalytics.com' },
];

/**
 * Set the URL on a button within a specific section.
 * Returns true if successful, false otherwise.
 */
async function setButtonUrl(
  page: Page,
  sectionId: string,
  projectName: string,
  targetUrl: string,
): Promise<boolean> {
  const sf = getSiteFrame(page);
  if (!sf) {
    console.log(`  [FAIL] No site frame`);
    return false;
  }

  const sectionSel = `.page-section[data-section-id="${sectionId}"]`;

  // Step 1: Click the section to select it (first click activates section)
  const clickR = await clickThroughOverlay(page, sectionSel);
  if (!clickR.success) {
    console.log(`  [FAIL] Could not click section: ${clickR.message}`);
    return false;
  }
  await page.waitForTimeout(1200);

  // Step 2: Find and click the button block within this section
  const section = sf.locator(sectionSel);
  const btnBlock = section.locator('.sqs-block-button').first();

  await btnBlock.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);

  let box = await btnBlock.boundingBox().catch(() => null);
  if (!box) {
    console.log(`  [FAIL] Could not get bounding box for button block`);
    return false;
  }

  // Ensure coordinates are within viewport
  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  if (box.y < 0 || box.y > viewport.height) {
    await btnBlock.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
    box = await btnBlock.boundingBox().catch(() => null);
    if (!box) {
      console.log(`  [FAIL] Button block still not visible after re-scroll`);
      return false;
    }
  }

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // First click — selects the section/activates Fluid Engine
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(1000);

  // Second click — selects the button block specifically (shows inline toolbar)
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(1500);

  // Step 3: Now the inline toolbar should be visible above the button.
  // The toolbar has a link icon (chain). Look for it.
  // The link icon button typically has an aria-label like "Link" or contains an SVG chain icon.
  // It's in the MAIN frame (not iframe) since it's a Fluid Engine UI element.

  // Strategy A: Look for a link button by aria-label in the toolbar
  const linkBtnSelectors = [
    'button[aria-label="Link"]',
    'button[aria-label="link"]',
    'button[aria-label="Add link"]',
    'button[aria-label="Edit link"]',
    'button[data-test="link"]',
    // The toolbar appears near the button — look for chain icon SVGs
  ];

  let linkBtnClicked = false;
  for (const sel of linkBtnSelectors) {
    const btn = page.locator(sel).first();
    const vis = await btn.isVisible({ timeout: 1000 }).catch(() => false);
    if (vis) {
      await btn.click();
      linkBtnClicked = true;
      console.log(`  [INFO] Clicked link button via: ${sel}`);
      break;
    }
  }

  // Strategy B: If we can't find by aria-label, look for SVG with a path that matches chain link
  // Or look for all visible toolbar buttons and identify the link one
  if (!linkBtnClicked) {
    // Try to find the toolbar and its buttons by inspecting what's near the button block
    // The toolbar is typically a floating div with several icon buttons
    const toolbarInfo = await page.evaluate(() => {
      // Find all visible small buttons that could be toolbar buttons
      const buttons = Array.from(document.querySelectorAll('button'));
      const toolbarBtns = buttons.filter(b => {
        const rect = b.getBoundingClientRect();
        const style = getComputedStyle(b);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width < 60 && rect.height < 60  // small icon buttons
          && rect.y > 0 && rect.y < 800;
      });

      return toolbarBtns.map(b => ({
        ariaLabel: b.getAttribute('aria-label') || '',
        text: b.textContent?.trim().substring(0, 30) || '',
        title: b.getAttribute('title') || '',
        class: b.className?.toString().substring(0, 80) || '',
        rect: { x: Math.round(b.getBoundingClientRect().x), y: Math.round(b.getBoundingClientRect().y), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) },
        hasSvg: b.querySelector('svg') !== null,
        dataTest: b.getAttribute('data-test') || '',
      }));
    });

    // Log toolbar buttons to understand the structure
    const nearbyBtns = toolbarInfo.filter(b => {
      // Toolbar buttons should be near the button block vertically
      return box && Math.abs(b.rect.y - (box.y - 40)) < 80;
    });

    if (nearbyBtns.length > 0) {
      console.log(`  [DEBUG] Toolbar buttons near button block:`);
      for (const b of nearbyBtns) {
        console.log(`    aria="${b.ariaLabel}" text="${b.text}" title="${b.title}" data-test="${b.dataTest}" pos=(${b.rect.x},${b.rect.y}) size=${b.rect.w}x${b.rect.h} svg=${b.hasSvg}`);
      }
    } else {
      console.log(`  [DEBUG] No toolbar buttons found near button block`);
      console.log(`  [DEBUG] All small visible buttons:`);
      for (const b of toolbarInfo.slice(0, 10)) {
        console.log(`    aria="${b.ariaLabel}" text="${b.text}" title="${b.title}" data-test="${b.dataTest}" pos=(${b.rect.x},${b.rect.y}) size=${b.rect.w}x${b.rect.h} svg=${b.hasSvg}`);
      }
    }

    // Try to find and click the link button by matching common patterns
    const linkButton = await page.evaluate((btnBox: { y: number }) => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const b of buttons) {
        const rect = b.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(b);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        // Check if this is a link button by aria-label, title, or data attributes
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        const title = (b.getAttribute('title') || '').toLowerCase();
        const dataTest = (b.getAttribute('data-test') || '').toLowerCase();

        if (label.includes('link') || title.includes('link') || dataTest.includes('link')) {
          // Make sure it's near the toolbar area (above the button block)
          if (Math.abs(rect.y - btnBox.y) < 100) {
            b.click();
            return { clicked: true, label, x: rect.x, y: rect.y };
          }
        }
      }
      return { clicked: false };
    }, { y: box!.y });

    if (linkButton.clicked) {
      linkBtnClicked = true;
      console.log(`  [INFO] Clicked link button via DOM search: label="${(linkButton as any).label}"`);
    }
  }

  // Strategy C: Look for a pencil/edit icon that might open the button editor
  if (!linkBtnClicked) {
    // The pencil icon in the toolbar might open the full editor panel
    const editBtnSelectors = [
      'button[aria-label="Edit"]',
      'button[aria-label="Edit button"]',
      'button[aria-label="edit"]',
      'button[data-test="edit"]',
    ];
    for (const sel of editBtnSelectors) {
      const btn = page.locator(sel).first();
      const vis = await btn.isVisible({ timeout: 1000 }).catch(() => false);
      if (vis) {
        await btn.click();
        console.log(`  [INFO] Clicked edit button via: ${sel}`);
        await page.waitForTimeout(1500);

        // Now check for ATTACH LINK / EDIT LINK in the side panel
        const attachSelectors = [
          'button:has-text("ATTACH LINK")',
          'button:has-text("EDIT LINK")',
          'button:has-text("Attach Link")',
          'button:has-text("Edit Link")',
        ];
        for (const attachSel of attachSelectors) {
          const attachBtn = page.locator(attachSel).first();
          const attachVis = await attachBtn.isVisible({ timeout: 1500 }).catch(() => false);
          if (attachVis) {
            await attachBtn.click();
            linkBtnClicked = true;
            console.log(`  [INFO] Clicked ${attachSel} in editor panel`);
            break;
          }
        }
        break;
      }
    }
  }

  if (!linkBtnClicked) {
    console.log(`  [FAIL] Could not find or click the link button`);
    await takeScreenshot(page, `link-btn-fail-${sectionId.substring(0, 8)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.mouse.click(100, 100);
    await page.waitForTimeout(300);
    return false;
  }

  await page.waitForTimeout(1000);

  // Step 4: Find the URL input and fill it
  const urlInputSelectors = [
    'input[placeholder*="link"]',
    'input[placeholder*="Link"]',
    'input[placeholder*="search"]',
    'input[placeholder*="Enter link"]',
    'input[placeholder*="enter link"]',
    'input[placeholder*="URL"]',
    'input[placeholder*="url"]',
    'input[placeholder*="Enter"]',
    'input[type="url"]',
    'input[type="text"]',
  ];

  let urlInput = null;
  for (const sel of urlInputSelectors) {
    const els = page.locator(sel);
    const count = await els.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = els.nth(i);
      const vis = await el.isVisible().catch(() => false);
      if (vis) {
        urlInput = el;
        break;
      }
    }
    if (urlInput) break;
  }

  if (!urlInput) {
    console.log(`  [FAIL] URL input not found`);
    await takeScreenshot(page, `url-input-fail-${sectionId.substring(0, 8)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.mouse.click(100, 100);
    await page.waitForTimeout(300);
    return false;
  }

  // Clear any existing value and type the new URL
  await urlInput.click();
  await page.waitForTimeout(200);
  await urlInput.fill(targetUrl);
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);

  // Step 5: Close the panel
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.mouse.click(100, 100);
  await page.waitForTimeout(500);

  console.log(`  [OK] URL set to ${targetUrl}`);
  return true;
}

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Navigate to Coding Projects page
    console.log('\nNavigating to Coding Projects page...');
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    const cpLink = page.locator('text=Coding Projects').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cpLink.click();
      console.log('Clicked Coding Projects link');
      await page.waitForTimeout(4000);
    } else {
      console.log('ERROR: Could not find Coding Projects link');
      return;
    }

    await enterEditMode(page);
    await page.waitForTimeout(3000);

    // Scroll to the top of the page first
    const sf = getSiteFrame(page);
    if (!sf) {
      console.log('ERROR: No site frame');
      return;
    }

    // Scroll iframe to top
    const siteFrame = page.frame({ name: 'sqs-site-frame' });
    if (siteFrame) {
      await siteFrame.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
    }

    const sectionCount = await sf.locator('.page-section').count();
    console.log(`Page has ${sectionCount} sections\n`);

    await takeScreenshot(page, 'set-button-urls-start');

    // Process each section
    const results: { name: string; success: boolean }[] = [];

    for (let i = 0; i < SECTIONS.length; i++) {
      const { id, name, url } = SECTIONS[i];
      console.log(`[${i + 1}/${SECTIONS.length}] ${name} -> ${url}`);

      const success = await setButtonUrl(page, id, name, url);
      results.push({ name, success });

      // Save every 4 sections to avoid losing progress
      if ((i + 1) % 4 === 0 && i < SECTIONS.length - 1) {
        console.log(`\n--- Saving progress after ${i + 1} sections ---`);
        const sr = await saveChanges(page);
        console.log(`Save: ${sr.message}`);
        await page.waitForTimeout(2000);

        // Re-enter edit mode after saving
        await enterEditMode(page);
        await page.waitForTimeout(3000);
      }

      console.log('');
    }

    // Final save
    console.log('=== Final Save ===');
    const sr = await saveChanges(page);
    console.log(`Save: ${sr.message}`);
    await page.waitForTimeout(2000);

    await takeScreenshot(page, 'set-button-urls-final');

    // Summary
    console.log('\n=== Results ===');
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);

    for (const r of results) {
      console.log(`  ${r.success ? '[OK]  ' : '[FAIL]'} ${r.name}`);
    }

    console.log(`\nTotal: ${successes.length}/${results.length} URLs set successfully.`);
    if (failures.length > 0) {
      console.log(`Failed: ${failures.map(f => f.name).join(', ')}`);
    }
  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
