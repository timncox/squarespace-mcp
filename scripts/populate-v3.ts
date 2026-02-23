/**
 * Populate the 8 existing project sections with actual content.
 * v3: Click text blocks DIRECTLY (not section center) to activate editor.
 *
 * Each section has:
 *   - 1 image block (already uploaded)
 *   - 2 text blocks: "BIG IDEAS, REAL IMPACT." + "Driven by curiosity..."
 *   - 1 button: already changed to "View Project" (from populate-v2)
 *
 * We replace both text blocks with project title and description.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { getSiteFrame, saveChanges, clickThroughOverlay, dblclickThroughOverlay } from '../src/automation/editor-actions.js';
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

/**
 * Edit a text block by clicking it directly (not via section).
 * Flow: click text block → section gets selected → double-click → editor activates → Cmd+A → type
 */
async function editTextBlock(
  page: Page,
  sectionId: string,
  blockIndex: number,
  newText: string,
  label: string,
): Promise<boolean> {
  const selector = blockIndex === 0
    ? `.page-section[data-section-id="${sectionId}"] .sqs-block-html:first-of-type .sqs-block-content`
    : `.page-section[data-section-id="${sectionId}"] .sqs-block-html:nth-of-type(2) .sqs-block-content`;

  // Click the text block directly
  const clickR = await clickThroughOverlay(page, selector);
  if (!clickR.success) {
    // Fallback: try nth-child or different selector
    const fallbackSel = `.page-section[data-section-id="${sectionId}"] .sqs-block-html .sqs-block-content`;
    const sf = getSiteFrame(page);
    if (sf) {
      const blocks = sf.locator(fallbackSel);
      const count = await blocks.count().catch(() => 0);
      if (blockIndex < count) {
        const block = blocks.nth(blockIndex);
        await block.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
        const box = await block.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(500);
        } else {
          console.log(`    ⚠ ${label}: text block not found`);
          return false;
        }
      } else {
        console.log(`    ⚠ ${label}: block index ${blockIndex} >= count ${count}`);
        return false;
      }
    } else {
      console.log(`    ⚠ ${label}: click failed and no site frame`);
      return false;
    }
  }
  await page.waitForTimeout(500);

  // Double-click the text block to activate editor
  const dblR = await dblclickThroughOverlay(page, selector);
  if (!dblR.success) {
    // Fallback: use boundingBox
    const sf = getSiteFrame(page);
    if (sf) {
      const blocks = sf.locator(`.page-section[data-section-id="${sectionId}"] .sqs-block-html .sqs-block-content`);
      const count = await blocks.count().catch(() => 0);
      if (blockIndex < count) {
        const box = await blocks.nth(blockIndex).boundingBox().catch(() => null);
        if (box) {
          await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(1000);
        }
      }
    }
  }
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
    console.log(`    ⚠ ${label}: could not activate text editor`);
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
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log(`    ✓ ${label}`);
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
      await page.waitForTimeout(5000);
    }

    await enterEditMode(page);
    await page.waitForTimeout(3000);

    // Verify we're on the right page
    const sf = getSiteFrame(page);
    if (!sf) { console.log('⚠ No site frame!'); return; }

    const sectionCount = await sf.locator('.page-section').count();
    console.log(`Page has ${sectionCount} sections`);
    const firstText = await sf.locator('.page-section:first-of-type .sqs-block-html .sqs-block-content').first().innerText().catch(() => '');
    console.log(`First section text: "${firstText.substring(0, 40)}"`);

    await takeScreenshot(page, 'populate-v3-start');

    console.log('\n=== Populating project content ===\n');
    let successCount = 0;

    for (let i = 0; i < PROJECTS.length; i++) {
      const p = PROJECTS[i];
      const sectionId = SECTION_IDS[i];
      console.log(`  [${i + 1}/${PROJECTS.length}] ${p.title}`);

      // Edit title text (first text block)
      const titleOk = await editTextBlock(page, sectionId, 0, p.title, 'title');

      // Edit description text (second text block)
      const descOk = await editTextBlock(page, sectionId, 1, p.description, 'description');

      if (titleOk || descOk) successCount++;
      console.log('');

      // Save every 4 projects
      if ((i + 1) % 4 === 0 && i < PROJECTS.length - 1) {
        console.log(`  --- Saving after ${i + 1} projects ---`);
        const sr = await saveChanges(page);
        console.log(`  ${sr.success ? '✓' : '✗'} ${sr.message}`);
        await page.waitForTimeout(2000);
        await enterEditMode(page);
        await page.waitForTimeout(2000);
        await takeScreenshot(page, `populate-v3-progress-${i + 1}`);
      }
    }

    // Final save
    console.log('\n=== Final Save ===');
    const sr = await saveChanges(page);
    console.log(sr.success ? `✅ ${sr.message}` : `⚠️ ${sr.message}`);
    await takeScreenshot(page, 'populate-v3-final');

    // Verify
    console.log('\n=== Verification ===');
    const sf2 = getSiteFrame(page);
    if (sf2) {
      for (let i = 0; i < SECTION_IDS.length; i++) {
        const sid = SECTION_IDS[i];
        const sec = sf2.locator(`.page-section[data-section-id="${sid}"]`);
        const textBlocks = sec.locator('.sqs-block-html .sqs-block-content');
        const cnt = await textBlocks.count().catch(() => 0);
        const t1 = cnt > 0 ? await textBlocks.nth(0).innerText().catch(() => '') : '';
        const t2 = cnt > 1 ? await textBlocks.nth(1).innerText().catch(() => '') : '';
        console.log(`  Section ${i}: "${t1.trim().substring(0, 30)}" | "${t2.trim().substring(0, 40)}"`);
      }
    }

    console.log(`\n✅ Done! ${successCount}/${PROJECTS.length} projects updated.`);
  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
