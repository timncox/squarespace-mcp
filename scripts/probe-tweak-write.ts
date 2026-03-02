/**
 * Comprehensive probe for POST /api/template/SetTemplateTweakSettings
 *
 * The endpoint returns 400 (not 404) so it exists — we need to discover the correct body shape.
 * This script systematically tries many variations of body format, content-type, method, and query params.
 *
 * Usage:
 *   npx tsx scripts/probe-tweak-write.ts
 *   npx tsx scripts/probe-tweak-write.ts --site tim-cox
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Cookie { name: string; value: string; domain: string; }

interface ProbeResult {
  label: string;
  method: string;
  url: string;
  contentType: string;
  bodyShape: string;
  status: number | null;
  statusText: string;
  responseBody: string;
  responseHeaders: Record<string, string>;
  durationMs: number;
  error?: string;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

const SESSION_PATH = resolve('storage', 'auth', 'sqsp-session.json');

function loadAuth(site: string): { cookieHeader: string; crumb: string | null } {
  if (!existsSync(SESSION_PATH)) {
    throw new Error(`Session file not found: ${SESSION_PATH}. Run a browser session first.`);
  }
  const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'));
  const cookies: Cookie[] = session.cookies ?? [];
  const globalC: Cookie[] = [];
  const siteC: Cookie[] = [];
  for (const c of cookies) {
    const d = c.domain.replace(/^\./, '');
    if (d === 'squarespace.com') globalC.push(c);
    else if (d.includes(site) || d === 'account.squarespace.com') siteC.push(c);
  }
  const byName = new Map<string, Cookie>();
  for (const c of [...globalC, ...siteC]) {
    const existing = byName.get(c.name);
    if (!existing || c.domain.includes(site)) byName.set(c.name, c);
  }
  const cookieHeader = Array.from(byName.values()).map(c => `${c.name}=${c.value}`).join('; ');
  let crumb: string | null = null;
  for (const c of siteC) {
    if (c.name === 'crumb' && c.domain.includes(site)) { crumb = c.value; break; }
  }
  return { cookieHeader, crumb };
}

// ─── HTTP Helper ────────────────────────────────────────────────────────────

async function doRequest(
  method: string,
  url: string,
  body: string | undefined,
  contentType: string,
  cookieHeader: string,
  site: string,
): Promise<{ status: number; statusText: string; body: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Origin: `https://${site}.squarespace.com`,
    Referer: `https://${site}.squarespace.com/`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    Accept: 'application/json, text/plain, */*',
  };
  if (body !== undefined) {
    headers['Content-Type'] = contentType;
  }

  const resp = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });

  const respBody = await resp.text();
  const respHeaders: Record<string, string> = {};
  for (const key of ['allow', 'x-error', 'x-sqsp-error', 'content-type', 'x-request-id', 'x-sqsp-request-id']) {
    const val = resp.headers.get(key);
    if (val) respHeaders[key] = val;
  }

  return { status: resp.status, statusText: resp.statusText, body: respBody, headers: respHeaders };
}

