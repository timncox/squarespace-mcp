import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent, PageSectionsData, BlockLayout } from '../content-save.js';

// ── Mock session file ─────────────────────────────────────────────────────

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

// ── Sample data helpers ──────────────────────────────────────────────────

const STUB_LAYOUT: BlockLayout = {
  mobile: { start: { x: 1, y: 0 }, end: { x: 8, y: 17 } },
  desktop: { start: { x: 4, y: 0 }, end: { x: 20, y: 6 } },
};

function makeGalleryBlock(blockId: string, collectionId: string, settings?: Record<string, unknown>): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 8,
        value: {
          'aspect-ratio': 'square',
          aspectRatio: null,
          'auto-crop': true,
          blockAnimation: 'none',
          collectionId,
          design: 'grid',
          lightbox: false,
          padding: 20,
          'show-meta': true,
          'show-meta-basic': true,
          'show-meta-only-title': false,
          'show-meta-only-description': false,
          'square-thumbs': true,
          'thumbnails-per-row': 4,
          vSize: null,
          transientGalleryId: collectionId,
          methodOption: 'transient',
          existingGallery: null,
          newWindow: false,
          ...settings,
        },
      },
    },
  };
}

function makeTextBlock(blockId: string, html: string): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 2,
        value: { engine: 'wysiwyg', source: html, html, textAttributes: [] },
      },
    },
  };
}

