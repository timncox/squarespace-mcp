/**
 * Add/update projects on the Coding Projects page.
 *
 * Phase 1: Screenshot external sites + generate titles/descriptions via Claude
 * Phase 2: Add missing project sections to Squarespace
 *
 * Current state of the page:
 * - 7 projects already exist with screenshots, titles, descriptions, buttons
 * - menu-block.lovable.app is MISSING (needs new section)
 * - PoolTogether Explorer is missing its screenshot image
 * - "Test Title" section is a leftover test artifact (needs removal)
 * - Empty section at bottom (needs removal)
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
import { chromium } from 'playwright';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { executeAgentAction } from '../src/automation/browser-agent-actions.js';
import { takeScreenshot } from '../src/utils/screenshot.js';
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

// Sites that need screenshots captured
const SITES_TO_CAPTURE = [
  { url: 'https://menu-block.lovable.app/', name: 'menu-block' },
  { url: 'https://timalytics2.netlify.app/', name: 'pooltogether-explorer' },
];

interface ProjectInfo {
  url: string;
  name: string;
  screenshotPath: string;
  title: string;
  description: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 1: Capture screenshots + generate content
// ════════════════════════════════════════════════════════════════════════════

async function captureScreenshots(): Promise<Map<string, string>> {
  console.log('\n══════════════════════════════════');
  console.log('  PHASE 1: Capture Screenshots');
  console.log('══════════════════════════════════\n');

  const uploadDir = path.resolve('storage/uploads');
  if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const screenshotPaths = new Map<string, string>();

  for (const site of SITES_TO_CAPTURE) {
    console.log(`\nCapturing ${site.url}...`);
    const sitePage = await context.newPage();
    try {
      await sitePage.goto(site.url, { waitUntil: 'networkidle', timeout: 30000 });
      await sitePage.waitForTimeout(3000); // Let animations settle

      const filename = `project-${site.name}.png`;
      const filepath = path.join(uploadDir, filename);
      await sitePage.screenshot({ path: filepath, type: 'png' });
      console.log(`  ✅ Saved to ${filepath}`);
      screenshotPaths.set(site.name, filepath);
    } catch (err) {
      console.error(`  ❌ Failed: ${(err as Error).message}`);
      // Try with longer timeout and domcontentloaded
      try {
        await sitePage.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sitePage.waitForTimeout(5000);
        const filename = `project-${site.name}.png`;
        const filepath = path.join(uploadDir, filename);
        await sitePage.screenshot({ path: filepath, type: 'png' });
        console.log(`  ✅ Saved (fallback) to ${filepath}`);
        screenshotPaths.set(site.name, filepath);
      } catch (err2) {
        console.error(`  ❌ Fallback also failed: ${(err2 as Error).message}`);
      }
    }
    await sitePage.close();
  }

  await browser.close();
  return screenshotPaths;
}

async function generateContent(screenshotPaths: Map<string, string>): Promise<ProjectInfo | null> {
  console.log('\n══════════════════════════════════');
  console.log('  PHASE 1b: Generate Content');
  console.log('══════════════════════════════════\n');

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const menuBlockPath = screenshotPaths.get('menu-block');
  if (!menuBlockPath) {
    console.log('❌ No screenshot for menu-block');
    return null;
  }

  // Read the screenshot and send to Claude for title + description
  const imageData = readFileSync(menuBlockPath);
  const base64 = imageData.toString('base64');

  console.log('Generating title and description for menu-block...');
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: base64 },
        },
        {
          type: 'text',
          text: `This is a screenshot of a web app at https://menu-block.lovable.app/. Generate a concise project title (2-4 words, no quotes) and a brief description (1-2 sentences, ~20-30 words) for a portfolio page. The description should explain what the app does in simple terms. Match the tone of these existing project descriptions:

- "Extract images, text, links, buttons, and forms from any URL. Supports single-page and full-site crawling."
- "Download Instagram photos and videos from any public profile. Enter a username or paste a URL to save content."
- "Interactive map connecting people in need with local churches and nonprofits."

Reply in this exact JSON format only, no other text:
{"title": "...", "description": "..."}`,
        },
      ],
    }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    console.log('❌ No text response from Claude');
    return null;
  }

  try {
    // Extract JSON from response (may have markdown wrapper)
    let jsonStr = textBlock.text.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);
    console.log(`  Title: ${parsed.title}`);
    console.log(`  Description: ${parsed.description}`);

    return {
      url: 'https://menu-block.lovable.app/',
      name: 'menu-block',
      screenshotPath: menuBlockPath,
      title: parsed.title,
      description: parsed.description,
    };
  } catch (err) {
    console.error('❌ Failed to parse Claude response:', textBlock.text);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 2: Edit Squarespace page
// ════════════════════════════════════════════════════════════════════════════

async function editSquarespacePage(
  newProject: ProjectInfo | null,
  ptScreenshotPath: string | undefined,
) {
  console.log('\n══════════════════════════════════');
  console.log('  PHASE 2: Edit Squarespace Page');
  console.log('══════════════════════════════════\n');

  const bm = getBrowserManager({ headless: false });
  try {
    await bm.initialize();
    await ensureLoggedIn(bm);
    const page = await bm.getPage();

    // ── Task A: Remove "Test Title" leftover section ──
    console.log('\n── Task A: Remove "Test Title" section ──');
    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Enter edit mode
    const editBtn = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
    if (await editBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await editBtn.click();
      await page.waitForTimeout(3000);
    }

    // Find the "Test Title" section and delete it
    const iframe = page.frameLocator('#sqs-site-frame');
    const sections = iframe.locator('section.page-section[data-section-id]');
    const secCount = await sections.count();
    console.log(`  Found ${secCount} sections`);

    for (let i = 0; i < secCount; i++) {
      const text = await sections.nth(i).innerText().catch(() => '');
      if (text.includes('Test Title') && text.includes('SHOP NOW')) {
        console.log(`  Found "Test Title" section at index ${i} — deleting via section toolbar`);

        // Scroll the section into view in the iframe
        await sections.nth(i).scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);

        // Get bounding box relative to iframe
        const secBox = await sections.nth(i).boundingBox();
        const iframeEl = page.locator('#sqs-site-frame');
        const iframeBox = await iframeEl.boundingBox();

        if (secBox && iframeBox) {
          // Click the section in main frame coordinates
          const absX = iframeBox.x + secBox.x + secBox.width / 2;
          const absY = iframeBox.y + secBox.y + 30; // Click near top to get toolbar
          await page.mouse.click(absX, absY);
          await page.waitForTimeout(1500);
          await takeScreenshot(page, 'task-a-section-clicked');

          // Look for the section toolbar — typically has a trash icon
          // In Squarespace, after clicking a section in edit mode, a toolbar appears
          // with options including delete (trash icon)
          const trashSelectors = [
            'button[aria-label="Delete section"]',
            'button[aria-label="Delete Section"]',
            'button[aria-label="Remove section"]',
            'button[data-test="section-action-delete"]',
            'button[data-test="delete-section"]',
            // The toolbar buttons are in the main frame
            '[class*="section-toolbar"] button[aria-label*="elete"]',
            '[class*="SectionToolbar"] button[aria-label*="elete"]',
          ];

          let deleted = false;
          for (const sel of trashSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
              await btn.click();
              await page.waitForTimeout(1000);

              // Confirm
              const confirm = page.locator('button:has-text("Confirm"), button:has-text("Delete"), button:has-text("Yes")').first();
              if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
                await confirm.click();
                console.log(`  ✅ Deleted "Test Title" section`);
                deleted = true;
              }
              break;
            }
          }

          if (!deleted) {
            // Take screenshot to see what toolbar looks like
            await takeScreenshot(page, 'task-a-no-delete-btn');
            console.log('  ⚠️ Could not find section delete button — listing toolbar buttons');

            // List all visible buttons to find the right one
            const allBtns = page.locator('button');
            const btnCount = await allBtns.count();
            for (let b = 0; b < btnCount; b++) {
              const btn = allBtns.nth(b);
              const vis = await btn.isVisible().catch(() => false);
              if (!vis) continue;
              const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
              const dataTest = await btn.getAttribute('data-test').catch(() => '');
              const btnText = await btn.innerText().catch(() => '');
              const box = await btn.boundingBox().catch(() => null);
              if ((ariaLabel || dataTest || btnText.trim()) && box && box.y < 200) {
                console.log(`    btn[${b}]: text="${btnText.trim()}" aria="${ariaLabel}" data-test="${dataTest}" y=${box.y.toFixed(0)}`);
              }
            }
          }
        }
        break;
      }
    }

    // Save after removing test section
    await page.waitForTimeout(1000);
    const saveBtn = page.locator('button:has-text("SAVE")').first();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      console.log('  Saved changes');
      await page.waitForTimeout(2000);
    }

    // ── Task B: Add menu-block project section ──
    if (newProject) {
      console.log(`\n── Task B: Add "${newProject.title}" section ──`);

      // The browser agent is best for complex multi-step Squarespace editing
      // Let's use executeBrowserTask with a detailed description
      // But first, let's try using compound actions directly

      // Navigate to the page fresh
      await page.goto('https://tim-cox.squarespace.com/coding-projects', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // Enter edit mode
      const editBtn2 = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
      if (await editBtn2.isVisible({ timeout: 5000 }).catch(() => false)) {
        await editBtn2.click();
        await page.waitForTimeout(3000);
      }

      // Step 1: Add a new section
      console.log('  Step 1: Adding new section...');
      const addSectionResult = await executeAgentAction(page, {
        action: 'addSection',
      });
      console.log(`  addSection: ${addSectionResult.success ? '✅' : '❌'} ${addSectionResult.message}`);

      if (addSectionResult.success) {
        await page.waitForTimeout(2000);

        // Step 2: Enter the new section's edit mode
        // The new section is typically at the bottom, but we need to find it
        // Look for the most recently added section
        console.log('  Step 2: Entering section edit mode...');
        const enterResult = await executeAgentAction(page, {
          action: 'enterSectionEditMode',
          sectionIndex: 0, // Try the first section — or we can use last
        });
        console.log(`  enterSectionEditMode: ${enterResult.success ? '✅' : '❌'} ${enterResult.message}`);

        if (enterResult.success) {
          // Step 3: Add image block with screenshot
          console.log(`  Step 3: Adding image block...`);
          const imgResult = await executeAgentAction(page, {
            action: 'addImageBlock',
            imagePath: newProject.screenshotPath,
            altText: `${newProject.title} screenshot`,
          });
          console.log(`  addImageBlock: ${imgResult.success ? '✅' : '❌'} ${imgResult.message}`);

          // Step 4: Add title text block
          console.log(`  Step 4: Adding title...`);
          const titleResult = await executeAgentAction(page, {
            action: 'addBlockToSection',
            blockType: 'Text',
            content: newProject.title,
          });
          console.log(`  addBlock(title): ${titleResult.success ? '✅' : '❌'} ${titleResult.message}`);

          // Step 5: Add description text block
          console.log(`  Step 5: Adding description...`);
          const descResult = await executeAgentAction(page, {
            action: 'addBlockToSection',
            blockType: 'Text',
            content: newProject.description,
          });
          console.log(`  addBlock(desc): ${descResult.success ? '✅' : '❌'} ${descResult.message}`);

          // Step 6: Add button block
          console.log(`  Step 6: Adding button...`);
          const btnResult = await executeAgentAction(page, {
            action: 'addBlockToSection',
            blockType: 'Button',
          });
          console.log(`  addBlock(button): ${btnResult.success ? '✅' : '❌'} ${btnResult.message}`);

          // Step 7: Edit button with URL
          if (btnResult.success) {
            console.log(`  Step 7: Setting button text + URL...`);
            const editBtnResult = await executeAgentAction(page, {
              action: 'editButtonBlock',
              searchText: 'Button',
              newLabel: 'View Project',
              url: newProject.url,
            });
            console.log(`  editButtonBlock: ${editBtnResult.success ? '✅' : '❌'} ${editBtnResult.message}`);
          }
        }

        // Save
        await executeAgentAction(page, { action: 'saveChanges' });
        console.log('  Saved changes');
      }
    }

    // ── Task C: Upload screenshot to PoolTogether Explorer section ──
    if (ptScreenshotPath) {
      console.log('\n── Task C: Add screenshot to PoolTogether Explorer ──');

      await page.goto('https://tim-cox.squarespace.com/coding-projects', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await page.waitForTimeout(3000);

      const editBtn3 = page.locator('[data-test="frameToolbarEdit"], button:has-text("EDIT")').first();
      if (await editBtn3.isVisible({ timeout: 5000 }).catch(() => false)) {
        await editBtn3.click();
        await page.waitForTimeout(3000);
      }

      // Enter edit mode for the PoolTogether Explorer section
      console.log('  Entering PoolTogether Explorer section...');
      const enterResult = await executeAgentAction(page, {
        action: 'enterSectionEditMode',
        searchText: 'PoolTogether Explorer',
      });
      console.log(`  enterSectionEditMode: ${enterResult.success ? '✅' : '❌'} ${enterResult.message}`);

      if (enterResult.success) {
        console.log(`  Adding image block...`);
        const imgResult = await executeAgentAction(page, {
          action: 'addImageBlock',
          imagePath: ptScreenshotPath,
          altText: 'PoolTogether Explorer screenshot',
        });
        console.log(`  addImageBlock: ${imgResult.success ? '✅' : '❌'} ${imgResult.message}`);
      }

      await executeAgentAction(page, { action: 'saveChanges' });
      console.log('  Saved changes');
    }

    // ── Final screenshot ──
    console.log('\n── Final state ──');
    await page.goto('https://tim-cox.squarespace.com/coding-projects', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);
    await takeScreenshot(page, 'coding-projects-final');

    // Verify sections
    const finalIframe = page.frameLocator('#sqs-site-frame');
    const finalSections = finalIframe.locator('section.page-section[data-section-id]');
    const finalCount = await finalSections.count();
    console.log(`\nFinal section count: ${finalCount}`);
    for (let i = 0; i < finalCount; i++) {
      const text = await finalSections.nth(i).innerText().catch(() => '');
      const preview = text.trim().substring(0, 60).replace(/\n/g, ' | ');
      console.log(`  [${i}] "${preview}"`);
    }

  } catch (err) {
    console.error('Error:', (err as Error).message);
  } finally {
    await bm.close();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Coding Projects Page Builder            ║');
  console.log('║  Phase 1: Screenshots + Content Gen      ║');
  console.log('║  Phase 2: Squarespace Page Editing       ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Phase 1: Capture screenshots
  const screenshotPaths = await captureScreenshots();
  console.log(`\nCaptured ${screenshotPaths.size} screenshots`);

  // Phase 1b: Generate content for new project
  const newProject = await generateContent(screenshotPaths);
  if (newProject) {
    console.log(`\nNew project ready: "${newProject.title}"`);
    console.log(`  Description: ${newProject.description}`);
    console.log(`  Screenshot: ${newProject.screenshotPath}`);
  }

  // Phase 2: Edit Squarespace page
  const ptScreenshotPath = screenshotPaths.get('pooltogether-explorer');
  await editSquarespacePage(newProject, ptScreenshotPath);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  Done!                                    ║');
  console.log('╚══════════════════════════════════════════╝');
}

main().catch(console.error);
