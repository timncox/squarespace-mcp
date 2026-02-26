/**
 * Populate the 8 existing project sections with actual content.
 * v2: Navigate directly to the coding projects page URL.
 *
 * Strategy: Use direct Playwright manipulation instead of editTextBlock,
 * since editTextBlock can't find the text (possible text-transform or
 * rendering issue). We'll:
 *   1. Navigate to each section by ID
 *   2. Double-click the text block to activate editor
 *   3. Select all + type new content
 *   4. Double-click button to open editor panel + set label
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, saveChanges, dblclickThroughOverlay, clickThroughOverlay } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const SECTION_IDS = [
  '6998b6a09463047a8fb1c422', // Section 0 — Menu Formatter
  '6998b6609463047a8fb1b68b', // Section 1 — Web Scraper
  '6998b620b4fa3256a4bb03ac', // Section 2 — InstaDownloader
  '6998b6ee752c90721b757fd3', // Section 3 — Community Care Map
  '6998b75325201324cd0c5528', // Section 4 — Prayer Map
  '6998b7ab9a433a09563d2d60', // Section 5 — PoolTogether Explorer
  '6998b7fa7503e854b6dd1142', // Section 6 — Prize Staking Vault Factory
  '6998b8543fd0b93b7177055f', // Section 7 — Bodega
];

const PROJECTS = [
  { title: 'Menu Formatter', description: 'AI-powered tool that converts messy restaurant menu text into clean, Squarespace-ready formatted output.', url: 'https://menu-block.lovable.app/' },
  { title: 'Web Scraper', description: 'Extract images, text, links, buttons, and forms from any URL. Supports single-page and full-site crawling.', url: 'https://webscrapetool.lovable.app' },
  { title: 'InstaDownloader', description: 'Download Instagram photos and videos from any public profile. Enter a username or paste a URL to save media.', url: 'https://instadownload.lovable.app' },
  { title: 'Community Care Map', description: 'Interactive map connecting people in need with local churches and nonprofits. Post needs and share resources.', url: 'https://resourcemap.lovable.app' },
  { title: 'Prayer Map', description: 'Share and pray for anonymous prayer requests on an interactive world map. No accounts needed. AI-moderated.', url: 'https://prayermap.lovable.app' },
  { title: 'PoolTogether Explorer', description: 'Track prize vaults, monitor contributions, and discover bonus rewards across multiple blockchain networks.', url: 'https://timalytics2.netlify.app' },
  { title: 'Prize Staking Vault Factory', description: 'Create custom tokens and deploy prize staking vaults. Powered by PoolTogether V5, supporting 4 networks.', url: 'https://staking.timalytics.com' },
  { title: 'Bodega', description: 'PoolTogether protocol account manager. Buy tickets for prize draws starting at just $3 per ticket.', url: 'https://bodega.timalytics.com' },
];

async function editTextInSection(
  page: Page,
  sectionId: string,
  textBlockIndex: number,
  newText: string,
  label: string,
): Promise<boolean> {
  const sf = getSiteFrame(page);
  if (!sf) return false;

  const section = sf.locator(`.page-section[data-section-id="${sectionId}"]`);
  const exists = await section.count().catch(() => 0);
  if (exists === 0) {
    console.log(`    ⚠ Section ${sectionId} not found`);
    return false;
  }

  // Find the text block within this section
  const textBlocks = section.locator('.sqs-block-html .sqs-block-content');
  const textCount = await textBlocks.count().catch(() => 0);
  if (textBlockIndex >= textCount) {
    console.log(`    ⚠ Text block index ${textBlockIndex} out of range (${textCount} blocks)`);
    return false;
  }

  const textBlock = textBlocks.nth(textBlockIndex);

  // Step 1: Click the section to select it
  const sectionSelector = `.page-section[data-section-id="${sectionId}"]`;
  const clickR = await clickThroughOverlay(page, sectionSelector);
  if (!clickR.success) {
    console.log(`    ⚠ Could not click section: ${clickR.message}`);
    return false;
  }
  await page.waitForTimeout(800);

  // Step 2: Check if Fluid Engine is active / Enter edit mode
  const addBlockVis = await page.getByRole('button', { name: /add block/i }).first()
    .isVisible({ timeout: 2000 }).catch(() => false);

  if (!addBlockVis) {
    // Try double-clicking to enter edit mode
    const dblR = await dblclickThroughOverlay(page, sectionSelector);
    if (!dblR.success) {
      console.log(`    ⚠ Could not dblclick section: ${dblR.message}`);
      return false;
    }
    await page.waitForTimeout(1500);
  }

  // Step 3: Scroll text block into view and double-click it
  await textBlock.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);

  const textSelector = `.page-section[data-section-id="${sectionId}"] .sqs-block-html:nth-of-type(${textBlockIndex + 1}) .sqs-block-content`;

  // Try to get the bounding box and double-click
  const box = await textBlock.boundingBox().catch(() => null);
  if (!box) {
    console.log(`    ⚠ Text block has no bounding box`);
    return false;
  }

  const viewport = page.viewportSize() || { width: 1440, height: 900 };
  if (box.y < 0 || box.y > viewport.height) {
    console.log(`    ⚠ Text block off-screen: y=${Math.round(box.y)}, vpH=${viewport.height}`);
    // Try scrolling again
    await textBlock.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    const box2 = await textBlock.boundingBox().catch(() => null);
    if (!box2 || box2.y < 0 || box2.y > viewport.height) {
      console.log(`    ⚠ Still off-screen after re-scroll`);
      return false;
    }
  }

  const finalBox = await textBlock.boundingBox().catch(() => null);
  if (!finalBox) return false;

  // Double-click to activate editor
  await page.mouse.dblclick(finalBox.x + finalBox.width / 2, finalBox.y + finalBox.height / 2);
  await page.waitForTimeout(1000);

  // Check if editor is active
  const siteFrame = page.frame({ name: 'sqs-site-frame' });
  let hasEditor = false;
  if (siteFrame) {
    hasEditor = await siteFrame.evaluate(() => {
      const active = document.activeElement;
      return active != null && (active as HTMLElement).isContentEditable;
    }).catch(() => false);
  }

  if (!hasEditor) {
    // Try pressing Enter
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    if (siteFrame) {
      hasEditor = await siteFrame.evaluate(() => {
        const active = document.activeElement;
        return active != null && (active as HTMLElement).isContentEditable;
      }).catch(() => false);
    }
  }

  if (!hasEditor) {
    console.log(`    ⚠ Could not activate text editor for ${label}`);
    return false;
  }

  // Select all and type
  await page.keyboard.press('Meta+a');
  await page.waitForTimeout(100);
  await page.keyboard.type(newText, { delay: 15 });
  await page.waitForTimeout(300);

  // Escape to deselect
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log(`    ✓ ${label}`);
  return true;
}

async function editButtonInSection(
  page: Page,
  sectionId: string,
  newLabel: string,
  url: string,
): Promise<boolean> {
  const sf = getSiteFrame(page);
  if (!sf) return false;

  const section = sf.locator(`.page-section[data-section-id="${sectionId}"]`);
  const buttons = section.locator('.sqs-block-button');
  const btnCount = await buttons.count().catch(() => 0);
  if (btnCount === 0) {
    console.log(`    ⚠ No button blocks in section ${sectionId}`);
    return false;
  }

  const button = buttons.first();
  await button.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);

  const btnBox = await button.boundingBox().catch(() => null);
  if (!btnBox) {
    console.log(`    ⚠ Button has no bounding box`);
    return false;
  }

  // Click the section first
  const sectionSelector = `.page-section[data-section-id="${sectionId}"]`;
  await clickThroughOverlay(page, sectionSelector);
  await page.waitForTimeout(500);

  // Enter edit mode
  await dblclickThroughOverlay(page, sectionSelector);
  await page.waitForTimeout(1000);

  // Click the button to select it
  const btnBox2 = await button.boundingBox().catch(() => null);
  if (!btnBox2) return false;
  await page.mouse.click(btnBox2.x + btnBox2.width / 2, btnBox2.y + btnBox2.height / 2);
  await page.waitForTimeout(800);

  // Double-click to open editor panel
  await page.mouse.dblclick(btnBox2.x + btnBox2.width / 2, btnBox2.y + btnBox2.height / 2);
  await page.waitForTimeout(1500);

  // Look for TEXT input in the editor panel
  let labelSet = false;
  const textInputSelectors = [
    'input[data-test="button-text-input"]',
    'input[placeholder*="Button"]',
    'input[value="Button"]',
    'input[value="SHOP NOW"]',
    'input[value="Shop Now"]',
  ];

  for (const sel of textInputSelectors) {
    const input = page.locator(sel).first();
    const visible = await input.isVisible({ timeout: 800 }).catch(() => false);
    if (visible) {
      await input.click();
      await input.fill(newLabel);
      labelSet = true;
      break;
    }
  }

  // Scan all visible text inputs
  if (!labelSet) {
    const allInputs = page.locator('input[type="text"], input:not([type])');
    const inputCount = await allInputs.count().catch(() => 0);
    for (let i = 0; i < inputCount; i++) {
      const inp = allInputs.nth(i);
      const vis = await inp.isVisible().catch(() => false);
      if (!vis) continue;
      const val = await inp.inputValue().catch(() => '');
      if (val === 'SHOP NOW' || val === 'Shop Now' || val === 'Button' || val === '') {
        await inp.click();
        await inp.fill(newLabel);
        labelSet = true;
        break;
      }
    }
  }

  // Look for URL input
  let urlSet = false;
  if (url) {
    const urlInputSelectors = [
      'input[data-test="button-url-input"]',
      'input[placeholder*="URL"]',
      'input[placeholder*="url"]',
      'input[placeholder*="Link"]',
      'input[placeholder*="link"]',
      'input[placeholder*="http"]',
    ];

    for (const sel of urlInputSelectors) {
      const input = page.locator(sel).first();
      const visible = await input.isVisible({ timeout: 800 }).catch(() => false);
      if (visible) {
        await input.click();
        await input.fill(url);
        urlSet = true;
        break;
      }
    }
  }

  // Escape to close editor
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log(`    ${labelSet ? '✓' : '✗'} button label${urlSet ? ' + URL' : url ? ' (URL not set)' : ''}`);
  return labelSet;
}

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Navigate directly to the Coding Projects page in edit mode
    console.log('\nNavigating to Coding Projects page...');
    await page.goto('https://tim-cox.squarespace.com/config/pages', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Click Coding Projects in the pages list
    const cpLink = page.locator('text=Coding Projects').first();
    if (await cpLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cpLink.click();
      console.log('Clicked Coding Projects link');
      await page.waitForTimeout(5000);
    } else {
      console.log('⚠ Coding Projects link not found!');
    }

    // Enter edit mode
    await enterEditMode(page);
    await page.waitForTimeout(3000);

    // Verify we're on the right page
    const sf = getSiteFrame(page);
    if (!sf) {
      console.log('⚠ No site frame!');
      return;
    }

    // Verify section count
    const sections = sf.locator('.page-section');
    const sectionCount = await sections.count();
    console.log(`Page has ${sectionCount} sections`);

    // Check the first section has an image (our project sections should)
    const firstSectionHasImg = await sections.first()
      .locator('.sqs-block-image img[src*="squarespace-cdn"], .sqs-block-image img[src*="images.squarespace"]')
      .count().catch(() => 0);
    console.log(`First section has CDN image: ${firstSectionHasImg > 0}`);

    // Look for our section IDs
    for (let i = 0; i < SECTION_IDS.length; i++) {
      const sid = SECTION_IDS[i];
      const found = await sf.locator(`.page-section[data-section-id="${sid}"]`).count().catch(() => 0);
      if (found === 0) {
        console.log(`⚠ Section ${i} (${sid}) NOT FOUND!`);
      }
    }

    // Check what text is actually in the first section
    const firstSection = sections.first();
    const firstText = await firstSection.locator('.sqs-block-html .sqs-block-content').first().innerText().catch(() => '(none)');
    console.log(`First section text: "${firstText.substring(0, 60)}"`);

    await takeScreenshot(page, 'populate-v2-start');

    console.log('\n=== Populating project content ===\n');

    let successCount = 0;

    for (let i = 0; i < PROJECTS.length; i++) {
      const p = PROJECTS[i];
      const sectionId = SECTION_IDS[i];
      console.log(`  [${i + 1}/${PROJECTS.length}] ${p.title}`);

      // Edit the first text block (title line — "BIG IDEAS, REAL IMPACT.")
      const titleOk = await editTextInSection(page, sectionId, 0, p.title, 'title');

      // Edit the second text block (description — "Driven by curiosity...")
      const descOk = await editTextInSection(page, sectionId, 1, p.description, 'description');

      // Edit button label + URL
      const btnOk = await editButtonInSection(page, sectionId, 'View Project', p.url);

      if (titleOk || descOk || btnOk) successCount++;
      console.log('');

      // Escape fully between sections
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      // Save every 4 projects
      if ((i + 1) % 4 === 0 && i < PROJECTS.length - 1) {
        console.log(`  --- Saving after ${i + 1} projects ---`);
        const sr = await saveChanges(page);
        console.log(`  ${sr.success ? '✓' : '✗'} ${sr.message}`);
        await page.waitForTimeout(2000);
        await enterEditMode(page);
        await page.waitForTimeout(2000);
        await takeScreenshot(page, `populate-v2-progress-${i + 1}`);
      }
    }

    // Final save
    console.log('\n=== Final Save ===');
    const sr = await saveChanges(page);
    console.log(sr.success ? `✅ ${sr.message}` : `⚠️ ${sr.message}`);
    await takeScreenshot(page, 'populate-v2-final');

    console.log(`\n✅ Done! ${successCount}/${PROJECTS.length} projects updated.`);
  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
