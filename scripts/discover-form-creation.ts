/**
 * Form Block Creation Discovery Script
 *
 * Launches a browser, logs into Squarespace, navigates to a page in edit mode,
 * adds a Form block, inspects it, and removes it — capturing all network
 * traffic to identify form block creation/configuration API endpoints.
 *
 * Note: `discover-forms.ts` handles form submission listing.
 * This script focuses on adding a Form BLOCK to a page section in the editor.
 *
 * Usage:
 *   npx tsx scripts/discover-form-creation.ts                          # Full discovery
 *   npx tsx scripts/discover-form-creation.ts --site smyth-tavern      # Different site
 *   npx tsx scripts/discover-form-creation.ts --page home              # Target page
 *   npx tsx scripts/discover-form-creation.ts --dry-run                # Read-only only
 *   npx tsx scripts/discover-form-creation.ts --action addFormBlock    # Single action
 *   npx tsx scripts/discover-form-creation.ts --headless               # Run headless
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
  targetPage: string;
  /** Whether a form block was successfully added */
  formBlockAdded: boolean;
  /** Whether we're in section edit mode */
  inEditMode: boolean;
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

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Enter section edit mode: click section → click "Edit Content" */
async function enterSectionEditMode(page: Page): Promise<boolean> {
  const siteFrame = page.frameLocator('#sqs-site-frame');

  // Click a section to select it
  const section = siteFrame.locator('.page-section, section').first();
  if (await section.isVisible({ timeout: 3000 }).catch(() => false)) {
    const sBox = await section.boundingBox();
    if (sBox) {
      await page.mouse.click(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
      await page.waitForTimeout(1500);
    }
  } else {
    console.log('    No sections found in iframe');
    return false;
  }

  // Click "Edit Content" to enter Fluid Engine edit mode
  const editBtn = page.locator(
    'button:has-text("Edit Content"), ' +
    'button:has-text("EDIT CONTENT"), ' +
    '[aria-label="Edit Content"]',
  ).first();
  if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await editBtn.click();
    await page.waitForTimeout(2000);
    console.log('    Entered section edit mode');
    return true;
  }

  console.log('    "Edit Content" button not found');
  return false;
}

// ─── Discovery Actions ────────────────────────────────────────────────────

const ACTION_NAMES = ['addFormBlock', 'inspectFormBlock', 'removeFormBlock'] as const;
type ActionName = typeof ACTION_NAMES[number];

