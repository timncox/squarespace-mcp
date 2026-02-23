/**
 * Add hero + 8 coding projects to the (empty) Coding Projects page.
 * Handles empty page state: uses the central ADD SECTION button for first section,
 * then addSection action for subsequent ones.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { join } from 'path';
import { Page } from 'playwright';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { enterEditMode } from '../src/automation/site-navigator.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { getSiteFrame, saveChanges } from '../src/automation/editor-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';

const SCREENSHOT_DIR = join(process.cwd(), 'storage', 'uploads', 'project-screenshots');

const PROJECTS = [
  { title: 'Menu Formatter', description: 'AI-powered tool that converts messy restaurant menu text into clean, Squarespace-ready formatted output.', url: 'https://menu-block.lovable.app/', screenshot: 'menu-block-lovable-app.png', alt: 'Menu Formatter app screenshot' },
  { title: 'Web Scraper', description: 'Extract images, text, links, buttons, and forms from any URL. Supports single-page and full-site crawling.', url: 'https://webscrapetool.lovable.app', screenshot: 'webscrapetool-lovable-app.png', alt: 'Web Scraper tool screenshot' },
  { title: 'InstaDownloader', description: 'Download Instagram photos and videos from any public profile. Enter a username or paste a URL to save media.', url: 'https://instadownload.lovable.app', screenshot: 'instadownload-lovable-app.png', alt: 'InstaDownloader app screenshot' },
  { title: 'Community Care Map', description: 'Interactive map connecting people in need with local churches and nonprofits. Post needs and share resources.', url: 'https://resourcemap.lovable.app', screenshot: 'resourcemap-lovable-app.png', alt: 'Community Care Map app screenshot' },
  { title: 'Prayer Map', description: 'Share and pray for anonymous prayer requests on an interactive world map. No accounts needed. AI-moderated.', url: 'https://prayermap.lovable.app', screenshot: 'prayermap-lovable-app.png', alt: 'Prayer Map app screenshot' },
  { title: 'PoolTogether Explorer', description: 'Track prize vaults, monitor contributions, and discover bonus rewards across multiple blockchain networks.', url: 'https://timalytics2.netlify.app', screenshot: 'timalytics2-netlify-app.png', alt: 'PoolTogether Explorer dashboard screenshot' },
  { title: 'Prize Staking Vault Factory', description: 'Create custom tokens and deploy prize staking vaults. Powered by PoolTogether V5, supporting 4 networks.', url: 'https://staking.timalytics.com', screenshot: 'staking-timalytics-com.png', alt: 'Prize Staking Vault Factory screenshot' },
  { title: 'Bodega', description: 'PoolTogether protocol account manager. Buy tickets for prize draws starting at just $3 per ticket.', url: 'https://bodega.timalytics.com', screenshot: 'bodega-timalytics-com.png', alt: 'Bodega PoolTogether app screenshot' },
];

async function act(page: Page, action: any, label: string): Promise<boolean> {
  const r = await executeAgentAction(page, action);
  console.log(`    ${r.success ? '✓' : '✗'} ${label}${r.success ? '' : ': ' + r.message?.substring(0, 120)}`);
  return r.success;
}

/** Click the central "ADD SECTION" button on an empty page (inside the iframe) */
async function addFirstSection(page: Page): Promise<boolean> {
  // The ADD SECTION button on an empty page is INSIDE the iframe (#sqs-site-frame)
  const siteFrame = getSiteFrame(page);
  if (!siteFrame) return false;

  const btn = siteFrame.locator('button:has-text("ADD SECTION")').first();
  const box = await btn.boundingBox().catch(() => null);
  if (!box) {
    console.log('    ✗ ADD SECTION button not found in iframe');
    return false;
  }

  // Click through the overlay at viewport-relative coords
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  console.log(`    ✓ Clicked ADD SECTION at (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)})`);
  await page.waitForTimeout(1500);

  // Click "Add Blank" in the section picker
  const addBlank = page.locator(':has-text("Add Blank")').first();
  if (await addBlank.isVisible({ timeout: 3000 }).catch(() => false)) {
    await addBlank.click();
    console.log('    ✓ Clicked Add Blank');
    await page.waitForTimeout(3000);
    return true;
  }
  await page.waitForTimeout(2000);
  return true;
}

/** Wait for section edit mode (ADD BLOCK visible) */
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

/** Enter section edit mode by clicking the section and then EDIT SECTION/EDIT CONTENT */
async function enterSectionEdit(page: Page): Promise<boolean> {
  // First check if already in edit mode
  if (await waitForEditMode(page, 1500)) return true;

  // Try double-clicking the last section to enter edit mode
  const siteFrame = getSiteFrame(page);
  if (!siteFrame) return false;

  const sections = await siteFrame.locator('.page-section').count();
  if (sections === 0) return false;

  // Click through overlay on the last non-footer section
  const lastContentIdx = Math.max(0, sections - 2);
  const section = siteFrame.locator('.page-section').nth(lastContentIdx);
  await section.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  const box = await section.boundingBox();
  if (!box) return false;

  // Single click to select
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(800);

  // Check for EDIT SECTION / EDIT CONTENT button
  const editBtn = page.getByRole('button', { name: /edit (section|content)/i });
  if (await editBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await editBtn.first().click();
    await page.waitForTimeout(1500);
    return await waitForEditMode(page, 3000);
  }

  // Double-click to enter edit mode directly
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1500);
  return await waitForEditMode(page, 3000);
}

