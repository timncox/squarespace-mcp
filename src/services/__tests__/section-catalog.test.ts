import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeCategoryName,
  lookupCatalogEntry,
  catalogToDiscoveryResult,
  getOrFetchCatalog,
  copyTemplateSectionFromCatalog,
} from '../section-catalog.js';
import type { SectionCatalogEntry } from '../content-save.js';

// ── Mock database ──────────────────────────────────────────────────────────

const mockDbRun = vi.fn();
const mockDbGet = vi.fn();
const mockDbPrepare = vi.fn(() => ({ run: mockDbRun, get: mockDbGet }));
vi.mock('../../db/database.js', () => ({
  getDb: () => ({ prepare: mockDbPrepare }),
}));

// ── Mock fs for ContentSaveClient ────────────────────────────────────────

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({
    cookies: [
      { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
      { name: 'crumb', value: 'crumb-abc', domain: '.test.squarespace.com', path: '/' },
    ],
  })),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

// ── Mock content-save for copyTemplateSection + getSectionCatalog ────────

const mockCopyTemplateSection = vi.fn();
const mockGetSectionCatalog = vi.fn();
vi.mock('../content-save.js', () => ({
  createContentSaveClient: () => ({
    getSectionCatalog: () => mockGetSectionCatalog(),
    copyTemplateSection: (...args: unknown[]) => mockCopyTemplateSection(...args),
  }),
}));

// ── Sample catalog data ──────────────────────────────────────────────────

function makeEntry(websiteId: string, collectionId: string, sectionId: string): SectionCatalogEntry {
  return { websiteId, collectionId, sectionId };
}

const SAMPLE_CATALOG: Record<string, SectionCatalogEntry[]> = {
  'CONTACT': [
    makeEntry('web1', 'coll1', 'sec-contact-0'),
    makeEntry('web1', 'coll1', 'sec-contact-1'),
    makeEntry('web1', 'coll1', 'sec-contact-2'),
  ],
  'ABOUT': [
    makeEntry('web2', 'coll2', 'sec-about-0'),
    makeEntry('web2', 'coll2', 'sec-about-1'),
  ],
  'SERVICES/OFFERINGS': [
    makeEntry('web3', 'coll3', 'sec-services-0'),
  ],
  'FAQS': [
    makeEntry('web4', 'coll4', 'sec-faqs-0'),
    makeEntry('web4', 'coll4', 'sec-faqs-1'),
  ],
  'MENUS': [
    makeEntry('web5', 'coll5', 'sec-menus-0'),
  ],
};

// ── Tests ────────────────────────────────────────────────────────────────

describe('normalizeCategoryName', () => {
  it('uppercases simple category names', () => {
    expect(normalizeCategoryName('Contact')).toBe('CONTACT');
    expect(normalizeCategoryName('about')).toBe('ABOUT');
    expect(normalizeCategoryName('TEAM')).toBe('TEAM');
  });

  it('resolves Services to SERVICES/OFFERINGS', () => {
    expect(normalizeCategoryName('Services')).toBe('SERVICES/OFFERINGS');
    expect(normalizeCategoryName('SERVICES')).toBe('SERVICES/OFFERINGS');
    expect(normalizeCategoryName('offerings')).toBe('SERVICES/OFFERINGS');
    expect(normalizeCategoryName('Services/Offerings')).toBe('SERVICES/OFFERINGS');
  });

  it('resolves FAQ variants', () => {
    expect(normalizeCategoryName('FAQ')).toBe('FAQS');
    expect(normalizeCategoryName('faqs')).toBe('FAQS');
  });

  it('resolves Menu variants', () => {
    expect(normalizeCategoryName('Menu')).toBe('MENUS');
    expect(normalizeCategoryName('Menus')).toBe('MENUS');
  });

  it('resolves Product variants', () => {
    expect(normalizeCategoryName('Product')).toBe('PRODUCTS');
    expect(normalizeCategoryName('Products')).toBe('PRODUCTS');
  });

  it('passes through unknown categories as uppercase', () => {
    expect(normalizeCategoryName('CustomCategory')).toBe('CUSTOMCATEGORY');
    expect(normalizeCategoryName('blog posts')).toBe('BLOG POSTS');
  });

  it('trims whitespace', () => {
    expect(normalizeCategoryName('  Contact  ')).toBe('CONTACT');
  });
});

