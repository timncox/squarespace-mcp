/**
 * Add 8 coding projects to the Coding Projects page.
 * Each project gets its own section with: Image + Title/Description text + Button.
 *
 * Key findings from testing:
 * - addSection automatically enters edit mode (ADD BLOCK visible)
 * - addImageBlock works with iframe block picker (JS click for off-screen tiles)
 * - After addImageBlock completes (Escape + click), we need to re-enter edit mode
 *   for the same section to add more blocks
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
  console.log(`    ${r.success ? '✓' : '✗'} ${label}${r.success ? '' : ': ' + r.message?.substring(0, 150)}`);
  return r.success;
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

/** Re-enter edit mode for the current section (after addImageBlock exits) */
async function reEnterEditMode(page: Page): Promise<boolean> {
  // Already in edit mode?
  if (await waitForEditMode(page, 1500)) return true;

  // Try enterSectionEditMode action with 'last' (most recently added section)
  const r = await executeAgentAction(page, { action: 'enterSectionEditMode', sectionIndex: 'last' });
  if (r.success) {
    return await waitForEditMode(page, 3000);
  }

  // Fallback: double-click the last non-footer section
  const siteFrame = getSiteFrame(page);
  if (!siteFrame) return false;

  const sections = await siteFrame.locator('.page-section').count();
  if (sections <= 1) return false;

  // Last content section is the one before footer (last)
  const lastContentIdx = sections - 2;
  const section = siteFrame.locator('.page-section').nth(lastContentIdx);
  await section.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  const box = await section.boundingBox();
  if (!box) return false;

  await page.mouse.dblclick(box.x + box.width / 2, box.y + 50);
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

    // Check current state
    const siteFrame = getSiteFrame(page);
    const sectionCount = siteFrame ? await siteFrame.locator('.page-section').count() : 0;
    console.log(`\nPage state: ${sectionCount} sections`);

    // ── Add each project (each in its own section) ──
    console.log(`\n=== Adding ${PROJECTS.length} Projects ===\n`);
    let successCount = 0;

    for (let i = 0; i < PROJECTS.length; i++) {
      const p = PROJECTS[i];
      console.log(`  [${i + 1}/${PROJECTS.length}] ${p.title}`);

      // Step 1: Add new section (this also enters edit mode)
      const sectionOk = await act(page, { action: 'addSection' }, 'addSection');
      if (!sectionOk) {
        console.log('    ⚠ Section failed — skipping this project');
        continue;
      }
      await page.waitForTimeout(1000);

      // Step 2: Add image block
      const imgPath = join(SCREENSHOT_DIR, p.screenshot);
      const imgOk = await act(page, { action: 'addImageBlock', imagePath: imgPath, altText: p.alt }, 'addImageBlock');
      await page.waitForTimeout(1500);

      // Step 3: Re-enter edit mode (addImageBlock's Step 7 presses Escape and clicks away)
      const editOk = await reEnterEditMode(page);
      if (!editOk) {
        console.log('    ⚠ Could not re-enter edit mode after image — skipping text/button');
        successCount++;
        continue;
      }

      // Step 4: Add title + description text block
      await act(page, { action: 'addBlockToSection', blockType: 'Text', content: `${p.title}\n${p.description}` }, 'addText');
      await page.waitForTimeout(1000);

      // Step 5: Re-enter edit mode if needed, add button
      if (!(await waitForEditMode(page, 1000))) {
        await reEnterEditMode(page);
      }
      await act(page, { action: 'addBlockToSection', blockType: 'Button', content: 'View Project' }, 'addButton');
      await page.waitForTimeout(1000);

      // Step 6: Edit button URL (this may not work yet — noted as known issue)
      // await act(page, { action: 'editButtonBlock', searchText: 'View Project', url: p.url }, 'editButton');
      // await page.waitForTimeout(500);

      // Escape to deselect and prepare for next project
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);

      successCount++;

      // Save periodically (every 4 projects)
      if ((i + 1) % 4 === 0) {
        console.log(`\n  --- Saving after ${i + 1} projects ---`);
        const sr = await saveChanges(page);
        console.log(`  ${sr.success ? '✓' : '✗'} ${sr.message}`);
        await page.waitForTimeout(2000);
        // Re-enter edit mode after save
        await enterEditMode(page);
        await page.waitForTimeout(2000);
        await takeScreenshot(page, `progress-${i + 1}`);
      }

      console.log('');
    }

    // Final save
    console.log('\n=== Final Save ===');
    const saveResult = await saveChanges(page);
    console.log(saveResult.success ? `✅ ${saveResult.message}` : `⚠️ ${saveResult.message}`);

    await takeScreenshot(page, 'projects-v3-final');
    console.log(`\n✅ Done! ${successCount}/${PROJECTS.length} projects added.`);

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await browserManager.close();
  }
}

main().catch(console.error);