function buildDiscoveryActions(): DiscoveryAction[] {
  return [
    // ── Mutating ──────────────────────────────────────────────────────
    {
      name: 'addFormBlock',
      label: 'Add a Form block to a page section',
      mutating: true,
      execute: async (page, ctx) => {
        // Ensure we're on the target page in edit mode
        await enterEditMode(page);
        await page.waitForTimeout(2000);

        // Enter section edit mode
        const inEditMode = await enterSectionEditMode(page);
        if (!inEditMode) {
          console.log('    Could not enter section edit mode — aborting');
          return;
        }
        ctx.inEditMode = true;

        // Click ADD BLOCK button
        const addBlockBtn = page.getByRole('button', { name: /add block/i }).first();
        if (!await addBlockBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log('    ADD BLOCK button not found — not in edit mode?');
          return;
        }

        await addBlockBtn.click();
        await page.waitForTimeout(2000);
        console.log('    Opened block picker');

        // Search for "Form" in the block picker
        // Try typing in a search box first
        const searchInput = page.locator(
          'input[placeholder*="Search" i], ' +
          'input[aria-label*="Search" i], ' +
          'input[type="search"]',
        ).first();

        if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          await searchInput.fill('Form');
          console.log('    Typed "Form" in block picker search');
          await page.waitForTimeout(1500);
        }

        // Find the Form block option in the picker
        // Try multiple strategies to find and click "Form"
        const frame = page.frame({ name: 'sqs-site-frame' });
        let clicked = false;

        // Strategy 1: Look for button with text "Form" in main page
        const formBtn = page.locator('button:has-text("Form")').first();
        if (await formBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await formBtn.click();
          clicked = true;
          console.log('    Clicked Form block option (main frame button)');
        }

        // Strategy 2: Look in iframe for "Form" text elements
        if (!clicked && frame) {
          clicked = await frame.evaluate(() => {
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
              const htmlEl = el as HTMLElement;
              const text = htmlEl.innerText?.trim();
              if (text === 'Form' && el.children.length <= 3) {
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
            console.log('    Clicked Form block option (iframe element)');
          }
        }

        // Strategy 3: Look for any element containing "Form" in the block picker area
        if (!clicked) {
          const formOptions = page.locator(
            '[class*="block-picker"] :text("Form"), ' +
            '[class*="BlockPicker"] :text("Form"), ' +
            '[role="listbox"] :text("Form"), ' +
            '[role="menu"] :text("Form")',
          ).first();

          if (await formOptions.isVisible({ timeout: 2000 }).catch(() => false)) {
            await formOptions.click();
            clicked = true;
            console.log('    Clicked Form option (block picker locator)');
          }
        }

        if (!clicked) {
          console.log('    Could not find "Form" in block picker — dumping visible block types');
          // Dump what's visible in the picker for debugging
          if (frame) {
            const blockNames = await frame.evaluate(() => {
              const items = Array.from(document.querySelectorAll('[class*="block-type"], [class*="BlockType"], [role="option"]'));
              return items.map((el) => (el as HTMLElement).innerText?.trim()).filter(Boolean).slice(0, 20);
            }).catch(() => [] as string[]);
            console.log(`    Visible block types: ${blockNames.join(', ')}`);
          }

          // Close the picker
          await page.keyboard.press('Escape');
          await page.waitForTimeout(1000);
          return;
        }

        // Wait for form block creation — this may trigger API calls to create a form entity
        console.log('    Waiting for form block creation API calls...');
        await page.waitForTimeout(8000);

        ctx.formBlockAdded = true;
        console.log('    Form block added successfully');

        // Check for any form configuration panel that appeared
        const configPanel = page.locator(
          '[class*="form-editor"], ' +
          '[class*="FormEditor"], ' +
          '[class*="form-config"], ' +
          '[class*="block-editor"], ' +
          '[aria-label*="Form" i]',
        );
        const configCount = await configPanel.count();
        if (configCount > 0) {
          console.log(`    Form configuration panel detected (${configCount} elements)`);
        }

        // Press Escape to close any panels
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      },
    },
    {
      name: 'inspectFormBlock',
      label: 'Inspect form block editor/configuration',
      mutating: false,
      execute: async (page, ctx) => {
        if (!ctx.formBlockAdded) {
          console.log('    No form block was added — skipping inspection');
          return;
        }

        const siteFrame = page.frameLocator('#sqs-site-frame');

        // Re-enter section edit mode if needed
        if (!ctx.inEditMode) {
          const entered = await enterSectionEditMode(page);
          if (!entered) {
            console.log('    Could not enter section edit mode — skipping');
            return;
          }
          ctx.inEditMode = true;
        }

        // Find the form block in the section
        const formBlock = siteFrame.locator(
          '.sqs-block-form, ' +
          '[class*="form-block"], ' +
          '[class*="FormBlock"], ' +
          '[data-block-type="form"], ' +
          '[data-block-type="51"]',  // form blocks might be type 51
        ).first();

        if (await formBlock.isVisible({ timeout: 3000 }).catch(() => false)) {
          const box = await formBlock.boundingBox();
          if (box) {
            // Double-click to open form editor
            await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
            console.log('    Double-clicked form block to open editor');
            await page.waitForTimeout(5000);

            // Look for form configuration elements
            const configElements = page.locator(
              'input[type="email"], ' +
              'input[placeholder*="email" i], ' +
              '[class*="form-field"], ' +
              '[class*="FormField"], ' +
              'button:has-text("Add Field"), ' +
              'button:has-text("Recipients"), ' +
              'button:has-text("Storage"), ' +
              'label:has-text("Form Name")',
            );
            const configCount = await configElements.count();
            console.log(`    Found ${configCount} form configuration elements`);

            // Try clicking various config tabs/sections
            const configTabs = page.locator(
              'button:has-text("Fields"), ' +
              'button:has-text("Storage"), ' +
              'button:has-text("Advanced"), ' +
              'button:has-text("Design"), ' +
              '[role="tab"]',
            );
            const tabCount = await configTabs.count();
            console.log(`    Found ${tabCount} configuration tabs`);

            for (let i = 0; i < Math.min(tabCount, 5); i++) {
              const tab = configTabs.nth(i);
              const tabText = await tab.innerText().catch(() => `tab-${i}`);
              if (await tab.isVisible({ timeout: 1000 }).catch(() => false)) {
                await tab.click();
                console.log(`    Clicked tab: "${tabText}"`);
                await page.waitForTimeout(2000);
              }
            }

            // Close the form editor
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);
          }
        } else {
          console.log('    Form block not found in section — trying to find any new block');

          // Try finding the most recently added block
          const allBlocks = siteFrame.locator('.sqs-block, [class*="block-"]');
          const blockCount = await allBlocks.count();
          console.log(`    Total blocks in section: ${blockCount}`);

          if (blockCount > 0) {
            const lastBlock = allBlocks.last();
            const box = await lastBlock.boundingBox().catch(() => null);
            if (box) {
              await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
              console.log('    Double-clicked last block to inspect');
              await page.waitForTimeout(3000);
              await page.keyboard.press('Escape');
              await page.waitForTimeout(1000);
            }
          }
        }
      },
    },
    {
      name: 'removeFormBlock',
      label: 'Remove the form block and save',
      mutating: true,
      execute: async (page, ctx) => {
        if (!ctx.formBlockAdded) {
          console.log('    No form block was added — skipping removal');
          return;
        }

        const siteFrame = page.frameLocator('#sqs-site-frame');

        // Re-enter section edit mode if needed
        if (!ctx.inEditMode) {
          const entered = await enterSectionEditMode(page);
          if (!entered) {
            console.log('    Could not enter section edit mode — skipping removal');
            return;
          }
          ctx.inEditMode = true;
        }

        // Find the form block
        const formBlock = siteFrame.locator(
          '.sqs-block-form, ' +
          '[class*="form-block"], ' +
          '[class*="FormBlock"], ' +
          '[data-block-type="form"], ' +
          '[data-block-type="51"]',
        ).first();

        let blockFound = false;

        if (await formBlock.isVisible({ timeout: 3000 }).catch(() => false)) {
          blockFound = true;
          const box = await formBlock.boundingBox();
          if (box) {
            // Click to select the block
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(1000);
          }
        }

        if (!blockFound) {
          // Try the last block in the section as fallback
          const allBlocks = siteFrame.locator('.sqs-block, [class*="block-"]');
          const blockCount = await allBlocks.count();
          if (blockCount > 0) {
            const lastBlock = allBlocks.last();
            const box = await lastBlock.boundingBox().catch(() => null);
            if (box) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
              blockFound = true;
              console.log('    Selected last block as fallback');
              await page.waitForTimeout(1000);
            }
          }
        }

        if (!blockFound) {
          console.log('    No block found to remove — saving and exiting');
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          await page.keyboard.press('Meta+s');
          await page.waitForTimeout(3000);
          return;
        }

        // Try to delete the block
        // Strategy 1: Press Delete/Backspace key
        await page.keyboard.press('Delete');
        await page.waitForTimeout(1000);

        // Strategy 2: Right-click for context menu
        if (blockFound) {
          const formBlockAgain = siteFrame.locator(
            '.sqs-block-form, [class*="form-block"], [class*="FormBlock"]',
          ).first();

          if (await formBlockAgain.isVisible({ timeout: 1000 }).catch(() => false)) {
            // Block still exists — try right-click
            const box = await formBlockAgain.boundingBox();
            if (box) {
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
              await page.waitForTimeout(1000);

              const deleteOption = page.locator(
                '[role="menuitem"]:has-text("Delete"), ' +
                '[role="menuitem"]:has-text("Remove"), ' +
                'button:has-text("Delete Block"), ' +
                'button:has-text("Remove")',
              ).first();

              if (await deleteOption.isVisible({ timeout: 2000 }).catch(() => false)) {
                await deleteOption.click();
                console.log('    Deleted form block via context menu');
                await page.waitForTimeout(2000);
              } else {
                console.log('    No delete option in context menu');
              }
            }
          } else {
            console.log('    Form block already removed (Delete key worked)');
          }
        }

        // Strategy 3: Look for a toolbar delete/trash button
        const trashBtn = page.locator(
          'button[aria-label*="Delete" i], ' +
          'button[aria-label*="Remove" i], ' +
          'button[aria-label*="Trash" i], ' +
          '[class*="trash"], ' +
          '[class*="delete-block"]',
        ).first();

        if (await trashBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await trashBtn.click();
          console.log('    Clicked trash/delete button');
          await page.waitForTimeout(2000);
        }

        // Exit edit mode and save
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // Save changes
        await page.keyboard.press('Meta+s');
        console.log('    Saving changes...');
        await page.waitForTimeout(5000);

        ctx.inEditMode = false;
        console.log('    Form block removal and save complete');
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

function printReport(reports: ActionReport[], catalog: EndpointEntry[], siteId: string, targetPage: string, dryRun: boolean): void {
  const totalRequests = reports.reduce((sum, r) => sum + r.requests.length, 0);

  console.log('\n' + '='.repeat(70));
  console.log('  FORM BLOCK CREATION DISCOVERY REPORT');
  console.log('='.repeat(70));
  console.log(`  Site:      ${siteId}`);
  console.log(`  Page:      ${targetPage}`);
  console.log(`  Dry run:   ${dryRun}`);
  console.log(`  Actions:   ${reports.length}`);
  console.log(`  Total API requests captured: ${totalRequests}`);

  console.log('\n' + '-'.repeat(70));
  console.log('  PER-ACTION CAPTURES');
  console.log('-'.repeat(70));

  for (const report of reports) {
    const status = report.error ? `ERROR: ${report.error}` : `${report.requests.length} requests`;
    console.log(`\n  ${report.label} [${report.name}] (${(report.durationMs / 1000).toFixed(1)}s) — ${status}`);

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

  // Form-related endpoints
  const formRelated = catalog.filter(
    (e) => e.path.toLowerCase().includes('form') || e.path.includes('/api/page-sections'),
  );
  if (formRelated.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('  FORM-RELATED ENDPOINTS');
    console.log('-'.repeat(70));

    for (const entry of formRelated) {
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

  // Write operations summary
  const writeOps = catalog.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method));
  if (writeOps.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('  ALL WRITE ENDPOINTS');
    console.log('-'.repeat(70));

    for (const entry of writeOps) {
      const statuses = entry.responseStatuses.join(',');
      const params = entry.queryParamKeys.length > 0 ? ` ?${entry.queryParamKeys.join('&')}` : '';
      const actions = entry.seenInActions.join(', ');
      console.log(`    ${entry.method.padEnd(7)} ${entry.path}${params}  [${statuses}]  from: ${actions}`);
    }
  }

  console.log(`\n  Unique endpoints: ${catalog.length}`);
  console.log(`  Write endpoints: ${writeOps.length}`);
  console.log(`  Form-related: ${formRelated.length}`);
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

  if (actionFilter) {
    const invalid = actionFilter.filter((a) => !ACTION_NAMES.includes(a as ActionName));
    if (invalid.length > 0) {
      console.error(`Unknown action(s): ${invalid.join(', ')}`);
      console.error(`Available: ${ACTION_NAMES.join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`\n  Squarespace Form Block Creation Discovery`);
  console.log(`  Site: ${siteId} | Page: ${targetPage} | Dry run: ${dryRun}`);
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

    // Navigate to site and target page
    await navigateToSite(page, client);
    await navigateToPage(page, client, targetPage);

    // Network capture — include all requests
    const capture = new NetworkCapture(page, {
      includePatterns: [/.*/],
    });

    const actions = buildDiscoveryActions();
    const reports: ActionReport[] = [];
    const ctx: ActionContext = {
      siteSubdomain: client.site.adminUrl.match(/https:\/\/([^.]+)/)?.[1] ?? siteId,
      targetPage,
      formBlockAdded: false,
      inEditMode: false,
    };

    for (const action of actions) {
      if (actionFilter && !actionFilter.includes(action.name)) continue;
      if (dryRun && action.mutating) {
        console.log(`  [SKIP] ${action.label} (mutating — dry-run mode)`);
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
    const outputPath = join(process.cwd(), 'data', `form-creation-discovery-${timestamp}.json`);

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      targetPage,
      dryRun,
      crumbToken: capture.getCrumbToken(),
      context: {
        formBlockAdded: ctx.formBlockAdded,
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

    printReport(reports, catalog, siteId, targetPage, dryRun);

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
