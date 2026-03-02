#!/usr/bin/env tsx
/**
 * discover-api-surface-round2.ts — Second-pass API discovery
 *
 * Deeper probing based on round 1 results:
 * - Try POST on 405 endpoints (/api/pages, /api/billing, /api/domains)
 * - Explore sub-paths of working endpoints (/api/navigation/*, /api/settings/*)
 * - Try more endpoint patterns based on Squarespace naming conventions
 * - Inspect /api/settings deeply for actionable fields
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SITE_SUBDOMAIN = 'grey-yellow-hbxc';
const COOKIES_PATH = join(homedir(), '.squarespace', 'cookies', `${SITE_SUBDOMAIN}.json`);
const BASE_URL = `https://${SITE_SUBDOMAIN}.squarespace.com`;
const TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

interface SessionCookie {
  name: string;
  value: string;
  domain: string;
}

function loadCookies(): { cookieHeader: string; crumbToken: string | null } {
  if (!existsSync(COOKIES_PATH)) {
    throw new Error(`Session file not found: ${COOKIES_PATH}`);
  }

  const session = JSON.parse(readFileSync(COOKIES_PATH, 'utf-8'));
  const cookies: SessionCookie[] = session.cookies ?? [];
  const globalCookies: SessionCookie[] = [];
  const siteCookies: SessionCookie[] = [];

  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, '');
    if (domain === 'squarespace.com') {
      globalCookies.push(c);
    } else if (
      domain === `${SITE_SUBDOMAIN}.squarespace.com` ||
      domain === `.${SITE_SUBDOMAIN}.squarespace.com` ||
      domain === 'account.squarespace.com'
    ) {
      siteCookies.push(c);
    }
  }

  const byName = new Map<string, SessionCookie>();
  for (const c of [...globalCookies, ...siteCookies]) {
    const existing = byName.get(c.name);
    if (!existing || c.domain.includes(SITE_SUBDOMAIN)) {
      byName.set(c.name, c);
    }
  }

  const cookieHeader = Array.from(byName.values())
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  let crumbToken: string | null = null;
  for (const c of siteCookies) {
    if (c.name === 'crumb' && c.domain.includes(SITE_SUBDOMAIN)) {
      crumbToken = c.value;
      break;
    }
  }

  return { cookieHeader, crumbToken };
}

function buildHeaders(cookieHeader: string): Record<string, string> {
  return {
    Cookie: cookieHeader,
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
  };
}

async function probe(
  path: string,
  headers: Record<string, string>,
  method: string = 'GET',
  body?: string,
): Promise<{ status: number; size: number; data?: unknown; error?: string }> {
  const url = `${BASE_URL}${path}`;
  try {
    const opts: RequestInit = {
      method,
      headers: body
        ? { ...headers, 'Content-Type': 'application/json' }
        : headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    if (body) opts.body = body;

    const response = await fetch(url, opts);
    const text = await response.text();

    let data: unknown = undefined;
    try {
      data = JSON.parse(text);
    } catch {
      // non-JSON
    }

    return { status: response.status, size: text.length, data, error: response.ok ? undefined : text.slice(0, 300) };
  } catch (err) {
    return { status: 0, size: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

function summarize(data: unknown, depth: number = 0, maxDepth: number = 2): string {
  if (data === null) return 'null';
  if (data === undefined) return 'undefined';
  if (typeof data !== 'object') {
    const str = String(data);
    return `${typeof data}: ${str.length > 60 ? str.slice(0, 60) + '...' : str}`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';
    if (depth >= maxDepth) return `Array[${data.length}]`;
    const itemSummary = summarize(data[0], depth + 1, maxDepth);
    return `Array[${data.length}] of ${itemSummary}`;
  }
  const keys = Object.keys(data as Record<string, unknown>);
  if (depth >= maxDepth) return `{${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}}`;
  const entries = keys.slice(0, 8).map((k) => `  ${'  '.repeat(depth)}${k}: ${summarize((data as Record<string, unknown>)[k], depth + 1, maxDepth)}`);
  return `{\n${entries.join('\n')}${keys.length > 8 ? `\n  ${'  '.repeat(depth)}... +${keys.length - 8} more` : ''}\n${'  '.repeat(depth)}}`;
}

async function main(): Promise<void> {
  console.log('🔍 Round 2: Deep API Surface Discovery\n');
  const { cookieHeader, crumbToken } = loadCookies();
  const headers = buildHeaders(cookieHeader);
  const output: string[] = [];

  function log(msg: string): void {
    console.log(msg);
    output.push(msg);
  }

  // ── 1. Deep dive on /api/navigation ──────────────────────────────────
  log('═══ /api/navigation — deep inspection ═══');
  const navResult = await probe('/api/navigation', headers);
  if (navResult.data && Array.isArray(navResult.data)) {
    log(`Navigation has ${navResult.data.length} nav groups:`);
    for (const nav of navResult.data) {
      log(`  - "${nav.name}" (identifier: ${nav.identifier}, index: ${nav.index})`);
      if (nav.links) {
        log(`    Links (${nav.links.length}):`);
        for (const link of nav.links) {
          log(`      ${link.title} → /${link.urlId} (type: ${link.typeName}, collectionId: ${link.collectionId}, ordering: ${link.ordering}, enabled: ${link.enabled})`);
        }
      }
    }
  }

  // ── 2. Deep dive on /api/settings ────────────────────────────────────
  log('\n═══ /api/settings — actionable fields ═══');
  const settingsResult = await probe('/api/settings', headers);
  if (settingsResult.data && typeof settingsResult.data === 'object') {
    const settings = settingsResult.data as Record<string, unknown>;
    const interesting = [
      'websiteId', 'ownerId', 'country', 'state',
      'homepageTitleFormat', 'collectionTitleFormat', 'itemTitleFormat',
      'seoHidden', 'isCookieBannerEnabled', 'isVisitorDataRestricted',
      'businessHours', 'internalContactPhoneNumber', 'internalContactEmail',
      'commentsEnabled', 'commentEnableByDefault',
      'announcementBarSettings', 'mobileInfoBarSettings',
      'storeSettings', 'userAccountsSettings',
      'ssBadgeType', 'ssBadgePosition', 'ssBadgeVisibility',
      'memberAreaNavigationSetting', 'displayAiContentDisclaimer',
    ];
    for (const key of interesting) {
      if (key in settings) {
        log(`  ${key}: ${JSON.stringify(settings[key]).slice(0, 200)}`);
      }
    }

    // Check if PUT works on settings
    log('\n  Testing PUT /api/settings (read-only check)...');
    const crumbSuffix = crumbToken ? `?crumb=${encodeURIComponent(crumbToken)}` : '';
    const putResult = await probe(`/api/settings${crumbSuffix}`, headers, 'PUT', JSON.stringify(settings));
    log(`  PUT /api/settings: ${putResult.status} (${putResult.size} bytes)`);
    if (putResult.status === 200) {
      log('  ✅ PUT /api/settings works! Settings are writable via API.');
    } else {
      log(`  ⚠️  PUT failed: ${putResult.error?.slice(0, 200)}`);
    }
  }

  // ── 3. 405 endpoints — try POST ──────────────────────────────────────
  log('\n═══ 405 endpoints — trying POST ═══');
  const method405 = ['/api/pages', '/api/billing', '/api/domains'];
  for (const path of method405) {
    const postResult = await probe(path, headers, 'POST', '{}');
    log(`  POST ${path}: ${postResult.status} (${postResult.size} bytes)${postResult.error ? ` — ${postResult.error.slice(0, 100)}` : ''}`);
  }

  // ── 4. Squarespace-specific endpoint patterns ────────────────────────
  log('\n═══ Additional endpoint patterns ═══');
  const additionalEndpoints = [
    // Config-style endpoints (based on site-header-footer pattern)
    '/api/site-config',
    '/api/website',
    '/api/website/settings',

    // Based on GetCollections pattern
    '/api/commondata/GetSettings',
    '/api/commondata/GetNavigation',

    // Social links (Squarespace has social icon blocks)
    '/api/social-accounts',
    '/api/social-account-links',

    // Based on known Squarespace internal APIs
    '/api/layouts',
    '/api/layout',
    '/api/pages/config',
    '/api/page/config',
    '/api/redirects',
    '/api/redirect-rules',

    // SEO & meta
    '/api/seo-data',
    '/api/meta',

    // CSS/Design
    '/api/less-variables',
    '/api/design-variables',
    '/api/custom-files',
    '/api/style',
    '/api/styles',
    '/api/site-styles',

    // Content management
    '/api/content',
    '/api/items',
    '/api/blocks',

    // Squarespace extensions
    '/api/extensions',
    '/api/extension-apps',

    // Commerce variations
    '/api/commerce',
    '/api/commerce/orders',
    '/api/commerce/inventory',

    // Member areas
    '/api/member-site',
    '/api/member/settings',

    // Scheduling
    '/api/scheduling/availability',
    '/api/acuity',

    // Forms
    '/api/form-submissions',
    '/api/forms',

    // Known Squarespace API patterns found in other tools
    '/api/template/GetTemplate',
    '/api/website-migration',
    '/api/site-badge',

    // Try without /api prefix
    '/config/design',
    '/config/pages',

    // New patterns based on Squarespace 7.1
    '/api/fluid-engine',
    '/api/section-templates',
    '/api/block-types',
  ];

  for (const path of additionalEndpoints) {
    const result = await probe(path, headers);
    const emoji = result.status === 200 ? '✅' : result.status === 404 ? '❌' : `⚠️  ${result.status}`;
    if (result.status === 200) {
      log(`  ${emoji} ${path} — ${result.size} bytes`);
      if (result.data) {
        log(`     ${summarize(result.data).split('\n').join('\n     ')}`);
      }
    } else if (result.status !== 404) {
      log(`  ${emoji} ${path} — ${result.error?.slice(0, 100) ?? ''}`);
    }
    // Skip 404s for cleaner output
  }

  // ── 5. Explore /api/commerce/products deeper ─────────────────────────
  log('\n═══ /api/commerce deep dive ═══');
  const commerceEndpoints = [
    '/api/commerce/products',
    '/api/commerce/orders',
    '/api/commerce/inventory',
    '/api/commerce/settings',
    '/api/commerce/coupons',
    '/api/commerce/shipping',
    '/api/commerce/tax',
    '/api/commerce/payments',
    '/api/commerce/categories',
  ];
  for (const path of commerceEndpoints) {
    const result = await probe(path, headers);
    if (result.status === 200) {
      log(`  ✅ ${path} — ${result.size} bytes: ${JSON.stringify(result.data).slice(0, 200)}`);
    } else if (result.status !== 404) {
      log(`  ⚠️  ${path} → ${result.status}`);
    }
  }

  // ── 6. Try navigation PUT for page reordering ────────────────────────
  log('\n═══ /api/navigation — testing PUT for page reordering ═══');
  if (navResult.data && crumbToken) {
    const crumbSuffix = `?crumb=${encodeURIComponent(crumbToken)}`;
    // Just read-back test — send the same data
    const putNav = await probe(`/api/navigation${crumbSuffix}`, headers, 'PUT', JSON.stringify(navResult.data));
    log(`  PUT /api/navigation: ${putNav.status} (${putNav.size} bytes)`);
    if (putNav.status === 200) {
      log('  ✅ Navigation is writable! Page reordering possible via API.');
    } else {
      log(`  ⚠️  PUT failed: ${putNav.error?.slice(0, 200)}`);
    }
  }

  // ── Write results ────────────────────────────────────────────────────
  const outputPath = join(process.cwd(), 'docs', 'plans', 'api-surface-round2.txt');
  writeFileSync(outputPath, output.join('\n'));
  console.log(`\n📝 Round 2 results written to: ${outputPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
