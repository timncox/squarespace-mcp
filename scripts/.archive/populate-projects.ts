/**
 * Populate the 8 existing project sections with actual content.
 * Each section currently has template defaults:
 *   - 2 text blocks: "BIG IDEAS, REAL IMPACT." + "Driven by curiosity..."
 *   - 1 button: "SHOP NOW"
 *
 * We'll replace the first text with project title/description
 * and update the button label.
 *
 * We also remove the test section (section 8) and section 5's missing image.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { join } from 'path';
import { Page } from 'playwright';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { getSiteFrame, saveChanges, dblclickThroughOverlay } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const SECTION_IDS = [
  '6998b6a09463047a8fb1c422', // Section 0 — Menu Formatter
  '6998b6609463047a8fb1b68b', // Section 1 — Web Scraper
  '6998b620b4fa3256a4bb03ac', // Section 2 — InstaDownloader
  '6998b6ee752c90721b757fd3', // Section 3 — Community Care Map
  '6998b75325201324cd0c5528', // Section 4 — Prayer Map
  '6998b7ab9a433a09563d2d60', // Section 5 — PoolTogether Explorer (no image)
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

async function waitForEditMode(page: Page, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const visible = await page.getByRole('button', { name: /add block/i }).first()
      .isVisible({ timeout: 500 }).catch(() => false);
    if (visible) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function main() {
  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // Navigate to Coding Projects page
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

    const sf = getSiteFrame(page);
    if (!sf) {
      console.log('No site frame found');
      return;
    }

    console.log('\n=== Populating project content ===\n');

    for (let i = 0; i < PROJECTS.length; i++) {
      const p = PROJECTS[i];
      const sectionId = SECTION_IDS[i];
      console.log(`  [${i + 1}/${PROJECTS.length}] ${p.title} (section: ${sectionId})`);

      // ── Step 1: Replace the first text block ("BIG IDEAS, REAL IMPACT.") ──
      // Use editTextBlock which handles section clicking, edit mode, and typing
      console.log('    Replacing title text...');
      const titleResult = await executeAgentAction(page, {
        action: 'editTextBlock',
        searchText: 'BIG IDEAS',
        newText: p.title,
      });
      console.log(`    ${titleResult.success ? '✓' : '✗'} editTitle: ${titleResult.message?.substring(0, 120)}`);
      await page.waitForTimeout(1000);

      // Escape to deselect
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      // ── Step 2: Replace the description text ("Driven by curiosity...") ──
      console.log('    Replacing description text...');
      const descResult = await executeAgentAction(page, {
        action: 'editTextBlock',
        searchText: 'Driven by curiosity',
        newText: p.description,
      });
      console.log(`    ${descResult.success ? '✓' : '✗'} editDesc: ${descResult.message?.substring(0, 120)}`);
      await page.waitForTimeout(1000);

      // Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      // ── Step 3: Update button label from "SHOP NOW" to "View Project" ──
      console.log('    Updating button label...');
      const btnResult = await executeAgentAction(page, {
        action: 'editButtonBlock',
        searchText: 'SHOP NOW',
        newLabel: 'View Project',
        url: p.url,
      });
      console.log(`    ${btnResult.success ? '✓' : '✗'} editButton: ${btnResult.message?.substring(0, 120)}`);
      await page.waitForTimeout(1000);

      // Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      console.log('');

      // Save every 4 projects
      if ((i + 1) % 4 === 0) {
        console.log(`  --- Saving after ${i + 1} projects ---`);
        const sr = await saveChanges(page);
        console.log(`  ${sr.success ? '✓' : '✗'} ${sr.message}`);
        await page.waitForTimeout(2000);
        await enterEditMode(page);
        await page.waitForTimeout(2000);
        await takeScreenshot(page, `populate-progress-${i + 1}`);
      }
    }

    // Final save
    console.log('\n=== Final Save ===');
    const saveResult = await saveChanges(page);
    console.log(saveResult.success ? `✅ ${saveResult.message}` : `⚠️ ${saveResult.message}`);
    await takeScreenshot(page, 'populate-final');

    // Verify
    console.log('\n=== Verification ===');
    const sf2 = getSiteFrame(page);
    if (sf2) {
      const sections = sf2.locator('.page-section');
      const count = await sections.count();
      for (let i = 0; i < Math.min(count, 8); i++) {
        const section = sections.nth(i);
        const textBlocks = section.locator('.sqs-block-html .sqs-block-content');
        const textCount = await textBlocks.count().catch(() => 0);
        const firstText = textCount > 0 ? await textBlocks.first().innerText().catch(() => '') : '';
        const buttons = section.locator('.sqs-block-button');
        const btnText = await buttons.first().innerText().catch(() => '');
        console.log(`  Section ${i}: text="${firstText.trim().substring(0, 40)}" btn="${btnText.trim()}"`);
      }
    }

    console.log('\n✅ Done!');
  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

main().catch(console.error);