describe('lookupCatalogEntry', () => {
  it('finds entry by category and index', () => {
    const entry = lookupCatalogEntry(SAMPLE_CATALOG, 'Contact', 1);
    expect(entry).toEqual(makeEntry('web1', 'coll1', 'sec-contact-1'));
  });

  it('finds entry at index 0', () => {
    const entry = lookupCatalogEntry(SAMPLE_CATALOG, 'About', 0);
    expect(entry).toEqual(makeEntry('web2', 'coll2', 'sec-about-0'));
  });

  it('normalizes category names before lookup', () => {
    const entry = lookupCatalogEntry(SAMPLE_CATALOG, 'Services', 0);
    expect(entry).toEqual(makeEntry('web3', 'coll3', 'sec-services-0'));
  });

  it('returns null for unknown category', () => {
    const entry = lookupCatalogEntry(SAMPLE_CATALOG, 'Unknown', 0);
    expect(entry).toBeNull();
  });

  it('returns null for out-of-range index', () => {
    const entry = lookupCatalogEntry(SAMPLE_CATALOG, 'Contact', 5);
    expect(entry).toBeNull();
  });

  it('returns null for negative index', () => {
    const entry = lookupCatalogEntry(SAMPLE_CATALOG, 'Contact', -1);
    expect(entry).toBeNull();
  });

  it('handles case-insensitive category matching', () => {
    const entry = lookupCatalogEntry(SAMPLE_CATALOG, 'faqs', 1);
    expect(entry).toEqual(makeEntry('web4', 'coll4', 'sec-faqs-1'));
  });
});

describe('catalogToDiscoveryResult', () => {
  it('converts catalog to TemplateDiscoveryResult shape', () => {
    const result = catalogToDiscoveryResult(SAMPLE_CATALOG);

    expect(result.categories).toHaveLength(5);
    expect(result.discoveredAt).toBeInstanceOf(Date);

    const contactCat = result.categories.find(c => c.name === 'CONTACT');
    expect(contactCat).toBeDefined();
    expect(contactCat!.templates).toHaveLength(3);
    expect(contactCat!.templates[0]).toEqual({ name: 'sec-contact-0', index: 0 });
    expect(contactCat!.templates[2]).toEqual({ name: 'sec-contact-2', index: 2 });
  });

  it('handles empty catalog', () => {
    const result = catalogToDiscoveryResult({});
    expect(result.categories).toHaveLength(0);
  });

  it('preserves category order and entry indices', () => {
    const result = catalogToDiscoveryResult(SAMPLE_CATALOG);
    const servicesCat = result.categories.find(c => c.name === 'SERVICES/OFFERINGS');
    expect(servicesCat).toBeDefined();
    expect(servicesCat!.templates).toHaveLength(1);
    expect(servicesCat!.templates[0].index).toBe(0);
  });
});

