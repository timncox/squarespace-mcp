/**
 * Follow-up probe: /api/tweak-engine POST and SetTemplateTweakSettings with templateId
 *
 * Key discovery from probe-tweak-write.ts:
 * - /api/tweak-engine allows POST (405 shows: HEAD,POST,GET,OPTIONS)
 * - All SetTemplateTweakSettings attempts return 400 with unique errorKeys
 *
 * Usage: npx tsx scripts/probe-tweak-write-2.ts
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
  contentType = 'application/json',
  addCrumb = true,
) {
  const { cookieHeader, crumb } = loadAuth();
  let url = `${baseUrl}${path}`;
  if (addCrumb && crumb && method !== 'GET') {
    url += (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(crumb)}`;
  }
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Origin: baseUrl,
    Referer: `${baseUrl}/`,
    Accept: 'application/json, text/plain, */*',
  };
  if (body !== undefined) headers['Content-Type'] = contentType;

  const resp = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await resp.text();
  const respHeaders: Record<string, string> = {};
  for (const key of ['allow', 'content-type', 'x-error', 'x-sqsp-error']) {
    const val = resp.headers.get(key);
    if (val) respHeaders[key] = val;
  }
  return { status: resp.status, statusText: resp.statusText, body: text, headers: respHeaders };
}

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('  TWEAK SETTINGS WRITE PROBE — ROUND 2');
  console.log('='.repeat(70));

  // ── Step 1: Get current data ──────────────────────────────────────────

  console.log('\n--- GET /api/template/GetTemplateTweakSettings?version=3 ---');
  const tweakResp = await req('GET', '/api/template/GetTemplateTweakSettings?version=3');
  const tweakData = JSON.parse(tweakResp.body);
  const { tweakValues, siteThemeSettings } = tweakData;
  console.log(`  ${tweakResp.status} — ${Object.keys(tweakValues).length} tweakValues`);

  console.log('\n--- GET /api/template/GetTemplate ---');
  const tplResp = await req('GET', '/api/template/GetTemplate');
  console.log(`  ${tplResp.status} (${tplResp.body.length} bytes)`);
  let tplData: any = null;
  if (tplResp.status === 200) {
    tplData = JSON.parse(tplResp.body);
    console.log(`  Keys: ${Object.keys(tplData).join(', ')}`);
    console.log(`  id: ${tplData.id}`);
    console.log(`  internalName: ${tplData.internalName}`);
    console.log(`  templateId: ${tplData.templateId}`);
    console.log(`  websiteId: ${tplData.websiteId}`);
    // Show more keys that might be relevant
    for (const key of ['version', 'templateVersion', 'previewUrl', 'type', 'hasDataStore']) {
      if (key in tplData) console.log(`  ${key}: ${JSON.stringify(tplData[key])}`);
    }
  }

  console.log('\n--- GET /api/tweak-engine (first 500 chars) ---');
  const engineResp = await req('GET', '/api/tweak-engine');
  console.log(`  ${engineResp.status} (${engineResp.body.length} bytes)`);
  if (engineResp.status === 200) {
    const engineData = JSON.parse(engineResp.body);
    console.log(`  Keys: ${Object.keys(engineData).join(', ')}`);
    for (const k of Object.keys(engineData)) {
      const val = engineData[k];
      const preview = typeof val === 'string' ? val.substring(0, 100) : JSON.stringify(val).substring(0, 100);
      console.log(`  ${k}: ${preview}`);
    }
  }

  // Also get siteLayout for potential IDs we need
  console.log('\n--- GET /api/commondata/GetSiteLayout ---');
  const layoutResp = await req('GET', '/api/commondata/GetSiteLayout');
  console.log(`  ${layoutResp.status}`);
  if (layoutResp.status === 200) {
    const layout = JSON.parse(layoutResp.body);
    console.log(`  Keys: ${Object.keys(layout).join(', ')}`);
    if (layout.templateId) console.log(`  templateId: ${layout.templateId}`);
    if (layout.websiteId) console.log(`  websiteId: ${layout.websiteId}`);
    if (layout.siteId) console.log(`  siteId: ${layout.siteId}`);
  }

  // ── Step 2: POST /api/tweak-engine variations ──────────────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  POST /api/tweak-engine variations');
  console.log('-'.repeat(70));

  const testKey = 'tweak-blog-item-show-date';
  const testVal = tweakValues[testKey];

  const tweakEngineProbes = [
    { label: 'Empty object', body: {} },
    { label: 'Partial tweakValues', body: { tweakValues: { [testKey]: testVal } } },
    { label: 'Full tweakValues', body: { tweakValues } },
    { label: 'Unwrapped flat values', body: tweakValues },
    { label: 'With siteThemeSettings', body: { tweakValues: { [testKey]: testVal }, siteThemeSettings } },
    { label: 'tweakLess key (matching GET)', body: { tweakLess: 'test' } },
    { label: 'compiledLess key', body: { compiledLess: 'test' } },
  ];

  for (const { label, body } of tweakEngineProbes) {
    const r = await req('POST', '/api/tweak-engine', body);
    const icon = r.status === 200 || r.status === 204 ? '🎉' : r.status === 400 ? '🔍' : '⚠️';
    console.log(`\n  ${icon} ${label}`);
    console.log(`     → ${r.status} ${r.statusText}`);
    if (r.body.length > 0) console.log(`     → body: ${r.body.substring(0, 300)}`);
    if (Object.keys(r.headers).length > 0) console.log(`     → headers: ${JSON.stringify(r.headers)}`);
  }

  // ── Step 3: POST SetTemplateTweakSettings with IDs from GetTemplate ────

  if (tplData) {
    console.log('\n' + '-'.repeat(70));
    console.log('  SetTemplateTweakSettings with template IDs');
    console.log('-'.repeat(70));

    const templateId = tplData.id;
    const websiteId = tplData.websiteId;

    const idProbes = [
      { label: 'templateId + websiteId + tweakValues', body: { templateId, websiteId, tweakValues: { [testKey]: testVal } } },
      { label: 'id + tweakValues', body: { id: templateId, tweakValues: { [testKey]: testVal } } },
      { label: 'websiteId + tweakValues', body: { websiteId, tweakValues: { [testKey]: testVal } } },
      { label: 'Full: templateId + websiteId + tweakValues + siteThemeSettings', body: { templateId, websiteId, tweakValues, siteThemeSettings } },
      { label: 'tweakValues nested in template obj', body: { template: { id: templateId, tweakValues: { [testKey]: testVal } } } },
      { label: 'version + tweakValues', body: { version: tplData.version ?? 3, tweakValues: { [testKey]: testVal } } },
    ];

    for (const { label, body } of idProbes) {
      const r = await req('POST', '/api/template/SetTemplateTweakSettings', body);
      const icon = r.status === 200 || r.status === 204 ? '🎉' : r.status === 400 ? '🔍' : '⚠️';
      console.log(`\n  ${icon} ${label}`);
      console.log(`     → ${r.status} ${r.statusText}`);
      if (r.body.length > 0) console.log(`     → body: ${r.body.substring(0, 300)}`);
    }

    // Also try with version=3 query
    console.log('\n  --- With version=3 query param ---');
    for (const { label, body } of idProbes.slice(0, 2)) {
      const r = await req('POST', '/api/template/SetTemplateTweakSettings?version=3', body);
      const icon = r.status === 200 || r.status === 204 ? '🎉' : r.status === 400 ? '🔍' : '⚠️';
      console.log(`\n  ${icon} ${label} (+ ?version=3)`);
      console.log(`     → ${r.status} ${r.statusText}`);
      if (r.body.length > 0) console.log(`     → body: ${r.body.substring(0, 300)}`);
    }
  }

  // ── Step 4: Try OPTIONS to see what's expected ─────────────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  OPTIONS requests (check CORS / expected content)');
  console.log('-'.repeat(70));

  for (const path of ['/api/template/SetTemplateTweakSettings', '/api/tweak-engine']) {
    const r = await req('OPTIONS', path, undefined, '', false);
    console.log(`\n  OPTIONS ${path}`);
    console.log(`     → ${r.status} ${r.statusText}`);
    console.log(`     → headers: ${JSON.stringify(r.headers)}`);
    if (r.body.length > 0) console.log(`     → body: ${r.body.substring(0, 200)}`);
  }

  // ── Step 5: Try POST /api/tweak-engine with form-encoded ──────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  POST /api/tweak-engine with form-encoded');
  console.log('-'.repeat(70));

  const formProbes = [
    { label: 'Form: tweakValues=JSON', body: `tweakValues=${encodeURIComponent(JSON.stringify({ [testKey]: testVal }))}` },
    { label: 'Form: key=value', body: `${encodeURIComponent(testKey)}=${encodeURIComponent(testVal)}` },
    { label: 'Form: empty', body: '' },
  ];

  for (const { label, body } of formProbes) {
    const r = await req('POST', '/api/tweak-engine', body, 'application/x-www-form-urlencoded');
    const icon = r.status === 200 || r.status === 204 ? '🎉' : r.status === 400 ? '🔍' : '⚠️';
    console.log(`\n  ${icon} ${label}`);
    console.log(`     → ${r.status} ${r.statusText}`);
    if (r.body.length > 0) console.log(`     → body: ${r.body.substring(0, 300)}`);
  }

  // ── Step 6: Check /api/settings for tweak-related fields ───────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  Check /api/settings for tweak-related fields');
  console.log('-'.repeat(70));

  const settingsResp = await req('GET', '/api/settings');
  if (settingsResp.status === 200) {
    const settings = JSON.parse(settingsResp.body);
    const tweakRelated = Object.keys(settings).filter(k =>
      k.toLowerCase().includes('tweak') ||
      k.toLowerCase().includes('theme') ||
      k.toLowerCase().includes('template') ||
      k.toLowerCase().includes('style')
    );
    console.log(`  Tweak/theme/template/style related keys in /api/settings:`);
    for (const k of tweakRelated) {
      const val = settings[k];
      const preview = typeof val === 'object' ? JSON.stringify(val).substring(0, 200) : String(val);
      console.log(`    ${k}: ${preview}`);
    }
  }

  // ── Step 7: Try writing tweaks through /api/settings ───────────────────

  console.log('\n' + '-'.repeat(70));
  console.log('  Try tweaks through /api/settings PUT');
  console.log('-'.repeat(70));

  // Maybe tweakValues live inside settings?
  const settingsWithTweaks = {
    tweakValues: { [testKey]: testVal },
  };
  const r = await req('PUT', '/api/settings', settingsWithTweaks);
  console.log(`  PUT /api/settings with tweakValues → ${r.status} ${r.statusText}`);
  if (r.body.length > 0) console.log(`  → body: ${r.body.substring(0, 300)}`);

  // Try siteThemeSettings via settings
  const settingsWithTheme = {
    siteThemeSettings,
  };
  const r2 = await req('PUT', '/api/settings', settingsWithTheme);
  console.log(`  PUT /api/settings with siteThemeSettings → ${r2.status} ${r2.statusText}`);
  if (r2.body.length > 0) console.log(`  → body: ${r2.body.substring(0, 300)}`);

  console.log('\n' + '='.repeat(70));
  console.log('  DONE');
  console.log('='.repeat(70) + '\n');
}

main().catch(err => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
