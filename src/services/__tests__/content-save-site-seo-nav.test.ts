import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import { websiteRecordForPut, navLinkToUpdateItem } from '../content-save/site.js';

// ── Mock session file (same shape as content-save-page-management.test.ts) ──

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
  origins: [
    {
      origin: 'https://test-site.squarespace.com',
      localStorage: [
        {
          name: 'statsig.cached.evaluations.v2',
          value: JSON.stringify({ data: '{"website_id":"5f7c98d5b6fdce54b4c628af","member_account_id":"6012345678abcdef01234567"}' }),
        },
      ],
    },
  ],
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

function jsonResponse(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) };
}

// GET /api/rest/websites/mine shape (trimmed) — includes keys the PUT rejects
const WEBSITE = {
  id: 'web-1', identifier: 'bmco', siteTitle: 'BOWERY MEAT COMPANY', metaDescription: 'This fall… debuts Seahorse',
  siteDescription: '', templateId: 'tmpl-1', timeZone: 'America/New_York',
  logoImage: { id: 'x' }, logoImageUrl: 'https://img', faviconItem: { id: 'f' }, installationId: 'inst',
  internalUrl: 'https://bmco.squarespace.com', screenshotId: 's', templateWebsiteId: 't', typekitId: 'k', hasBeenCloneable: false,
};

// GET /api/navigation shape (bmco, 2026-10-14)
const NAV = [
  {
    identifier: 'mainNav', name: 'Main Navigation', links: [
      { title: 'Menu', urlId: 'menu', typeName: 'page', collectionId: 'c-menu', enabled: true, passwordProtected: false, collectionType: 10, isFolder: false, ordering: 3, updatedOn: 1, pagePermissionType: 1, isDraft: false, icon: 'page' },
      { title: 'Event Inquiries', externalLink: { title: 'Event Inquiries', url: '#', newWindow: true }, enabled: false, passwordProtected: false, isFolder: false, isDraft: false },
      { title: 'Gallery', urlId: 'gallery-1', typeName: 'page', collectionId: 'c-gal', enabled: true, passwordProtected: false, collectionType: 10, isFolder: false, ordering: 5, updatedOn: 2, pagePermissionType: 1, isDraft: false, icon: 'page' },
    ],
  },
  { identifier: '_hidden', name: 'Not Linked', links: [
    { title: 'Press', urlId: 'press', typeName: 'blog-basic-grid', collectionId: 'c-press', categories: [], tags: [], icon: 'blog', enabled: true, isFolder: false, isDraft: false },
  ] },
];

