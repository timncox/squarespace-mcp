/**
 * URL Redirects API Discovery Script
 *
 * Launches a browser, logs into Squarespace, navigates to the Advanced
 * settings panel, and captures all network traffic related to URL mappings
 * to identify the redirect management API endpoints.
 *
 * Usage:
 *   npx tsx scripts/discover-url-redirects.ts                        # Full discovery on default site
 *   npx tsx scripts/discover-url-redirects.ts --site smyth-tavern    # Different site
 *   npx tsx scripts/discover-url-redirects.ts --dry-run              # Read-only actions only
 *   npx tsx scripts/discover-url-redirects.ts --action readMappings  # Single action
 *   npx tsx scripts/discover-url-redirects.ts --headless             # Run headless
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
  /** Original URL mappings content — used for revert */
  originalMappings?: string;
  /** Crumb token extracted from network capture */
  crumbToken?: string | null;
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

const ACTION_NAMES = ['readMappings', 'addRedirect', 'programmaticProbe'] as const;
type ActionName = typeof ACTION_NAMES[number];

function buildDiscoveryActions(): DiscoveryAction[] {
  return [
    // ── Read-only ─────────────────────────────────────────────────────
    {
      name: 'readMappings',
      label: 'Navigate to Advanced settings and read URL mappings',
      mutating: false,
      execute: async (page, ctx) => {
        const advancedUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/settings/advanced`;
        console.log(`    Navigating to: ${advancedUrl}`);
        await page.goto(advancedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        console.log(`    Landed on: ${page.url()}`);

        // Look for URL Mappings section — try various selectors
        const mappingsSelectors = [
          'textarea[name*="url" i]',
          'textarea[data-test*="url" i]',
          'textarea[aria-label*="URL" i]',
          'textarea[aria-label*="mapping" i]',
          'textarea[placeholder*="redirect" i]',
          'textarea[placeholder*="mapping" i]',
          // Generic large textareas in the advanced settings panel
          'textarea',
        ];

        let foundTextarea = false;
        for (const selector of mappingsSelectors) {
          const el = page.locator(selector).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            const content = await el.inputValue().catch(() => '');
            console.log(`    Found URL mappings textarea (${selector})`);
            console.log(`    Current content (${content.length} chars):`);
            if (content.trim()) {
              const lines = content.split('\n').filter((l) => l.trim());
              for (const line of lines.slice(0, 10)) {
                console.log(`      ${line}`);
              }
              if (lines.length > 10) console.log(`      ... (${lines.length} total lines)`);
            } else {
              console.log(`      (empty)`);
            }
            ctx.originalMappings = content;
            foundTextarea = true;
            break;
          }
        }

        if (!foundTextarea) {
          // Try looking for expandable sections or buttons that reveal URL mappings
          const expandables = page.locator(
            'button:has-text("URL Mappings"), ' +
            'button:has-text("URL Redirect"), ' +
            '[class*="accordion"]:has-text("URL"), ' +
            'summary:has-text("URL"), ' +
            'h3:has-text("URL")',
          );
          const expandCount = await expandables.count();
          console.log(`    No textarea found directly — found ${expandCount} expandable sections`);

          for (let i = 0; i < expandCount; i++) {
            const el = expandables.nth(i);
            const text = await el.innerText().catch(() => '');
            console.log(`    Clicking expandable: "${text}"`);
            await el.click();
            await page.waitForTimeout(2000);

            // Check again for textarea after expanding
            const textarea = page.locator('textarea').first();
            if (await textarea.isVisible({ timeout: 2000 }).catch(() => false)) {
              const content = await textarea.inputValue().catch(() => '');
              console.log(`    Found textarea after expanding — content: ${content.length} chars`);
              ctx.originalMappings = content;
              foundTextarea = true;
              break;
            }
          }
        }

        if (!foundTextarea) {
          console.log('    Could not find URL mappings textarea — capturing page state');
          // Dump all visible text inputs/textareas for debugging
          const allTextareas = page.locator('textarea');
          const allInputs = page.locator('input[type="text"]');
          console.log(`    Page has ${await allTextareas.count()} textareas, ${await allInputs.count()} text inputs`);
        }
      },
    },

    // ── Mutating ──────────────────────────────────────────────────────
    {
      name: 'addRedirect',
      label: 'Add a test redirect mapping, save, then revert',
      mutating: true,
      execute: async (page, ctx) => {
        const advancedUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/settings/advanced`;
        console.log(`    Navigating to: ${advancedUrl}`);
        await page.goto(advancedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Find the URL mappings textarea
        const textareaSelectors = [
          'textarea[name*="url" i]',
          'textarea[data-test*="url" i]',
          'textarea[aria-label*="URL" i]',
          'textarea[aria-label*="mapping" i]',
          'textarea',
        ];

        let textarea = null;
        for (const selector of textareaSelectors) {
          const el = page.locator(selector).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            textarea = el;
            console.log(`    Found textarea: ${selector}`);
            break;
          }
        }

        // Try clicking expandable sections if no textarea found
        if (!textarea) {
          const expandables = page.locator(
            'button:has-text("URL Mappings"), ' +
            'button:has-text("URL Redirect"), ' +
            '[class*="accordion"]:has-text("URL"), ' +
            'summary:has-text("URL")',
          );
          for (let i = 0; i < await expandables.count(); i++) {
            await expandables.nth(i).click();
            await page.waitForTimeout(2000);
            const ta = page.locator('textarea').first();
            if (await ta.isVisible({ timeout: 2000 }).catch(() => false)) {
              textarea = ta;
              break;
            }
          }
        }

        if (!textarea) {
          console.log('    URL mappings textarea not found — skipping');
          return;
        }

        // Read current content
        const originalContent = await textarea.inputValue().catch(() => '');
        ctx.originalMappings = originalContent;
        console.log(`    Original content: ${originalContent.length} chars`);

        // Append test redirect line
        const testLine = '/discovery-test-old -> /discovery-test-new [301]';
        const newContent = originalContent.trim()
          ? originalContent.trim() + '\n' + testLine
          : testLine;

        // Clear and fill with new content
        await textarea.click();
        await page.waitForTimeout(300);
        await textarea.fill(newContent);
        console.log(`    Added test redirect: ${testLine}`);
        await page.waitForTimeout(1000);

        // Tab out to trigger blur/change events
        await page.keyboard.press('Tab');
        await page.waitForTimeout(1000);

        // Look for Save button
        const saveSelectors = [
          'button:has-text("Save")',
          'button:has-text("SAVE")',
          'button:has-text("Apply")',
          'button[data-test*="save" i]',
          'button[type="submit"]',
        ];

        let saved = false;
        for (const selector of saveSelectors) {
          const btn = page.locator(selector).first();
          if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await btn.click();
            console.log(`    Clicked Save button (${selector})`);
            saved = true;
            break;
          }
        }

        // Also try Cmd+S
        if (!saved) {
          console.log('    No Save button found — trying Cmd+S');
          await page.keyboard.press('Meta+s');
        }

        console.log('    Waiting for save API call...');
        await page.waitForTimeout(5000);

        // ── Revert ──
        console.log('    Reverting to original content...');
        // Re-find the textarea (page may have re-rendered)
        let revertTextarea = null;
        for (const selector of textareaSelectors) {
          const el = page.locator(selector).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            revertTextarea = el;
            break;
          }
        }

        if (revertTextarea) {
          await revertTextarea.click();
          await page.waitForTimeout(300);
          await revertTextarea.fill(originalContent);
          await page.keyboard.press('Tab');
          await page.waitForTimeout(1000);

          // Save the revert
          for (const selector of saveSelectors) {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await btn.click();
              console.log('    Saved revert');
              break;
            }
          }
          // Fallback Cmd+S
          await page.keyboard.press('Meta+s');
          await page.waitForTimeout(5000);
          console.log('    Revert complete');
        } else {
          console.log('    Could not re-find textarea for revert');
        }
      },
    },
    {
      name: 'programmaticProbe',
      label: 'Probe URL mapping API endpoints directly',
      mutating: true,
      execute: async (page, ctx) => {
        // First get crumb token from cookies/page
        const crumb = ctx.crumbToken ?? await page.evaluate(() => {
          // Try to find crumb in cookies
          const match = document.cookie.match(/crumb=([^;]+)/);
          if (match) return match[1];
          // Try meta tag
          const meta = document.querySelector('meta[name="squarespace-crumb"]');
          if (meta) return meta.getAttribute('content');
          // Try window config
          const win = window as unknown as Record<string, unknown>;
          const config = win.Static as Record<string, unknown> | undefined;
          if (config?.SQUARESPACE_CONTEXT) {
            const sqCtx = config.SQUARESPACE_CONTEXT as Record<string, unknown>;
            return (sqCtx.crumbToken as string) ?? null;
          }
          return null;
        }).catch(() => null);

        console.log(`    Crumb token: ${crumb ? crumb.substring(0, 10) + '...' : 'not found'}`);

        // Probe candidate endpoints
        const probes: Array<{ method: string; path: string; body?: unknown }> = [
          // Check if URL mappings are in the main settings response
          { method: 'GET', path: '/api/settings' },
          // Likely save endpoints
          { method: 'POST', path: '/api/config/SaveUrlMappings' },
          { method: 'PUT', path: '/api/url-mappings' },
          { method: 'GET', path: '/api/url-mappings' },
          { method: 'POST', path: '/api/settings/url-mappings' },
          { method: 'GET', path: '/api/settings/url-mappings' },
          // Try with test body for POST
          {
            method: 'POST',
            path: '/api/config/SaveUrlMappings',
            body: { urlMappings: '/probe-test -> /probe-dest [301]' },
          },
        ];

        for (const probe of probes) {
          const url = `https://${ctx.siteSubdomain}.squarespace.com${probe.path}`;
          console.log(`    Probing: ${probe.method} ${probe.path}${probe.body ? ' [with body]' : ''}`);

          try {
            const result = await page.evaluate(
              async ({ url, method, body, crumb }: { url: string; method: string; body?: unknown; crumb: string | null }) => {
                const headers: Record<string, string> = {
                  Accept: 'application/json, text/plain, */*',
                  'Content-Type': 'application/json',
                };
                if (crumb) headers['X-Squarespace-Crumb'] = crumb;

                const opts: RequestInit = { method, credentials: 'include', headers };
                if (body && method !== 'GET') {
                  opts.body = JSON.stringify(body);
                }

                const r = await fetch(url, opts);
                const status = r.status;
                let responseBody: unknown = null;
                const contentType = r.headers.get('content-type') ?? '';
                if (contentType.includes('json')) {
                  try { responseBody = await r.json(); } catch { /* ignore */ }
                } else {
                  try {
                    const text = await r.text();
                    responseBody = text.substring(0, 500);
                  } catch { /* ignore */ }
                }
                return { status, responseBody, contentType };
              },
              { url, method: probe.method, body: probe.body, crumb },
            );

            console.log(`    → ${result.status} (${result.contentType})`);

            if (result.status === 200 && result.responseBody) {
              const preview = JSON.stringify(result.responseBody).substring(0, 300);
              console.log(`    Response: ${preview}`);

              // If this is /api/settings, check for URL mapping fields
              if (probe.path === '/api/settings' && typeof result.responseBody === 'object') {
                const settings = result.responseBody as Record<string, unknown>;
                const urlKeys = Object.keys(settings).filter(
                  (k) => k.toLowerCase().includes('url') || k.toLowerCase().includes('mapping') || k.toLowerCase().includes('redirect'),
                );
                if (urlKeys.length > 0) {
                  console.log(`    URL-related settings keys: ${urlKeys.join(', ')}`);
                  for (const key of urlKeys) {
                    const val = settings[key];
                    const valStr = typeof val === 'string' ? val.substring(0, 200) : JSON.stringify(val).substring(0, 200);
                    console.log(`      ${key}: ${valStr}`);
                  }
                }
              }
            }
          } catch (err) {
            console.log(`    → ERROR: ${errMsg(err)}`);
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
  console.log('  URL REDIRECTS API DISCOVERY REPORT');
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
    console.log('  WRITE ENDPOINTS (most interesting for redirect API)');
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

  console.log(`\n  Squarespace URL Redirects Discovery`);
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
        await action.execute(page, ctx);
        capture.stop();
        const requests = capture.getCapturedRequests();
        const durationMs = Date.now() - startMs;
        // Save crumb token for programmatic probe
        if (!ctx.crumbToken) ctx.crumbToken = capture.getCrumbToken();
        reports.push({ name: action.name, label: action.label, requests, durationMs });
        console.log(`         Captured ${requests.length} request(s) (${(durationMs / 1000).toFixed(1)}s)`);
      } catch (err) {
        capture.stop();
        const error = errMsg(err);
        const durationMs = Date.now() - startMs;
        if (!ctx.crumbToken) ctx.crumbToken = capture.getCrumbToken();
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
    const outputPath = join(process.cwd(), 'data', `url-redirects-discovery-${timestamp}.json`);

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      dryRun,
      crumbToken: ctx.crumbToken ?? null,
      context: {
        originalMappings: ctx.originalMappings ?? null,
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
