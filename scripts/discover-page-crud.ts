/**
 * Page CRUD API Discovery Script
 *
 * Launches a browser, logs into Squarespace, and performs page lifecycle
 * operations (create, read settings, update settings, delete) while
 * capturing all network traffic to catalog the internal API endpoints.
 *
 * Usage:
 *   npx tsx scripts/discover-page-crud.ts                        # Full CRUD on default site
 *   npx tsx scripts/discover-page-crud.ts --site smyth-tavern    # Different site
 *   npx tsx scripts/discover-page-crud.ts --dry-run              # Read-only (skip create/update/delete)
 *   npx tsx scripts/discover-page-crud.ts --action createPage    # Single action
 *   npx tsx scripts/discover-page-crud.ts --keep-page            # Don't delete the created page
 *   npx tsx scripts/discover-page-crud.ts --headless             # Run headless
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { resolveSite, navigateToSite, enterEditMode } from '../src/automation/site-navigator.js';
import { discoverSites } from '../src/automation/site-discovery.js';
import { NetworkCapture, type CapturedRequest } from '../src/automation/network-capture.js';
import { errMsg } from '../src/utils/errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface DiscoveryAction {
  name: string;
  label: string;
  mutating: boolean;
  execute: (page: Page, ctx: ActionContext) => Promise<void>;
}

interface ActionContext {
  siteSubdomain: string;
  /** Page URL ID created during 'createPage' — needed by update/delete */
  createdPageUrlId?: string;
  /** Collection ID of the created page */
  createdCollectionId?: string;
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
  sampleRequestBody?: unknown;
  sampleResponseBody?: unknown;
  queryParamKeys: string[];
}

// ─── CLI Flags ────────────────────────────────────────────────────────────

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
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

const ACTION_NAMES = [
  'listPages', 'createPage', 'readPageSettings', 'updatePageSettings',
  'reorderPages', 'deletePage',
] as const;
type ActionName = typeof ACTION_NAMES[number];