describe('ContentSaveClient — site SEO + navigation links', () => {
  let client: ContentSaveClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  describe('websiteRecordForPut()', () => {
    it('keeps only the keys the SEO panel sends', () => {
      const body = websiteRecordForPut(WEBSITE);
      expect(body.metaDescription).toBe(WEBSITE.metaDescription);
      expect(body.siteTitle).toBe('BOWERY MEAT COMPANY');
      for (const k of ['logoImage', 'logoImageUrl', 'faviconItem', 'installationId', 'internalUrl', 'screenshotId', 'templateWebsiteId', 'typekitId', 'hasBeenCloneable']) {
        expect(body).not.toHaveProperty(k);
      }
    });
  });

  describe('updateSiteSeo()', () => {
    it('PUTs the trimmed website record with the new meta description', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(WEBSITE)).mockResolvedValueOnce(jsonResponse({}));
      const r = await client.updateSiteSeo({ metaDescription: 'Upscale steakhouse.' });
      expect(r.success).toBe(true);
      expect(r.updatedFields).toEqual(['metaDescription']);
      const [url, opts] = mockFetch.mock.calls[1];
      expect(url).toContain('/api/rest/websites/mine');
      expect(opts.method).toBe('PUT');
      expect(opts.headers['x-csrf-token']).toBe('crumb-token-abc');
      const sent = JSON.parse(opts.body);
      expect(sent.metaDescription).toBe('Upscale steakhouse.');
      expect(sent).not.toHaveProperty('logoImage');
      expect(sent).not.toHaveProperty('installationId');
    });

    it('routes title formats through site settings', async () => {
      const spy = vi.spyOn(client, 'updateSettings').mockResolvedValue({ success: true, updatedFields: ['collectionTitleFormat'] });
      const r = await client.updateSiteSeo({ collectionTitleFormat: '%p — Bowery Meat Company' });
      expect(r.success).toBe(true);
      expect(spy).toHaveBeenCalledWith({ collectionTitleFormat: '%p — Bowery Meat Company' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('errors when nothing is passed', async () => {
      const r = await client.updateSiteSeo({});
      expect(r.success).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('surfaces a rejected PUT', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(WEBSITE)).mockResolvedValueOnce(jsonResponse('', 400));
      const r = await client.updateSiteSeo({ metaDescription: 'x' });
      expect(r.success).toBe(false);
      expect(r.error).toContain('400');
    });
  });

  describe('navLinkToUpdateItem()', () => {
    it('drops icon/categories/tags and gives pages an items array', () => {
      const out = navLinkToUpdateItem(NAV[1].links[0]);
      expect(out).not.toHaveProperty('icon');
      expect(out).not.toHaveProperty('categories');
      expect(out).not.toHaveProperty('tags');
      expect(out.items).toEqual([]);
    });
    it('passes external links through unchanged', () => {
      expect(navLinkToUpdateItem(NAV[0].links[1])).toEqual(NAV[0].links[1]);
    });
    it('converts folder children recursively', () => {
      const folder = { title: 'More', isFolder: true, icon: 'folder', links: [NAV[0].links[0]] };
      const out = navLinkToUpdateItem(folder) as any;
      expect(out.items).toHaveLength(1);
      expect(out.items[0]).not.toHaveProperty('icon');
    });
  });

  describe('updateNavLink()', () => {
    it('rewrites one link and sends the whole navigation back in editor shape', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(structuredClone(NAV)))   // GET /api/navigation
        .mockResolvedValueOnce(jsonResponse({ templateId: 'tmpl-1' })) // resolveTemplateId
        .mockResolvedValueOnce(jsonResponse({}));                       // POST UpdateNavigation
      const r = await client.updateNavLink('Event Inquiries', 'https://mercerstreet.tripleseat.com/party_request/48940');
      expect(r).toMatchObject({ success: true, navigation: 'mainNav', previousUrl: '#' });

      const [url, opts] = mockFetch.mock.calls[2];
      expect(url).toContain('/api/widget/UpdateNavigation');
      const sent = JSON.parse(opts.body);
      expect(sent.fieldName).toBe('mainNav');
      expect(sent.templateId).toBe('tmpl-1');
      expect(sent.navigation.items.map((i: any) => i.title)).toEqual(['Menu', 'Event Inquiries', 'Gallery']);
      expect(sent.navigation.items[1].externalLink).toEqual({ title: 'Event Inquiries', url: 'https://mercerstreet.tripleseat.com/party_request/48940', newWindow: true });
      expect(sent.navigation.items[0]).not.toHaveProperty('icon');
      expect(sent.navigation.items[0].items).toEqual([]);
    });

    it('can change newWindow', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(structuredClone(NAV))).mockResolvedValueOnce(jsonResponse({ templateId: 't' })).mockResolvedValueOnce(jsonResponse({}));
      await client.updateNavLink('Event Inquiries', 'https://example.com/', false);
      const sent = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(sent.navigation.items[1].externalLink.newWindow).toBe(false);
    });

    it('refuses page links and unknown titles without writing', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(structuredClone(NAV)));
      const r = await client.updateNavLink('Menu', 'https://example.com/');
      expect(r.success).toBe(false);
      expect(r.error).toContain('No custom link');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('updatePageMetadata() seoHidden', () => {
    it('sets seoData.seoHidden', async () => {
      const settings = { id: 'c-press', title: 'Press', seoData: { seoTitle: 'Press', seoHidden: false } };
      mockFetch.mockResolvedValueOnce(jsonResponse(settings)).mockResolvedValueOnce(jsonResponse(settings));
      const r = await client.updatePageMetadata('c-press', { seoHidden: true });
      expect(r.success).toBe(true);
      expect(r.updatedFields).toEqual(['seoHidden']);
      const sent = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(sent.collectionData.seoData).toEqual({ seoTitle: 'Press', seoHidden: true });
    });
  });
});
