/**
 * API Discovery Script
 *
 * Launches a browser, logs into Squarespace, and systematically performs
 * editor actions while capturing all network traffic to catalog the internal
 * API surface.
 *
 * Usage:
 *   npx tsx scripts/discover-api.ts                          # Full discovery on default site
 *   npx tsx scripts/discover-api.ts --site smyth-tavern      # Use a different site
 *   npx tsx scripts/discover-api.ts --dry-run                # Read-only actions only (no edits)
 *   npx tsx scripts/discover-api.ts --page home              # Target a specific page
 *   npx tsx scripts/discover-api.ts --action editText        # Run a single action
 *   npx tsx scripts/discover-api.ts --action navigate --action editSEO  # Multiple actions
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { resolveSite, navigateToSite, navigateToPage, enterEditMode } from '../src/automation/site-navigator.js';
import { discoverSites } from '../src/automation/site-discovery.js';
import { NetworkCapture, type CapturedRequest } from '../src/automation/network-capture.js';
import { logger } from '../src/utils/logger.js';
import { errMsg } from '../src/utils/errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface DiscoveryAction {
  name: string;
  label: string;
  /** If true, only runs in full mode (skipped in --dry-run) */
  mutating: boolean;
  execute: (page: Page) => Promise<void>;
}

interface ActionReport {
  name: string;
  label: string;
  requests: CapturedRequest[];
  error?: string;
  durationMs: number;
}

interface EndpointEntry {
  method: string;
  path: string;
  seenInActions: string[];
  responseStatuses: number[];
  hasRequestBody: boolean;
  queryParamKeys: string[];
}

// ─── CLI Flags ────────────────────────────────────────────────────────────

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      // Support multiple --action flags by comma-separating values
      if (key === 'action' && flags[key]) {
        flags[key] += ',' + value;
      } else {
        flags[key] = value;
      }
      if (value !== 'true') i++;
    }
  }
  return flags;
}

// ─── Discovery Actions ────────────────────────────────────────────────────

/** All known action names. Used for --action flag validation. */
const ACTION_NAMES = [
  'navigate', 'enterEditMode', 'clickSection', 'openTextEditor',
  'openPageSettings', 'editText', 'addBlock', 'addSection',
  'uploadImage', 'editSEO', 'editCSS', 'openDesign', 'createBlogPost',
] as const;
type ActionName = typeof ACTION_NAMES[number];

