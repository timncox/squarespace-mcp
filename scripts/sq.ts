#!/usr/bin/env tsx
/**
 * sq.ts — Squarespace direct API CLI
 * Usage: tsx scripts/sq.ts <subcommand> [flags]
 *
 * Subcommands:
 *   login          --site <id>
 *   snapshot       --site <id> --page <slug>
 *   add-section    --site <id> --page <slug>
 *   add-text       --site <id> --page <slug> --section <idx> --html <str>
 *   update-text    --site <id> --page <slug> --search <str> --html <str>
 *   patch-text     --site <id> --page <slug> --search <str> --new <str>
 *   add-button     --site <id> --page <slug> --section <idx> --label <str> --url <str>
 *   remove-block   --site <id> --page <slug> --search <str>
 *   add-image      --site <id> --page <slug> --section <idx> --asset-url <str> [--alt <str>]
 *   move-section   --site <id> --page <slug> --index <n> --direction up|down
 *   section-style  --site <id> --page <slug> --search <str> [--theme <str>] [--height <str>]
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { createContentSaveClient } from '../src/services/content-save.js';
import type { SectionStyleOptions } from '../src/services/content-save.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SQ_DIR = join(homedir(), '.squarespace');
const COOKIES_DIR = join(SQ_DIR, 'cookies');
const CONFIG_PATH = join(SQ_DIR, 'config.json');
const PAGE_CACHE_PATH = join(SQ_DIR, 'page-id-cache.json');
const PAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const HOME_SLUGS = ['homepage', 'home-page', 'home', 'landing', 'index', 'main', ''];

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function getCookiePath(subdomain: string): string {
  return join(COOKIES_DIR, `${subdomain}.json`);
}

function normalizeSlug(slug: string): string {
  return HOME_SLUGS.includes(slug.toLowerCase()) ? 'home' : slug;
}

function promptInTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Site resolution ───────────────────────────────────────────────────────────

interface SiteEntry {
  id: string;
  aliases?: string[];
  site: {
    adminUrl: string;
    pages?: Array<{ slug: string; title: string }>;
  };
}

function extractSubdomain(adminUrl: string): string | null {
  const match = adminUrl.match(/https?:\/\/([^.]+)\.squarespace\.com/);
  return match ? match[1] : null;
}

function resolveSite(identifier: string): { subdomain: string; adminUrl: string } {
  const sitesPath = join(process.cwd(), 'config', 'sites.json');
  if (!existsSync(sitesPath)) {
    throw new Error(`sites.json not found at ${sitesPath}`);
  }
  const sitesData = JSON.parse(readFileSync(sitesPath, 'utf-8')) as { clients: SiteEntry[] };

  for (const client of sitesData.clients) {
    const subdomain = extractSubdomain(client.site.adminUrl);

    // Match by client ID
    if (client.id === identifier) {
      if (!subdomain) throw new Error(`Cannot extract subdomain from adminUrl for client ${client.id}`);
      return { subdomain, adminUrl: client.site.adminUrl };
    }

    // Match by alias (case-insensitive)
    if (client.aliases?.some((a) => a.toLowerCase() === identifier.toLowerCase())) {
      if (!subdomain) throw new Error(`Cannot extract subdomain from adminUrl for client ${client.id}`);
      return { subdomain, adminUrl: client.site.adminUrl };
    }

    // Match by raw subdomain
    if (subdomain === identifier) {
      return { subdomain, adminUrl: client.site.adminUrl };
    }
  }

  // No match — use identifier directly as subdomain
  return {
    subdomain: identifier,
    adminUrl: `https://${identifier}.squarespace.com/config/website`,
  };
}

// ── Page ID cache ─────────────────────────────────────────────────────────────

interface PageCacheEntry {
  collectionId: string;
  pageSectionsId: string;
  cachedAt: number;
}

type PageCache = Record<string, PageCacheEntry>;

function loadPageCache(): PageCache {
  if (!existsSync(PAGE_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(PAGE_CACHE_PATH, 'utf-8')) as PageCache;
  } catch {
    return {};
  }
}

function savePageCache(cache: PageCache): void {
  mkdirSync(SQ_DIR, { recursive: true });
  writeFileSync(PAGE_CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function resolvePageIds(
  subdomain: string,
  slug: string,
  overrides: { psid?: string; colid?: string },
): Promise<{ pageSectionsId: string; collectionId: string }> {
  if (overrides.psid && overrides.colid) {
    return { pageSectionsId: overrides.psid, collectionId: overrides.colid };
  }

  const normalized = normalizeSlug(slug);
  const cacheKey = `${subdomain}:${normalized}`;

  // Check cache
  const cache = loadPageCache();
  const entry = cache[cacheKey];
  if (entry && Date.now() - entry.cachedAt < PAGE_CACHE_TTL_MS) {
    const result = {
      pageSectionsId: overrides.psid ?? entry.pageSectionsId,
      collectionId: overrides.colid ?? entry.collectionId,
    };
    return result;
  }

  // Resolve collectionId via API
  const cookiePath = getCookiePath(subdomain);
  const client = createContentSaveClient(subdomain, cookiePath);

  const apiSlug = normalized === 'home' ? '' : normalized;
  const pageIds = await client.getPageIds(apiSlug);
  if (!pageIds) {
    throw new Error(`Could not find page with slug "${slug}" on ${subdomain}. Check the slug and ensure you are logged in.`);
  }

  const collectionId = overrides.colid ?? pageIds.collectionId;

  // Resolve pageSectionsId from public HTML
  const pageUrl = normalized === 'home'
    ? `https://${subdomain}.squarespace.com/`
    : `https://${subdomain}.squarespace.com/${normalized}`;

  let pageSectionsId: string;
  if (overrides.psid) {
    pageSectionsId = overrides.psid;
  } else {
    try {
      const res = await fetch(pageUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${pageUrl}`);
      }
      const html = await res.text();
      const match = html.match(/data-page-sections="([^"]+)"/);
      if (!match) {
        throw new Error(
          `data-page-sections not found on ${pageUrl}. The site may be private.\n` +
          `Hint: use --psid <id> and --colid <id> to bypass page ID resolution.`,
        );
      }
      pageSectionsId = match[1];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to fetch pageSectionsId from ${pageUrl}: ${msg}\n` +
        `Hint: use --psid <id> and --colid <id> to bypass page ID resolution.`,
      );
    }
  }

  // Cache result
  cache[cacheKey] = { collectionId, pageSectionsId, cachedAt: Date.now() };
  savePageCache(cache);

  return { pageSectionsId, collectionId };
}

// ── Subcommands ───────────────────────────────────────────────────────────────

async function cmdLogin(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Credentials not found at ${CONFIG_PATH}. Create it with: { "email": "...", "password": "..." }`);
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as { email: string; password: string };
  if (!config.email || !config.password) {
    throw new Error(`${CONFIG_PATH} must contain "email" and "password" fields`);
  }

  const { subdomain, adminUrl } = resolveSite(siteId);
  const cookiePath = getCookiePath(subdomain);

  mkdirSync(COOKIES_DIR, { recursive: true });

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.error(`Navigating to login page...`);
    await page.goto('https://login.squarespace.com/', { waitUntil: 'networkidle', timeout: 30000 });

    // Fill credentials
    await page.fill('input[name="email"], input[type="email"]', config.email);
    await page.fill('input[name="password"], input[type="password"]', config.password);

    // Wait for submit button to be enabled
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('#login-button, [data-test="login-button"], button[type="submit"]');
        return btn && !(btn as HTMLButtonElement).disabled;
      },
      { timeout: 10000 },
    );

    await page.click('#login-button, [data-test="login-button"], button[type="submit"]');

    // Race: account page or 2FA
    const accountPromise = page
      .waitForURL('**/account/**', { timeout: 30000 })
      .then(() => 'account' as const);

    const twoFAPromise = page
      .locator('input[name="totp"], input[name="code"], input[placeholder*="code"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .then(() => '2fa' as const);

    const result = await Promise.race([accountPromise, twoFAPromise]).catch(() => 'timeout' as const);

    if (result === '2fa') {
      const code = await promptInTerminal('Enter your Squarespace 2FA code: ');
      await page.fill('input[name="totp"], input[name="code"], input[placeholder*="code"]', code);
      await page.click('button[type="submit"]');
      await page.waitForURL('**/account/**', { timeout: 15000 });
    } else if (result === 'timeout') {
      if (!page.url().includes('account.squarespace.com')) {
        throw new Error(`Login failed — landed on: ${page.url()}`);
      }
    }

    console.error(`Login successful. Navigating to site admin...`);
    await page.goto(adminUrl, { waitUntil: 'networkidle', timeout: 30000 });

    await context.storageState({ path: cookiePath });
    console.log(JSON.stringify({ success: true, subdomain, cookiePath }));
  } finally {
    await browser.close();
  }
}

async function cmdSnapshot(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const data = await client.getPageSections(pageSectionsId);

  console.log(JSON.stringify({ subdomain, slug, pageSectionsId, collectionId, sections: data.sections }, null, 2));
}

async function cmdAddSection(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.addBlankSection(pageSectionsId, collectionId);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAddText(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const html = flags.html;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!html) throw new Error('--html is required');

  const sectionIndex = parseInt(flags.section || '0', 10);
  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.addTextBlock(pageSectionsId, collectionId, sectionIndex, html);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdUpdateText(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  const html = flags.html;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');
  if (!html) throw new Error('--html is required');

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.updateTextBlock(pageSectionsId, collectionId, search, html);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdPatchText(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  const newText = flags.new;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');
  if (!newText) throw new Error('--new is required');

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.patchTextBlock(pageSectionsId, collectionId, search, newText);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAddButton(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const label = flags.label;
  const url = flags.url;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!label) throw new Error('--label is required');
  if (!url) throw new Error('--url is required');

  const sectionIndex = parseInt(flags.section || '0', 10);
  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.addButtonBlock(pageSectionsId, collectionId, sectionIndex, label, url);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdRemoveBlock(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.removeBlock(pageSectionsId, collectionId, search);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAddImage(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const assetUrl = flags['asset-url'];
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!assetUrl) throw new Error('--asset-url is required');

  const sectionIndex = parseInt(flags.section || '0', 10);
  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.addImageBlock(pageSectionsId, collectionId, sectionIndex, assetUrl, {
    altText: flags.alt,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdMoveSection(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  const direction = flags.direction as 'up' | 'down';
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required (text content within the section to move)');
  if (!direction || !['up', 'down'].includes(direction)) throw new Error('--direction must be "up" or "down"');

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.moveSection(pageSectionsId, collectionId, search, direction);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSectionStyle(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');

  const styles: SectionStyleOptions = {};
  if (flags.theme) styles.sectionTheme = flags.theme as SectionStyleOptions['sectionTheme'];
  if (flags.height) styles.sectionHeight = flags.height as SectionStyleOptions['sectionHeight'];

  const sectionSearch: string | number = /^\d+$/.test(search) ? parseInt(search, 10) : search;

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.editSectionStyle(pageSectionsId, collectionId, sectionSearch, styles);
  console.log(JSON.stringify(result, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const USAGE = `
Squarespace direct API CLI

Usage: tsx scripts/sq.ts <subcommand> [flags]

Subcommands:
  login          --site <id>
  snapshot       --site <id> --page <slug>
  add-section    --site <id> --page <slug>
  add-text       --site <id> --page <slug> --section <idx> --html <str>
  update-text    --site <id> --page <slug> --search <str> --html <str>
  patch-text     --site <id> --page <slug> --search <str> --new <str>
  add-button     --site <id> --page <slug> --section <idx> --label <str> --url <str>
  remove-block   --site <id> --page <slug> --search <str>
  add-image      --site <id> --page <slug> --section <idx> --asset-url <str> [--alt <str>]
  move-section   --site <id> --page <slug> --search <str> --direction up|down  (--search matches text in the section)
  section-style  --site <id> --page <slug> --search <str> [--theme <str>] [--height <str>]

Common flags:
  --psid <id>    Override pageSectionsId (skip page ID resolution)
  --colid <id>   Override collectionId (skip page ID resolution)

Site identifiers: client ID, client alias, or raw subdomain (e.g. grey-yellow-hbxc)
`.trim();

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (subcommand) {
    case 'login':         return cmdLogin(flags);
    case 'snapshot':      return cmdSnapshot(flags);
    case 'add-section':   return cmdAddSection(flags);
    case 'add-text':      return cmdAddText(flags);
    case 'update-text':   return cmdUpdateText(flags);
    case 'patch-text':    return cmdPatchText(flags);
    case 'add-button':    return cmdAddButton(flags);
    case 'remove-block':  return cmdRemoveBlock(flags);
    case 'add-image':     return cmdAddImage(flags);
    case 'move-section':  return cmdMoveSection(flags);
    case 'section-style': return cmdSectionStyle(flags);
    default:
      console.error(USAGE);
      process.exit(subcommand ? 1 : 0);
  }
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

run();
