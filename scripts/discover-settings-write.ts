/**
 * Settings Write API Discovery Script
 *
 * Launches a browser, logs into Squarespace, and performs settings modifications
 * (business info, blogging, site availability) while capturing all network traffic
 * to discover the internal API endpoints used for writing settings.
 *
 * Usage:
 *   npx tsx scripts/discover-settings-write.ts                          # Full discovery on default site
 *   npx tsx scripts/discover-settings-write.ts --site smyth-tavern      # Use a different site
 *   npx tsx scripts/discover-settings-write.ts --dry-run                # Read-only (skip mutating actions)
 *   npx tsx scripts/discover-settings-write.ts --action businessInfo    # Run a single action
 *   npx tsx scripts/discover-settings-write.ts --headless               # Run headless
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
  'businessInfo', 'blogging', 'siteAvailability', 'programmaticProbe',
] as const;
type ActionName = typeof ACTION_NAMES[number];

function buildDiscoveryActions(): DiscoveryAction[] {
  return [
    // ── businessInfo (mutating) ──────────────────────────────────────
    {
      name: 'businessInfo',
      label: 'Navigate to Business Information settings, modify and revert',
      mutating: true,
      execute: async (page, ctx) => {
        const url = `https://${ctx.siteSubdomain}.squarespace.com/config/settings/business-information`;
        console.log(`    Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Try multiple selectors to find the business name input
        const businessNameSelectors = [
          'input[name*="business"]',
          'input[aria-label*="Business"]',
          'label:has-text("Business Name") + input',
          'label:has-text("Business Name") ~ input',
          'input[data-test*="business"]',
          'input[placeholder*="Business"]',
          'input[placeholder*="business"]',
        ];

        let businessInput = null;
        for (const sel of businessNameSelectors) {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
            businessInput = loc;
            console.log(`    Found business name input via: ${sel}`);
            break;
          }
        }

        if (!businessInput) {
          // Fallback: find any visible text input on the page
          const allInputs = page.locator('input[type="text"], input:not([type])');
          const count = await allInputs.count();
          console.log(`    Business name selectors failed — found ${count} generic inputs`);
          for (let i = 0; i < count; i++) {
            const inp = allInputs.nth(i);
            if (await inp.isVisible({ timeout: 500 }).catch(() => false)) {
              const val = await inp.inputValue().catch(() => '');
              console.log(`    Input #${i}: value="${val}"`);
              if (val.length > 0) {
                businessInput = inp;
                console.log(`    Using input #${i} as business name field`);
                break;
              }
            }
          }
        }

        if (businessInput) {
          const originalValue = await businessInput.inputValue();
          console.log(`    Current value: "${originalValue}"`);

          // Modify value
          await businessInput.fill(originalValue + ' DISCOVERY_TEST');
          console.log(`    Changed to: "${originalValue} DISCOVERY_TEST"`);
          await page.waitForTimeout(500);

          // Tab out to trigger blur/change events
          await page.keyboard.press('Tab');
          await page.waitForTimeout(1000);

          // Try to find and click Save button
          const saveSelectors = [
            'button:has-text("Save")',
            'button:has-text("Done")',
            'button:has-text("Apply")',
            'button[data-test*="save"]',
          ];
          let saved = false;
          for (const sel of saveSelectors) {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
              await btn.click();
              console.log(`    Clicked save via: ${sel}`);
              saved = true;
              break;
            }
          }

          if (!saved) {
            // Try Cmd+S as backup
            await page.keyboard.press('Meta+s');
            console.log('    Pressed Cmd+S as save fallback');
          }

          // Wait for save API call
          await page.waitForTimeout(5000);

          // Revert: clear and re-type original value
          // Re-find the input in case the page re-rendered
          for (const sel of businessNameSelectors) {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
              businessInput = loc;
              break;
            }
          }
          if (businessInput) {
            await businessInput.fill(originalValue);
            console.log(`    Reverted to: "${originalValue}"`);
            await page.keyboard.press('Tab');
            await page.waitForTimeout(1000);

            // Save again
            for (const sel of saveSelectors) {
              const btn = page.locator(sel).first();
              if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
                await btn.click();
                console.log('    Saved revert');
                break;
              }
            }
            await page.keyboard.press('Meta+s');
            await page.waitForTimeout(5000);
          }
        } else {
          console.log('    No business name input found — check page structure');

          // Log available elements for debugging
          const headings = page.locator('h1, h2, h3, label');
          const hCount = await headings.count();
          for (let i = 0; i < Math.min(hCount, 10); i++) {
            const text = await headings.nth(i).innerText().catch(() => '');
            if (text.trim()) console.log(`    Label/heading: "${text.trim()}"`);
          }
        }
      },
    },

    // ── blogging (mutating) ──────────────────────────────────────────
    {
      name: 'blogging',
      label: 'Navigate to Blogging settings, modify and revert',
      mutating: true,
      execute: async (page, ctx) => {
        const url = `https://${ctx.siteSubdomain}.squarespace.com/config/settings/blogging`;
        console.log(`    Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Look for any editable field — posts per page, date format, etc.
        const inputSelectors = [
          'input[type="number"]',
          'input[type="text"]',
          'select',
          'input:not([type="hidden"])',
        ];

        let editableField = null;
        for (const sel of inputSelectors) {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
            editableField = loc;
            console.log(`    Found editable field via: ${sel}`);
            break;
          }
        }

        if (editableField) {
          const tagName = await editableField.evaluate((el) => el.tagName.toLowerCase());
          const originalValue = tagName === 'select'
            ? await editableField.evaluate((el) => (el as HTMLSelectElement).value)
            : await editableField.inputValue();
          console.log(`    Current value: "${originalValue}" (${tagName})`);

          if (tagName === 'select') {
            // For selects, try changing to a different option
            const options = await editableField.evaluate((el) => {
              const opts = (el as HTMLSelectElement).options;
              return Array.from(opts).map((o) => o.value);
            });
            console.log(`    Available options: ${options.join(', ')}`);
            const otherValue = options.find((o) => o !== originalValue);
            if (otherValue) {
              await editableField.selectOption(otherValue);
              console.log(`    Changed to: "${otherValue}"`);
            }
          } else {
            // For inputs, modify the value
            await editableField.fill(originalValue + '9');
            console.log(`    Changed to: "${originalValue}9"`);
          }

          await page.keyboard.press('Tab');
          await page.waitForTimeout(1000);

          // Try to save
          const saveBtn = page.locator('button:has-text("Save"), button:has-text("Done")').first();
          if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await saveBtn.click();
            console.log('    Clicked Save');
          } else {
            await page.keyboard.press('Meta+s');
            console.log('    Pressed Cmd+S');
          }
          await page.waitForTimeout(5000);

          // Revert
          if (tagName === 'select') {
            await editableField.selectOption(originalValue);
          } else {
            await editableField.fill(originalValue);
          }
          console.log(`    Reverted to: "${originalValue}"`);
          await page.keyboard.press('Tab');
          await page.waitForTimeout(1000);

          const saveBtn2 = page.locator('button:has-text("Save"), button:has-text("Done")').first();
          if (await saveBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
            await saveBtn2.click();
          } else {
            await page.keyboard.press('Meta+s');
          }
          await page.waitForTimeout(5000);
        } else {
          console.log('    No editable fields found on blogging settings page');
          // Log labels for debugging
          const labels = page.locator('label, h2, h3, [class*="label"]');
          const lCount = await labels.count();
          for (let i = 0; i < Math.min(lCount, 10); i++) {
            const text = await labels.nth(i).innerText().catch(() => '');
            if (text.trim()) console.log(`    Label: "${text.trim()}"`);
          }
        }
      },
    },

    // ── siteAvailability (read-only observation) ─────────────────────
    {
      name: 'siteAvailability',
      label: 'Navigate to Site Availability and observe settings shape',
      mutating: true,
      execute: async (page, ctx) => {
        const url = `https://${ctx.siteSubdomain}.squarespace.com/config/settings/site-availability`;
        console.log(`    Navigating to: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        // Log what's available but DON'T change anything — too risky
        console.log('    Observing site availability settings (NOT modifying)...');

        // Look for toggle/radio elements
        const toggleSelectors = [
          'input[type="radio"]',
          'input[type="checkbox"]',
          '[role="switch"]',
          '[role="radio"]',
          'button[aria-pressed]',
          '[class*="toggle"]',
          '[class*="switch"]',
        ];

        for (const sel of toggleSelectors) {
          const elements = page.locator(sel);
          const count = await elements.count();
          if (count > 0) {
            console.log(`    Found ${count} elements matching: ${sel}`);
            for (let i = 0; i < Math.min(count, 5); i++) {
              const el = elements.nth(i);
              const label = await el.getAttribute('aria-label').catch(() => null);
              const checked = await el.getAttribute('aria-checked').catch(() =>
                el.getAttribute('checked').catch(() => null)
              );
              const name = await el.getAttribute('name').catch(() => null);
              console.log(`      #${i}: label="${label}" checked="${checked}" name="${name}"`);
            }
          }
        }

        // Look for text labels to understand the settings shape
        const labels = page.locator('label, h2, h3, p, [class*="description"]');
        const lCount = await labels.count();
        console.log(`    Found ${lCount} label/text elements`);
        for (let i = 0; i < Math.min(lCount, 15); i++) {
          const text = await labels.nth(i).innerText().catch(() => '');
          if (text.trim() && text.length < 200) {
            console.log(`    Text: "${text.trim().substring(0, 100)}"`);
          }
        }

        // Wait to capture any API traffic from just loading the page
        await page.waitForTimeout(3000);
      },
    },

    // ── programmaticProbe (API probing) ──────────────────────────────
    {
      name: 'programmaticProbe',
      label: 'Probe settings write endpoints via direct API calls',
      mutating: true,
      execute: async (page, ctx) => {
        console.log('    Running programmatic API probes from browser context...');

        // First, ensure we have a crumb token
        const crumb = ctx.crumbToken;
        if (!crumb) {
          console.log('    WARNING: No crumb token available — probes may fail');
        }

        // Probe 1: POST /api/config/SaveSettings with empty body
        console.log('\n    Probe 1: POST /api/config/SaveSettings');
        const probe1 = await page.evaluate(async (crumbToken) => {
          try {
            const resp = await fetch(`/api/config/SaveSettings?crumb=${crumbToken ?? ''}`, {
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
        console.log(`    Result: ${JSON.stringify(probe1, null, 2).substring(0, 500)}`);

        // Probe 2: POST /api/config/SaveBusinessInformation with empty body
        console.log('\n    Probe 2: POST /api/config/SaveBusinessInformation');
        const probe2 = await page.evaluate(async (crumbToken) => {
          try {
            const resp = await fetch(`/api/config/SaveBusinessInformation?crumb=${crumbToken ?? ''}`, {
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
        console.log(`    Result: ${JSON.stringify(probe2, null, 2).substring(0, 500)}`);

        // Probe 3: GET /api/settings first, then PUT with no-op (same data back)
        console.log('\n    Probe 3: GET /api/settings then PUT /api/settings (no-op)');
        const probe3 = await page.evaluate(async (crumbToken) => {
          try {
            // First GET the current settings
            const getResp = await fetch('/api/settings');
            const settings = await getResp.json();
            const settingsKeys = Object.keys(settings);

            // Now try PUT with the same settings (no actual change)
            const putResp = await fetch(`/api/settings?crumb=${crumbToken ?? ''}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings),
            });
            const putBody = await putResp.text();

            return {
              getStatus: getResp.status,
              settingsKeyCount: settingsKeys.length,
              settingsKeys: settingsKeys.slice(0, 30),
              putStatus: putResp.status,
              putStatusText: putResp.statusText,
              putBody: putBody.substring(0, 2000),
            };
          } catch (err) {
            return { error: String(err) };
          }
        }, crumb);
        console.log(`    Result: ${JSON.stringify(probe3, null, 2).substring(0, 1000)}`);

        // Probe 4: POST /api/config/SaveSiteSettings with empty body
        console.log('\n    Probe 4: POST /api/config/SaveSiteSettings');
        const probe4 = await page.evaluate(async (crumbToken) => {
          try {
            const resp = await fetch(`/api/config/SaveSiteSettings?crumb=${crumbToken ?? ''}`, {
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

        // Probe 5: PATCH /api/settings with minimal body
        console.log('\n    Probe 5: PATCH /api/settings');
        const probe5 = await page.evaluate(async (crumbToken) => {
          try {
            const resp = await fetch(`/api/settings?crumb=${crumbToken ?? ''}`, {
              method: 'PATCH',
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
  console.log('  SETTINGS WRITE API DISCOVERY REPORT');
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

  console.log(`\n  Squarespace Settings Write Discovery`);
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
    const outputPath = join(process.cwd(), 'data', `settings-write-discovery-${timestamp}.json`);

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
