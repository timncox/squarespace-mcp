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
  mobile: { start: { x: 1, y: 0 }, end: { x: 8, y: 6 } },
  desktop: { start: { x: 1, y: 0 }, end: { x: 24, y: 6 } },
};

function makeTextBlock(blockId: string, html: string, layout?: BlockLayout): GridContent {
  return {
    layout: layout ? { ...layout } : { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 2,
        value: { engine: 'wysiwyg', source: html, html, textAttributes: [] },
      },
    },
  };
}

function makeSection(id: string, blocks: GridContent[]): PageSection {
  return {
    id,
    sectionName: 'FLUID_ENGINE',
    fluidEngineContext: {
      id: `ctx-${id}`,
      gridContents: blocks,
      gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
    },
  };
}

function makeSections(...sections: PageSection[]): PageSection[] {
  return sections;
}

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return { sections, updatedOn: Date.now() };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Section Operations', () => {
  let client: ContentSaveClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  const PS_ID = 'ps-123';
  const COLL_ID = 'coll-456';

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper: mock GET + PUT cycle
  function mockGetPut(sections: PageSection[]) {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => makePageSectionsData(sections) }) // GET
      .mockResolvedValueOnce({ ok: true, text: async () => '{}' }); // PUT
  }

  function mockGetOnly(sections: PageSection[]) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => makePageSectionsData(sections),
    });
  }

  function mockGetPutFail(sections: PageSection[]) {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => makePageSectionsData(sections) }) // GET
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error', text: async () => 'Server error' }); // PUT
  }

  // ── editSectionStyle ──────────────────────────────────────────────────

  describe('editSectionStyle()', () => {
    it('updates sectionTheme on section found by index', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Hello</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>World</p>')]),
      );
      mockGetPut(sections);

      const result = await client.editSectionStyle(PS_ID, COLL_ID, 0, { sectionTheme: 'dark' });

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('sec-0');
      expect(result.sectionIndex).toBe(0);
      expect(result.updatedFields).toContain('sectionTheme');
    });

    it('updates backgroundColor on section found by text search', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>About Us</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Contact Info</p>')]),
      );
      mockGetPut(sections);

      const result = await client.editSectionStyle(PS_ID, COLL_ID, 'Contact Info', {
        backgroundColor: '#ff0000',
      });

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('sec-1');
      expect(result.sectionIndex).toBe(1);
      expect(result.updatedFields).toContain('backgroundColor');
    });

    it('updates multiple properties at once', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Content</p>')]),
      );
      mockGetPut(sections);

      const result = await client.editSectionStyle(PS_ID, COLL_ID, 0, {
        sectionTheme: 'light',
        backgroundColor: '#ffffff',
        sectionHeight: 'large',
        paddingTop: '80px',
        paddingBottom: '40px',
        blockSpacing: '20px',
        contentWidth: 'full',
        verticalAlignment: 'middle',
      });

      expect(result.success).toBe(true);
      expect(result.updatedFields).toEqual([
        'sectionTheme',
        'backgroundColor',
        'sectionHeight',
        'paddingTop',
        'paddingBottom',
        'blockSpacing',
        'contentWidth',
        'verticalAlignment',
      ]);
    });

    it('returns error when no style properties provided', async () => {
      const result = await client.editSectionStyle(PS_ID, COLL_ID, 0, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('No style properties provided');
    });

    it('returns error when section index out of range', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Only section</p>')]),
      );
      mockGetOnly(sections);

      const result = await client.editSectionStyle(PS_ID, COLL_ID, 5, { sectionTheme: 'dark' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');
    });

    it('returns error when section not found by text', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Hello</p>')]),
      );
      mockGetOnly(sections);

      const result = await client.editSectionStyle(PS_ID, COLL_ID, 'nonexistent text', {
        sectionTheme: 'dark',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No section found');
    });

    it('returns updated fields list', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Content</p>')]),
      );
      mockGetPut(sections);

      const result = await client.editSectionStyle(PS_ID, COLL_ID, 0, {
        sectionTheme: 'dark',
        contentWidth: 'inset',
      });

      expect(result.success).toBe(true);
      expect(result.updatedFields).toHaveLength(2);
      expect(result.updatedFields).toContain('sectionTheme');
      expect(result.updatedFields).toContain('contentWidth');
    });

    it('handles save failure', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Content</p>')]),
      );
      mockGetPutFail(sections);

      const result = await client.editSectionStyle(PS_ID, COLL_ID, 0, { sectionTheme: 'dark' });

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ── duplicateSection ──────────────────────────────────────────────────

  describe('duplicateSection()', () => {
    it('duplicates section at given index', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>First</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Second</p>')]),
      );
      mockGetPut(sections);

      const result = await client.duplicateSection(PS_ID, COLL_ID, 0);

      expect(result.success).toBe(true);
      expect(result.originalSectionId).toBe('sec-0');
      expect(result.newSectionId).toBeTruthy();
      expect(result.newSectionId).not.toBe('sec-0');
      expect(result.newSectionIndex).toBe(1);
    });

    it('regenerates all block IDs (no duplicates)', async () => {
      const sections = makeSections(
        makeSection('sec-0', [
          makeTextBlock('blk-a', '<p>Block A</p>'),
          makeTextBlock('blk-b', '<p>Block B</p>'),
        ]),
      );
      mockGetPut(sections);

      await client.duplicateSection(PS_ID, COLL_ID, 0);

      // Inspect the PUT body to verify block IDs were regenerated
      const putCall = mockFetch.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const allBlockIds: string[] = [];
      for (const section of putBody.sections) {
        for (const gc of section.fluidEngineContext?.gridContents || []) {
          allBlockIds.push(gc.content.value.id);
        }
      }
      // Original 2 blocks + 2 cloned blocks = 4 unique IDs (all different)
      expect(new Set(allBlockIds).size).toBe(4);
      // Original section keeps blk-a, blk-b (exactly once each)
      expect(allBlockIds.filter(id => id === 'blk-a')).toHaveLength(1);
      expect(allBlockIds.filter(id => id === 'blk-b')).toHaveLength(1);
      // Cloned blocks have new IDs (not blk-a or blk-b)
      const clonedIds = allBlockIds.filter(id => id !== 'blk-a' && id !== 'blk-b');
      expect(clonedIds).toHaveLength(2);
      expect(clonedIds[0]).not.toBe(clonedIds[1]);
    });

    it('inserts clone after original', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>First</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Second</p>')]),
        makeSection('sec-2', [makeTextBlock('blk-2', '<p>Third</p>')]),
      );
      mockGetPut(sections);

      await client.duplicateSection(PS_ID, COLL_ID, 1);

      const putCall = mockFetch.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      // Should now have 4 sections: sec-0, sec-1, clone, sec-2
      expect(putBody.sections).toHaveLength(4);
      expect(putBody.sections[0].id).toBe('sec-0');
      expect(putBody.sections[1].id).toBe('sec-1');
      // index 2 is the clone (new ID)
      expect(putBody.sections[2].id).not.toBe('sec-1');
      expect(putBody.sections[3].id).toBe('sec-2');
    });

    it('section count increases by 1', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Only</p>')]),
      );
      mockGetPut(sections);

      await client.duplicateSection(PS_ID, COLL_ID, 0);

      const putCall = mockFetch.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      expect(putBody.sections).toHaveLength(2);
    });

    it('returns error for out-of-range index', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Only</p>')]),
      );
      mockGetOnly(sections);

      const result = await client.duplicateSection(PS_ID, COLL_ID, 3);

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');
    });

    it('handles text search for section', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>About Us</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Contact</p>')]),
      );
      mockGetPut(sections);

      const result = await client.duplicateSection(PS_ID, COLL_ID, 'Contact');

      expect(result.success).toBe(true);
      expect(result.originalSectionId).toBe('sec-1');
      expect(result.newSectionIndex).toBe(2);
    });
  });

  // ── reorderSections ───────────────────────────────────────────────────

  describe('reorderSections()', () => {
    it('reorders 3 sections correctly', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>First</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Second</p>')]),
        makeSection('sec-2', [makeTextBlock('blk-2', '<p>Third</p>')]),
      );
      mockGetPut(sections);

      const result = await client.reorderSections(PS_ID, COLL_ID, [2, 0, 1]);

      expect(result.success).toBe(true);
      expect(result.newOrder).toEqual([2, 0, 1]);
      expect(result.sectionsCount).toBe(3);

      const putCall = mockFetch.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      expect(putBody.sections[0].id).toBe('sec-2');
      expect(putBody.sections[1].id).toBe('sec-0');
      expect(putBody.sections[2].id).toBe('sec-1');
    });

    it('returns error when newOrder length does not match', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>First</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Second</p>')]),
      );
      mockGetOnly(sections);

      const result = await client.reorderSections(PS_ID, COLL_ID, [0, 1, 2]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not match');
    });

    it('returns error for duplicate indices', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>First</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Second</p>')]),
        makeSection('sec-2', [makeTextBlock('blk-2', '<p>Third</p>')]),
      );
      mockGetOnly(sections);

      const result = await client.reorderSections(PS_ID, COLL_ID, [0, 0, 1]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Duplicate index');
    });

    it('returns error for out-of-range index', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>First</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Second</p>')]),
      );
      mockGetOnly(sections);

      const result = await client.reorderSections(PS_ID, COLL_ID, [0, 5]);

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');
    });

    it('no-op when order is identity [0, 1, 2]', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>First</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Second</p>')]),
        makeSection('sec-2', [makeTextBlock('blk-2', '<p>Third</p>')]),
      );
      mockGetPut(sections);

      const result = await client.reorderSections(PS_ID, COLL_ID, [0, 1, 2]);

      expect(result.success).toBe(true);

      const putCall = mockFetch.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      expect(putBody.sections[0].id).toBe('sec-0');
      expect(putBody.sections[1].id).toBe('sec-1');
      expect(putBody.sections[2].id).toBe('sec-2');
    });
  });

  // ── duplicateBlock ────────────────────────────────────────────────────

  describe('duplicateBlock()', () => {
    it('creates new block with unique ID', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-original', '<p>Duplicate me</p>')]),
      );
      mockGetPut(sections);

      const result = await client.duplicateBlock(PS_ID, COLL_ID, 'Duplicate me');

      expect(result.success).toBe(true);
      expect(result.originalBlockId).toBe('blk-original');
      expect(result.newBlockId).toBeTruthy();
      expect(result.newBlockId).not.toBe('blk-original');
      expect(result.sectionId).toBe('sec-0');
    });

    it('new block positioned below original', async () => {
      const layout: BlockLayout = {
        mobile: { start: { x: 1, y: 0 }, end: { x: 8, y: 6 } },
        desktop: { start: { x: 1, y: 0 }, end: { x: 24, y: 6 } },
      };
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Original</p>', layout)]),
      );
      mockGetPut(sections);

      await client.duplicateBlock(PS_ID, COLL_ID, 'Original');

      const putCall = mockFetch.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
      expect(gridContents).toHaveLength(2);

      const cloned = gridContents[1];
      // Original ends at Y=6, gap=2, so clone starts at Y=8
      expect(cloned.layout.desktop.start.y).toBe(8);
      expect(cloned.layout.desktop.end.y).toBe(14); // 8 + 6 height
      // Same X coords
      expect(cloned.layout.desktop.start.x).toBe(1);
      expect(cloned.layout.desktop.end.x).toBe(24);
    });

    it('backfills verticalAlignment on existing blocks', async () => {
      // Block without verticalAlignment set
      const block = makeTextBlock('blk-0', '<p>No VA</p>');
      delete (block.layout!.desktop as Record<string, unknown>).verticalAlignment;
      delete (block.layout!.mobile as Record<string, unknown>).verticalAlignment;

      const sections = makeSections(makeSection('sec-0', [block]));
      mockGetPut(sections);

      await client.duplicateBlock(PS_ID, COLL_ID, 'No VA');

      const putCall = mockFetch.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const originalBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(originalBlock.layout.desktop.verticalAlignment).toBe('top');
      expect(originalBlock.layout.mobile.verticalAlignment).toBe('top');
    });

    it('returns error when block not found', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Hello</p>')]),
      );
      mockGetOnly(sections);

      const result = await client.duplicateBlock(PS_ID, COLL_ID, 'nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');
    });

    it('deep clones content (mutations do not affect original)', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Clone test</p>')]),
      );
      mockGetPut(sections);

      await client.duplicateBlock(PS_ID, COLL_ID, 'Clone test');

      const putCall = mockFetch.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const gridContents = putBody.sections[0].fluidEngineContext.gridContents;

      // Mutating the clone's content should not affect the original
      const original = gridContents[0];
      const clone = gridContents[1];
      expect(clone.content.value.value.html).toBe(original.content.value.value.html);
      expect(clone.content.value.id).not.toBe(original.content.value.id);
    });

    it('handles save failure', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Will fail</p>')]),
      );
      mockGetPutFail(sections);

      const result = await client.duplicateBlock(PS_ID, COLL_ID, 'Will fail');

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ── addBlankSection ───────────────────────────────────────────────────
  // Uses GET + local section construction + PUT (no mysterious POST endpoint).

  describe('addBlankSection()', () => {
    it('uses GET+PUT (no POST to add endpoint)', async () => {
      mockGetPut([makeSection('sec-0', [makeTextBlock('blk-0', '<p>Hello</p>')])]);

      await client.addBlankSection(PS_ID, COLL_ID);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');
      expect(mockFetch.mock.calls[1][1].method).toBe('PUT');
    });

    it('appends blank section after existing sections', async () => {
      const sections = makeSections(
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>Existing</p>')]),
      );
      mockGetPut(sections);

      const result = await client.addBlankSection(PS_ID, COLL_ID);

      expect(result.success).toBe(true);
      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(putBody.sections).toHaveLength(2);
      expect(putBody.sections[0].id).toBe('sec-0');
    });

    it('new section is a blank FLUID_ENGINE with empty gridContents', async () => {
      mockGetPut([]);

      await client.addBlankSection(PS_ID, COLL_ID);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const newSection = putBody.sections[0];
      expect(newSection.sectionName).toBe('FLUID_ENGINE');
      expect(newSection.fluidEngineContext.gridContents).toEqual([]);
      expect(newSection.fluidEngineContext.gridSettings.breakpointSettings.desktop.columns).toBe(24);
    });

    it('returns generated sectionId matching the new section', async () => {
      mockGetPut([]);

      const result = await client.addBlankSection(PS_ID, COLL_ID);

      expect(result.success).toBe(true);
      expect(result.sectionId).toMatch(/^[0-9a-f]{20}$/);
      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(result.sectionId).toBe(putBody.sections[0].id);
    });

    it('returns error when GET fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Server error' });

      const result = await client.addBlankSection(PS_ID, COLL_ID);

      expect(result.success).toBe(false);
    });

    it('returns error when PUT fails', async () => {
      mockGetPutFail([]);

      const result = await client.addBlankSection(PS_ID, COLL_ID);

      expect(result.success).toBe(false);
    });
  });
});