async function main() {
  const browserManager = getBrowserManager({ headless: false });
  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

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

    // First, check if the footer has the "BIG IDEAS" text from previous failed run
    // and undo it if needed
    console.log('\n=== Checking page state ===');
    const siteFrame = getSiteFrame(page);
    if (siteFrame) {
      const sectionCount = await siteFrame.locator('.page-section').count();
      console.log(`  Sections in iframe: ${sectionCount}`);

      // Check for "Empty Page" text (means we need to add from scratch)
      const emptyPage = await page.locator('text=Empty Page').isVisible({ timeout: 2000 }).catch(() => false);
      const addPageContent = await page.locator('text=Add Page Content').isVisible({ timeout: 1000 }).catch(() => false);
      console.log(`  Empty page: ${emptyPage}, Add Page Content visible: ${addPageContent}`);
    }

    // ── Undo any footer damage from previous run ──
    // Press Cmd+Z a bunch of times to undo, then save
    console.log('\n=== Undoing previous changes ===');
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Meta+z');
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(2000);

    // Save the undo state
    const undoSave = await saveChanges(page);
    console.log(`  Undo save: ${undoSave.message}`);
    await page.waitForTimeout(1000);

    // Take screenshot to see state after undo
    await takeScreenshot(page, 'after-undo');

    // Re-check section count
    const siteFrame2 = getSiteFrame(page);
    let currentSections = 0;
    if (siteFrame2) {
      currentSections = await siteFrame2.locator('.page-section').count();
      console.log(`  Sections after undo: ${currentSections}`);
    }

    // ── Add hero section ──
    console.log('\n=== Adding Hero Section ===');

    // Check if the "Add Page Content" / "ADD SECTION" button is visible (empty page)
    const emptyPageBtn = await page.locator('text=Add Page Content').isVisible({ timeout: 2000 }).catch(() => false);

    if (emptyPageBtn || currentSections <= 1) {
      console.log('  Page is empty — using central ADD SECTION button');
      const added = await addFirstSection(page);
      if (!added) {
        console.log('  ✗ Could not add first section');
        await takeScreenshot(page, 'first-section-fail');
        return;
      }
    } else {
      // Page has sections — use addSection action
      await act(page, { action: 'addSection' }, 'addSection');
      await page.waitForTimeout(1000);
    }

    // Enter edit mode for the new section
    console.log('  Entering edit mode...');
    const inEditMode = await enterSectionEdit(page);
    console.log(`  Edit mode: ${inEditMode}`);

    if (inEditMode) {
      await act(page, { action: 'addBlockToSection', blockType: 'Text', content: 'BIG IDEAS, REAL IMPACT\nCoding projects built with purpose — from AI tools to blockchain apps.' }, 'addText (hero)');
      await page.waitForTimeout(1000);
    }

    // Escape to deselect
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // ── Add each project ──
    console.log(`\n=== Adding ${PROJECTS.length} Projects ===\n`);

    for (let i = 0; i < PROJECTS.length; i++) {
      const p = PROJECTS[i];
      console.log(`  [${i + 1}/${PROJECTS.length}] ${p.title}`);

      // Add new section
      const sectionAdded = await act(page, { action: 'addSection' }, 'addSection');
      if (!sectionAdded) {
        console.log('    Trying central ADD SECTION button fallback...');
        await addFirstSection(page);
      }
      await page.waitForTimeout(1000);

      // Enter edit mode
      const editOk = await enterSectionEdit(page);
      if (!editOk) {
        // Try the action handler as fallback
        await act(page, { action: 'enterSectionEditMode', sectionIndex: 'last' }, 'enterSectionEditMode (fallback)');
        await page.waitForTimeout(500);
      }

      // Add image block (may exit edit mode afterward)
      const imgPath = join(SCREENSHOT_DIR, p.screenshot);
      await act(page, { action: 'addImageBlock', imagePath: imgPath, altText: p.alt }, 'addImageBlock');
      await page.waitForTimeout(1500);

      // Re-enter edit mode (addImageBlock closes the panel and exits edit mode)
      if (!(await waitForEditMode(page, 1500))) {
        await enterSectionEdit(page);
      }

      await act(page, { action: 'addBlockToSection', blockType: 'Text', content: `${p.title}\n${p.description}` }, 'addText');
      await page.waitForTimeout(1000);

      // Re-enter edit mode if needed
      if (!(await waitForEditMode(page, 1000))) {
        await enterSectionEdit(page);
      }

      await act(page, { action: 'addBlockToSection', blockType: 'Button', content: 'View Project' }, 'addButton');
      await page.waitForTimeout(1000);

      await act(page, { action: 'editButtonBlock', searchText: 'View Project', url: p.url }, 'editButton');
      await page.waitForTimeout(500);

      // Escape to deselect
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      // Take progress screenshot every 4 projects
      if ((i + 1) % 4 === 0) {
        await takeScreenshot(page, `progress-${i + 1}`);
      }

      console.log('');
    }

    // Final save
    console.log('Saving...');
    const saveResult = await saveChanges(page);
    console.log(saveResult.success ? `✅ ${saveResult.message}` : `⚠️ ${saveResult.message}`);

    await takeScreenshot(page, 'projects-v2-final');
    console.log('\n✅ Done!');

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
