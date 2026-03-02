#!/usr/bin/env tsx
/**
 * sq.ts — Squarespace direct API CLI
 * Usage: tsx scripts/sq.ts <subcommand> [flags]
 *
 * Run without arguments or with --help for full subcommand list.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { createContentSaveClient, ContentSaveClient } from '../src/services/content-save.js';
import type { SectionStyleOptions } from '../src/services/content-save.js';
import type { UpdateNavigationItem } from '../src/services/content-save-types.js';
import { extractAndValidateLinks } from '../src/services/link-validator.js';

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

// ── Color conversion ─────────────────────────────────────────────────────────

function hexToHsl(hex: string): { hue: number; saturation: number; lightness: number } {
  const clean = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`Invalid hex color: ${hex}`);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { hue: 0, saturation: 0, lightness: Math.round(l * 10000) / 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return {
    hue: Math.round(h * 36000) / 100,
    saturation: Math.round(s * 10000) / 100,
    lightness: Math.round(l * 10000) / 100,
  };
}

function parseColorArg(input: string): { hue: number; saturation: number; lightness: number } {
  if (input.startsWith('#')) return hexToHsl(input);
  const parts = input.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
    return { hue: parts[0], saturation: parts[1], lightness: parts[2] };
  }
  throw new Error(`Invalid color format: ${input} (use #hex or H,S,L)`);
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

// ── Blog helper ──────────────────────────────────────────────────────────────

async function resolveBlogCollectionId(
  client: ReturnType<typeof createContentSaveClient>,
  blogSlug: string,
): Promise<string> {
  const collections = await client.listCollections();
  const blog = collections.find((c) => c.urlId === blogSlug);
  if (!blog) {
    const blogs = collections
      .filter((c) => c.typeName === 'blog')
      .map((c) => c.urlId)
      .join(', ');
    throw new Error(`Blog "${blogSlug}" not found. Available blogs: ${blogs || 'none'}. Use list-pages to see all collections.`);
  }
  return blog.id;
}

// ── New subcommands ──────────────────────────────────────────────────────────

async function cmdUploadImage(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const url = flags.url;
  if (!siteId) throw new Error('--site is required');
  if (!url) throw new Error('--url is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.uploadImageToSite(url);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdCreatePage(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const title = flags.title;
  if (!siteId) throw new Error('--site is required');
  if (!title) throw new Error('--title is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.createPageViaApi(title, flags.slug);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdDeletePage(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const page = flags.page;
  if (!siteId) throw new Error('--site is required');
  if (!page) throw new Error('--page is required');

  const { subdomain } = resolveSite(siteId);
  const { collectionId } = await resolvePageIds(subdomain, page, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.deletePageViaApi(collectionId);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdCreatePost(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const blogSlug = flags.blog;
  const title = flags.title;
  if (!siteId) throw new Error('--site is required');
  if (!blogSlug) throw new Error('--blog is required');
  if (!title) throw new Error('--title is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const collectionId = await resolveBlogCollectionId(client, blogSlug);

  const options: { body?: string; tags?: string[]; draft?: boolean } = {};
  if (flags.body) options.body = flags.body;
  if (flags.tags) options.tags = flags.tags.split(',').map((t) => t.trim());
  if (flags.draft === 'true') options.draft = true;

  const result = await client.createBlogPost(collectionId, title, options);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdUpdatePost(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const blogSlug = flags.blog;
  const search = flags.search;
  if (!siteId) throw new Error('--site is required');
  if (!blogSlug) throw new Error('--blog is required');
  if (!search) throw new Error('--search is required (title text to find the post)');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const collectionId = await resolveBlogCollectionId(client, blogSlug);

  // Find the post by title search
  const items = await client.getCollectionItems(collectionId);
  const post = items.items?.find((item) =>
    item.title?.toLowerCase().includes(search.toLowerCase()),
  );
  if (!post) throw new Error(`No post matching "${search}" found in blog "${blogSlug}"`);

  const updates: { title?: string; body?: string; tags?: string[]; draft?: boolean } = {};
  if (flags.title) updates.title = flags.title;
  if (flags.body) updates.body = flags.body;
  if (flags.tags) updates.tags = flags.tags.split(',').map((t) => t.trim());
  if (flags.draft !== undefined && flags.draft !== 'true') {
    // --draft without value means true, explicit --draft false means false
  }
  if (flags.draft === 'true') updates.draft = true;
  if (flags.draft === 'false') updates.draft = false;

  const result = await client.updateBlogPost(collectionId, post.id, updates);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdListPosts(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const blogSlug = flags.blog;
  if (!siteId) throw new Error('--site is required');
  if (!blogSlug) throw new Error('--blog is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const collectionId = await resolveBlogCollectionId(client, blogSlug);

  const options: { limit?: number } = {};
  if (flags.limit) options.limit = parseInt(flags.limit, 10);

  const result = await client.getCollectionItems(collectionId, options);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdMoveBlock(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  const direction = flags.direction as 'up' | 'down' | 'left' | 'right';
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');
  if (!direction || !['up', 'down', 'left', 'right'].includes(direction)) {
    throw new Error('--direction must be "up", "down", "left", or "right"');
  }

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const steps = flags.steps ? parseInt(flags.steps, 10) : undefined;
  const result = await client.moveBlock(pageSectionsId, collectionId, search, direction, steps);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdResizeBlock(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');

  const width = flags.width as 'smaller' | 'larger' | 'full' | undefined;
  const height = flags.height as 'shorter' | 'taller' | undefined;
  if (!width && !height) throw new Error('at least one of --width or --height is required');
  if (width && !['smaller', 'larger', 'full'].includes(width)) {
    throw new Error('--width must be "smaller", "larger", or "full"');
  }
  if (height && !['shorter', 'taller'].includes(height)) {
    throw new Error('--height must be "shorter" or "taller"');
  }

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.resizeBlock(pageSectionsId, collectionId, search, width, height);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdCustomCSS(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));

  if (flags.css || flags.file) {
    let css: string;
    if (flags.file) {
      if (!existsSync(flags.file)) throw new Error(`File not found: ${flags.file}`);
      css = readFileSync(flags.file, 'utf-8');
    } else {
      css = flags.css;
    }
    const result = await client.saveCustomCSS(css);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = await client.getCustomCSS();
    console.log(JSON.stringify(result, null, 2));
  }
}

async function cmdSiteIdentity(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));

  const hasUpdates = flags.name || flags.phone || flags.email || flags.address;
  if (hasUpdates) {
    const updates: { businessName?: string; phone?: string; email?: string; address?: string } = {};
    if (flags.name) updates.businessName = flags.name;
    if (flags.phone) updates.phone = flags.phone;
    if (flags.email) updates.email = flags.email;
    if (flags.address) updates.address = flags.address;
    const result = await client.updateSiteIdentity(updates);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = await client.getSiteIdentity();
    console.log(JSON.stringify(result, null, 2));
  }
}

async function cmdUpdateMetadata(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');

  const { subdomain } = resolveSite(siteId);
  const { collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const updates: { title?: string; description?: string; seoTitle?: string; seoDescription?: string } = {};
  if (flags.title) updates.title = flags.title;
  if (flags.description) updates.description = flags.description;
  if (flags['seo-title']) updates.seoTitle = flags['seo-title'];
  if (flags['seo-description']) updates.seoDescription = flags['seo-description'];

  if (!updates.title && !updates.description && !updates.seoTitle && !updates.seoDescription) {
    throw new Error('at least one of --title, --description, --seo-title, --seo-description is required');
  }

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.updatePageMetadata(collectionId, updates);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdListPages(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.listCollections();
  console.log(JSON.stringify(result, null, 2));
}

async function cmdUpdateButton(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');

  const updates: { newLabel?: string; url?: string } = {};
  if (flags.label) updates.newLabel = flags.label;
  if (flags.url) updates.url = flags.url;

  if (!updates.newLabel && !updates.url) {
    throw new Error('at least one of --label or --url is required');
  }

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.updateButtonBlock(pageSectionsId, collectionId, search, updates);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdUpdateImage(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');

  const fields: { title?: string; altText?: string; description?: string } = {};
  if (flags.title) fields.title = flags.title;
  if (flags.alt) fields.altText = flags.alt;
  if (flags.description) fields.description = flags.description;

  if (!fields.title && !fields.altText && !fields.description) {
    throw new Error('at least one of --title, --alt, --description is required');
  }

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.updateImageBlock(pageSectionsId, collectionId, search, fields);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdUpdateMenu(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  const menusJson = flags.menus;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');
  if (!menusJson) throw new Error('--menus is required (JSON string of menu array)');

  let menus: unknown[];
  try {
    menus = JSON.parse(menusJson);
  } catch {
    throw new Error('--menus must be valid JSON');
  }
  if (!Array.isArray(menus)) throw new Error('--menus must be a JSON array');

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.updateMenuBlock(pageSectionsId, collectionId, search, menus);
  console.log(JSON.stringify(result, null, 2));
}

// ── Navigation / Settings / Code Injection ──────────────────────────────────

async function cmdNavigation(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.getNavigation();
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSettings(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.getSettings();
  console.log(JSON.stringify(result, null, 2));
}

async function cmdFooter(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));

  if (flags.text && flags.search) {
    const result = await client.patchFooterTextBlock(flags.search, flags.text);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = await client.getFooterSections();
    console.log(JSON.stringify(result, null, 2));
  }
}

async function cmdCodeInjection(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));

  if (flags.get === 'true' || (!flags.header && !flags.footer)) {
    const result = await client.getCodeInjection();
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = await client.saveCodeInjection(
      flags.header !== 'true' ? flags.header : undefined,
      flags.footer !== 'true' ? flags.footer : undefined,
    );
    console.log(JSON.stringify(result, null, 2));
  }
}

// ── Design Settings / Advanced ──────────────────────────────────────────────

async function cmdGetFonts(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.getWebsiteFonts();
  console.log(JSON.stringify(result, null, 2));
}

async function cmdGetColors(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.getWebsiteColors();
  console.log(JSON.stringify(result, null, 2));
}

async function cmdGetAdvancedSettings(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.getAdvancedSettings();
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSetFont(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const fontName = flags.font;
  const fontFamily = flags.family;
  if (!siteId) throw new Error('--site is required');
  if (!fontName) throw new Error('--font is required (heading-font, body-font, or meta-font)');
  if (!fontFamily) throw new Error('--family is required (e.g. "Playfair Display")');

  const validNames = ['heading-font', 'body-font', 'meta-font'];
  if (!validNames.includes(fontName)) {
    throw new Error(`--font must be one of: ${validNames.join(', ')}`);
  }

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.updateFont(fontName, { fontFamily });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSetColor(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const colorId = flags.id;
  const colorValue = flags.value;
  if (!siteId) throw new Error('--site is required');
  if (!colorId) throw new Error('--id is required (e.g. white, black, safeLightAccent)');
  if (!colorValue) throw new Error('--value is required (hex #ff6600 or HSL 32,55,58)');

  const hsl = parseColorArg(colorValue);
  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.updatePaletteColor(colorId, hsl);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSetAdvancedSettings(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const filePath = flags.file;
  if (!siteId) throw new Error('--site is required');
  if (!filePath) throw new Error('--file is required (path to JSON file with settings)');
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const data = JSON.parse(readFileSync(filePath, 'utf-8'));
  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.saveAdvancedSettings(data);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdGetTweaks(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.getTemplateTweakSettings();
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSetTweaks(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  // Accept key=value pairs from --set flags or a JSON file
  const filePath = flags.file;
  const setValues = flags.set;

  let updates: Record<string, string> = {};

  if (filePath) {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    updates = JSON.parse(readFileSync(filePath, 'utf-8'));
  } else if (setValues) {
    // Parse comma-separated key=value pairs
    for (const pair of setValues.split(',')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) throw new Error(`Invalid key=value pair: ${pair}`);
      updates[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  } else {
    throw new Error('--set <key=value,...> or --file <path> is required');
  }

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.setTemplateTweakSettings(updates);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdReorderNav(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const pageIdsStr = flags['page-ids'];
  if (!siteId) throw new Error('--site is required');
  if (!pageIdsStr) throw new Error('--page-ids is required (comma-separated collection IDs in desired order)');

  const desiredOrder = pageIdsStr.split(',').map((id) => id.trim()).filter(Boolean);
  if (desiredOrder.length === 0) throw new Error('--page-ids must contain at least one collection ID');

  const { subdomain } = resolveSite(siteId);
  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));

  // 1. Get current navigation
  const navResult = await client.getNavigation();
  if (!navResult.success || !navResult.data) {
    throw new Error(`Failed to get navigation: ${navResult.error ?? 'unknown error'}`);
  }

  const currentItems = navResult.data.mainNavigation;
  console.error(`Current navigation: ${currentItems.map((i) => `${i.title} (${i.collectionId})`).join(', ')}`);

  // 2. Validate all provided IDs exist in current navigation
  const itemMap = new Map<string, typeof currentItems[0]>();
  for (const item of currentItems) {
    if (item.collectionId) itemMap.set(item.collectionId, item);
  }

  for (const id of desiredOrder) {
    if (!itemMap.has(id)) {
      throw new Error(
        `Collection ID "${id}" not found in main navigation.\n` +
        `Available IDs: ${currentItems.map((i) => `${i.collectionId} (${i.title})`).join(', ')}`,
      );
    }
  }

  // 3. Build UpdateNavigationItem[] in desired order
  // Items not in the desired order list are appended at the end (preserving relative order)
  const orderedItems: typeof currentItems[0][] = [];
  for (const id of desiredOrder) {
    orderedItems.push(itemMap.get(id)!);
  }
  for (const item of currentItems) {
    if (item.collectionId && !desiredOrder.includes(item.collectionId)) {
      orderedItems.push(item);
    }
  }

  // 4. Convert NavigationItem[] to UpdateNavigationItem[]
  const updateItems = orderedItems.map((item, idx) => ({
    title: item.title,
    urlId: item.urlSlug,
    typeName: 'page',
    collectionId: item.collectionId ?? item.id,
    enabled: item.enabled ?? true,
    passwordProtected: false,
    collectionType: item.collectionType ?? 10,
    isFolder: item.isFolder ?? false,
    ordering: idx,
    updatedOn: Date.now(),
    pagePermissionType: 3,
    isDraft: item.isDraft ?? false,
    items: [] as UpdateNavigationItem[],
    id: item.id,
  }));

  console.error(`New order: ${orderedItems.map((i) => i.title).join(', ')}`);

  // 5. Save
  const result = await client.updateNavigation('mainNav', updateItems);
  console.log(JSON.stringify(result, null, 2));
}

// ── Block addition commands ──────────────────────────────────────────────────

async function cmdAddQuote(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const text = flags.text;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!text) throw new Error('--text is required');

  const sectionIndex = parseInt(flags.section || '0', 10);
  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.addQuoteBlock(pageSectionsId, collectionId, sectionIndex, text, flags.attribution);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAddCode(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const code = flags.code;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!code) throw new Error('--code is required');

  const sectionIndex = parseInt(flags.section || '0', 10);
  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.addCodeBlock(pageSectionsId, collectionId, sectionIndex, code, flags.language);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAddVideo(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const url = flags.url;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!url) throw new Error('--url is required');

  const sectionIndex = parseInt(flags.section || '0', 10);
  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.addVideoBlock(pageSectionsId, collectionId, sectionIndex, url, {
    title: flags.title,
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAddDivider(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');

  const sectionIndex = parseInt(flags.section || '0', 10);
  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.addDividerBlock(pageSectionsId, collectionId, sectionIndex);
  console.log(JSON.stringify(result, null, 2));
}

// ── Section/block management commands ────────────────────────────────────────

async function cmdDuplicateSection(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const search = flags.search;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!search) throw new Error('--search is required');

  const sectionSearch: string | number = /^\d+$/.test(search) ? parseInt(search, 10) : search;

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.duplicateSection(pageSectionsId, collectionId, sectionSearch);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSwapBlocks(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const block1 = flags.block1;
  const block2 = flags.block2;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!block1) throw new Error('--block1 is required');
  if (!block2) throw new Error('--block2 is required');

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.swapBlocks(pageSectionsId, collectionId, block1, block2);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdDuplicateBlock(flags: Record<string, string>): Promise<void> {
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
  const result = await client.duplicateBlock(pageSectionsId, collectionId, search);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdGallery(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  const imageUrls = flags.images;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');
  if (!imageUrls) throw new Error('--images is required (comma-separated asset URLs)');

  const sectionIndex = parseInt(flags.section || '0', 10);
  const columns = flags.cols ? parseInt(flags.cols, 10) : undefined;

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId, collectionId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const images = imageUrls.split(',').map((url) => ({
    assetUrl: url.trim(),
    ...(columns ? { layout: { columns } } : {}),
  }));

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const result = await client.addImageBlockBatch(pageSectionsId, collectionId, sectionIndex, images);
  console.log(JSON.stringify(result, null, 2));
}

// ── Utility commands ─────────────────────────────────────────────────────────

async function cmdSessionHealth(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  if (!siteId) throw new Error('--site is required');

  const { subdomain } = resolveSite(siteId);
  const cookiePath = getCookiePath(subdomain);
  const result = ContentSaveClient.checkSessionHealth(cookiePath);
  console.log(JSON.stringify({ subdomain, cookiePath, ...result }, null, 2));
}

async function cmdValidateLinks(flags: Record<string, string>): Promise<void> {
  const siteId = flags.site;
  const slug = flags.page;
  if (!siteId) throw new Error('--site is required');
  if (!slug) throw new Error('--page is required');

  const { subdomain } = resolveSite(siteId);
  const { pageSectionsId } = await resolvePageIds(subdomain, slug, {
    psid: flags.psid,
    colid: flags.colid,
  });

  const client = createContentSaveClient(subdomain, getCookiePath(subdomain));
  const data = await client.getPageSections(pageSectionsId);
  const result = await extractAndValidateLinks(data.sections);
  console.log(JSON.stringify(result, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const USAGE = `
Squarespace direct API CLI

Usage: tsx scripts/sq.ts <subcommand> [flags]

Subcommands:
  login            --site <id>
  snapshot         --site <id> --page <slug>

  Page & Section management:
  add-section      --site <id> --page <slug>
  move-section     --site <id> --page <slug> --search <str> --direction up|down
  section-style    --site <id> --page <slug> --search <str> [--theme <str>] [--height <str>]
  create-page      --site <id> --title <str> [--slug <str>]
  delete-page      --site <id> --page <slug>
  list-pages       --site <id>
  update-metadata  --site <id> --page <slug> [--title <str>] [--description <str>] [--seo-title <str>] [--seo-description <str>]

  Block editing:
  add-text         --site <id> --page <slug> --section <idx> --html <str>
  update-text      --site <id> --page <slug> --search <str> --html <str>
  patch-text       --site <id> --page <slug> --search <str> --new <str>
  add-button       --site <id> --page <slug> --section <idx> --label <str> --url <str>
  update-button    --site <id> --page <slug> --search <str> [--label <str>] [--url <str>]
  remove-block     --site <id> --page <slug> --search <str>
  add-image        --site <id> --page <slug> --section <idx> --asset-url <str> [--alt <str>]
  update-image     --site <id> --page <slug> --search <str> [--title <str>] [--alt <str>] [--description <str>]
  update-menu      --site <id> --page <slug> --search <str> --menus <json>
  move-block       --site <id> --page <slug> --search <str> --direction up|down|left|right [--steps <n>]
  resize-block     --site <id> --page <slug> --search <str> [--width smaller|larger|full] [--height shorter|taller]

  Blog:
  create-post      --site <id> --blog <slug> --title <str> [--body <str>] [--tags <csv>] [--draft]
  update-post      --site <id> --blog <slug> --search <str> [--title <str>] [--body <str>] [--tags <csv>] [--draft]
  list-posts       --site <id> --blog <slug> [--limit <n>]

  More block types:
  add-quote        --site <id> --page <slug> --section <idx> --text <str> [--attribution <str>]
  add-code         --site <id> --page <slug> --section <idx> --code <str> [--language <str>]
  add-video        --site <id> --page <slug> --section <idx> --url <str> [--title <str>]
  add-divider      --site <id> --page <slug> --section <idx>
  gallery          --site <id> --page <slug> --section <idx> --images <csv-urls> [--cols <n>]

  Section/block operations:
  duplicate-section --site <id> --page <slug> --search <str|idx>
  swap-blocks      --site <id> --page <slug> --block1 <str> --block2 <str>
  duplicate-block  --site <id> --page <slug> --search <str>

  Site-wide:
  upload-image     --site <id> --url <image-url> [--filename <str>]
  custom-css       --site <id> [--css <str> | --file <path>]   (read if no flags, write if --css or --file)
  site-identity    --site <id> [--name <str>] [--phone <str>] [--email <str>] [--address <str>]
  navigation       --site <id>
  settings         --site <id>
  footer           --site <id> [--search <str> --text <str>]   (read if no flags, patch text if --search + --text)
  code-injection   --site <id> [--header <str>] [--footer <str>] [--get]   (read if --get or no flags, write if --header/--footer)
  reorder-nav      --site <id> --page-ids <id1,id2,id3>       (reorder main navigation pages)
  get-fonts        --site <id>                                  (get website font configuration)
  set-font         --site <id> --font <name> --family <str>     (set font: heading-font, body-font, meta-font)
  get-colors       --site <id>                                  (get website color palette and themes)
  set-color        --site <id> --id <color-id> --value <hex|hsl>  (set palette color: #ff6600 or 32,55,58)
  get-advanced-settings --site <id>                             (get advanced settings: URL mappings, 404, etc.)
  set-advanced-settings --site <id> --file <path>               (save advanced settings from JSON file)
  get-tweaks       --site <id>                                  (get tweak definitions and values)
  set-tweaks       --site <id> --set <k=v,...> | --file <path>   (set template tweak settings)

  Utilities:
  session-health   --site <id>
  validate-links   --site <id> --page <slug>

Common flags:
  --psid <id>    Override pageSectionsId (skip page ID resolution)
  --colid <id>   Override collectionId (skip page ID resolution)

Site identifiers: client ID, client alias, or raw subdomain (e.g. grey-yellow-hbxc)
`.trim();

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (subcommand) {
    case 'login':           return cmdLogin(flags);
    case 'snapshot':        return cmdSnapshot(flags);
    case 'add-section':     return cmdAddSection(flags);
    case 'add-text':        return cmdAddText(flags);
    case 'update-text':     return cmdUpdateText(flags);
    case 'patch-text':      return cmdPatchText(flags);
    case 'add-button':      return cmdAddButton(flags);
    case 'remove-block':    return cmdRemoveBlock(flags);
    case 'add-image':       return cmdAddImage(flags);
    case 'move-section':    return cmdMoveSection(flags);
    case 'section-style':   return cmdSectionStyle(flags);
    case 'upload-image':    return cmdUploadImage(flags);
    case 'create-page':     return cmdCreatePage(flags);
    case 'delete-page':     return cmdDeletePage(flags);
    case 'create-post':     return cmdCreatePost(flags);
    case 'update-post':     return cmdUpdatePost(flags);
    case 'list-posts':      return cmdListPosts(flags);
    case 'move-block':      return cmdMoveBlock(flags);
    case 'resize-block':    return cmdResizeBlock(flags);
    case 'custom-css':      return cmdCustomCSS(flags);
    case 'site-identity':   return cmdSiteIdentity(flags);
    case 'update-metadata': return cmdUpdateMetadata(flags);
    case 'list-pages':      return cmdListPages(flags);
    case 'update-button':   return cmdUpdateButton(flags);
    case 'update-image':    return cmdUpdateImage(flags);
    case 'update-menu':     return cmdUpdateMenu(flags);
    case 'navigation':      return cmdNavigation(flags);
    case 'settings':        return cmdSettings(flags);
    case 'footer':          return cmdFooter(flags);
    case 'code-injection':  return cmdCodeInjection(flags);
    case 'reorder-nav':     return cmdReorderNav(flags);
    case 'get-fonts':       return cmdGetFonts(flags);
    case 'set-font':        return cmdSetFont(flags);
    case 'get-colors':      return cmdGetColors(flags);
    case 'set-color':       return cmdSetColor(flags);
    case 'get-advanced-settings': return cmdGetAdvancedSettings(flags);
    case 'set-advanced-settings': return cmdSetAdvancedSettings(flags);
    case 'get-tweaks':      return cmdGetTweaks(flags);
    case 'set-tweaks':      return cmdSetTweaks(flags);
    case 'add-quote':       return cmdAddQuote(flags);
    case 'add-code':        return cmdAddCode(flags);
    case 'add-video':       return cmdAddVideo(flags);
    case 'add-divider':     return cmdAddDivider(flags);
    case 'duplicate-section': return cmdDuplicateSection(flags);
    case 'swap-blocks':     return cmdSwapBlocks(flags);
    case 'duplicate-block': return cmdDuplicateBlock(flags);
    case 'gallery':         return cmdGallery(flags);
    case 'session-health':  return cmdSessionHealth(flags);
    case 'validate-links':  return cmdValidateLinks(flags);
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
