#!/usr/bin/env tsx
/**
 * discover-api-surface.ts — Probe undiscovered Squarespace API endpoints
 *
 * Uses authenticated session cookies to explore the API surface area
 * against the grey-yellow-hbxc test site.
 *
 * Usage: npx tsx scripts/discover-api-surface.ts
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ── Config ──────────────────────────────────────────────────────────────────

const SITE_SUBDOMAIN = 'grey-yellow-hbxc';
const COOKIES_PATH = join(homedir(), '.squarespace', 'cookies', `${SITE_SUBDOMAIN}.json`);
const BASE_URL = `https://${SITE_SUBDOMAIN}.squarespace.com`;
const TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// ── Cookie loading (mirrors ContentSaveClient.loadSessionCookies) ───────

interface SessionCookie {
  name: string;
  value: string;
  domain: string;
}

function loadCookies(): { cookieHeader: string; crumbToken: string | null } {
  if (!existsSync(COOKIES_PATH)) {
    throw new Error(`Session file not found: ${COOKIES_PATH}. Run 'tsx scripts/sq.ts login --site ${SITE_SUBDOMAIN}' first.`);
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

  // Deduplicate, preferring site-specific cookies
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

// ── HTTP helper ─────────────────────────────────────────────────────────

function buildHeaders(cookieHeader: string): Record<string, string> {
  return {
    Cookie: cookieHeader,
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
  };
}

interface ProbeResult {
  endpoint: string;
  status: number;
  responseSize: number;
  topLevelKeys: string[];
  keyInfo: Record<string, string>;
  error?: string;
  sampleData?: unknown;
}

async function probeEndpoint(
  path: string,
  headers: Record<string, string>,
): Promise<ProbeResult> {
  const url = `${BASE_URL}${path}`;
  const result: ProbeResult = {
    endpoint: path,
    status: 0,
    responseSize: 0,
    topLevelKeys: [],
    keyInfo: {},
  };

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    result.status = response.status;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      result.error = `HTTP ${response.status}: ${body.slice(0, 200)}`;
      result.responseSize = body.length;
      return result;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    result.responseSize = text.length;

    if (contentType.includes('json') || text.startsWith('{') || text.startsWith('[')) {
      try {
        const data = JSON.parse(text);

        if (Array.isArray(data)) {
          result.topLevelKeys = ['(array)'];
          result.keyInfo['(array)'] = `Array[${data.length}]`;
          if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
            result.keyInfo['(array) item keys'] = Object.keys(data[0]).join(', ');
          }
          // Sample first item
          if (data.length > 0) {
            result.sampleData = data[0];
          }
        } else if (typeof data === 'object' && data !== null) {
          result.topLevelKeys = Object.keys(data);
          for (const key of result.topLevelKeys) {
            const val = data[key];
            if (val === null) {
              result.keyInfo[key] = 'null';
            } else if (Array.isArray(val)) {
              result.keyInfo[key] = `Array[${val.length}]`;
              if (val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
                result.keyInfo[key] += ` of {${Object.keys(val[0]).slice(0, 8).join(', ')}}`;
              }
            } else if (typeof val === 'object') {
              const subKeys = Object.keys(val);
              result.keyInfo[key] = `Object{${subKeys.slice(0, 10).join(', ')}}${subKeys.length > 10 ? ` +${subKeys.length - 10} more` : ''}`;
            } else {
              const str = String(val);
              result.keyInfo[key] = `${typeof val}: ${str.length > 80 ? str.slice(0, 80) + '...' : str}`;
            }
          }
        }
      } catch {
        result.error = 'JSON parse failed';
        result.keyInfo['raw'] = text.slice(0, 200);
      }
    } else {
      result.error = `Non-JSON content-type: ${contentType}`;
      result.keyInfo['raw'] = text.slice(0, 200);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ── Endpoints to probe ──────────────────────────────────────────────────

const ENDPOINTS = [
  // Navigation & page ordering
  '/api/navigation',

  // Design & theming
  '/api/site-design',
  '/api/design-data',
  '/api/design',

  // URL redirects
  '/api/url-redirects',

  // Forms
  '/api/form-builder/forms',

  // Commerce
  '/api/commerce/products',

  // Members
  '/api/members',
  '/api/member-areas',

  // Page config / ordering
  '/api/config/pages',

  // Settings
  '/api/settings',
  '/api/site-settings',

  // Additional discovery
  '/api/site-data',
  '/api/template-config',
  '/api/sitewide-settings',
  '/api/fonts',
  '/api/colors',
  '/api/social-links',

  // Already known (for reference/comparison)
  '/api/commondata/GetCollections/',
  '/api/site-header-footer',

  // Additional speculative endpoints
  '/api/pages',
  '/api/blog',
  '/api/blog/posts',
  '/api/collections',
  '/api/template',
  '/api/template/GetTemplate',
  '/api/customcss',
  '/api/custom-css',
  '/api/website-settings',
  '/api/site',
  '/api/config',
  '/api/schema',
  '/api/widgets',
  '/api/integrations',
  '/api/analytics',
  '/api/search',
  '/api/localization',
  '/api/i18n',
  '/api/seo',
  '/api/panel',
  '/api/billing',
  '/api/domains',
  '/api/dns',
  '/api/notifications',
  '/api/announcements',
  '/api/popups',
  '/api/scheduling',
  '/api/appointments',
  '/api/favicon',
  '/api/media',
  '/api/assets',
];

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🔍 Squarespace API Surface Discovery');
  console.log(`   Site: ${SITE_SUBDOMAIN}`);
  console.log(`   Cookie file: ${COOKIES_PATH}`);
  console.log('');

  const { cookieHeader, crumbToken } = loadCookies();
  console.log(`   Cookies loaded: ${cookieHeader.split(';').length} cookies`);
  console.log(`   Crumb token: ${crumbToken ? 'yes' : 'no'}`);
  console.log('');

  const headers = buildHeaders(cookieHeader);
  const results: ProbeResult[] = [];

  // Probe endpoints sequentially (avoid rate limiting)
  for (const endpoint of ENDPOINTS) {
    process.stdout.write(`  ${endpoint} ... `);
    const result = await probeEndpoint(endpoint, headers);
    results.push(result);

    if (result.status === 200) {
      console.log(`✅ ${result.status} (${result.responseSize} bytes, ${result.topLevelKeys.length} keys)`);
    } else if (result.status === 404) {
      console.log(`❌ 404`);
    } else if (result.status === 401 || result.status === 403) {
      console.log(`🔒 ${result.status}`);
    } else if (result.status === 0) {
      console.log(`💥 Error: ${result.error}`);
    } else {
      console.log(`⚠️  ${result.status} (${result.responseSize} bytes)`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));

  const successful = results.filter((r) => r.status === 200);
  const notFound = results.filter((r) => r.status === 404);
  const authFailed = results.filter((r) => r.status === 401 || r.status === 403);
  const other = results.filter((r) => r.status !== 200 && r.status !== 404 && r.status !== 401 && r.status !== 403);

  console.log(`\n✅ Successful (${successful.length}):`);
  for (const r of successful) {
    console.log(`   ${r.endpoint}`);
    console.log(`      Size: ${r.responseSize} bytes`);
    console.log(`      Keys: ${r.topLevelKeys.join(', ')}`);
    for (const [key, info] of Object.entries(r.keyInfo)) {
      console.log(`        ${key}: ${info}`);
    }
  }

  console.log(`\n❌ Not Found (${notFound.length}):`);
  for (const r of notFound) {
    console.log(`   ${r.endpoint}`);
  }

  if (authFailed.length > 0) {
    console.log(`\n🔒 Auth Failed (${authFailed.length}):`);
    for (const r of authFailed) {
      console.log(`   ${r.endpoint} → ${r.status}`);
    }
  }

  if (other.length > 0) {
    console.log(`\nℹ️  Other (${other.length}):`);
    for (const r of other) {
      console.log(`   ${r.endpoint} → ${r.status}: ${r.error ?? ''}`);
    }
  }

  // ── Write detailed results ────────────────────────────────────────

  // JSON for detailed analysis
  const jsonPath = join(process.cwd(), 'docs', 'plans', 'api-surface-raw.json');
  mkdirSync(join(process.cwd(), 'docs', 'plans'), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\n📝 Raw results written to: ${jsonPath}`);

  // Generate markdown discovery doc
  const md = generateMarkdown(results);
  const mdPath = join(process.cwd(), 'docs', 'plans', 'api-surface-discovery.md');
  writeFileSync(mdPath, md);
  console.log(`📝 Discovery doc written to: ${mdPath}`);
}

function generateMarkdown(results: ProbeResult[]): string {
  const successful = results.filter((r) => r.status === 200);
  const lines: string[] = [];

  lines.push('# Squarespace API Surface Discovery');
  lines.push('');
  lines.push(`**Date**: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`**Site**: grey-yellow-hbxc`);
  lines.push(`**Total endpoints probed**: ${results.length}`);
  lines.push(`**Successful (200)**: ${successful.length}`);
  lines.push(`**Not Found (404)**: ${results.filter((r) => r.status === 404).length}`);
  lines.push(`**Auth Required**: ${results.filter((r) => r.status === 401 || r.status === 403).length}`);
  lines.push('');

  // Successful endpoints — detailed
  lines.push('## Working Endpoints');
  lines.push('');
  for (const r of successful) {
    lines.push(`### \`GET ${r.endpoint}\``);
    lines.push('');
    lines.push(`- **Status**: ${r.status}`);
    lines.push(`- **Response size**: ${r.responseSize} bytes`);
    lines.push(`- **Top-level keys**: ${r.topLevelKeys.join(', ')}`);
    lines.push('');
    lines.push('**Key details:**');
    lines.push('');
    lines.push('| Key | Type/Info |');
    lines.push('|-----|----------|');
    for (const [key, info] of Object.entries(r.keyInfo)) {
      lines.push(`| \`${key}\` | ${info.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }

  // Already-known endpoints
  const known = ['/api/commondata/GetCollections/', '/api/site-header-footer'];
  const knownResults = successful.filter((r) => known.includes(r.endpoint));
  const newResults = successful.filter((r) => !known.includes(r.endpoint));

  lines.push('## New vs Already-Known');
  lines.push('');
  lines.push(`**New endpoints**: ${newResults.length}`);
  lines.push(`**Already known**: ${knownResults.length}`);
  lines.push('');

  if (newResults.length > 0) {
    lines.push('### New Discoveries');
    lines.push('');
    for (const r of newResults) {
      lines.push(`- \`${r.endpoint}\` — ${r.responseSize} bytes, keys: ${r.topLevelKeys.slice(0, 5).join(', ')}${r.topLevelKeys.length > 5 ? '...' : ''}`);
    }
    lines.push('');
  }

  // Not found
  lines.push('## Not Found (404)');
  lines.push('');
  for (const r of results.filter((r) => r.status === 404)) {
    lines.push(`- \`${r.endpoint}\``);
  }
  lines.push('');

  // Auth required
  const authResults = results.filter((r) => r.status === 401 || r.status === 403);
  if (authResults.length > 0) {
    lines.push('## Auth Required');
    lines.push('');
    for (const r of authResults) {
      lines.push(`- \`${r.endpoint}\` → ${r.status}`);
    }
    lines.push('');
  }

  // Other status codes
  const otherResults = results.filter((r) => r.status !== 200 && r.status !== 404 && r.status !== 401 && r.status !== 403 && r.status !== 0);
  if (otherResults.length > 0) {
    lines.push('## Other Status Codes');
    lines.push('');
    for (const r of otherResults) {
      lines.push(`- \`${r.endpoint}\` → ${r.status}`);
    }
    lines.push('');
  }

  // Potential ContentSaveClient methods
  lines.push('## Potential ContentSaveClient Methods');
  lines.push('');
  lines.push('Based on discovered endpoints, these methods could be added to ContentSaveClient:');
  lines.push('');
  lines.push('| Endpoint | Potential Method | Use Case |');
  lines.push('|----------|-----------------|----------|');

  for (const r of newResults) {
    const methodName = suggestMethodName(r.endpoint);
    const useCase = suggestUseCase(r.endpoint, r);
    if (methodName) {
      lines.push(`| \`${r.endpoint}\` | \`${methodName}\` | ${useCase} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function suggestMethodName(endpoint: string): string | null {
  const map: Record<string, string> = {
    '/api/navigation': 'getNavigation() / updateNavigation()',
    '/api/site-design': 'getSiteDesign() / updateSiteDesign()',
    '/api/design-data': 'getDesignData()',
    '/api/design': 'getDesign()',
    '/api/url-redirects': 'getUrlRedirects() / addUrlRedirect()',
    '/api/form-builder/forms': 'getForms()',
    '/api/commerce/products': 'getProducts()',
    '/api/members': 'getMembers()',
    '/api/member-areas': 'getMemberAreas()',
    '/api/config/pages': 'getPageConfig() / reorderPages()',
    '/api/settings': 'getSettings()',
    '/api/site-settings': 'getSiteSettings()',
    '/api/site-data': 'getSiteData()',
    '/api/template-config': 'getTemplateConfig()',
    '/api/sitewide-settings': 'getSitewideSettings()',
    '/api/fonts': 'getFonts() / updateFonts()',
    '/api/colors': 'getColors() / updateColors()',
    '/api/social-links': 'getSocialLinks() / updateSocialLinks()',
    '/api/pages': 'getPages()',
    '/api/blog': 'getBlog()',
    '/api/blog/posts': 'getBlogPosts()',
    '/api/collections': 'getCollections()',
    '/api/customcss': 'getCustomCSS() / updateCustomCSS()',
    '/api/custom-css': 'getCustomCSS() / updateCustomCSS()',
    '/api/website-settings': 'getWebsiteSettings()',
    '/api/site': 'getSite()',
    '/api/config': 'getConfig()',
    '/api/favicon': 'getFavicon()',
    '/api/media': 'getMedia()',
    '/api/assets': 'getAssets()',
    '/api/announcements': 'getAnnouncements()',
    '/api/popups': 'getPopups()',
    '/api/seo': 'getSeoSettings()',
  };
  return map[endpoint] ?? null;
}

function suggestUseCase(endpoint: string, result: ProbeResult): string {
  const map: Record<string, string> = {
    '/api/navigation': 'Page ordering in nav menu, nav structure management',
    '/api/site-design': 'Fonts, colors, site-wide design tokens',
    '/api/design-data': 'Design system data',
    '/api/design': 'Design settings',
    '/api/url-redirects': 'Manage URL redirects (301/302)',
    '/api/form-builder/forms': 'Form field configuration, form management',
    '/api/commerce/products': 'Product listings, inventory',
    '/api/members': 'Member management',
    '/api/member-areas': 'Member area configuration',
    '/api/config/pages': 'Page reordering, page configuration',
    '/api/settings': 'Site settings management',
    '/api/site-settings': 'Site settings management',
    '/api/social-links': 'Social media links management',
    '/api/fonts': 'Font management, typography settings',
    '/api/colors': 'Color palette management',
    '/api/customcss': 'Custom CSS injection',
    '/api/custom-css': 'Custom CSS injection',
    '/api/favicon': 'Favicon management',
    '/api/seo': 'SEO settings management',
    '/api/announcements': 'Announcement bar management',
    '/api/popups': 'Popup/promotional popup management',
  };
  return map[endpoint] ?? `Response: ${result.responseSize} bytes, ${result.topLevelKeys.length} keys`;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
