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
