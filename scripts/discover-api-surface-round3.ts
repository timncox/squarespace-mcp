#!/usr/bin/env tsx
/**
 * discover-api-surface-round3.ts — Focused deep probe
 *
 * Based on rounds 1 & 2:
 * - Check if /config/design and /config/pages are HTML or JSON
 * - Try PATCH on /api/navigation and /api/settings
 * - Try POST on /api/settings with specific field updates
 * - Explore more variations of working endpoints
 * - Look for custom CSS, SEO, social links APIs
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SITE_SUBDOMAIN = 'grey-yellow-hbxc';
const COOKIES_PATH = join(homedir(), '.squarespace', 'cookies', `${SITE_SUBDOMAIN}.json`);
const BASE_URL = `https://${SITE_SUBDOMAIN}.squarespace.com`;
const TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

interface SessionCookie { name: string; value: string; domain: string; }

function loadCookies(): { cookieHeader: string; crumbToken: string | null } {
  const session = JSON.parse(readFileSync(COOKIES_PATH, 'utf-8'));
  const cookies: SessionCookie[] = session.cookies ?? [];
  const globalCookies: SessionCookie[] = [];
  const siteCookies: SessionCookie[] = [];

  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, '');
    if (domain === 'squarespace.com') globalCookies.push(c);
    else if (domain.includes(SITE_SUBDOMAIN) || domain === 'account.squarespace.com') siteCookies.push(c);
  }

  const byName = new Map<string, SessionCookie>();
  for (const c of [...globalCookies, ...siteCookies]) {
    const existing = byName.get(c.name);
    if (!existing || c.domain.includes(SITE_SUBDOMAIN)) byName.set(c.name, c);
  }

  const cookieHeader = Array.from(byName.values()).map((c) => `${c.name}=${c.value}`).join('; ');
  let crumbToken: string | null = null;
  for (const c of siteCookies) {
    if (c.name === 'crumb' && c.domain.includes(SITE_SUBDOMAIN)) { crumbToken = c.value; break; }
  }
  return { cookieHeader, crumbToken };
}

function buildHeaders(cookieHeader: string): Record<string, string> {
  return {
    Cookie: cookieHeader, Origin: BASE_URL, Referer: `${BASE_URL}/`,
    'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*',
  };
}

async function probe(path: string, headers: Record<string, string>, method = 'GET', body?: string) {
  const url = `${BASE_URL}${path}`;
  try {
    const opts: RequestInit = { method, headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (body) opts.body = body;
    const res = await fetch(url, opts);
    const ct = res.headers.get('content-type') ?? '';
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, size: text.length, contentType: ct, data, text: text.slice(0, 500), isJson: !!data };
  } catch (err) {
    return { status: 0, size: 0, contentType: '', data: undefined, text: '', isJson: false, error: String(err) };
  }
}

async function main(): Promise<void> {
  const { cookieHeader, crumbToken } = loadCookies();
  const headers = buildHeaders(cookieHeader);
  const crumbSuffix = crumbToken ? `?crumb=${encodeURIComponent(crumbToken)}` : '';

  console.log('🔍 Round 3: Focused Deep Probe\n');

  // ── 1. Check /config endpoints (HTML or JSON?) ──────────────────────
  console.log('═══ /config endpoints — HTML check ═══');
  for (const path of ['/config/design', '/config/pages']) {
    const r = await probe(path, headers);
    console.log(`  ${path}: ${r.status}, contentType=${r.contentType}, isJson=${r.isJson}, size=${r.size}`);
    if (!r.isJson) {
      console.log(`    First 200 chars: ${r.text.slice(0, 200)}`);
    }
  }

  // ── 2. PATCH on navigation ──────────────────────────────────────────
  console.log('\n═══ /api/navigation — trying PATCH ═══');
  const navData = (await probe('/api/navigation', headers)).data;
  if (navData) {
    const patchResult = await probe(`/api/navigation${crumbSuffix}`, headers, 'PATCH', JSON.stringify(navData));
    console.log(`  PATCH /api/navigation: ${patchResult.status} (${patchResult.size} bytes)`);
    if (patchResult.status !== 200) console.log(`    Response: ${patchResult.text.slice(0, 200)}`);
  }

  // ── 3. POST on settings (partial update) ────────────────────────────
  console.log('\n═══ /api/settings — trying POST and PATCH ═══');
  // Try POST
  const postSettings = await probe(`/api/settings${crumbSuffix}`, headers, 'POST', JSON.stringify({ seoHidden: false }));
  console.log(`  POST /api/settings: ${postSettings.status} (${postSettings.size} bytes)`);
  if (postSettings.data) console.log(`    Response preview: ${JSON.stringify(postSettings.data).slice(0, 200)}`);
  if (postSettings.status !== 200) console.log(`    Error: ${postSettings.text.slice(0, 200)}`);

  // Try PATCH
  const patchSettings = await probe(`/api/settings${crumbSuffix}`, headers, 'PATCH', JSON.stringify({ seoHidden: false }));
  console.log(`  PATCH /api/settings: ${patchSettings.status} (${patchSettings.size} bytes)`);
  if (patchSettings.data) console.log(`    Response preview: ${JSON.stringify(patchSettings.data).slice(0, 200)}`);

  // ── 4. Explore sub-endpoints of /api/settings ───────────────────────
  console.log('\n═══ /api/settings sub-endpoints ═══');
  const settingsSubPaths = [
    '/api/settings/announcement-bar',
    '/api/settings/social-accounts',
    '/api/settings/seo',
    '/api/settings/cookie-banner',
    '/api/settings/business-info',
    '/api/settings/business-hours',
    '/api/settings/domains',
    '/api/settings/security',
    '/api/settings/locale',
    '/api/settings/language',
    '/api/settings/blog',
    '/api/settings/comments',
    '/api/settings/store',
    '/api/settings/badge',
    '/api/settings/favicon',
    '/api/settings/share-buttons',
    '/api/settings/advanced',
    '/api/settings/code-injection',
  ];
  for (const path of settingsSubPaths) {
    const r = await probe(path, headers);
    if (r.status === 200) {
      console.log(`  ✅ ${path} — ${r.size} bytes, isJson=${r.isJson}`);
      if (r.isJson) {
        const keys = typeof r.data === 'object' && r.data !== null ? Object.keys(r.data as Record<string, unknown>) : [];
        console.log(`     Keys: ${keys.slice(0, 10).join(', ')}`);
      }
    } else if (r.status !== 404) {
      console.log(`  ⚠️  ${path} → ${r.status}`);
    }
  }

  // ── 5. More Squarespace API patterns ────────────────────────────────
  console.log('\n═══ Additional Squarespace patterns ═══');
  const moreEndpoints = [
    // Custom CSS endpoint variations
    '/api/custom-css/draft',
    '/api/customcss/draft',

    // Social accounts (from settings.socialAccountDisplayOrder)
    '/api/social-accounts',
    '/api/social-account-links',

    // Announcement bar
    '/api/announcement-bar',
    '/api/announcements/bar',

    // Redirects (different patterns)
    '/api/url-redirects/list',
    '/api/redirect',

    // Page-level APIs using known collectionIds
    '/api/collections/6993497ab23b0453e46b656c',  // Menus page
    '/api/items/6993497ab23b0453e46b656c',

    // Website-level meta
    '/api/website/69934978b23b0453e46b6508',

    // Mobile info bar
    '/api/mobile-info-bar',

    // Lock screen / password
    '/api/lock-screen',

    // DNS / domain variations
    '/api/domains/list',

    // Form builder variations
    '/api/form-builder',
    '/api/forms/list',

    // Blog posts via collection
    `/api/blog/69a358daecb2f10afcc77780`,

    // Fonts via template
    '/api/template/fonts',

    // Squarespace 7.1 specific
    '/api/visitor-data',
    '/api/site-badge',
    '/api/cookie-consent',
    '/api/code-injection',

    // Page-level config
    '/api/page-config',
    '/api/page-metadata',

    // Internationalization
    '/api/locale',
    '/api/language',
    '/api/translations',

    // Marketing
    '/api/marketing',
    '/api/email',
    '/api/campaigns',

    // Connected accounts
    '/api/connected-accounts',
    '/api/third-party-connections',
  ];

  for (const path of moreEndpoints) {
    const r = await probe(path, headers);
    if (r.status === 200) {
      console.log(`  ✅ ${path} — ${r.size} bytes`);
      if (r.isJson && r.data && typeof r.data === 'object') {
        const keys = Object.keys(r.data as Record<string, unknown>);
        console.log(`     Keys: ${keys.slice(0, 10).join(', ')}`);
        // Show nested structure for interesting endpoints
        for (const key of keys.slice(0, 5)) {
          const val = (r.data as Record<string, unknown>)[key];
          if (Array.isArray(val)) {
            console.log(`     ${key}: Array[${val.length}]`);
          } else if (typeof val === 'object' && val !== null) {
            console.log(`     ${key}: Object{${Object.keys(val as Record<string, unknown>).slice(0, 5).join(', ')}}`);
          } else {
            console.log(`     ${key}: ${String(val).slice(0, 80)}`);
          }
        }
      } else if (!r.isJson) {
        console.log(`     (non-JSON, first 100 chars): ${r.text.slice(0, 100)}`);
      }
    } else if (r.status !== 404) {
      console.log(`  ⚠️  ${path} → ${r.status}`);
    }
  }

  // ── 6. Try PUT on settings with specific field (safe test) ──────────
  console.log('\n═══ /api/settings — safe write test ═══');
  // Read current settings first
  const currentSettings = await probe('/api/settings', headers);
  if (currentSettings.data && typeof currentSettings.data === 'object') {
    const settings = currentSettings.data as Record<string, unknown>;
    const currentId = settings.id;

    // Try PUT with the full settings object (identity write)
    console.log(`  Settings ID: ${currentId}`);
    console.log('  Trying PUT with full settings object...');
    const putFull = await probe(`/api/settings${crumbSuffix}`, { ...headers, 'Content-Type': 'application/json' }, 'PUT', JSON.stringify(settings));
    console.log(`  PUT (full): ${putFull.status} (${putFull.size} bytes)`);
    if (putFull.text) console.log(`    Response: ${putFull.text.slice(0, 300)}`);

    // Try PUT with just the ID + one field
    console.log('  Trying PUT with id + single field...');
    const putPartial = await probe(`/api/settings/${currentId}${crumbSuffix}`, { ...headers, 'Content-Type': 'application/json' }, 'PUT', JSON.stringify({ id: currentId, seoHidden: false }));
    console.log(`  PUT (partial to /${currentId}): ${putPartial.status} (${putPartial.size} bytes)`);
    if (putPartial.text) console.log(`    Response: ${putPartial.text.slice(0, 300)}`);
  }

  // ── 7. Check for custom CSS endpoint ────────────────────────────────
  console.log('\n═══ Custom CSS endpoints ═══');
  const cssEndpoints = [
    '/api/custom-css',
    '/api/custom-css/live',
    '/api/custom-css/draft',
    '/api/site-css',
    '/api/less',
    '/api/less-variables',
  ];
  for (const path of cssEndpoints) {
    const r = await probe(path, headers);
    if (r.status === 200) {
      console.log(`  ✅ ${path} — ${r.size} bytes, contentType=${r.contentType}`);
      console.log(`     Preview: ${r.text.slice(0, 200)}`);
    } else if (r.status !== 404) {
      console.log(`  ⚠️  ${path} → ${r.status}`);
    }
  }

  console.log('\n✅ Round 3 complete.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
