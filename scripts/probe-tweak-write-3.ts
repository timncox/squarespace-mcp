/**
 * Round 3 probe: Session validation + tweak-engine body shape + extra headers
 *
 * Key findings from round 2:
 * - /api/tweak-engine POST → 500 (tries to process, needs correct body)
 * - /api/tweak-engine requires JSON (415 for form-encoded)
 * - /api/template/GetTemplate → 500 (possible session issue)
 * - SetTemplateTweakSettings consistently 400
 *
 * Hypotheses to test:
 * 1. tweak-engine POST might be a compile/preview endpoint needing tweakLess + tweakValues
 * 2. SetTemplateTweakSettings might need X-Requested-With header
 * 3. Session might be partially stale — check known-working endpoints
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';

interface Cookie { name: string; value: string; domain: string; }

const SESSION_PATH = resolve('storage', 'auth', 'sqsp-session.json');
const site = 'grey-yellow-hbxc';
const baseUrl = `https://${site}.squarespace.com`;

function loadAuth() {
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

async function req(
  method: string,
  path: string,
  body?: unknown,
  options?: { contentType?: string; addCrumb?: boolean; extraHeaders?: Record<string, string> },
) {
  const { cookieHeader, crumb } = loadAuth();
  const opts = { contentType: 'application/json', addCrumb: true, ...options };
  let url = `${baseUrl}${path}`;
  if (opts.addCrumb && crumb && method !== 'GET') {
    url += (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(crumb)}`;
  }
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Origin: baseUrl,
    Referer: `${baseUrl}/`,
    Accept: 'application/json, text/plain, */*',
    ...(opts.extraHeaders ?? {}),
  };
  if (body !== undefined) headers['Content-Type'] = opts.contentType!;

  const resp = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text();
  const respHeaders: Record<string, string> = {};
  for (const key of ['allow', 'content-type', 'x-error', 'x-sqsp-error', 'x-sqsp-request-id']) {
    const val = resp.headers.get(key);
    if (val) respHeaders[key] = val;
  }
  return { status: resp.status, statusText: resp.statusText, body: text, headers: respHeaders };
}

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('  TWEAK WRITE PROBE — ROUND 3');
  console.log('='.repeat(70));

  // ── Session Health Check ───────────────────────────────────────────────
  console.log('\n--- Session Health Check ---');

  const settingsR = await req('GET', '/api/settings');
  console.log(`  GET /api/settings → ${settingsR.status} (known-working read)`);

  // Check a known working write (PUT /api/settings with empty — should 500 not 401)
  const writeCheck = await req('PUT', '/api/website-fonts', {});
  console.log(`  PUT /api/website-fonts (empty) → ${writeCheck.status} (write auth check)`);

  // Check crumb
  const { crumb } = loadAuth();
  console.log(`  Crumb: ${crumb ? 'present (' + crumb.substring(0, 20) + '...)' : 'MISSING'}`);

  // ── Get tweak data ─────────────────────────────────────────────────────
  console.log('\n--- Fetch current data ---');

  const tweakResp = await req('GET', '/api/template/GetTemplateTweakSettings?version=3');
  const tweakData = JSON.parse(tweakResp.body);
  const { tweakValues, siteThemeSettings, tweakDefinitions } = tweakData;
  console.log(`  Tweak GET → ${tweakResp.status}, ${Object.keys(tweakValues).length} values, ${tweakDefinitions.length} defs`);

  // Get tweak-engine data structure
  const engineResp = await req('GET', '/api/tweak-engine');
  const engineData = JSON.parse(engineResp.body);
  console.log(`  Tweak-engine → ${engineResp.status}, keys: ${Object.keys(engineData).join(', ')}`);

  const testKey = 'tweak-blog-item-show-date';
  const testVal = tweakValues[testKey];

  // ── Test 1: tweak-engine POST with engine-shaped bodies ────────────────
  console.log('\n' + '-'.repeat(70));
  console.log('  TEST 1: /api/tweak-engine POST with engine-shaped bodies');
  console.log('-'.repeat(70));

  // The GET returns: tweakLess, tweakIdMap, tweakValues, staticCss
  // Maybe POST needs the same structure or part of it

  const engineProbes = [
    {
      label: 'tweakValues only (from engine GET)',
      body: { tweakValues: engineData.tweakValues },
    },
    {
      label: 'Full engine data echoed back',
      body: engineData,
    },
    {
      label: 'tweakValues + tweakIdMap',
      body: { tweakValues: engineData.tweakValues, tweakIdMap: engineData.tweakIdMap },
    },
    {
      label: 'Modified single value in full tweakValues',
      body: { tweakValues: { ...engineData.tweakValues, [testKey]: testVal } },
    },
  ];

  for (const { label, body } of engineProbes) {
    const r = await req('POST', '/api/tweak-engine', body);
    const icon = r.status === 200 || r.status === 204 ? '🎉' : r.status === 500 ? '💥' : '🔍';
    console.log(`\n  ${icon} ${label} → ${r.status}`);
    if (r.body.length > 0) console.log(`     body: ${r.body.substring(0, 200)}`);
  }

  // ── Test 2: SetTemplateTweakSettings with extra headers ────────────────
  console.log('\n' + '-'.repeat(70));
  console.log('  TEST 2: SetTemplateTweakSettings with extra request headers');
  console.log('-'.repeat(70));

  const headerVariations: Array<{ label: string; headers: Record<string, string> }> = [
    { label: 'X-Requested-With: XMLHttpRequest', headers: { 'X-Requested-With': 'XMLHttpRequest' } },
    { label: 'X-CSRF-Token from crumb', headers: { 'X-CSRF-Token': crumb ?? '' } },
    { label: 'Both X-Requested-With + X-CSRF-Token', headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': crumb ?? '' } },
    { label: 'Accept: */*', headers: { Accept: '*/*' } },
    { label: 'Content-Type: text/plain', headers: {} },
  ];

  for (const { label, headers } of headerVariations) {
    const body = label.includes('text/plain')
      ? undefined // will test separately
      : { tweakValues: { [testKey]: testVal } };
    const ct = label.includes('text/plain') ? 'text/plain' : 'application/json';
    const finalBody = label.includes('text/plain')
      ? JSON.stringify({ tweakValues: { [testKey]: testVal } })
      : body;

    const r = await req('POST', '/api/template/SetTemplateTweakSettings', finalBody, {
      extraHeaders: headers,
      contentType: ct,
    });
    const icon = r.status === 200 || r.status === 204 ? '🎉' : r.status === 400 ? '🔍' : '⚠️';
    console.log(`\n  ${icon} ${label} → ${r.status}`);
    if (r.body.length > 0) console.log(`     body: ${r.body.substring(0, 200)}`);
  }

  // ── Test 3: Network capture emulation ──────────────────────────────────
  // The Squarespace editor likely sends specific data when changing a tweak.
  // Let's try to emulate what the editor would send.
  console.log('\n' + '-'.repeat(70));
  console.log('  TEST 3: Editor-emulation body shapes');
  console.log('-'.repeat(70));

  // The editor might send the FULL current state with one modified value
  const modifiedValues = { ...tweakValues };
  // Don't actually change anything — keep same value
  modifiedValues[testKey] = testVal;

  const editorProbes = [
    {
      label: 'Full state: tweakValues + siteThemeSettings + version',
      body: { tweakValues: modifiedValues, siteThemeSettings, version: 3 },
    },
    {
      label: 'Full state + tweakDefinitions',
      body: { tweakValues: modifiedValues, siteThemeSettings, tweakDefinitions, version: 3 },
    },
    {
      label: 'Wrapped: { tweakSettings: { tweakValues, siteThemeSettings } }',
      body: { tweakSettings: { tweakValues: modifiedValues, siteThemeSettings } },
    },
    {
      label: 'With "changed" marker: { tweakValues, changedTweaks: [key] }',
      body: { tweakValues: { [testKey]: testVal }, changedTweaks: [testKey] },
    },
    {
      label: 'Just changed: { name, value }',
      body: { name: testKey, value: testVal },
    },
    {
      label: '{ tweakName: key, tweakValue: val }',
      body: { tweakName: testKey, tweakValue: testVal },
    },
    {
      label: '{ key: tweakName, value: tweakValue }',
      body: { key: testKey, value: testVal },
    },
  ];

  for (const { label, body } of editorProbes) {
    const r = await req('POST', '/api/template/SetTemplateTweakSettings', body);
    const icon = r.status === 200 || r.status === 204 ? '🎉' : r.status === 400 ? '🔍' : '⚠️';
    console.log(`\n  ${icon} ${label} → ${r.status}`);
    if (r.body.length > 0 && r.status !== 400) console.log(`     body: ${r.body.substring(0, 200)}`);
  }

  // ── Test 4: Try to reverse-engineer from error keys ────────────────────
  // Different errorKeys might indicate different validation failures
  // Let's try with null/undefined/empty values to see if error changes
  console.log('\n' + '-'.repeat(70));
  console.log('  TEST 4: Edge case bodies (null, array, string)');
  console.log('-'.repeat(70));

  const edgeCases = [
    { label: 'null body', body: null },
    { label: 'string body "test"', body: '"test"' },
    { label: 'number body 42', body: '42' },
    { label: 'array body []', body: [] },
    { label: 'Deeply nested tweaks', body: { template: { tweaks: { values: { [testKey]: testVal } } } } },
    { label: 'settings key', body: { settings: { tweakValues: { [testKey]: testVal } } } },
  ];

  for (const { label, body } of edgeCases) {
    const rawBody = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = await req('POST', '/api/template/SetTemplateTweakSettings', rawBody ?? undefined, {
      contentType: 'application/json',
    });
    const icon = r.status === 200 || r.status === 204 ? '🎉' : r.status === 400 ? '🔍' : '⚠️';
    console.log(`\n  ${icon} ${label} → ${r.status}`);
    if (r.body.length > 0 && r.body !== '{"error":"Something went wrong.","errorKey":"' + r.body.match(/"errorKey":"([^"]+)"/)?.[1] + '","cleaned":true}') {
      console.log(`     body: ${r.body.substring(0, 200)}`);
    }
    // Extract errorKey
    const errorMatch = r.body.match(/"errorKey":"([^"]+)"/);
    if (errorMatch) console.log(`     errorKey: ${errorMatch[1]}`);
  }

  // ── Test 5: Check /api/website-id and use it ──────────────────────────
  console.log('\n' + '-'.repeat(70));
  console.log('  TEST 5: Website ID approaches');
  console.log('-'.repeat(70));

  // Get websiteId from navigation (known working endpoint)
  const navResp = await req('GET', '/api/navigation');
  let websiteId = '';
  if (navResp.status === 200) {
    const nav = JSON.parse(navResp.body);
    websiteId = nav.websiteId || '';
    console.log(`  websiteId from /api/navigation: ${websiteId}`);
  }

  if (websiteId) {
    const idProbes = [
      { label: 'websiteId + tweakValues', body: { websiteId, tweakValues: { [testKey]: testVal } } },
      { label: 'websiteId + tweakValues + siteThemeSettings', body: { websiteId, tweakValues: { [testKey]: testVal }, siteThemeSettings } },
    ];

    for (const { label, body } of idProbes) {
      const r = await req('POST', '/api/template/SetTemplateTweakSettings', body);
      const icon = r.status === 200 || r.status === 204 ? '🎉' : r.status === 400 ? '🔍' : '⚠️';
      console.log(`  ${icon} ${label} → ${r.status}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('  DONE');
  console.log('='.repeat(70) + '\n');
}

main().catch(err => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
