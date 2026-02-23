/**
 * Site Reader — Reads Squarespace page/collection data via the ?format=json-pretty endpoint.
 *
 * Enables pre-edit analysis and post-edit verification by reading structured page data
 * instead of relying solely on screenshots. Any public Squarespace page at
 * {url}?format=json-pretty returns the full page JSON including website metadata,
 * collection data, items array, and block content.
 *
 * Usage:
 * ```ts
 * const reader = new SiteReader('https://smyth-tavern.squarespace.com');
 * const page = await reader.readPage('menus');
 * const blocks = await reader.getPageBlocks('home');
 * const pages = await reader.listPages();
 * ```
 */

import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Top-level page JSON from Squarespace ?format=json-pretty */
export interface SquarespacePageData {
  website: WebsiteMetadata;
  collection?: CollectionData;
  item?: ItemData;
  items?: ItemData[];
  pagination?: PaginationData;
  /** Raw JSON — fields beyond what we've typed */
  [key: string]: unknown;
}

export interface WebsiteMetadata {
  id: string;
  siteTitle: string;
  siteDescription?: string;
  siteTagLine?: string;
  socialLogoImageUrl?: string;
  shareButtonOptions?: Record<string, boolean>;
  location?: {
    addressLine1?: string;
    addressLine2?: string;
    addressCountry?: string;
  };
  [key: string]: unknown;
}

export interface CollectionData {
  id: string;
  title: string;
  description?: string;
  urlId: string;
  typeName: string;
  type: number;
  mainImage?: ImageData;
  tags?: string[];
  categories?: string[];
  enabled: boolean;
  [key: string]: unknown;
}

export interface ItemData {
  id: string;
  title: string;
  urlId: string;
  body?: string;
  excerpt?: string;
  assetUrl?: string;
  author?: { displayName: string };
  publishOn?: number;
  updatedOn?: number;
  tags?: string[];
  categories?: string[];
  structuredContent?: StructuredContentBlock;
  items?: LayoutBlock[];
  [key: string]: unknown;
}

export interface ImageData {
  id?: string;
  url?: string;
  assetUrl?: string;
  originalSize?: { width: number; height: number };
  title?: string;
  altText?: string;
  [key: string]: unknown;
}

export interface PaginationData {
  nextPage: boolean;
  nextPageOffset?: number;
  nextPageUrl?: string;
  [key: string]: unknown;
}

/** Structured content (Fluid Engine layout) */
export interface StructuredContentBlock {
  _type: string;
  blocks?: LayoutBlock[];
  styles?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Individual block within a page layout */
export interface LayoutBlock {
  id?: string;
  type: string | number;
  value?: BlockValue;
  children?: LayoutBlock[];
  [key: string]: unknown;
}

export interface BlockValue {
  html?: string;
  text?: string;
  url?: string;
  imageId?: string;
  buttonText?: string;
  linkUrl?: string;
  altText?: string;
  [key: string]: unknown;
}

/** Extracted block info for easy consumption */
export interface ExtractedBlock {
  type: string;
  text?: string;
  html?: string;
  imageUrl?: string;
  imageAlt?: string;
  buttonText?: string;
  buttonUrl?: string;
  raw: LayoutBlock;
}

/** Extracted SEO data */
export interface PageSEOData {
  title?: string;
  description?: string;
  seoTitle?: string;
  seoDescription?: string;
  socialImage?: string;
  urlSlug: string;
}

/** Diff result between two page snapshots */
export interface PageDiff {
  slug: string;
  changed: boolean;
  changes: DiffChange[];
}

export interface DiffChange {
  path: string;
  type: 'added' | 'removed' | 'modified';
  before?: unknown;
  after?: unknown;
}

/** Cache entry with TTL */
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

// ─── Block Type Map ───────────────────────────────────────────────────────────

/** Squarespace block type numbers → human-readable names */
const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: 'text',
  2: 'image',
  3: 'gallery',
  4: 'video',
  5: 'audio',
  6: 'embed',
  7: 'quote',
  8: 'link',
  9: 'product',
  10: 'form',
  11: 'code',
  12: 'map',
  17: 'newsletter',
  20: 'line',
  23: 'button',
  24: 'markdown',
  28: 'donation',
  44: 'summary',
  51: 'menu',
  52: 'accordion',
  53: 'socialLinks',
  55: 'calendar',
};

function blockTypeName(type: string | number): string {
  if (typeof type === 'string') return type;
  return BLOCK_TYPE_NAMES[type] ?? `unknown_${type}`;
}

// ─── SiteReader Class ─────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 15000;
const COLLECTION_PAGE_SIZE = 20;