function buildDiscoveryActions(pageSlug: string): DiscoveryAction[] {
  return [
    // ── Read-only actions ──────────────────────────────────────────────
    {
      name: 'navigate',
      label: 'Navigate to page',
      mutating: false,
      execute: async (page) => {
        // Already navigated by setup — capture the idle state API calls
        await page.waitForTimeout(2000);
      },
    },
    {
      name: 'enterEditMode',
      label: 'Enter edit mode',
      mutating: false,
      execute: async (page) => {
        await enterEditMode(page);
        await page.waitForTimeout(3000);
      },
    },
    {
      name: 'clickSection',
      label: 'Click section to enter edit mode',
      mutating: false,
      execute: async (page) => {
        const siteFrame = page.frameLocator('#sqs-site-frame');
        const firstSection = siteFrame.locator('.page-section').first();
        if (await firstSection.isVisible({ timeout: 3000 }).catch(() => false)) {
          const box = await firstSection.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(2000);
          }
        } else {
          console.log('    No sections found in iframe');
        }
      },
    },
    {
      name: 'openTextEditor',
      label: 'Double-click text block to open editor',
      mutating: false,
      execute: async (page) => {
        const siteFrame = page.frameLocator('#sqs-site-frame');
        const textBlock = siteFrame.locator('.sqs-block-html .sqs-block-content, [class*="html-block"] p').first();
        if (await textBlock.isVisible({ timeout: 3000 }).catch(() => false)) {
          const box = await textBlock.boundingBox();
          if (box) {
            await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(2000);
          }
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      },
    },
    {
      name: 'openPageSettings',
      label: 'Open page settings panel',
      mutating: false,
      execute: async (page) => {
        const settingsBtn = page.locator('[data-test="page-settings"], button[aria-label*="Settings"], button[aria-label*="settings"]').first();
        if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await settingsBtn.click();
          await page.waitForTimeout(2000);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        } else {
          console.log('    Page settings button not found — skipping');
        }
      },
    },

    // ── Mutating actions ───────────────────────────────────────────────
    {
      name: 'editText',
      label: 'Edit text block (type + save + undo)',
      mutating: true,
      execute: async (page) => {
        // First ensure we're in edit mode on a page
        const siteFrame = page.frameLocator('#sqs-site-frame');

        // Click a section first to select it
        const section = siteFrame.locator('.page-section, section').first();
        if (await section.isVisible({ timeout: 3000 }).catch(() => false)) {
          const sBox = await section.boundingBox();
          if (sBox) {
            await page.mouse.click(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
            await page.waitForTimeout(1500);
          }
        }

        // Click "Edit Content" to enter Fluid Engine edit mode
        const editBtn = page.locator('button:has-text("Edit Content"), button:has-text("EDIT CONTENT"), [aria-label="Edit Content"]').first();
        if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await editBtn.click();
          await page.waitForTimeout(2000);
          console.log('    Entered section edit mode');
        }

        // Now find and double-click a text block
        const textBlock = siteFrame.locator('.sqs-block-html .sqs-block-content, [class*="html-block"] p, h1, h2, h3').first();
        if (await textBlock.isVisible({ timeout: 3000 }).catch(() => false)) {
          const box = await textBlock.boundingBox();
          if (box) {
            // Double-click to enter text editor
            await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(2000);

            // Type test text — this should trigger autosave
            await page.keyboard.type('DISCOVERY_TEST');
            console.log('    Typed test text — waiting for autosave...');
            // Wait longer for the autosave to fire
            await page.waitForTimeout(5000);

            // Click outside to deselect and trigger save
            await page.mouse.click(50, 50);
            await page.waitForTimeout(3000);

            // Now undo: re-enter edit mode and undo
            if (box) {
              await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
              await page.waitForTimeout(1000);
              // Select all and undo multiple times
              await page.keyboard.press('Meta+a');
              await page.waitForTimeout(300);
              for (let i = 0; i < 15; i++) {
                await page.keyboard.press('Meta+z');
                await page.waitForTimeout(200);
              }
              await page.waitForTimeout(2000);
              // Click outside to save the undo
              await page.mouse.click(50, 50);
              await page.waitForTimeout(3000);
            }
            console.log('    Undid changes — should capture save API for both operations');
          }
        } else {
          console.log('    No text block found — skipping');
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      },
    },
    {
      name: 'addBlock',
      label: 'Add a Text block (actually create it)',
      mutating: true,
      execute: async (page) => {
        const siteFrame = page.frameLocator('#sqs-site-frame');

        // Click a section to select it
        const section = siteFrame.locator('.page-section, section').first();
        if (await section.isVisible({ timeout: 3000 }).catch(() => false)) {
          const sBox = await section.boundingBox();
          if (sBox) {
            await page.mouse.click(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
            await page.waitForTimeout(1500);
          }
        }

        // Enter edit mode
        const editBtn = page.locator('button:has-text("Edit Content"), button:has-text("EDIT CONTENT"), [aria-label="Edit Content"]').first();
        if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await editBtn.click();
          await page.waitForTimeout(2000);
        }

        // Click ADD BLOCK
        const addBlockBtn = page.getByRole('button', { name: /add block/i }).first();
        if (await addBlockBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await addBlockBtn.click();
          await page.waitForTimeout(2000);
          console.log('    Opened Add Block dialog');

          // Click "Text" to actually add a text block
          const frame = page.frame({ name: 'sqs-site-frame' });
          if (frame) {
            const clicked = await frame.evaluate(() => {
              const allElements = document.querySelectorAll('*');
              for (const el of allElements) {
                const htmlEl = el as HTMLElement;
                const text = htmlEl.innerText?.trim();
                if (text === 'Text' && el.children.length <= 3) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    htmlEl.click();
                    return true;
                  }
                }
              }
              return false;
            }).catch(() => false);

            if (clicked) {
              console.log('    Clicked Text block — waiting for block creation API...');
              await page.waitForTimeout(5000);
            } else {
              console.log('    Could not find Text in block picker');
            }
          }

          await page.keyboard.press('Escape');
          await page.waitForTimeout(2000);
        } else {
          console.log('    Add Block button not found — not in edit mode?');
        }
      },
    },
    {
      name: 'addSection',
      label: 'Add a section from template (actually create it)',
      mutating: true,
      execute: async (page) => {
        // First exit any edit mode by pressing Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);

        const siteFrame = page.frameLocator('#sqs-site-frame');

        // Scroll down to find section boundaries — ADD SECTION appears between sections
        const sections = siteFrame.locator('.page-section, section[data-section-id]');
        const count = await sections.count();
        console.log(`    Found ${count} sections on page`);

        if (count > 0) {
          // Hover between sections to reveal the ADD SECTION button
          for (let i = 0; i < count; i++) {
            const sec = sections.nth(i);
            const box = await sec.boundingBox().catch(() => null);
            if (box) {
              // Hover just below the section bottom boundary
              await page.mouse.move(box.x + box.width / 2, box.y + box.height + 5);
              await page.waitForTimeout(1000);

              // Check if ADD SECTION appeared
              const addBtn = page.getByRole('button', { name: /add section/i }).first();
              if (await addBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
                await addBtn.click();
                console.log(`    Clicked Add Section after section ${i}`);
                await page.waitForTimeout(4000);

                // The section template picker should now be open
                // Click the first template to actually add a section
                const templateItem = page.locator('[class*="template-thumbnail"], [class*="SectionThumbnail"], [data-test*="section-template"]').first();
                if (await templateItem.isVisible({ timeout: 3000 }).catch(() => false)) {
                  await templateItem.click();
                  console.log('    Clicked first template — waiting for section creation API...');
                  await page.waitForTimeout(5000);
                } else {
                  console.log('    No template items found in picker — capturing what we have');
                }

                await page.keyboard.press('Escape');
                await page.waitForTimeout(2000);
                break;
              }
            }
          }
        }

        // Fallback: try the bottom-of-page add section
        const addSectionFallback = page.locator('button:has-text("Add Section"), button:has-text("ADD SECTION")').first();
        if (await addSectionFallback.isVisible({ timeout: 2000 }).catch(() => false)) {
          await addSectionFallback.click();
          console.log('    Clicked fallback Add Section button');
          await page.waitForTimeout(4000);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        }
      },
    },
    {
      name: 'uploadImage',
      label: 'Upload an image to an image block',
      mutating: true,
      execute: async (page) => {
        const siteFrame = page.frameLocator('#sqs-site-frame');

        // Click a section
        const section = siteFrame.locator('.page-section, section').first();
        if (await section.isVisible({ timeout: 3000 }).catch(() => false)) {
          const sBox = await section.boundingBox();
          if (sBox) {
            await page.mouse.click(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
            await page.waitForTimeout(1500);
          }
        }

        // Enter edit mode
        const editBtn = page.locator('button:has-text("Edit Content"), button:has-text("EDIT CONTENT"), [aria-label="Edit Content"]').first();
        if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await editBtn.click();
          await page.waitForTimeout(2000);
        }

        // Add an Image block
        const addBlockBtn = page.getByRole('button', { name: /add block/i }).first();
        if (await addBlockBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await addBlockBtn.click();
          await page.waitForTimeout(2000);

          // Click "Image" in the block picker
          const frame = page.frame({ name: 'sqs-site-frame' });
          if (frame) {
            const clicked = await frame.evaluate(() => {
              const allElements = document.querySelectorAll('*');
              for (const el of allElements) {
                const htmlEl = el as HTMLElement;
                const text = htmlEl.innerText?.trim();
                if (text === 'Image' && el.children.length <= 3) {
                  const rect = el.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    htmlEl.click();
                    return true;
                  }
                }
              }
              return false;
            }).catch(() => false);

            if (clicked) {
              console.log('    Added Image block — waiting for editor panel...');
              await page.waitForTimeout(3000);

              // Find the empty image block and double-click to open editor
              const emptyImgBlock = siteFrame.locator('.sqs-block-image').last();
              const imgBox = await emptyImgBlock.boundingBox().catch(() => null);
              if (imgBox) {
                await page.mouse.dblclick(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
                await page.waitForTimeout(2000);
              }

              // Now try to upload a test image via file input
              // Create a tiny 1x1 PNG for testing
              const { writeFileSync, existsSync, mkdirSync } = await import('fs');
              const testImgPath = join(process.cwd(), 'storage', 'uploads', 'discovery-test.png');
              if (!existsSync(join(process.cwd(), 'storage', 'uploads'))) {
                mkdirSync(join(process.cwd(), 'storage', 'uploads'), { recursive: true });
              }
              // Minimal valid PNG (1x1 pixel, red)
              const PNG_HEADER = Buffer.from([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
                0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
                0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB
                0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
                0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, // compressed data
                0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, // ...
                0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
                0x44, 0xae, 0x42, 0x60, 0x82,
              ]);
              writeFileSync(testImgPath, PNG_HEADER);
              console.log(`    Created test image at ${testImgPath}`);

              // Try all file inputs in both frames
              let uploaded = false;

              // iframe file inputs
              if (frame) {
                const iframeInputs = frame.locator('input[type="file"]');
                const iCount = await iframeInputs.count();
                for (let i = 0; i < iCount; i++) {
                  try {
                    await iframeInputs.nth(i).setInputFiles(testImgPath);
                    uploaded = true;
                    console.log(`    Uploaded via iframe file input #${i}`);
                    break;
                  } catch { /* try next */ }
                }
              }

              // main frame file inputs
              if (!uploaded) {
                const mainInputs = page.locator('input[type="file"]');
                const mCount = await mainInputs.count();
                for (let i = 0; i < mCount; i++) {
                  try {
                    await mainInputs.nth(i).setInputFiles(testImgPath);
                    uploaded = true;
                    console.log(`    Uploaded via main frame file input #${i}`);
                    break;
                  } catch { /* try next */ }
                }
              }

              if (uploaded) {
                console.log('    Image uploaded — waiting for upload API call...');
                await page.waitForTimeout(8000);
              } else {
                console.log('    No file input found — image upload API not captured');
              }
            }
          }
        }

        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      },
    },
    {
      name: 'editSEO',
      label: 'Open SEO settings',
      mutating: true,
      execute: async (page) => {
        // Try opening page-level SEO settings first
        const seoBtn = page.locator('button:has-text("SEO"), [data-test*="seo"], [aria-label*="SEO"]').first();
        if (await seoBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await seoBtn.click();
          await page.waitForTimeout(2000);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        } else {
          // Navigate to site-level SEO settings via URL
          const siteMatch = page.url().match(/https:\/\/([^.]+)\.squarespace\.com/);
          if (siteMatch) {
            const seoUrl = `https://${siteMatch[1]}.squarespace.com/config/settings/seo`;
            console.log(`    Navigating to site SEO: ${seoUrl}`);
            await page.goto(seoUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(3000);
          }
        }
      },
    },
    {
      name: 'editCSS',
      label: 'Open Custom CSS editor and capture save endpoint',
      mutating: true,
      execute: async (page) => {
        const siteMatch = page.url().match(/https:\/\/([^.]+)\.squarespace\.com/);
        if (!siteMatch) {
          console.log('    Could not determine site URL for Custom CSS navigation');
          return;
        }

        // Navigate to the correct Custom CSS URL (same as handleEditCustomCSS)
        const cssUrl = `https://${siteMatch[1]}.squarespace.com/config/design/custom-css`;
        console.log(`    Navigating to: ${cssUrl}`);
        await page.goto(cssUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Find and click the CodeMirror editor
        const codeEditor = page.locator('.CodeMirror').first();
        if (await codeEditor.isVisible({ timeout: 3000 }).catch(() => false)) {
          await codeEditor.click();
          await page.waitForTimeout(500);

          // Type a CSS comment
          await page.keyboard.type('/* discovery-test */');
          console.log('    Typed CSS — triggering save with Cmd+S...');
          await page.waitForTimeout(1000);

          // Save via Cmd+S to trigger the save API call
          await page.keyboard.press('Meta+s');
          console.log('    Pressed Cmd+S — waiting for save API...');
          await page.waitForTimeout(5000);

          // Undo the change
          for (let i = 0; i < 20; i++) {
            await page.keyboard.press('Meta+z');
            await page.waitForTimeout(100);
          }
          console.log('    Undid CSS changes — saving clean state...');
          await page.waitForTimeout(500);

          // Save the reverted state too
          await page.keyboard.press('Meta+s');
          await page.waitForTimeout(5000);
        } else {
          // Fallback: try textarea or contenteditable
          const textarea = page.locator('textarea, [contenteditable="true"]').first();
          if (await textarea.isVisible({ timeout: 3000 }).catch(() => false)) {
            await textarea.click();
            await page.waitForTimeout(500);
            await page.keyboard.type('/* discovery-test */');
            await page.keyboard.press('Meta+s');
            console.log('    Typed + saved via textarea fallback — waiting...');
            await page.waitForTimeout(5000);
            for (let i = 0; i < 20; i++) {
              await page.keyboard.press('Meta+z');
              await page.waitForTimeout(100);
            }
            await page.keyboard.press('Meta+s');
            await page.waitForTimeout(5000);
          } else {
            console.log('    No CSS editor found');
          }
        }
      },
    },
    {
      name: 'openDesign',
      label: 'Open Design panel',
      mutating: false,
      execute: async (page) => {
        const siteMatch = page.url().match(/https:\/\/([^.]+)\.squarespace\.com/);
        if (siteMatch) {
          const designUrl = `https://${siteMatch[1]}.squarespace.com/config/design`;
          console.log(`    Navigating to: ${designUrl}`);
          await page.goto(designUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(3000);
        }
      },
    },
    {
      name: 'createBlogPost',
      label: 'Create blog post (navigate to blog)',
      mutating: true,
      execute: async (page) => {
        const siteMatch = page.url().match(/https:\/\/([^.]+)\.squarespace\.com/);
        if (!siteMatch) return;

        const pagesUrl = `https://${siteMatch[1]}.squarespace.com/config/pages`;
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Look for a blog collection
        const blogItem = page.locator('[data-test="pages-panel-item"]:has-text("Blog"), [data-test="pages-panel-item"]:has-text("News"), [data-test="pages-panel-item"]:has-text("Posts")').first();
        if (await blogItem.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('    Found blog collection — clicking');
          await blogItem.click();
          await page.waitForTimeout(3000);

          // Look for "Add" button to create a new post
          const addBtn = page.locator('button:has-text("Add"), button:has-text("+"), [aria-label*="Add"]').first();
          if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await addBtn.click();
            await page.waitForTimeout(4000);
            console.log('    New blog post created — capturing API calls');

            // Discard the draft
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);
            const discardBtn = page.locator('button:has-text("Discard"), button:has-text("Delete"), button:has-text("Don\'t Save")').first();
            if (await discardBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await discardBtn.click();
              await page.waitForTimeout(1000);
            }
          } else {
            console.log('    No Add button found');
          }
        } else {
          console.log('    No blog collection found on this site');
        }
      },
    },
  ];
}

