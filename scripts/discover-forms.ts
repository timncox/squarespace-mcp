/**
 * Forms API Discovery Script
 *
 * Launches a browser, logs into Squarespace, navigates to the Forms &
 * Submissions panel, and captures all network traffic to identify the
 * forms listing API endpoint and response shape.
 *
 * Usage:
 *   npx tsx scripts/discover-forms.ts                        # Default site
 *   npx tsx scripts/discover-forms.ts --site grey-yellow-hbxc
 *   npx tsx scripts/discover-forms.ts --headless             # Run headless
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

interface EndpointEntry {
  method: string;
  path: string;
  responseStatuses: number[];
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
      flags[key] = value;
      if (value !== 'true') i++;
    }
  }
  return flags;
}

// ─── Discovery ────────────────────────────────────────────────────────────

/** Navigate to the Forms & Submissions panel and capture API traffic. */
async function discoverFormsList(page: Page, siteSubdomain: string): Promise<CapturedRequest[]> {
  const capture = new NetworkCapture(page, { includePatterns: [/.*/] });
  capture.clear();
  await capture.start();

  // Try several known Forms & Submissions panel URLs (SPA may route differently)
  const panelCandidates = [
    `/config/profiles/form-submissions`,
    `/config/website/forms`,
    `/config/forms`,
  ];

  for (const panelPath of panelCandidates) {
    const panelUrl = `https://${siteSubdomain}.squarespace.com${panelPath}`;
    console.log(`    Trying panel URL: ${panelUrl}`);
    await page.goto(panelUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    console.log(`    → landed on: ${finalUrl}`);

    // If we ended up somewhere other than the home dashboard, this is likely correct
    if (!finalUrl.includes('/config/website') && !finalUrl.endsWith('/config/')) {
      console.log(`    ✓ Appears to be the forms panel`);
      break;
    }
  }

  // Wait for any lazy-loaded panel content
  await page.waitForTimeout(3000);
  const formItems = page.locator(
    '[data-test*="form"], [class*="FormItem"], [class*="form-item"], [class*="submission"]',
  );
  const count = await formItems.count();
  console.log(`    Found ${count} visible form element(s) in panel`);

  // Scroll to trigger any lazy-loaded content
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  capture.stop();
  return capture.getCapturedRequests();
}

/** Also probe the most-likely endpoint candidates directly. */
async function probeEndpointCandidates(
  page: Page,
  siteSubdomain: string,
  crumbToken: string | null,
): Promise<CapturedRequest[]> {
  const candidates = [
    `/api/forms`,
    `/api/v1/forms`,
    `/api/content/forms`,
    `/api/v1/form-submissions`,
    `/api/profiles/forms`,
    `/api/v1/profiles/forms`,
    `/api/v1/profiles/form-submissions`,
  ];

  const results: CapturedRequest[] = [];

  for (const path of candidates) {
    const url = `https://${siteSubdomain}.squarespace.com${path}`;
    console.log(`    Probing: GET ${path}`);

    try {
      const response = await page.evaluate(
        async ({ url, crumb }: { url: string; crumb: string | null }) => {
          const headers: Record<string, string> = {
            Accept: 'application/json, text/plain, */*',
          };
          if (crumb) headers['X-Squarespace-Crumb'] = crumb;

          const r = await fetch(url, { method: 'GET', credentials: 'include', headers });
          const status = r.status;
          let body: unknown = null;
          try { body = await r.json(); } catch { /* ignore */ }
          return { status, body };
        },
        { url, crumb: crumbToken },
      );

      console.log(`    ${path} → ${response.status}`);
      if (response.status === 200) {
        console.log(`    ✓ SUCCESS — response shape: ${JSON.stringify(response.body).slice(0, 200)}`);
      }

      results.push({
        method: 'GET',
        path,
        url,
        queryParams: {},
        requestBody: null,
        responseStatus: response.status,
        responseBody: response.body,
        durationMs: null,
      });
    } catch (err) {
      console.log(`    ${path} → ERROR: ${errMsg(err)}`);
    }
  }

  return results;
}

// ─── Report ───────────────────────────────────────────────────────────────

function buildEndpointCatalog(requests: CapturedRequest[]): EndpointEntry[] {
  const map = new Map<string, EndpointEntry>();

  for (const req of requests) {
    const key = `${req.method} ${req.path}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { method: req.method, path: req.path, responseStatuses: [], queryParamKeys: [] };
      map.set(key, entry);
    }
    if (req.responseStatus !== null && !entry.responseStatuses.includes(req.responseStatus)) {
      entry.responseStatuses.push(req.responseStatus);
    }
    if (req.responseBody && !entry.sampleResponseBody) {
      entry.sampleResponseBody = req.responseBody;
    }
    for (const k of Object.keys(req.queryParams)) {
      if (!entry.queryParamKeys.includes(k)) entry.queryParamKeys.push(k);
    }
  }

  return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function printReport(panelRequests: CapturedRequest[], probeResults: CapturedRequest[]): void {
  console.log('\n' + '='.repeat(70));
  console.log('  FORMS API DISCOVERY REPORT');
  console.log('='.repeat(70));

  // Highlight form-related requests from panel navigation
  const formRelated = panelRequests.filter(
    (r) => r.path.toLowerCase().includes('form') || r.path.includes('/api/'),
  );

  console.log(`\n  Panel navigation captured ${panelRequests.length} total requests`);
  console.log(`  Form-related / API requests: ${formRelated.length}`);

  if (formRelated.length > 0) {
    console.log('\n  Form-related requests from panel navigation:');
    for (const req of formRelated) {
      const statusStr = req.responseStatus !== null ? `[${req.responseStatus}]` : '';
      console.log(`    ${req.method.padEnd(7)} ${req.path} ${statusStr}`);
      if (req.responseBody && req.responseStatus === 200) {
        const preview = JSON.stringify(req.responseBody).slice(0, 300);
        console.log(`             response: ${preview}`);
      }
    }
  }

  console.log('\n  Direct endpoint probe results:');
  for (const req of probeResults) {
    const statusStr = req.responseStatus !== null ? `[${req.responseStatus}]` : '';
    const icon = req.responseStatus === 200 ? '✓' : '✗';
    console.log(`    ${icon} GET ${req.path} ${statusStr}`);
    if (req.responseBody && req.responseStatus === 200) {
      const preview = JSON.stringify(req.responseBody).slice(0, 400);
      console.log(`      response: ${preview}`);
    }
  }

  const successful = probeResults.filter((r) => r.responseStatus === 200);
  if (successful.length > 0) {
    console.log('\n  ✓ CONFIRMED WORKING ENDPOINTS:');
    for (const req of successful) {
      console.log(`    GET ${req.path}`);
    }
  } else {
    console.log('\n  ✗ No direct probes succeeded — check panel navigation results above');
  }

  console.log('='.repeat(70));
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const siteId = flags.site ?? 'tim-cox';
  const headless = flags.headless === 'true';

  console.log(`\n  Squarespace Forms API Discovery`);
  console.log(`  Site: ${siteId}\n`);

  const browserManager = getBrowserManager({ headless });

  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    await discoverSites(page);
    const client = await resolveSite(siteId, page);
    console.log(`  Resolved site: ${client.name} (${client.site.adminUrl})\n`);

    await navigateToSite(page, client);

    const siteSubdomain = client.site.adminUrl.match(/https:\/\/([^.]+)/)?.[1] ?? siteId;

    // Step 1: Navigate to Forms panel and capture traffic
    console.log('  [STEP 1] Navigate to Forms & Submissions panel');
    const panelCapture = new NetworkCapture(page, { includePatterns: [/.*/] });
    panelCapture.clear();
    await panelCapture.start();
    const panelRequests = await discoverFormsList(page, siteSubdomain);
    const crumbToken = panelCapture.getCrumbToken();
    console.log(`  Captured ${panelRequests.length} requests (crumb: ${crumbToken ? 'found' : 'not found'})`);

    // Step 2: Probe candidate endpoints directly via page.evaluate
    console.log('\n  [STEP 2] Probe known endpoint candidates');
    const probeResults = await probeEndpointCandidates(page, siteSubdomain, crumbToken);

    // Save full output
    const allRequests = [...panelRequests, ...probeResults];
    const catalog = buildEndpointCatalog(allRequests);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = join(process.cwd(), 'data', `forms-discovery-${timestamp}.json`);

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      crumbToken,
      summary: {
        panelRequestCount: panelRequests.length,
        probeResultCount: probeResults.length,
        successfulProbes: probeResults.filter((r) => r.responseStatus === 200).length,
      },
      endpointCatalog: catalog,
      panelRequests,
      probeResults,
    };

    await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n  Full capture saved to: ${outputPath}`);

    printReport(panelRequests, probeResults);

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