function buildDiscoveryActions(): DiscoveryAction[] {
  return [
    // ── Read-only ─────────────────────────────────────────────────────
    {
      name: 'listPages',
      label: 'Navigate to Pages panel and list all pages',
      mutating: false,
      execute: async (page, ctx) => {
        const pagesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
        console.log(`    Navigating to: ${pagesUrl}`);
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Count visible page items
        const pageItems = page.locator('[data-test="pages-panel-item"]');
        const count = await pageItems.count();
        console.log(`    Found ${count} page items in panel`);

        // Also check for collections (blogs, stores, etc.)
        const collections = page.locator('[data-test="pages-panel-collection"]');
        const collCount = await collections.count();
        console.log(`    Found ${collCount} collections`);
      },
    },

    // ── Mutating ──────────────────────────────────────────────────────
    {
      name: 'createPage',
      label: 'Create a new blank page',
      mutating: true,
      execute: async (page, ctx) => {
        // Navigate to pages panel
        const pagesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Click the "+" or "Add Page" button in the main navigation section
        // Squarespace has the add button next to "Main Navigation" or "Not Linked"
        const addBtn = page.locator(
          'button[aria-label*="Add"], ' +
          'button[data-test="add-page-button"], ' +
          '[data-test="pages-panel-add-page"]'
        ).first();

        if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await addBtn.click();
          console.log('    Clicked Add Page button');
          await page.waitForTimeout(3000);
        } else {
          // Fallback: look for "+" icon near "MAIN NAVIGATION"
          const plusBtns = page.locator('button').filter({ hasText: '+' });
          const plusCount = await plusBtns.count();
          console.log(`    Found ${plusCount} "+" buttons, trying first...`);
          if (plusCount > 0) {
            await plusBtns.first().click();
            await page.waitForTimeout(3000);
          }
        }

        // The "Add Page" dialog should appear — look for "Blank" page option
        const blankOption = page.locator(
          'button:has-text("Blank"), ' +
          '[data-test*="blank"], ' +
          '[class*="blank" i]'
        ).first();

        if (await blankOption.isVisible({ timeout: 5000 }).catch(() => false)) {
          await blankOption.click();
          console.log('    Selected "Blank" page type');
          await page.waitForTimeout(5000);
        } else {
          // Try clicking the first page type option
          console.log('    "Blank" not found — looking for any page type option...');
          const pageTypes = page.locator('[class*="PageType"], [class*="page-type"], [data-test*="page-type"]');
          const typeCount = await pageTypes.count();
          console.log(`    Found ${typeCount} page type options`);
          if (typeCount > 0) {
            await pageTypes.first().click();
            await page.waitForTimeout(5000);
          }
        }

        // Try to capture the page ID from the URL or response
        // After creating, Squarespace navigates to the new page editor
        const currentUrl = page.url();
        console.log(`    Current URL after create: ${currentUrl}`);

        // Extract page URL slug from the current URL
        const urlMatch = currentUrl.match(/squarespace\.com\/([^/]+?)(?:\?|$)/);
        if (urlMatch) {
          ctx.createdPageUrlId = urlMatch[1];
          console.log(`    Created page URL ID: ${ctx.createdPageUrlId}`);
        }

        // Also try to find the page title input to rename it
        const titleInput = page.locator(
          'input[data-test="page-title"], ' +
          'input[aria-label*="title" i], ' +
          'input[placeholder*="Page Title" i]'
        ).first();

        if (await titleInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          await titleInput.fill('');
          await titleInput.fill('Discovery Test Page');
          console.log('    Renamed page to "Discovery Test Page"');
          await page.waitForTimeout(2000);

          // Press Enter or click Done to confirm
          await page.keyboard.press('Enter');
          await page.waitForTimeout(3000);
        }

        // Wait for the page to fully load so we capture all API calls
        await page.waitForTimeout(3000);
      },
    },
    {
      name: 'readPageSettings',
      label: 'Open page settings to capture settings read API',
      mutating: false,
      execute: async (page, ctx) => {
        // If we just created a page, navigate to it first
        if (ctx.createdPageUrlId) {
          const pageUrl = `https://${ctx.siteSubdomain}.squarespace.com/${ctx.createdPageUrlId}`;
          console.log(`    Navigating to created page: ${pageUrl}`);
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(3000);
        }

        // Try to open page settings via the gear icon
        // In the editor, there's usually a settings icon in the page header
        const settingsBtn = page.locator(
          'button[data-test="page-settings"], ' +
          'button[aria-label*="Settings" i], ' +
          'button[aria-label*="Page Settings" i], ' +
          '[data-test="page-header-settings"]'
        ).first();

        if (await settingsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await settingsBtn.click();
          console.log('    Opened page settings panel');
          await page.waitForTimeout(4000);

          // Look for tabs: General, SEO, Social, Advanced
          const tabs = page.locator('[role="tab"], [data-test*="tab"]');
          const tabCount = await tabs.count();
          console.log(`    Found ${tabCount} settings tabs`);

          // Click SEO tab if available — this often triggers additional API calls
          const seoTab = page.locator('[role="tab"]:has-text("SEO"), button:has-text("SEO")').first();
          if (await seoTab.isVisible({ timeout: 2000 }).catch(() => false)) {
            await seoTab.click();
            console.log('    Clicked SEO tab');
            await page.waitForTimeout(2000);
          }

          // Click Social tab
          const socialTab = page.locator('[role="tab"]:has-text("Social"), button:has-text("Social")').first();
          if (await socialTab.isVisible({ timeout: 2000 }).catch(() => false)) {
            await socialTab.click();
            console.log('    Clicked Social tab');
            await page.waitForTimeout(2000);
          }

          // Click Advanced tab
          const advTab = page.locator('[role="tab"]:has-text("Advanced"), button:has-text("Advanced")').first();
          if (await advTab.isVisible({ timeout: 2000 }).catch(() => false)) {
            await advTab.click();
            console.log('    Clicked Advanced tab');
            await page.waitForTimeout(2000);
          }

          // Close settings
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
        } else {
          // Fallback: try navigating to config URL directly
          const configUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
          console.log(`    Settings button not found — navigating to ${configUrl}`);
          await page.goto(configUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(3000);

          // Click on the page to open its settings
          const targetPage = ctx.createdPageUrlId ?? 'home';
          const pageItem = page.locator(`[data-test="pages-panel-item"]:has-text("${targetPage}")`).first();
          if (await pageItem.isVisible({ timeout: 3000 }).catch(() => false)) {
            // Right-click or gear icon to get settings
            const gear = pageItem.locator('button[aria-label*="Settings" i], button[aria-label*="settings" i]').first();
            if (await gear.isVisible({ timeout: 2000 }).catch(() => false)) {
              await gear.click();
              await page.waitForTimeout(4000);
            } else {
              await pageItem.click();
              await page.waitForTimeout(3000);
            }
          }
        }
      },
    },
    {
      name: 'updatePageSettings',
      label: 'Update page settings (title, slug, description)',
      mutating: true,
      execute: async (page, ctx) => {
        // Navigate to pages panel
        const pagesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Find the page we created (or home as fallback)
        const targetText = ctx.createdPageUrlId ? 'Discovery Test' : 'Home';
        const pageItems = page.locator('[data-test="pages-panel-item"]');
        const itemCount = await pageItems.count();

        let targetItem = null;
        for (let i = 0; i < itemCount; i++) {
          const text = await pageItems.nth(i).innerText().catch(() => '');
          if (text.toLowerCase().includes(targetText.toLowerCase())) {
            targetItem = pageItems.nth(i);
            break;
          }
        }

        if (!targetItem) {
          console.log(`    Could not find page "${targetText}" — skipping`);
          return;
        }

        // Click the page to select it, then look for settings
        await targetItem.click();
        await page.waitForTimeout(2000);

        // Look for settings gear on the selected page
        const settingsGear = page.locator(
          'button[aria-label*="Settings" i], ' +
          '[data-test="page-settings"], ' +
          'button[data-test*="settings"]'
        ).first();

        if (await settingsGear.isVisible({ timeout: 3000 }).catch(() => false)) {
          await settingsGear.click();
          console.log('    Opened page settings');
          await page.waitForTimeout(3000);
        }

        // Find the page title input and modify it
        const titleInput = page.locator(
          'input[data-test="page-title-input"], ' +
          'input[data-test="page-settings-title"], ' +
          'label:has-text("Navigation Title") + input, ' +
          'label:has-text("Page Title") + input'
        ).first();

        if (await titleInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          const currentTitle = await titleInput.inputValue();
          console.log(`    Current title: "${currentTitle}"`);

          // Modify and save
          await titleInput.fill(currentTitle + ' (Updated)');
          await page.waitForTimeout(1000);

          // Look for Save button
          const saveBtn = page.locator(
            'button:has-text("Save"), button:has-text("Done"), button:has-text("Apply")'
          ).first();
          if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await saveBtn.click();
            console.log('    Saved page settings update');
            await page.waitForTimeout(4000);
          }

          // Revert the title
          if (await settingsGear.isVisible({ timeout: 2000 }).catch(() => false)) {
            await settingsGear.click();
            await page.waitForTimeout(2000);
          }
          if (await titleInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await titleInput.fill(currentTitle);
            await page.waitForTimeout(1000);
            if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await saveBtn.click();
              console.log('    Reverted page title');
              await page.waitForTimeout(3000);
            }
          }
        } else {
          // Try finding page description input instead
          const descInput = page.locator(
            'textarea[data-test*="description"], ' +
            'input[data-test*="description"], ' +
            'label:has-text("Description") + textarea'
          ).first();

          if (await descInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log('    Found description field — modifying...');
            await descInput.fill('Discovery test description');
            await page.waitForTimeout(2000);

            const saveBtn = page.locator('button:has-text("Save"), button:has-text("Done")').first();
            if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await saveBtn.click();
              await page.waitForTimeout(3000);
            }
          } else {
            console.log('    No settings input fields found');
          }
        }

        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      },
    },
    {
      name: 'reorderPages',
      label: 'Reorder pages in navigation (drag or API)',
      mutating: true,
      execute: async (page, ctx) => {
        // Navigate to pages panel
        const pagesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Get all page items
        const pageItems = page.locator('[data-test="pages-panel-item"]');
        const count = await pageItems.count();
        console.log(`    Found ${count} pages — attempting drag reorder`);

        if (count >= 2) {
          // Try drag from item 1 to item 0 position
          const source = pageItems.nth(1);
          const target = pageItems.nth(0);

          const sourceBox = await source.boundingBox().catch(() => null);
          const targetBox = await target.boundingBox().catch(() => null);

          if (sourceBox && targetBox) {
            // Perform a drag operation
            await page.mouse.move(
              sourceBox.x + sourceBox.width / 2,
              sourceBox.y + sourceBox.height / 2,
            );
            await page.mouse.down();
            await page.waitForTimeout(500);

            // Move to above the first item
            await page.mouse.move(
              targetBox.x + targetBox.width / 2,
              targetBox.y - 5,
              { steps: 10 },
            );
            await page.waitForTimeout(500);
            await page.mouse.up();
            console.log('    Performed drag reorder');
            await page.waitForTimeout(4000);

            // Drag back to restore original order
            const newSource = pageItems.nth(0);
            const newTarget = pageItems.nth(1);
            const ns = await newSource.boundingBox().catch(() => null);
            const nt = await newTarget.boundingBox().catch(() => null);

            if (ns && nt) {
              await page.mouse.move(ns.x + ns.width / 2, ns.y + ns.height / 2);
              await page.mouse.down();
              await page.waitForTimeout(500);
              await page.mouse.move(nt.x + nt.width / 2, nt.y + nt.height + 5, { steps: 10 });
              await page.waitForTimeout(500);
              await page.mouse.up();
              console.log('    Restored original order');
              await page.waitForTimeout(3000);
            }
          }
        }
      },
    },
    {
      name: 'deletePage',
      label: 'Delete the discovery test page',
      mutating: true,
      execute: async (page, ctx) => {
        if (!ctx.createdPageUrlId) {
          console.log('    No page was created — skipping delete');
          return;
        }

        // Navigate to pages panel
        const pagesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Find the "Discovery Test" page
        const pageItems = page.locator('[data-test="pages-panel-item"]');
        const itemCount = await pageItems.count();

        let targetItem = null;
        for (let i = 0; i < itemCount; i++) {
          const text = await pageItems.nth(i).innerText().catch(() => '');
          if (text.toLowerCase().includes('discovery test')) {
            targetItem = pageItems.nth(i);
            break;
          }
        }

        if (!targetItem) {
          console.log('    Could not find "Discovery Test" page — skipping delete');
          return;
        }

        // Click to select the page
        await targetItem.click();
        await page.waitForTimeout(2000);

        // Open settings
        const settingsBtn = page.locator(
          'button[aria-label*="Settings" i], ' +
          '[data-test="page-settings"], ' +
          'button[data-test*="settings"]'
        ).first();

        if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await settingsBtn.click();
          await page.waitForTimeout(2000);
        }

        // Find the delete button (usually at bottom of settings panel)
        const deleteBtn = page.locator(
          'button:has-text("Delete"), ' +
          'button:has-text("Delete Page"), ' +
          'button[data-test*="delete"]'
        ).first();

        if (await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await deleteBtn.click();
          console.log('    Clicked Delete Page');
          await page.waitForTimeout(2000);

          // Confirm deletion dialog
          const confirmBtn = page.locator(
            'button:has-text("Confirm"), ' +
            'button:has-text("Delete"), ' +
            'button:has-text("Yes"), ' +
            '[data-test*="confirm-delete"]'
          ).last();

          if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await confirmBtn.click();
            console.log('    Confirmed page deletion');
            await page.waitForTimeout(5000);
          }
        } else {
          console.log('    Delete button not found in settings panel');

          // Fallback: try right-click context menu
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);

          if (targetItem) {
            await targetItem.click({ button: 'right' });
            await page.waitForTimeout(1000);

            const ctxDelete = page.locator('[role="menuitem"]:has-text("Delete"), button:has-text("Delete")').first();
            if (await ctxDelete.isVisible({ timeout: 2000 }).catch(() => false)) {
              await ctxDelete.click();
              await page.waitForTimeout(2000);

              const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Delete")').last();
              if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await confirmBtn.click();
                console.log('    Deleted via context menu');
                await page.waitForTimeout(5000);
              }
            }
          }
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
        if (!entry.sampleRequestBody) entry.sampleRequestBody = req.requestBody;
      }
      if (req.responseBody && !entry.sampleResponseBody) {
        entry.sampleResponseBody = req.responseBody;
      }
      for (const k of Object.keys(req.queryParams)) {
        if (!entry.queryParamKeys.includes(k)) {
          entry.queryParamKeys.push(k);
        }
      }
    }
  }

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
  console.log('  PAGE CRUD API DISCOVERY REPORT');
  console.log('='.repeat(70));
  console.log(`  Site:      ${siteId}`);
  console.log(`  Dry run:   ${dryRun}`);
  console.log(`  Actions:   ${reports.length}`);
  console.log(`  Total API requests captured: ${totalRequests}`);

  console.log('\n' + '-'.repeat(70));
  console.log('  PER-ACTION CAPTURES');
  console.log('-'.repeat(70));

  for (const report of reports) {
    const status = report.error ? `ERROR: ${report.error}` : `${report.requests.length} requests`;
    console.log(`\n  ${report.label} [${report.name}] (${(report.durationMs / 1000).toFixed(1)}s) — ${status}`);

    // Only show write operations and key GETs
    const interesting = report.requests.filter(
      (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) || r.path.includes('/api/'),
    );
    for (const req of interesting) {
      const statusStr = req.responseStatus !== null ? `[${req.responseStatus}]` : '';
      const durStr = req.durationMs !== null ? `(${req.durationMs}ms)` : '';
      const bodyStr = req.requestBody ? ' [body]' : '';
      console.log(`    ${req.method.padEnd(7)} ${req.path} ${statusStr} ${durStr}${bodyStr}`);
      if (Object.keys(req.queryParams).length > 0) {
        console.log(`            query: ${JSON.stringify(req.queryParams)}`);
      }
    }
  }

  // Write operations summary
  const writeOps = catalog.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method));
  if (writeOps.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('  WRITE ENDPOINTS (most interesting for API implementation)');
    console.log('-'.repeat(70));

    for (const entry of writeOps) {
      const statuses = entry.responseStatuses.join(',');
      const params = entry.queryParamKeys.length > 0 ? ` ?${entry.queryParamKeys.join('&')}` : '';
      const actions = entry.seenInActions.join(', ');
      console.log(`\n    ${entry.method.padEnd(7)} ${entry.path}${params}`);
      console.log(`            status: ${statuses}  from: ${actions}`);

      if (entry.sampleRequestBody) {
        const bodyStr = JSON.stringify(entry.sampleRequestBody, null, 2);
        const truncated = bodyStr.length > 500 ? bodyStr.substring(0, 500) + '\n            ...' : bodyStr;
        console.log(`            request body:\n${truncated.split('\n').map((l) => '              ' + l).join('\n')}`);
      }
    }
  }

  console.log(`\n  Unique endpoints: ${catalog.length}`);
  console.log(`  Write endpoints: ${writeOps.length}`);
  console.log('='.repeat(70));
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const siteId = flags.site ?? 'tim-cox';
  const dryRun = flags['dry-run'] === 'true';
  const headless = flags.headless === 'true';
  const keepPage = flags['keep-page'] === 'true';
  const actionFilter = flags.action ? flags.action.split(',') : null;

  if (actionFilter) {
    const invalid = actionFilter.filter((a) => !ACTION_NAMES.includes(a as ActionName));
    if (invalid.length > 0) {
      console.error(`Unknown action(s): ${invalid.join(', ')}`);
      console.error(`Available: ${ACTION_NAMES.join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`\n  Squarespace Page CRUD Discovery`);
  console.log(`  Site: ${siteId} | Dry run: ${dryRun} | Keep page: ${keepPage}`);
  if (actionFilter) console.log(`  Actions: ${actionFilter.join(', ')}`);
  console.log('');

  const browserManager = getBrowserManager({ headless });

  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    await discoverSites(page);
    const client = await resolveSite(siteId, page);
    console.log(`  Resolved site: ${client.name} (${client.site.adminUrl})\n`);

    await navigateToSite(page, client);

    // Network capture — include all requests
    const capture = new NetworkCapture(page, {
      includePatterns: [/.*/],
    });

    const actions = buildDiscoveryActions();
    const reports: ActionReport[] = [];
    const ctx: ActionContext = {
      siteSubdomain: client.site.adminUrl.match(/https:\/\/([^.]+)/)?.[1] ?? siteId,
    };

    for (const action of actions) {
      if (actionFilter && !actionFilter.includes(action.name)) continue;
      if (dryRun && action.mutating) {
        console.log(`  [SKIP] ${action.label} (mutating — dry-run mode)`);
        continue;
      }
      if (action.name === 'deletePage' && keepPage) {
        console.log(`  [SKIP] ${action.label} (--keep-page flag)`);
        continue;
      }

      console.log(`  [RUN]  ${action.label}`);
      capture.clear();
      await capture.start();
      const startMs = Date.now();

      try {
        await action.execute(page, ctx);
        capture.stop();
        const requests = capture.getCapturedRequests();
        const durationMs = Date.now() - startMs;
        reports.push({ name: action.name, label: action.label, requests, durationMs });
        console.log(`         Captured ${requests.length} request(s) (${(durationMs / 1000).toFixed(1)}s)`);
      } catch (err) {
        capture.stop();
        const error = errMsg(err);
        const durationMs = Date.now() - startMs;
        reports.push({
          name: action.name,
          label: action.label,
          requests: capture.getCapturedRequests(),
          error,
          durationMs,
        });
        console.log(`         ERROR: ${error}`);
      }
    }

    const catalog = buildEndpointCatalog(reports);

    // Save full capture to JSON
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = join(process.cwd(), 'data', `page-crud-discovery-${timestamp}.json`);

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      dryRun,
      keepPage,
      crumbToken: capture.getCrumbToken(),
      context: {
        createdPageUrlId: ctx.createdPageUrlId ?? null,
      },
      summary: {
        totalActions: reports.length,
        totalRequests: reports.reduce((s, r) => s + r.requests.length, 0),
        uniqueEndpoints: catalog.length,
        writeEndpoints: catalog.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method)).length,
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

    printReport(reports, catalog, siteId, dryRun);

    await browserManager.saveSession();

    if (!headless) {
      console.log('\n  Browser is still open for inspection. Press Ctrl+C to close.\n');
      await new Promise(() => {});
    } else {
      await browserManager.close();
    }
  } catch (err) {
    console.error(`\n  Fatal error: ${errMsg(err)}\n`);
    await browserManager.close();
    process.exit(1);
  }
}

main();