export class SiteReader {
  private baseUrl: string;
  private cache = new Map<string, CacheEntry<unknown>>();

  constructor(baseUrl: string) {
    // Normalize: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Fetch a page's full JSON data.
   * Returns null if the page is not found or password-protected.
   */
  async readPage(slug: string): Promise<SquarespacePageData | null> {
    const normalizedSlug = this.normalizeSlug(slug);
    const url = normalizedSlug
      ? `${this.baseUrl}/${normalizedSlug}?format=json-pretty`
      : `${this.baseUrl}?format=json-pretty`;

    return this.fetchJson<SquarespacePageData>(url, `page:${normalizedSlug || 'home'}`);
  }

  /**
   * Fetch a collection (blog, events, gallery, etc.) with pagination support.
   * Collections return 20 items per page by default.
   */
  async readCollection(
    slug: string,
    options?: { offset?: number; limit?: number },
  ): Promise<{ data: SquarespacePageData | null; items: ItemData[]; hasMore: boolean }> {
    const normalizedSlug = this.normalizeSlug(slug);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? COLLECTION_PAGE_SIZE;

    const allItems: ItemData[] = [];
    let currentOffset = offset;
    let hasMore = true;
    let pageData: SquarespacePageData | null = null;

    while (allItems.length < limit && hasMore) {
      const url = currentOffset > 0
        ? `${this.baseUrl}/${normalizedSlug}?format=json-pretty&offset=${currentOffset}`
        : `${this.baseUrl}/${normalizedSlug}?format=json-pretty`;

      const data = await this.fetchJson<SquarespacePageData>(url, `collection:${normalizedSlug}:${currentOffset}`);

      if (!data) {
        return { data: null, items: [], hasMore: false };
      }

      if (!pageData) pageData = data;

      const items = data.items ?? [];
      allItems.push(...items);

      hasMore = data.pagination?.nextPage ?? false;
      currentOffset = data.pagination?.nextPageOffset ?? currentOffset + COLLECTION_PAGE_SIZE;

      // Safety: if no items returned, stop
      if (items.length === 0) break;
    }

    return {
      data: pageData,
      items: allItems.slice(0, limit),
      hasMore,
    };
  }

  /**
   * List all pages/navigation items from the site root JSON.
   * Returns the navigation structure with page titles, slugs, and types.
   */
  async listPages(): Promise<Array<{ title: string; slug: string; type: string; enabled: boolean }>> {
    const data = await this.fetchJson<SquarespacePageData>(
      `${this.baseUrl}?format=json-pretty`,
      'site-root',
    );

    if (!data?.website) return [];

    const pages: Array<{ title: string; slug: string; type: string; enabled: boolean }> = [];

    // Navigate the website.navigation array
    const nav = (data.website as Record<string, unknown>).navigation as unknown[];
    if (Array.isArray(nav)) {
      for (const item of nav) {
        const navItem = item as Record<string, unknown>;
        pages.push({
          title: String(navItem.title ?? ''),
          slug: String(navItem.urlId ?? ''),
          type: String(navItem.typeName ?? 'page'),
          enabled: Boolean(navItem.enabled ?? true),
        });

        // Include child pages (dropdown menus)
        const children = navItem.items ?? navItem.children;
        if (Array.isArray(children)) {
          for (const child of children) {
            const childItem = child as Record<string, unknown>;
            pages.push({
              title: String(childItem.title ?? ''),
              slug: String(childItem.urlId ?? ''),
              type: String(childItem.typeName ?? 'page'),
              enabled: Boolean(childItem.enabled ?? true),
            });
          }
        }
      }
    }

    return pages;
  }

  /**
   * Extract block data from a page — text content, images, buttons, etc.
   * Returns structured block info for easy consumption by agents.
   */
  async getPageBlocks(slug: string): Promise<ExtractedBlock[]> {
    const data = await this.readPage(slug);
    if (!data) return [];

    const blocks: ExtractedBlock[] = [];

    // Extract from collection mainContent / items
    if (data.collection) {
      this.extractBlocksFromItem(data.collection as unknown as LayoutBlock, blocks);
    }

    // Extract from item (single page view)
    if (data.item) {
      this.extractBlocksFromItem(data.item as unknown as LayoutBlock, blocks);

      // Structured content (Fluid Engine)
      if (data.item.structuredContent?.blocks) {
        for (const block of data.item.structuredContent.blocks) {
          this.extractBlock(block, blocks);
        }
      }
    }

    // Extract from items array
    if (data.items) {
      for (const item of data.items) {
        if (item.body) {
          blocks.push({
            type: 'text',
            html: item.body,
            text: this.stripHtml(item.body),
            raw: item as unknown as LayoutBlock,
          });
        }
        if (item.structuredContent?.blocks) {
          for (const block of item.structuredContent.blocks) {
            this.extractBlock(block, blocks);
          }
        }
      }
    }

    // Extract from page layout sections (mainContent)
    const mainContent = (data as Record<string, unknown>).mainContent;
    if (mainContent && typeof mainContent === 'object') {
      this.extractBlocksFromLayout(mainContent as LayoutBlock, blocks);
    }

    return blocks;
  }

  /**
   * Extract SEO metadata from a page.
   */
  async getPageSEO(slug: string): Promise<PageSEOData | null> {
    const data = await this.readPage(slug);
    if (!data) return null;

    const collection = data.collection ?? {};
    const item = data.item ?? {};
    const website = data.website ?? {};

    return {
      title: (collection as Record<string, unknown>).title as string | undefined
        ?? (item as Record<string, unknown>).title as string | undefined,
      description: (collection as Record<string, unknown>).description as string | undefined
        ?? (item as Record<string, unknown>).excerpt as string | undefined,
      seoTitle: (collection as Record<string, unknown>).seoTitle as string | undefined
        ?? (item as Record<string, unknown>).seoTitle as string | undefined
        ?? (website as Record<string, unknown>).seoTitle as string | undefined,
      seoDescription: (collection as Record<string, unknown>).seoDescription as string | undefined
        ?? (item as Record<string, unknown>).seoDescription as string | undefined
        ?? (website as Record<string, unknown>).seoDescription as string | undefined,
      socialImage: (collection as Record<string, unknown>).socialImage as string | undefined
        ?? ((collection as Record<string, unknown>).mainImage as ImageData | undefined)?.assetUrl
        ?? ((item as Record<string, unknown>).assetUrl as string | undefined),
      urlSlug: slug,
    };
  }

  /**
   * Compare two page JSON snapshots and return what changed.
   * Use by capturing `readPage()` before and after an edit.
   */
  diffPages(slug: string, before: SquarespacePageData, after: SquarespacePageData): PageDiff {
    const changes: DiffChange[] = [];

    // Compare collection-level fields
    if (before.collection && after.collection) {
      this.diffObject('collection', before.collection, after.collection, changes);
    }

    // Compare items
    const beforeItems = before.items ?? [];
    const afterItems = after.items ?? [];

    if (beforeItems.length !== afterItems.length) {
      changes.push({
        path: 'items.length',
        type: 'modified',
        before: beforeItems.length,
        after: afterItems.length,
      });
    }

    // Compare matching items by ID
    for (const afterItem of afterItems) {
      const beforeItem = beforeItems.find((b) => b.id === afterItem.id);
      if (!beforeItem) {
        changes.push({ path: `items[${afterItem.id}]`, type: 'added', after: afterItem.title });
      } else {
        if (beforeItem.title !== afterItem.title) {
          changes.push({
            path: `items[${afterItem.id}].title`,
            type: 'modified',
            before: beforeItem.title,
            after: afterItem.title,
          });
        }
        if (beforeItem.body !== afterItem.body) {
          changes.push({
            path: `items[${afterItem.id}].body`,
            type: 'modified',
            before: this.truncate(beforeItem.body, 80),
            after: this.truncate(afterItem.body, 80),
          });
        }
      }
    }

    for (const beforeItem of beforeItems) {
      if (!afterItems.find((a) => a.id === beforeItem.id)) {
        changes.push({ path: `items[${beforeItem.id}]`, type: 'removed', before: beforeItem.title });
      }
    }

    return {
      slug,
      changed: changes.length > 0,
      changes,
    };
  }

  /**
   * Fetch the site's unminified CSS stylesheet.
   */
  async getStylesheet(): Promise<string | null> {
    const url = `${this.baseUrl}/site.css?minify=false`;
    const cacheKey = 'stylesheet';

    const cached = this.getFromCache<string>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      logger.info({ url }, 'SiteReader: fetching stylesheet');
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'SquarespaceHelper/1.0' },
      });

      if (!response.ok) {
        logger.warn({ status: response.status, url }, 'SiteReader: stylesheet fetch failed');
        return null;
      }

      const css = await response.text();
      this.setCache(cacheKey, css);
      logger.info({ length: css.length }, 'SiteReader: stylesheet fetched');
      return css;
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'SiteReader: stylesheet fetch error');
      return null;
    }
  }

  /** Clear the internal cache. */
  clearCache(): void {
    this.cache.clear();
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private normalizeSlug(slug: string): string {
    const lower = slug.toLowerCase().trim();
    const HOME_SLUGS = ['homepage', 'home-page', 'home', 'landing', 'index', 'main', ''];
    if (HOME_SLUGS.includes(lower)) return '';
    return slug.replace(/^\/+/, '');
  }

  private async fetchJson<T>(url: string, cacheKey: string): Promise<T | null> {
    const cached = this.getFromCache<T>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      logger.info({ url }, 'SiteReader: fetching JSON');
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'SquarespaceHelper/1.0',
        },
      });

      if (response.status === 404) {
        logger.warn({ url }, 'SiteReader: page not found (404)');
        return null;
      }

      if (response.status === 401 || response.status === 403) {
        logger.warn({ url, status: response.status }, 'SiteReader: page is password-protected or restricted');
        return null;
      }

      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'SiteReader: unexpected response status');
        return null;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('json') && !contentType.includes('text')) {
        logger.warn({ url, contentType }, 'SiteReader: unexpected content type');
        return null;
      }

      const data = await response.json() as T;
      this.setCache(cacheKey, data);
      return data;
    } catch (err) {
      logger.warn({ error: errMsg(err), url }, 'SiteReader: fetch failed');
      return null;
    }
  }

  private getFromCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  private setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private extractBlock(block: LayoutBlock, out: ExtractedBlock[]): void {
    const type = blockTypeName(block.type);
    const value = block.value ?? {};

    const extracted: ExtractedBlock = { type, raw: block };

    if (value.html) {
      extracted.html = value.html;
      extracted.text = this.stripHtml(value.html);
    }
    if (value.text) {
      extracted.text = value.text;
    }
    if (value.imageId || value.url?.includes('squarespace-cdn.com')) {
      extracted.imageUrl = value.url;
      extracted.imageAlt = value.altText;
    }
    if (value.buttonText) {
      extracted.buttonText = value.buttonText;
      extracted.buttonUrl = value.linkUrl;
    }

    out.push(extracted);

    // Recurse into children
    if (block.children) {
      for (const child of block.children) {
        this.extractBlock(child, out);
      }
    }
  }

  private extractBlocksFromItem(item: LayoutBlock, out: ExtractedBlock[]): void {
    const record = item as unknown as Record<string, unknown>;

    // Body HTML
    if (record.body && typeof record.body === 'string') {
      out.push({
        type: 'text',
        html: record.body,
        text: this.stripHtml(record.body),
        raw: item,
      });
    }

    // Items within the page layout
    if (Array.isArray(record.items)) {
      for (const child of record.items) {
        this.extractBlock(child as LayoutBlock, out);
      }
    }
  }

  private extractBlocksFromLayout(layout: LayoutBlock, out: ExtractedBlock[]): void {
    // The mainContent can have rows → columns → blocks
    const record = layout as unknown as Record<string, unknown>;
    if (Array.isArray(record.rows)) {
      for (const row of record.rows) {
        const rowRecord = row as Record<string, unknown>;
        if (Array.isArray(rowRecord.columns)) {
          for (const col of rowRecord.columns) {
            const colRecord = col as Record<string, unknown>;
            if (Array.isArray(colRecord.blocks)) {
              for (const block of colRecord.blocks) {
                this.extractBlock(block as LayoutBlock, out);
              }
            }
          }
        }
      }
    }

    // Sections array
    if (Array.isArray(record.sections)) {
      for (const section of record.sections) {
        this.extractBlocksFromLayout(section as LayoutBlock, out);
      }
    }

    // Direct blocks
    if (Array.isArray(record.blocks)) {
      for (const block of record.blocks) {
        this.extractBlock(block as LayoutBlock, out);
      }
    }
  }

  private diffObject(
    prefix: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    changes: DiffChange[],
  ): void {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];

    for (const key of keys) {
      // Skip noisy internal fields
      if (key === 'id' || key.startsWith('_')) continue;

      const path = `${prefix}.${key}`;
      const bVal = before[key];
      const aVal = after[key];

      if (bVal === undefined && aVal !== undefined) {
        changes.push({ path, type: 'added', after: this.truncate(String(aVal), 120) });
      } else if (bVal !== undefined && aVal === undefined) {
        changes.push({ path, type: 'removed', before: this.truncate(String(bVal), 120) });
      } else if (typeof bVal === 'string' && typeof aVal === 'string' && bVal !== aVal) {
        changes.push({
          path,
          type: 'modified',
          before: this.truncate(bVal, 80),
          after: this.truncate(aVal, 80),
        });
      }
    }
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  private truncate(value: string | undefined, maxLen: number): string | undefined {
    if (!value) return undefined;
    return value.length > maxLen ? value.substring(0, maxLen) + '...' : value;
  }
}