// ─── Report Generation ────────────────────────────────────────────────────

function buildEndpointCatalog(reports: ActionReport[]): EndpointEntry[] {
  const endpointMap = new Map<string, EndpointEntry>();

  for (const report of reports) {
    for (const req of report.requests) {
      const key = `${req.method} ${req.path}`;
      let entry = endpointMap.get(key);
      if (!entry) {
        entry = {
          method: req.method,
          path: req.path,
          seenInActions: [],
          responseStatuses: [],
          hasRequestBody: false,
          queryParamKeys: [],
        };
        endpointMap.set(key, entry);
      }

      if (!entry.seenInActions.includes(report.name)) {
        entry.seenInActions.push(report.name);
      }
      if (req.responseStatus !== null && !entry.responseStatuses.includes(req.responseStatus)) {
        entry.responseStatuses.push(req.responseStatus);
      }
      if (req.requestBody) {
        entry.hasRequestBody = true;
      }
      for (const key of Object.keys(req.queryParams)) {
        if (!entry.queryParamKeys.includes(key)) {
          entry.queryParamKeys.push(key);
        }
      }
    }
  }

  // Sort: mutating methods first (POST/PUT/PATCH/DELETE), then by path
  const methodOrder: Record<string, number> = { POST: 0, PUT: 1, PATCH: 2, DELETE: 3, GET: 4 };
  return Array.from(endpointMap.values()).sort((a, b) => {
    const orderA = methodOrder[a.method] ?? 5;
    const orderB = methodOrder[b.method] ?? 5;
    if (orderA !== orderB) return orderA - orderB;
    return a.path.localeCompare(b.path);
  });
}