function makeSectionsWithGallery(galleryBlock: GridContent, ...extraBlocks: GridContent[]): PageSection[] {
  return [
    {
      id: 'section-1',
      sectionName: 'FLUID_ENGINE',
      fluidEngineContext: {
        id: 'ctx-1',
        gridContents: [galleryBlock, ...extraBlocks],
        gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
      },
    },
  ];
}

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return { sections, updatedOn: Date.now() };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Gallery', () => {
  let client: ContentSaveClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  const PS_ID = 'ps-123';
  const COLL_ID = 'coll-456';
  const GALLERY_COLL_ID = 'gallery-coll-789';

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── findGalleryBlock ────────────────────────────────────────────────────

  describe('findGalleryBlock()', () => {
    it('finds a gallery block by collectionId', () => {
      const gallery = makeGalleryBlock('blk-1', GALLERY_COLL_ID);
      const sections = makeSectionsWithGallery(gallery);
      const result = client.findGalleryBlock(sections, GALLERY_COLL_ID);
      expect(result).not.toBeNull();
      expect(result!.galleryCollectionId).toBe(GALLERY_COLL_ID);
      expect(result!.blockIndex).toBe(0);
    });

    it('finds a gallery block by block ID prefix', () => {
      const gallery = makeGalleryBlock('abc123def456', GALLERY_COLL_ID);
      const sections = makeSectionsWithGallery(gallery);
      const result = client.findGalleryBlock(sections, 'abc123');
      expect(result).not.toBeNull();
      expect(result!.galleryCollectionId).toBe(GALLERY_COLL_ID);
    });

    it('finds first gallery block when no searchText', () => {
      const gallery = makeGalleryBlock('blk-1', GALLERY_COLL_ID);
      const text = makeTextBlock('blk-2', '<p>Hello</p>');
      const sections = makeSectionsWithGallery(gallery, text);
      const result = client.findGalleryBlock(sections);
      expect(result).not.toBeNull();
      expect(result!.galleryCollectionId).toBe(GALLERY_COLL_ID);
    });

    it('returns null when no gallery blocks exist', () => {
      const text = makeTextBlock('blk-1', '<p>Hello</p>');
      const sections: PageSection[] = [{
        id: 'section-1',
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: {
          id: 'ctx-1',
          gridContents: [text],
          gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
        },
      }];
      const result = client.findGalleryBlock(sections, GALLERY_COLL_ID);
      expect(result).toBeNull();
    });

    it('returns null when searchText does not match', () => {
      const gallery = makeGalleryBlock('blk-1', GALLERY_COLL_ID);
      const sections = makeSectionsWithGallery(gallery);
      const result = client.findGalleryBlock(sections, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  // ── updateGallerySettings ──────────────────────────────────────────────

  describe('updateGallerySettings()', () => {
    it('updates thumbnails-per-row', async () => {
      const gallery = makeGalleryBlock('blk-1', GALLERY_COLL_ID);
      const sections = makeSectionsWithGallery(gallery);
      const data = makePageSectionsData(sections);

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => data }) // GET
        .mockResolvedValueOnce({ ok: true, text: async () => '{}' }); // PUT

      const result = await client.updateGallerySettings(PS_ID, COLL_ID, GALLERY_COLL_ID, {
        'thumbnails-per-row': 6,
      });

      expect(result.success).toBe(true);
      expect(result.updatedFields).toContain('thumbnails-per-row');

      // Verify PUT was called with updated sections
      const putCall = mockFetch.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const updatedBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(updatedBlock.content.value.value['thumbnails-per-row']).toBe(6);
    });

    it('updates aspect-ratio', async () => {
      const gallery = makeGalleryBlock('blk-1', GALLERY_COLL_ID);
      const sections = makeSectionsWithGallery(gallery);
      const data = makePageSectionsData(sections);

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => data })
        .mockResolvedValueOnce({ ok: true, text: async () => '{}' });

      const result = await client.updateGallerySettings(PS_ID, COLL_ID, GALLERY_COLL_ID, {
        'aspect-ratio': 'anamorphic-widescreen',
      });

      expect(result.success).toBe(true);
      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const block = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(block.content.value.value['aspect-ratio']).toBe('anamorphic-widescreen');
    });

    it('updates multiple settings at once', async () => {
      const gallery = makeGalleryBlock('blk-1', GALLERY_COLL_ID);
      const sections = makeSectionsWithGallery(gallery);
      const data = makePageSectionsData(sections);

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => data })
        .mockResolvedValueOnce({ ok: true, text: async () => '{}' });

      const result = await client.updateGallerySettings(PS_ID, COLL_ID, GALLERY_COLL_ID, {
        'thumbnails-per-row': 3,
        'aspect-ratio': 'standard',
        padding: 10,
        lightbox: true,
      });

      expect(result.success).toBe(true);
      expect(result.updatedFields).toEqual(['thumbnails-per-row', 'aspect-ratio', 'padding', 'lightbox']);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const val = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
      expect(val['thumbnails-per-row']).toBe(3);
      expect(val['aspect-ratio']).toBe('standard');
      expect(val.padding).toBe(10);
      expect(val.lightbox).toBe(true);
    });

    it('falls back to first gallery block when searchText does not match', async () => {
      const gallery = makeGalleryBlock('blk-1', GALLERY_COLL_ID);
      const sections = makeSectionsWithGallery(gallery);
      const data = makePageSectionsData(sections);

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => data })
        .mockResolvedValueOnce({ ok: true, text: async () => '{}' });

      const result = await client.updateGallerySettings(PS_ID, COLL_ID, 'nonexistent', {
        'thumbnails-per-row': 5,
      });

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('blk-1');
    });

    it('fails when no gallery blocks exist', async () => {
      const text = makeTextBlock('blk-1', '<p>Hello</p>');
      const sections: PageSection[] = [{
        id: 'section-1',
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: { id: 'ctx-1', gridContents: [text], gridSettings: {} },
      }];
      const data = makePageSectionsData(sections);

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => data });

      const result = await client.updateGallerySettings(PS_ID, COLL_ID, 'anything', {
        'thumbnails-per-row': 6,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No gallery block found');
    });

    it('preserves existing gallery settings not in the update', async () => {
      const gallery = makeGalleryBlock('blk-1', GALLERY_COLL_ID, {
        'thumbnails-per-row': 4,
        design: 'grid',
        padding: 20,
      });
      const sections = makeSectionsWithGallery(gallery);
      const data = makePageSectionsData(sections);

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => data })
        .mockResolvedValueOnce({ ok: true, text: async () => '{}' });

      await client.updateGallerySettings(PS_ID, COLL_ID, GALLERY_COLL_ID, {
        'thumbnails-per-row': 6,
      });

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const val = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
      expect(val['thumbnails-per-row']).toBe(6);
      expect(val.design).toBe('grid');
      expect(val.padding).toBe(20);
    });
  });

  // ── addBlankSection ────────────────────────────────────────────────────

  describe('addBlankSection()', () => {
    function mockGetPut(sections: PageSection[]) {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sections, updatedOn: Date.now() }) }) // GET
        .mockResolvedValueOnce({ ok: true, text: async () => '{}' }); // PUT
    }

    it('appends a blank FLUID_ENGINE section via GET+PUT', async () => {
      const sections = [{ id: 'sec-0', sectionName: 'FLUID_ENGINE', fluidEngineContext: { id: 'ctx-0', gridContents: [], gridSettings: { breakpointSettings: { desktop: { columns: 24 } } } } }];
      mockGetPut(sections);

      const result = await client.addBlankSection(PS_ID, COLL_ID);

      expect(result.success).toBe(true);
      expect(result.sectionId).toMatch(/^[0-9a-f]{24}$/);

      // Only 2 fetch calls: GET + PUT (no POST to add endpoint)
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');
      expect(mockFetch.mock.calls[1][1].method).toBe('PUT');
    });

    it('PUT body contains original sections plus new blank section', async () => {
      const sections = [{ id: 'sec-0', sectionName: 'FLUID_ENGINE', fluidEngineContext: { id: 'ctx-0', gridContents: [], gridSettings: { breakpointSettings: { desktop: { columns: 24 } } } } }];
      mockGetPut(sections);

      await client.addBlankSection(PS_ID, COLL_ID);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(putBody.sections).toHaveLength(2);
      expect(putBody.sections[0].id).toBe('sec-0');
      const newSection = putBody.sections[1];
      expect(newSection.sectionName).toBe('FLUID_ENGINE');
      expect(newSection.fluidEngineContext.gridContents).toEqual([]);
      expect(newSection.fluidEngineContext.gridSettings.breakpointSettings.desktop.columns).toBe(24);
    });

    it('new section has unique generated IDs', async () => {
      const sections: PageSection[] = [];
      mockGetPut(sections);

      const result = await client.addBlankSection(PS_ID, COLL_ID);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const newSection = putBody.sections[0];
      expect(newSection.id).toMatch(/^[0-9a-f]{24}$/);
      expect(newSection.fluidEngineContext.id).toMatch(/^[0-9a-f]{24}$/);
      expect(newSection.id).not.toBe(newSection.fluidEngineContext.id);
      expect(result.sectionId).toBe(newSection.id);
    });

    it('returns error when GET fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Server error' });

      const result = await client.addBlankSection(PS_ID, COLL_ID);
      expect(result.success).toBe(false);
    });

    it('returns error when PUT fails', async () => {
      const sections: PageSection[] = [];
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sections, updatedOn: Date.now() }) })
        .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad request' });

      const result = await client.addBlankSection(PS_ID, COLL_ID);
      expect(result.success).toBe(false);
    });
  });

  // ── copyTemplateSection ────────────────────────────────────────────────

  describe('copyTemplateSection()', () => {
    it('copies a template section with correct query params', async () => {
      const copyResult = { id: 'new-copied-section-id' };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => copyResult });

      const result = await client.copyTemplateSection('src-website-id', 'src-coll-id', 'src-section-id');

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('new-copied-section-id');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain('/api/content/copy/section');
      expect(url).toContain('sourceWebsiteId=src-website-id');
      expect(url).toContain('sourceCollectionId=src-coll-id');
      expect(url).toContain('sourceSectionId=src-section-id');
      expect(url).toContain('crumb=crumb-token-abc');
    });

    it('returns error on failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not found' });

      const result = await client.copyTemplateSection('src-w', 'src-c', 'src-s');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to copy template section');
    });

    it('returns section data from response', async () => {
      const sectionData = { id: 'new-id', sectionName: 'FLUID_ENGINE', styles: { sectionTheme: 'dark' } };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => sectionData });

      const result = await client.copyTemplateSection('sw', 'sc', 'ss');
      expect(result.sectionData).toEqual(sectionData);
    });
  });

  // ── getSectionCatalog ──────────────────────────────────────────────────

  describe('getSectionCatalog()', () => {
    it('parses category-keyed response', async () => {
      const catalogData = {
        'CONTACT': [
          { websiteId: 'w1', collectionId: 'c1', sectionId: 's1' },
          { websiteId: 'w1', collectionId: 'c1', sectionId: 's2' },
        ],
        'MENUS': [
          { websiteId: 'w1', collectionId: 'c2', sectionId: 's3' },
        ],
      };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => catalogData });

      const result = await client.getSectionCatalog();
      expect(result.success).toBe(true);
      expect(result.categories).toEqual(['CONTACT', 'MENUS']);
      expect(result.sections).toHaveLength(3);
      expect(result.catalog!['CONTACT']).toHaveLength(2);
      expect(result.catalog!['MENUS']).toHaveLength(1);
    });

    it('flattens all entries into sections array', async () => {
      const catalogData = {
        'A': [{ websiteId: 'w1', collectionId: 'c1', sectionId: 's1' }],
        'B': [{ websiteId: 'w1', collectionId: 'c2', sectionId: 's2' }],
        'C': [{ websiteId: 'w1', collectionId: 'c3', sectionId: 's3' }],
      };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => catalogData });

      const result = await client.getSectionCatalog();
      expect(result.sections).toHaveLength(3);
      expect(result.sections![0].sectionId).toBe('s1');
      expect(result.sections![2].sectionId).toBe('s3');
    });

    it('returns error on failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error' });

      const result = await client.getSectionCatalog();
      expect(result.success).toBe(false);
    });
  });

  // ── getGalleryItems ────────────────────────────────────────────────────

  describe('getGalleryItems()', () => {
    it('parses paginated response with results array', async () => {
      const response = {
        results: [
          { id: 'item-1', title: 'Photo 1' },
          { id: 'item-2', title: 'Photo 2' },
        ],
        hasPreviousPage: false,
        hasNextPage: false,
      };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

      const result = await client.getGalleryItems(GALLERY_COLL_ID);
      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(false);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain(`/api/content-collections/${GALLERY_COLL_ID}/content-items`);
      expect(url).toContain('crumb=');
    });

    it('reports hasMore when hasNextPage is true', async () => {
      const response = {
        results: [{ id: 'item-1' }],
        hasPreviousPage: false,
        hasNextPage: true,
      };
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => response });

      const result = await client.getGalleryItems(GALLERY_COLL_ID);
      expect(result.success).toBe(true);
      expect(result.hasMore).toBe(true);
    });

    it('handles direct array response', async () => {
      const items = [{ id: 'item-1' }, { id: 'item-2' }];
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => items });

      const result = await client.getGalleryItems(GALLERY_COLL_ID);
      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
    });

    it('returns error on failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

      const result = await client.getGalleryItems(GALLERY_COLL_ID);
      expect(result.success).toBe(false);
    });
  });

  // ── getGalleryItemCount ────────────────────────────────────────────────

  describe('getGalleryItemCount()', () => {
    it('fetches gallery item count', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => 5 });

      const result = await client.getGalleryItemCount(GALLERY_COLL_ID);
      expect(result.success).toBe(true);
      expect(result.count).toBe(5);
    });

    it('handles wrapped response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ count: 3 }) });

      const result = await client.getGalleryItemCount(GALLERY_COLL_ID);
      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
    });
  });

  // ── addGalleryImage ────────────────────────────────────────────────────

  describe('addGalleryImage()', () => {
    it('adds an image to a gallery collection', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'new-item-id' }) });

      const result = await client.addGalleryImage(GALLERY_COLL_ID, 'asset-123');
      expect(result.success).toBe(true);
      expect(result.itemId).toBe('new-item-id');

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain(`/api/galleries/${GALLERY_COLL_ID}/images`);
      expect(url).toContain('crumb=');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.assetId).toBe('asset-123');
    });

    it('includes metadata when provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await client.addGalleryImage(GALLERY_COLL_ID, 'asset-123', {
        title: 'My Photo',
        description: 'A nice photo',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.title).toBe('My Photo');
      expect(body.description).toBe('A nice photo');
    });

    it('returns error on failure', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Bad request' });

      const result = await client.addGalleryImage(GALLERY_COLL_ID, 'asset-123');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to add gallery image');
    });
  });

  // ── uploadImageToSite ──────────────────────────────────────────────────

  describe('uploadImageToSite()', () => {
    it('uploads an image and returns asset info', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'job-123' }) }) // POST upload
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'COMPLETED', assetId: 'asset-456', contentItemId: 'item-789' }) }); // GET job

      const result = await client.uploadImageToSite('https://example.com/photo.jpg');
      expect(result.success).toBe(true);
      expect(result.assetId).toBe('asset-456');
      expect(result.contentItemId).toBe('item-789');
    });

    it('returns error when upload fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error' });

      const result = await client.uploadImageToSite('https://example.com/photo.jpg');
      expect(result.success).toBe(false);
    });

    it('returns error when job fails', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'job-123' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'FAILED' }) });

      const result = await client.uploadImageToSite('https://example.com/photo.jpg');
      expect(result.success).toBe(false);
      expect(result.error).toContain('failed');
    });
  });

  // ── removeGalleryImage ──────────────────────────────────────────────────

  describe('removeGalleryImage()', () => {
    it('deletes an image and returns success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
      });

      const result = await client.removeGalleryImage(GALLERY_COLL_ID, 'item-abc');
      expect(result.success).toBe(true);
      expect(result.itemId).toBe('item-abc');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/content-items/item-abc');
      expect(opts.method).toBe('DELETE');
    });

    it('returns error on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

      const result = await client.removeGalleryImage(GALLERY_COLL_ID, 'nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('404');
    });
  });
});