// ─── Main ───────────────────────────────────────────────────────────────────

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

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const site = flags.site ?? 'grey-yellow-hbxc';
  const baseUrl = `https://${site}.squarespace.com`;

  console.log('\n' + '='.repeat(70));
  console.log('  TWEAK SETTINGS WRITE PROBE');
  console.log('='.repeat(70));
  console.log(`  Site: ${site}`);
  console.log(`  Session: ${SESSION_PATH}\n`);

  const { cookieHeader, crumb } = loadAuth(site);
  console.log(`  Auth: cookies loaded, crumb ${crumb ? 'present' : 'MISSING'}\n`);

  if (!crumb) {
    console.error('ERROR: No crumb token found. Cannot make write requests.');
    process.exit(1);
  }

  // ── Step 1: GET current tweak data ──────────────────────────────────────

  console.log('-'.repeat(70));
  console.log('  STEP 1: GET current tweak settings');
  console.log('-'.repeat(70));

  const getUrl = `${baseUrl}/api/template/GetTemplateTweakSettings?version=3`;
  const getResp = await doRequest('GET', getUrl, undefined, '', cookieHeader, site);
  console.log(`  GET → ${getResp.status} (${getResp.body.length} bytes)\n`);

  if (getResp.status !== 200) {
    console.error('Failed to GET tweak settings. Aborting.');
    process.exit(1);
  }

  const tweakData = JSON.parse(getResp.body);
  const { tweakValues, siteThemeSettings } = tweakData;
  const tweakDefCount = tweakData.tweakDefinitions?.length ?? 0;

  console.log(`  tweakDefinitions: ${tweakDefCount} items`);
  console.log(`  tweakValues: ${Object.keys(tweakValues).length} keys`);
  console.log(`  siteThemeSettings: ${JSON.stringify(siteThemeSettings)}`);

  // Pick a safe tweak to modify (change back to same value = no-op)
  const testTweakKey = 'tweak-blog-item-show-date';
  const testTweakCurrentValue = tweakValues[testTweakKey] ?? 'true';
  console.log(`\n  Test tweak: "${testTweakKey}" = "${testTweakCurrentValue}"`);

  // ── Step 2: Systematic probe of SetTemplateTweakSettings ────────────────

  const allResults: ProbeResult[] = [];
  let probeNum = 0;

  async function probe(
    label: string,
    method: string,
    path: string,
    body: unknown | undefined,
    contentType: string = 'application/json',
    addCrumb: boolean = true,
  ): Promise<ProbeResult> {
    probeNum++;
    let url = `${baseUrl}${path}`;
    if (addCrumb) {
      url += (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(crumb!)}`;
    }

    const bodyStr = body !== undefined
      ? (typeof body === 'string' ? body : JSON.stringify(body))
      : undefined;

    const start = Date.now();
    try {
      const resp = await doRequest(method, url, bodyStr, contentType, cookieHeader, site);
      const duration = Date.now() - start;

      const result: ProbeResult = {
        label,
        method,
        url: url.replace(crumb!, '***'),
        contentType,
        bodyShape: bodyStr ? bodyStr.substring(0, 200) : '(no body)',
        status: resp.status,
        statusText: resp.statusText,
        responseBody: resp.body.substring(0, 500),
        responseHeaders: resp.headers,
        durationMs: duration,
      };
      allResults.push(result);

      const icon = resp.status === 200 || resp.status === 204 ? '🎉🎉🎉'
        : resp.status === 400 ? '🔍'
        : resp.status === 404 ? '❌'
        : resp.status === 405 ? '🚫'
        : '⚠️';

      console.log(`\n  ${icon} #${probeNum}: ${label}`);
      console.log(`     ${method} ${path}${addCrumb ? '?crumb=...' : ''}`);
      console.log(`     Content-Type: ${contentType}`);
      console.log(`     → ${resp.status} ${resp.statusText} (${duration}ms)`);
      if (resp.body.length > 0 && resp.body.length < 500) {
        console.log(`     → body: ${resp.body}`);
      } else if (resp.body.length > 0) {
        console.log(`     → body (first 300): ${resp.body.substring(0, 300)}`);
      }
      if (Object.keys(resp.headers).length > 0) {
        console.log(`     → headers: ${JSON.stringify(resp.headers)}`);
      }

      return result;
    } catch (err) {
      const result: ProbeResult = {
        label,
        method,
        url: url.replace(crumb!, '***'),
        contentType,
        bodyShape: bodyStr ? bodyStr.substring(0, 200) : '(no body)',
        status: null,
        statusText: '',
        responseBody: '',
        responseHeaders: {},
        durationMs: Date.now() - start,
        error: String(err),
      };
      allResults.push(result);
      console.log(`\n  💥 #${probeNum}: ${label} → ERROR: ${err}`);
      return result;
    }
  }

  // ── Group A: POST /api/template/SetTemplateTweakSettings with JSON ──────

  console.log('\n' + '-'.repeat(70));
  console.log('  GROUP A: POST SetTemplateTweakSettings (JSON body variations)');
  console.log('-'.repeat(70));

  // A1: Empty object
  await probe(
    'Empty JSON object',
    'POST', '/api/template/SetTemplateTweakSettings',
    {},
  );

  // A2: Just tweakValues (partial — single value)
  await probe(
    'Partial tweakValues (single key)',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
  );

  // A3: Full tweakValues from GET
  await probe(
    'Full tweakValues from GET',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweakValues },
  );

  // A4: Full mirror of GET response (tweakValues + siteThemeSettings)
  await probe(
    'tweakValues + siteThemeSettings (mirror GET)',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweakValues, siteThemeSettings },
  );

  // A5: Full GET response including tweakDefinitions
  await probe(
    'Full GET response (definitions + values + theme)',
    'POST', '/api/template/SetTemplateTweakSettings',
    tweakData,
  );

  // A6: Just the tweakValues directly (not wrapped)
  await probe(
    'Unwrapped tweakValues (flat object)',
    'POST', '/api/template/SetTemplateTweakSettings',
    tweakValues,
  );

  // A7: Single key-value at top level
  await probe(
    'Single tweak at top level',
    'POST', '/api/template/SetTemplateTweakSettings',
    { [testTweakKey]: testTweakCurrentValue },
  );

  // A8: With version in body
  await probe(
    'tweakValues + version in body',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue }, version: 3 },
  );

  // A9: With version as string
  await probe(
    'tweakValues + version string',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue }, version: '3' },
  );

  // A10: Nested under "settings"
  await probe(
    'Nested under settings key',
    'POST', '/api/template/SetTemplateTweakSettings',
    { settings: { [testTweakKey]: testTweakCurrentValue } },
  );

  // A11: With templateId (like UpdateNavigation needs)
  await probe(
    'tweakValues + templateId from GET',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue }, templateId: tweakData.templateId ?? '' },
  );

  // ── Group B: POST with version=3 query param ───────────────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  GROUP B: POST SetTemplateTweakSettings with ?version=3');
  console.log('-'.repeat(70));

  // B1: version=3 query + partial tweakValues
  await probe(
    'version=3 query + partial tweakValues',
    'POST', '/api/template/SetTemplateTweakSettings?version=3',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
  );

  // B2: version=3 query + full tweakValues
  await probe(
    'version=3 query + full tweakValues',
    'POST', '/api/template/SetTemplateTweakSettings?version=3',
    { tweakValues },
  );

  // B3: version=3 query + full mirror
  await probe(
    'version=3 query + full mirror',
    'POST', '/api/template/SetTemplateTweakSettings?version=3',
    { tweakValues, siteThemeSettings },
  );

  // B4: version=3 query + unwrapped
  await probe(
    'version=3 query + unwrapped values',
    'POST', '/api/template/SetTemplateTweakSettings?version=3',
    tweakValues,
  );

  // ── Group C: PUT on various URLs ──────────────────────────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  GROUP C: PUT method variations');
  console.log('-'.repeat(70));

  // C1: PUT on the GET URL
  await probe(
    'PUT on GetTemplateTweakSettings?version=3 (full data)',
    'PUT', '/api/template/GetTemplateTweakSettings?version=3',
    tweakData,
  );

  // C2: PUT on GetTemplateTweakSettings with just tweakValues
  await probe(
    'PUT on GetTemplateTweakSettings?version=3 (tweakValues only)',
    'PUT', '/api/template/GetTemplateTweakSettings?version=3',
    { tweakValues },
  );

  // C3: PUT on SetTemplateTweakSettings
  await probe(
    'PUT on SetTemplateTweakSettings',
    'PUT', '/api/template/SetTemplateTweakSettings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
  );

  // C4: PUT on SetTemplateTweakSettings with version query
  await probe(
    'PUT on SetTemplateTweakSettings?version=3',
    'PUT', '/api/template/SetTemplateTweakSettings?version=3',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
  );

  // ── Group D: Form-encoded variations ───────────────────────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  GROUP D: Form-encoded body (like SaveAdvancedSettings)');
  console.log('-'.repeat(70));

  // D1: Form-encoded tweakValues as JSON string
  await probe(
    'Form-encoded: tweakValues=JSON',
    'POST', '/api/template/SetTemplateTweakSettings',
    `tweakValues=${encodeURIComponent(JSON.stringify({ [testTweakKey]: testTweakCurrentValue }))}`,
    'application/x-www-form-urlencoded',
  );

  // D2: Form-encoded individual keys
  await probe(
    'Form-encoded: individual key=value',
    'POST', '/api/template/SetTemplateTweakSettings',
    `${encodeURIComponent(testTweakKey)}=${encodeURIComponent(testTweakCurrentValue)}`,
    'application/x-www-form-urlencoded',
  );

  // D3: Form-encoded with version
  await probe(
    'Form-encoded: tweakValues=JSON + version=3',
    'POST', '/api/template/SetTemplateTweakSettings',
    `tweakValues=${encodeURIComponent(JSON.stringify({ [testTweakKey]: testTweakCurrentValue }))}&version=3`,
    'application/x-www-form-urlencoded',
  );

  // D4: Form-encoded full tweakValues
  await probe(
    'Form-encoded: full tweakValues as JSON',
    'POST', '/api/template/SetTemplateTweakSettings',
    `tweakValues=${encodeURIComponent(JSON.stringify(tweakValues))}`,
    'application/x-www-form-urlencoded',
  );

  // ── Group E: No crumb (test if crumb matters) ──────────────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  GROUP E: Without crumb token');
  console.log('-'.repeat(70));

  // E1: No crumb
  await probe(
    'No crumb + partial tweakValues',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
    'application/json',
    false, // no crumb
  );

  // ── Group F: Alternate endpoint paths ──────────────────────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  GROUP F: Alternate endpoint paths');
  console.log('-'.repeat(70));

  // F1: Without the Get/Set prefix
  await probe(
    'POST /api/template/TemplateTweakSettings',
    'POST', '/api/template/TemplateTweakSettings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
  );

  // F2: tweak-settings (kebab)
  await probe(
    'POST /api/template/tweak-settings',
    'POST', '/api/template/tweak-settings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
  );

  // F3: site-theme-settings
  await probe(
    'POST /api/template/site-theme-settings',
    'POST', '/api/template/site-theme-settings',
    { siteThemeSettings },
  );

  // F4: PUT on tweak-settings
  await probe(
    'PUT /api/template/tweak-settings',
    'PUT', '/api/template/tweak-settings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
  );

  // F5: /api/tweak-engine (seen in some Squarespace contexts)
  await probe(
    'GET /api/tweak-engine',
    'GET', '/api/tweak-engine',
    undefined,
    '',
    false,
  );

  // F6: PUT /api/tweak-engine
  await probe(
    'PUT /api/tweak-engine',
    'PUT', '/api/tweak-engine',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
  );

  // F7: POST /api/template/SetTemplateTweakSettings with siteThemeSettings only
  await probe(
    'siteThemeSettings only (no tweakValues)',
    'POST', '/api/template/SetTemplateTweakSettings',
    { siteThemeSettings },
  );

  // F8: POST /api/template/SetSiteThemeSettings
  await probe(
    'POST /api/template/SetSiteThemeSettings',
    'POST', '/api/template/SetSiteThemeSettings',
    { siteThemeSettings },
  );

  // F9: Try PATCH on the GET URL
  await probe(
    'PATCH /api/template/GetTemplateTweakSettings?version=3',
    'PATCH', '/api/template/GetTemplateTweakSettings?version=3',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
  );

  // ── Group G: Different JSON wrapping patterns ──────────────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  GROUP G: Different JSON wrapping patterns');
  console.log('-'.repeat(70));

  // G1: Array wrapper
  await probe(
    'Array of {name, value} pairs',
    'POST', '/api/template/SetTemplateTweakSettings',
    [{ name: testTweakKey, value: testTweakCurrentValue }],
  );

  // G2: Keyed by "tweaks"
  await probe(
    'Wrapped in "tweaks" key',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweaks: { [testTweakKey]: testTweakCurrentValue } },
  );

  // G3: data wrapper
  await probe(
    'Wrapped in "data" key',
    'POST', '/api/template/SetTemplateTweakSettings',
    { data: { tweakValues: { [testTweakKey]: testTweakCurrentValue } } },
  );

  // G4: values wrapper (like form values)
  await probe(
    'Wrapped in "values" key',
    'POST', '/api/template/SetTemplateTweakSettings',
    { values: { [testTweakKey]: testTweakCurrentValue } },
  );

  // G5: Full GET but tweakDefinitions as empty array
  await probe(
    'tweakValues + siteThemeSettings + empty definitions',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweakDefinitions: [], tweakValues, siteThemeSettings },
  );

  // G6: With templateVersion
  await probe(
    'tweakValues + templateVersion: 3',
    'POST', '/api/template/SetTemplateTweakSettings',
    { tweakValues: { [testTweakKey]: testTweakCurrentValue }, templateVersion: 3 },
  );

  // ── Group H: GetTemplate info to find templateId ─────────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  GROUP H: Using templateId from GetTemplate');
  console.log('-'.repeat(70));

  const templateResp = await doRequest('GET', `${baseUrl}/api/template/GetTemplate`, undefined, '', cookieHeader, site);
  let templateId = '';
  if (templateResp.status === 200) {
    try {
      const tpl = JSON.parse(templateResp.body);
      templateId = tpl.id || tpl.templateId || '';
      console.log(`  GetTemplate → ${templateResp.status}, id: "${templateId}"`);
      console.log(`  Keys: ${Object.keys(tpl).slice(0, 15).join(', ')}`);
    } catch {
      console.log(`  GetTemplate → ${templateResp.status} (not JSON)`);
    }
  }

  if (templateId) {
    // H1: With templateId in body
    await probe(
      'tweakValues + templateId in body',
      'POST', '/api/template/SetTemplateTweakSettings',
      { tweakValues: { [testTweakKey]: testTweakCurrentValue }, templateId },
    );

    // H2: With templateId in query
    await probe(
      'tweakValues + templateId in query',
      'POST', `/api/template/SetTemplateTweakSettings?templateId=${encodeURIComponent(templateId)}`,
      { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
    );

    // H3: PUT on template-specific path
    await probe(
      `PUT /api/template/${templateId}/tweaks`,
      'PUT', `/api/template/${templateId}/tweaks`,
      { tweakValues: { [testTweakKey]: testTweakCurrentValue } },
    );

    // H4: POST /api/template/SetTemplateTweakSettings with everything
    await probe(
      'Full body: tweakValues + siteThemeSettings + templateId',
      'POST', '/api/template/SetTemplateTweakSettings',
      { tweakValues, siteThemeSettings, templateId },
    );

    // H5: Form-encoded with templateId
    await probe(
      'Form-encoded: tweakValues + templateId',
      'POST', '/api/template/SetTemplateTweakSettings',
      `tweakValues=${encodeURIComponent(JSON.stringify({ [testTweakKey]: testTweakCurrentValue }))}&templateId=${encodeURIComponent(templateId)}`,
      'application/x-www-form-urlencoded',
    );
  }

  // ── Summary ────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));

  const successes = allResults.filter(r => r.status === 200 || r.status === 204);
  const badRequests = allResults.filter(r => r.status === 400);
  const notFound = allResults.filter(r => r.status === 404);
  const notAllowed = allResults.filter(r => r.status === 405);
  const serverErrors = allResults.filter(r => r.status !== null && r.status >= 500);
  const others = allResults.filter(r =>
    r.status !== null && r.status !== 200 && r.status !== 204 &&
    r.status !== 400 && r.status !== 404 && r.status !== 405 && r.status < 500
  );

  if (successes.length > 0) {
    console.log('\n  🎉🎉🎉 SUCCESSFUL WRITES:');
    for (const r of successes) {
      console.log(`    ${r.label}`);
      console.log(`      ${r.method} → ${r.status} (${r.durationMs}ms)`);
      console.log(`      Body shape: ${r.bodyShape}`);
      if (r.responseBody) console.log(`      Response: ${r.responseBody.substring(0, 300)}`);
    }
  } else {
    console.log('\n  ❌ No successful writes found.');
  }

  if (serverErrors.length > 0) {
    console.log(`\n  💥 Server Errors (500): ${serverErrors.length} — endpoint tried to process!`);
    for (const r of serverErrors) {
      console.log(`    ${r.label} → ${r.status} ${r.statusText}`);
      if (r.responseBody) console.log(`      Response: ${r.responseBody.substring(0, 200)}`);
    }
  }

  console.log(`\n  📊 Status breakdown:`);
  console.log(`    200/204 (success): ${successes.length}`);
  console.log(`    400 (bad request): ${badRequests.length}`);
  console.log(`    404 (not found):   ${notFound.length}`);
  console.log(`    405 (not allowed): ${notAllowed.length}`);
  console.log(`    500+ (server err): ${serverErrors.length}`);
  console.log(`    Other:             ${others.length}`);
  console.log(`    Total probes:      ${allResults.length}`);

  // Log unique 400 response bodies (they might differ with clues)
  const unique400Bodies = new Map<string, string[]>();
  for (const r of badRequests) {
    const key = r.responseBody.substring(0, 200) || '(empty)';
    if (!unique400Bodies.has(key)) unique400Bodies.set(key, []);
    unique400Bodies.get(key)!.push(r.label);
  }

  if (unique400Bodies.size > 0) {
    console.log(`\n  🔍 Unique 400 response bodies (${unique400Bodies.size}):`);
    for (const [body, labels] of unique400Bodies) {
      console.log(`    Body: "${body}"`);
      console.log(`      Probes: ${labels.join(', ')}`);
    }
  }

  // Save full report
  const reportPath = join(process.cwd(), 'data', `tweak-write-probe-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), site, probes: allResults }, null, 2));
  console.log(`\n  Full report saved: ${reportPath}`);
  console.log('\n' + '='.repeat(70) + '\n');
}

main().catch(err => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