function printReport(reports: ActionReport[], catalog: EndpointEntry[], siteId: string, dryRun: boolean): void {
  const totalRequests = reports.reduce((sum, r) => sum + r.requests.length, 0);

  console.log('\n' + '='.repeat(70));
  console.log('  API DISCOVERY REPORT');
  console.log('='.repeat(70));
  console.log(`  Site:      ${siteId}`);
  console.log(`  Dry run:   ${dryRun}`);
  console.log(`  Actions:   ${reports.length}`);
  console.log(`  Total API requests captured: ${totalRequests}`);

  // ── Per-action summary ────────────────────────────────────────────
  console.log('\n' + '-'.repeat(70));
  console.log('  PER-ACTION CAPTURES');
  console.log('-'.repeat(70));

  for (const report of reports) {
    const status = report.error ? `ERROR: ${report.error}` : `${report.requests.length} requests`;
    console.log(`\n  ${report.label} [${report.name}] (${(report.durationMs / 1000).toFixed(1)}s) — ${status}`);

    for (const req of report.requests) {
      const statusStr = req.responseStatus !== null ? `[${req.responseStatus}]` : '';
      const durStr = req.durationMs !== null ? `(${req.durationMs}ms)` : '';
      console.log(`    ${req.method.padEnd(7)} ${req.path} ${statusStr} ${durStr}`);
      if (Object.keys(req.queryParams).length > 0) {
        console.log(`            query: ${JSON.stringify(req.queryParams)}`);
      }
    }
  }

  // ── Endpoint catalog ──────────────────────────────────────────────
  console.log('\n' + '-'.repeat(70));
  console.log('  ENDPOINT CATALOG (grouped by path prefix)');
  console.log('-'.repeat(70));

  if (catalog.length === 0) {
    console.log('  (no API endpoints captured)');
  } else {
    // Group by first 3 path segments
    const groups = new Map<string, EndpointEntry[]>();
    for (const entry of catalog) {
      const parts = entry.path.split('/').filter(Boolean);
      const prefix = '/' + parts.slice(0, Math.min(3, parts.length)).join('/');
      const list = groups.get(prefix) ?? [];
      list.push(entry);
      groups.set(prefix, list);
    }

    for (const [prefix, entries] of groups) {
      console.log(`\n  ${prefix}`);
      for (const entry of entries) {
        const statuses = entry.responseStatuses.join(',');
        const body = entry.hasRequestBody ? ' [body]' : '';
        const params = entry.queryParamKeys.length > 0 ? ` ?${entry.queryParamKeys.join('&')}` : '';
        const actions = entry.seenInActions.join(', ');
        console.log(`    ${entry.method.padEnd(7)} ${entry.path}${params}`);
        console.log(`            status: ${statuses}${body}  from: ${actions}`);
      }
    }
  }

  console.log(`\n  Unique endpoints: ${catalog.length}`);
  console.log('='.repeat(70));
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const siteId = flags.site ?? 'tim-cox';
  const targetPage = flags.page ?? 'home';
  const dryRun = flags['dry-run'] === 'true';
  const headless = flags.headless === 'true';
  const actionFilter = flags.action ? flags.action.split(',') : null;

  // Validate --action flags
  if (actionFilter) {
    const invalid = actionFilter.filter((a) => !ACTION_NAMES.includes(a as ActionName));
    if (invalid.length > 0) {
      console.error(`Unknown action(s): ${invalid.join(', ')}`);
      console.error(`Available: ${ACTION_NAMES.join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`\n  Squarespace API Discovery`);
  console.log(`  Site: ${siteId} | Page: ${targetPage} | Dry run: ${dryRun}`);
  if (actionFilter) {
    console.log(`  Actions: ${actionFilter.join(', ')}`);
  }
  console.log('');

  const browserManager = getBrowserManager({ headless });

  try {
    // ── Setup ────────────────────────────────────────────────────────
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    // Discover sites and resolve config
    await discoverSites(page);
    const client = await resolveSite(siteId, page);
    console.log(`  Resolved site: ${client.name} (${client.site.adminUrl})\n`);

    // Navigate to site and target page
    await navigateToSite(page, client);
    await navigateToPage(page, client, targetPage);

    // ── Discovery Loop ───────────────────────────────────────────────
    const capture = new NetworkCapture(page, {
      // Capture ALL requests — we need to find where image uploads actually go
      includePatterns: [/.*/],
    });

    const actions = buildDiscoveryActions(targetPage);
    const reports: ActionReport[] = [];

    for (const action of actions) {
      // Skip if --action filter is set and this action isn't in the list
      if (actionFilter && !actionFilter.includes(action.name)) {
        continue;
      }

      if (dryRun && action.mutating) {
        console.log(`  [SKIP] ${action.label} (mutating — dry-run mode)`);
        continue;
      }

      console.log(`  [RUN]  ${action.label}`);
      capture.clear();
      await capture.start();
      const startMs = Date.now();

      try {
        await action.execute(page);
        capture.stop();
        const requests = capture.getCapturedRequests();
        const durationMs = Date.now() - startMs;
        reports.push({ name: action.name, label: action.label, requests, durationMs });
        console.log(`         Captured ${requests.length} request(s) (${(durationMs / 1000).toFixed(1)}s)`);
      } catch (err) {
        capture.stop();
        const error = errMsg(err);
        const durationMs = Date.now() - startMs;
        reports.push({ name: action.name, label: action.label, requests: capture.getCapturedRequests(), error, durationMs });
        console.log(`         ERROR: ${error}`);
      }
    }

    // ── Build endpoint catalog ───────────────────────────────────────
    const catalog = buildEndpointCatalog(reports);

    // ── Save full capture data to JSON ───────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = join(process.cwd(), 'data', `api-discovery-${timestamp}.json`);

    const allRequests = reports.flatMap((r) => r.requests);
    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      targetPage,
      dryRun,
      crumbToken: capture.getCrumbToken(),
      summary: {
        totalActions: reports.length,
        totalRequests: allRequests.length,
        uniqueEndpoints: catalog.length,
        actionsWithErrors: reports.filter((r) => r.error).length,
      },
      endpointCatalog: catalog,
      actionReports: reports.map((r) => ({
        name: r.name,
        label: r.label,
        error: r.error ?? null,
        durationMs: r.durationMs,
        requestCount: r.requests.length,
        requests: r.requests,
      })),
    };

    await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n  Full capture saved to: ${outputPath}`);

    // ── Print report ─────────────────────────────────────────────────
    printReport(reports, catalog, siteId, dryRun);

    // ── Cleanup ──────────────────────────────────────────────────────
    await browserManager.saveSession();

    if (!headless) {
      console.log('\n  Browser is still open for inspection. Press Ctrl+C to close.\n');
      await new Promise(() => {});
    } else {
      await browserManager.close();
    }
  } catch (err) {
    console.error(`\n  Fatal error: ${errMsg(err)}\n`);
    logger.error({ error: errMsg(err) }, 'API discovery script failed');
    await browserManager.close();
    process.exit(1);
  }
}

main();
