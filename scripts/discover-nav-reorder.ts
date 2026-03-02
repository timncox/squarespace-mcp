/**
 * Navigation Reorder API Discovery Script
 *
 * Launches a browser, logs into Squarespace, and performs page reordering
 * operations (drag-and-drop + programmatic API probes) while capturing
 * all network traffic to discover the internal API endpoints.
 *
 * Usage:
 *   npx tsx scripts/discover-nav-reorder.ts                          # Full discovery on default site
 *   npx tsx scripts/discover-nav-reorder.ts --site smyth-tavern      # Use a different site
 *   npx tsx scripts/discover-nav-reorder.ts --dry-run                # Read-only (skip mutating actions)
 *   npx tsx scripts/discover-nav-reorder.ts --action readNavigation  # Run a single action
 *   npx tsx scripts/discover-nav-reorder.ts --headless               # Run headless
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { resolveSite, navigateToSite } from '../src/automation/site-navigator.js';
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
  crumbToken?: string;
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
  'readNavigation', 'dragReorder', 'programmaticProbe',
] as const;
type ActionName = typeof ACTION_NAMES[number];

function buildDiscoveryActions(): DiscoveryAction[] {
  return [
    // ── readNavigation (read-only) ───────────────────────────────────
    {
      name: 'readNavigation',
      label: 'Navigate to Pages panel and capture navigation API calls',
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

        // Log page names for reference
        for (let i = 0; i < count; i++) {
          const text = await pageItems.nth(i).innerText().catch(() => '');
          console.log(`    Page #${i}: "${text.trim()}"`);
        }

        // Also check for collections
        const collections = page.locator('[data-test="pages-panel-collection"]');
        const collCount = await collections.count();
        console.log(`    Found ${collCount} collections`);

        // Wait for any additional API traffic
        await page.waitForTimeout(3000);
      },
    },

    // ── dragReorder (mutating) ───────────────────────────────────────
    {
      name: 'dragReorder',
      label: 'Drag-and-drop reorder pages in navigation',
      mutating: true,
      execute: async (page, ctx) => {
        const pagesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
        console.log(`    Navigating to: ${pagesUrl}`);
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Get all page items
        const pageItems = page.locator('[data-test="pages-panel-item"]');
        const count = await pageItems.count();
        console.log(`    Found ${count} pages — attempting drag reorder`);

        if (count < 2) {
          console.log('    Need at least 2 pages for drag reorder — skipping');
          return;
        }

        // Log original order
        for (let i = 0; i < count; i++) {
          const text = await pageItems.nth(i).innerText().catch(() => '');
          console.log(`    Original order #${i}: "${text.trim()}"`);
        }

        // Drag second page above first page
        const source = pageItems.nth(1);
        const target = pageItems.nth(0);
        const sourceBox = await source.boundingBox().catch(() => null);
        const targetBox = await target.boundingBox().catch(() => null);

        if (sourceBox && targetBox) {
          console.log('    Performing drag: page #1 → above page #0');

          // Move mouse to source center
          await page.mouse.move(
            sourceBox.x + sourceBox.width / 2,
            sourceBox.y + sourceBox.height / 2,
          );
          await page.waitForTimeout(300);

          // Press and hold
          await page.mouse.down();
          await page.waitForTimeout(500);

          // Drag slowly to target (above first item)
          await page.mouse.move(
            targetBox.x + targetBox.width / 2,
            targetBox.y - 5,
            { steps: 15 },
          );
          await page.waitForTimeout(500);

          // Release
          await page.mouse.up();
          console.log('    Drag completed — waiting for save API...');
          await page.waitForTimeout(4000);

          // Verify new order
          const newPageItems = page.locator('[data-test="pages-panel-item"]');
          const newCount = await newPageItems.count();
          for (let i = 0; i < Math.min(newCount, 5); i++) {
            const text = await newPageItems.nth(i).innerText().catch(() => '');
            console.log(`    New order #${i}: "${text.trim()}"`);
          }

          // Drag back to restore original order
          console.log('    Restoring original order...');
          const newSource = newPageItems.nth(0);
          const newTarget = newPageItems.nth(1);
          const ns = await newSource.boundingBox().catch(() => null);
          const nt = await newTarget.boundingBox().catch(() => null);

          if (ns && nt) {
            await page.mouse.move(ns.x + ns.width / 2, ns.y + ns.height / 2);
            await page.waitForTimeout(300);
            await page.mouse.down();
            await page.waitForTimeout(500);
            await page.mouse.move(
              nt.x + nt.width / 2,
              nt.y + nt.height + 5,
              { steps: 15 },
            );
            await page.waitForTimeout(500);
            await page.mouse.up();
            console.log('    Restored original order — waiting for save API...');
            await page.waitForTimeout(4000);
          } else {
            console.log('    Could not get bounding boxes for restore drag');
          }
        } else {
          console.log('    Could not get bounding boxes for source/target pages');

          // Fallback: try using drag handles if they exist
          const dragHandles = page.locator('[data-test*="drag"], [aria-label*="drag" i], [class*="drag-handle"]');
          const handleCount = await dragHandles.count();
          console.log(`    Found ${handleCount} drag handles as fallback`);
        }
      },
    },

    // ── programmaticProbe (API probing) ──────────────────────────────
    {
      name: 'programmaticProbe',
      label: 'Probe navigation write endpoints via direct API calls',
      mutating: true,
      execute: async (page, ctx) => {
        console.log('    Running programmatic API probes from browser context...');

        const crumb = ctx.crumbToken;
        if (!crumb) {
          console.log('    WARNING: No crumb token available — probes may fail');
        }

        // Probe 1: GET /api/navigation — we know this works
        console.log('\n    Probe 1: GET /api/navigation');
        const probe1 = await page.evaluate(async () => {
          try {
            const resp = await fetch('/api/navigation');
            const body = await resp.json();
            return {
              status: resp.status,
              keys: Object.keys(body),
              mainNavCount: Array.isArray(body.mainNavigation) ? body.mainNavigation.length : 'not array',
              notLinkedCount: Array.isArray(body.notLinked) ? body.notLinked.length : 'not array',
              sampleMainNav: Array.isArray(body.mainNavigation)
                ? body.mainNavigation.slice(0, 3).map((p: Record<string, unknown>) => ({
                    id: p.id,
                    title: p.title,
                    urlSlug: p.urlSlug,
                    type: p.type,
                  }))
                : null,
              fullBody: JSON.stringify(body).substring(0, 3000),
            };
          } catch (err) {
            return { error: String(err) };
          }
        });
        console.log(`    Result: status=${(probe1 as Record<string, unknown>).status}, keys=${JSON.stringify((probe1 as Record<string, unknown>).keys)}`);
        console.log(`    Main nav count: ${(probe1 as Record<string, unknown>).mainNavCount}, Not linked count: ${(probe1 as Record<string, unknown>).notLinkedCount}`);
        if ((probe1 as Record<string, unknown>).sampleMainNav) {
          console.log(`    Sample pages: ${JSON.stringify((probe1 as Record<string, unknown>).sampleMainNav, null, 2)}`);
        }

        // Probe 2: PUT /api/navigation with full navigation JSON (no-op — same data back)
        console.log('\n    Probe 2: PUT /api/navigation (no-op, same data back)');
        const probe2 = await page.evaluate(async (crumbToken) => {
          try {
            // First GET navigation
            const getResp = await fetch('/api/navigation');
            const navigation = await getResp.json();

            // PUT it back unchanged
            const putResp = await fetch(`/api/navigation?crumb=${crumbToken ?? ''}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(navigation),
            });
            const putBody = await putResp.text();

            return {
              getStatus: getResp.status,
              putStatus: putResp.status,
              putStatusText: putResp.statusText,
              putBody: putBody.substring(0, 2000),
            };
          } catch (err) {
            return { error: String(err) };
          }
        }, crumb);
        console.log(`    Result: ${JSON.stringify(probe2, null, 2).substring(0, 1000)}`);

        // Probe 3: POST /api/navigation/reorder
        console.log('\n    Probe 3: POST /api/navigation/reorder');
        const probe3 = await page.evaluate(async (crumbToken) => {
          try {
            const resp = await fetch(`/api/navigation/reorder?crumb=${crumbToken ?? ''}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            const body = await resp.text();
            return { status: resp.status, statusText: resp.statusText, body: body.substring(0, 2000) };
          } catch (err) {
            return { error: String(err) };
          }
        }, crumb);
        console.log(`    Result: ${JSON.stringify(probe3, null, 2).substring(0, 500)}`);

        // Probe 4: POST /api/navigation with empty body
        console.log('\n    Probe 4: POST /api/navigation');
        const probe4 = await page.evaluate(async (crumbToken) => {
          try {
            const resp = await fetch(`/api/navigation?crumb=${crumbToken ?? ''}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            const body = await resp.text();
            return { status: resp.status, statusText: resp.statusText, body: body.substring(0, 2000) };
          } catch (err) {
            return { error: String(err) };
          }
        }, crumb);
        console.log(`    Result: ${JSON.stringify(probe4, null, 2).substring(0, 500)}`);

        // Probe 5: PUT /api/config/SaveNavigation
        console.log('\n    Probe 5: PUT /api/config/SaveNavigation');
        const probe5 = await page.evaluate(async (crumbToken) => {
          try {
            const resp = await fetch(`/api/config/SaveNavigation?crumb=${crumbToken ?? ''}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            const body = await resp.text();
            return { status: resp.status, statusText: resp.statusText, body: body.substring(0, 2000) };
          } catch (err) {
            return { error: String(err) };
          }
        }, crumb);
        console.log(`    Result: ${JSON.stringify(probe5, null, 2).substring(0, 500)}`);

        // Probe 6: POST /api/config/SaveNavigation
        console.log('\n    Probe 6: POST /api/config/SaveNavigation');
        const probe6 = await page.evaluate(async (crumbToken) => {
          try {
            const resp = await fetch(`/api/config/SaveNavigation?crumb=${crumbToken ?? ''}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            const body = await resp.text();
            return { status: resp.status, statusText: resp.statusText, body: body.substring(0, 2000) };
          } catch (err) {
            return { error: String(err) };
          }
        }, crumb);
        console.log(`    Result: ${JSON.stringify(probe6, null, 2).substring(0, 500)}`);

        await page.waitForTimeout(2000);
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
  console.log('  NAV REORDER API DISCOVERY REPORT');
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
  const actionFilter = flags.action ? flags.action.split(',') : null;

  if (actionFilter) {
    const invalid = actionFilter.filter((a) => !ACTION_NAMES.includes(a as ActionName));
    if (invalid.length > 0) {
      console.error(`Unknown action(s): ${invalid.join(', ')}`);
      console.error(`Available: ${ACTION_NAMES.join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`\n  Squarespace Navigation Reorder Discovery`);
  console.log(`  Site: ${siteId} | Dry run: ${dryRun}`);
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

      console.log(`  [RUN]  ${action.label}`);
      capture.clear();
      await capture.start();
      const startMs = Date.now();

      try {
        // Pass crumb token from capture to context for programmatic probes
        ctx.crumbToken = capture.getCrumbToken() ?? undefined;

        await action.execute(page, ctx);
        capture.stop();
        const requests = capture.getCapturedRequests();
        const durationMs = Date.now() - startMs;
        reports.push({ name: action.name, label: action.label, requests, durationMs });
        console.log(`         Captured ${requests.length} request(s) (${(durationMs / 1000).toFixed(1)}s)`);

        // Update crumb token after each action
        ctx.crumbToken = capture.getCrumbToken() ?? ctx.crumbToken;
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
    const outputPath = join(process.cwd(), 'data', `nav-reorder-discovery-${timestamp}.json`);

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      dryRun,
      crumbToken: capture.getCrumbToken(),
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
