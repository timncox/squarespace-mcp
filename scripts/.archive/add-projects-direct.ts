/**
 * Add 8 coding projects to the Coding Projects page using direct action calls.
 * Bypasses the browser agent's Claude loop for speed and reliability.
 *
 * Each project: addSection → enterSectionEditMode → addImageBlock → addBlockToSection(Text) → addBlockToSection(Button) → editButtonBlock
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { join } from 'path';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const SCREENSHOT_DIR = join(process.cwd(), 'storage', 'uploads', 'project-screenshots');

const PROJECTS = [
  {
    title: 'Menu Formatter',
    description: 'AI-powered tool that converts messy restaurant menu text into clean, Squarespace-ready formatted output.',
    url: 'https://menu-block.lovable.app/',
    screenshot: join(SCREENSHOT_DIR, 'menu-block-lovable-app.png'),
    alt: 'Menu Formatter app screenshot',
  },
  {
    title: 'Web Scraper',
    description: 'Extract images, text, links, buttons, and forms from any URL. Supports single-page and full-site crawling.',
    url: 'https://webscrapetool.lovable.app',
    screenshot: join(SCREENSHOT_DIR, 'webscrapetool-lovable-app.png'),
    alt: 'Web Scraper tool screenshot',
  },
  {
    title: 'InstaDownloader',
    description: 'Download Instagram photos and videos from any public profile. Enter a username or paste a URL to save media.',
    url: 'https://instadownload.lovable.app',
    screenshot: join(SCREENSHOT_DIR, 'instadownload-lovable-app.png'),
    alt: 'InstaDownloader app screenshot',
  },
  {
    title: 'Community Care Map',
    description: 'Interactive map connecting people in need with local churches and nonprofits. Post needs and share resources.',
    url: 'https://resourcemap.lovable.app',
    screenshot: join(SCREENSHOT_DIR, 'resourcemap-lovable-app.png'),
    alt: 'Community Care Map app screenshot',
  },
  {
    title: 'Prayer Map',
    description: 'Share and pray for anonymous prayer requests on an interactive world map. No accounts needed. AI-moderated.',
    url: 'https://prayermap.lovable.app',
    screenshot: join(SCREENSHOT_DIR, 'prayermap-lovable-app.png'),
    alt: 'Prayer Map app screenshot',
  },
  {
    title: 'PoolTogether Explorer',
    description: 'Track prize vaults, monitor contributions, and discover bonus rewards across multiple blockchain networks.',
    url: 'https://timalytics2.netlify.app',
    screenshot: join(SCREENSHOT_DIR, 'timalytics2-netlify-app.png'),
    alt: 'PoolTogether Explorer dashboard screenshot',
  },
  {
    title: 'Prize Staking Vault Factory',
    description: 'Create custom tokens and deploy prize staking vaults. Powered by PoolTogether V5, supporting 4 networks.',
    url: 'https://staking.timalytics.com',
    screenshot: join(SCREENSHOT_DIR, 'staking-timalytics-com.png'),
    alt: 'Prize Staking Vault Factory screenshot',
  },
  {
    title: 'Bodega',
    description: 'PoolTogether protocol account manager. Buy tickets for prize draws starting at just $3 per ticket.',
    url: 'https://bodega.timalytics.com',
    screenshot: join(SCREENSHOT_DIR, 'bodega-timalytics-com.png'),
    alt: 'Bodega PoolTogether app screenshot',
  },
];

async function runAction(page: any, action: any, label: string): Promise<boolean> {
  const result = await executeAgentAction(page, action);
  const status = result.success ? '✓' : '✗';
  console.log(`    ${status} ${label}: ${result.message?.substring(0, 120) || ''}`);
  return result.success;
}

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

    // First add a hero section with title
    console.log('\n=== Adding Hero Section ===');
    await runAction(page, { action: 'addSection' }, 'addSection (hero)');
    await page.waitForTimeout(1000);
    await runAction(page, { action: 'enterSectionEditMode', sectionIndex: 'last' }, 'enterSectionEditMode');
    await page.waitForTimeout(500);
    await runAction(page, { action: 'addBlockToSection', blockType: 'Text', content: 'BIG IDEAS, REAL IMPACT\nCoding projects built with purpose — from AI tools to blockchain apps.' }, 'addText (hero)');
    await page.waitForTimeout(1000);

    // Click somewhere neutral to deselect (escape edit mode)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    console.log(`\n=== Adding ${PROJECTS.length} Projects ===\n`);

    for (let i = 0; i < PROJECTS.length; i++) {
      const p = PROJECTS[i];
      console.log(`  [${i + 1}/${PROJECTS.length}] ${p.title}`);

      // Step 1: Add new section
      await runAction(page, { action: 'addSection' }, 'addSection');
      await page.waitForTimeout(1000);

      // Step 2: Enter edit mode on the new section
      await runAction(page, { action: 'enterSectionEditMode', sectionIndex: 'last' }, 'enterSectionEditMode');
      await page.waitForTimeout(500);

      // Step 3: Add image block
      await runAction(page, { action: 'addImageBlock', imagePath: p.screenshot, altText: p.alt }, 'addImageBlock');
      await page.waitForTimeout(1500);

      // Step 4: Add text block (title + description)
      await runAction(page, { action: 'addBlockToSection', blockType: 'Text', content: `${p.title}\n${p.description}` }, 'addText');
      await page.waitForTimeout(1000);

      // Step 5: Add button block
      await runAction(page, { action: 'addBlockToSection', blockType: 'Button', content: 'View Project' }, 'addButton');
      await page.waitForTimeout(1000);

      // Step 6: Set button URL
      await runAction(page, { action: 'editButtonBlock', searchText: 'View Project', url: p.url }, 'editButton');
      await page.waitForTimeout(500);

      // Escape to deselect before next project
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      console.log('');
    }

    // Save
    console.log('Saving...');
    const saveResult = await saveChanges(page);
    console.log(saveResult.success ? `✅ ${saveResult.message}` : `⚠️ ${saveResult.message}`);

    await takeScreenshot(page, 'projects-added-final');
    console.log('\nDone! All projects added.');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