describe('getOrFetchCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cached catalog on cache hit', async () => {
    mockDbGet.mockReturnValueOnce({
      categories_json: JSON.stringify(SAMPLE_CATALOG),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });

    const result = await getOrFetchCatalog('test-site');
    expect(result).toEqual(SAMPLE_CATALOG);
    expect(mockGetSectionCatalog).not.toHaveBeenCalled();
  });

  it('fetches from API on cache miss', async () => {
    mockDbGet.mockReturnValueOnce(undefined); // cache miss

    mockGetSectionCatalog.mockResolvedValueOnce({
      success: true,
      catalog: SAMPLE_CATALOG,
    });

    const result = await getOrFetchCatalog('test-site');
    expect(result).toEqual(SAMPLE_CATALOG);
    expect(mockGetSectionCatalog).toHaveBeenCalled();
    // Should cache the result
    expect(mockDbRun).toHaveBeenCalled();
  });

  it('bypasses cache when forceRefresh is true', async () => {
    mockGetSectionCatalog.mockResolvedValueOnce({
      success: true,
      catalog: SAMPLE_CATALOG,
    });

    const result = await getOrFetchCatalog('test-site', true);
    expect(result).toEqual(SAMPLE_CATALOG);
    expect(mockGetSectionCatalog).toHaveBeenCalled();
    // Should not read cache
    expect(mockDbGet).not.toHaveBeenCalled();
  });

  it('returns null when API fails', async () => {
    mockDbGet.mockReturnValueOnce(undefined); // cache miss

    mockGetSectionCatalog.mockResolvedValueOnce({
      success: false,
      error: 'Unauthorized',
    });

    const result = await getOrFetchCatalog('test-site');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockDbGet.mockReturnValueOnce(undefined); // cache miss
    mockGetSectionCatalog.mockRejectedValueOnce(new Error('Network error'));

    const result = await getOrFetchCatalog('test-site');
    expect(result).toBeNull();
  });
});

describe('copyTemplateSectionFromCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies a template section successfully', async () => {
    // Cache hit for catalog
    mockDbGet.mockReturnValueOnce({
      categories_json: JSON.stringify(SAMPLE_CATALOG),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });

    mockCopyTemplateSection.mockResolvedValueOnce({
      success: true,
      sectionId: 'new-section-123',
    });

    const result = await copyTemplateSectionFromCatalog('test-site', 'Contact', 1);
    expect(result).toEqual({ success: true, sectionId: 'new-section-123' });
    expect(mockCopyTemplateSection).toHaveBeenCalledWith('web1', 'coll1', 'sec-contact-1');
  });

  it('returns null when catalog fetch fails', async () => {
    // Cache miss + API failure
    mockDbGet.mockReturnValueOnce(undefined);
    mockGetSectionCatalog.mockRejectedValueOnce(new Error('Network error'));

    const result = await copyTemplateSectionFromCatalog('test-site', 'Contact', 0);
    expect(result).toBeNull();
    expect(mockCopyTemplateSection).not.toHaveBeenCalled();
  });

  it('returns null when category not found in catalog', async () => {
    mockDbGet.mockReturnValueOnce({
      categories_json: JSON.stringify(SAMPLE_CATALOG),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });

    const result = await copyTemplateSectionFromCatalog('test-site', 'NonExistent', 0);
    expect(result).toBeNull();
    expect(mockCopyTemplateSection).not.toHaveBeenCalled();
  });

  it('returns null when template index out of range', async () => {
    mockDbGet.mockReturnValueOnce({
      categories_json: JSON.stringify(SAMPLE_CATALOG),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });

    const result = await copyTemplateSectionFromCatalog('test-site', 'Contact', 99);
    expect(result).toBeNull();
    expect(mockCopyTemplateSection).not.toHaveBeenCalled();
  });

  it('returns null when copy API fails', async () => {
    mockDbGet.mockReturnValueOnce({
      categories_json: JSON.stringify(SAMPLE_CATALOG),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });

    mockCopyTemplateSection.mockResolvedValueOnce({
      success: false,
      error: 'Copy failed',
    });

    const result = await copyTemplateSectionFromCatalog('test-site', 'About', 0);
    expect(result).toBeNull();
    expect(mockCopyTemplateSection).toHaveBeenCalledWith('web2', 'coll2', 'sec-about-0');
  });

  it('normalizes category name before lookup', async () => {
    mockDbGet.mockReturnValueOnce({
      categories_json: JSON.stringify(SAMPLE_CATALOG),
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });

    mockCopyTemplateSection.mockResolvedValueOnce({
      success: true,
      sectionId: 'new-section-svc',
    });

    const result = await copyTemplateSectionFromCatalog('test-site', 'Services', 0);
    expect(result).toEqual({ success: true, sectionId: 'new-section-svc' });
    // Should resolve 'Services' → 'SERVICES/OFFERINGS' and find sec-services-0
    expect(mockCopyTemplateSection).toHaveBeenCalledWith('web3', 'coll3', 'sec-services-0');
  });
});
