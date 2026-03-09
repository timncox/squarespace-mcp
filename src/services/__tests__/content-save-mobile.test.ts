import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent, PageSectionsData, BlockLayout, GridSettings } from '../content-save.js';

// ── Mock session file ────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLayout(
  mobile: { sx: number; sy: number; ex: number; ey: number; visible?: boolean },
  desktop: { sx: number; sy: number; ex: number; ey: number } = { sx: 1, sy: 0, ex: 13, ey: 3 },
): BlockLayout {
  return {
    mobile: {
      start: { x: mobile.sx, y: mobile.sy },
      end: { x: mobile.ex, y: mobile.ey },
      visible: mobile.visible ?? true,
    },
    desktop: {
      start: { x: desktop.sx, y: desktop.sy },
      end: { x: desktop.ex, y: desktop.ey },
    },
  };
}

function makeTextBlock(blockId: string, html: string, layout?: BlockLayout): GridContent {
  return {
    layout: layout ?? makeLayout({ sx: 1, sy: 0, ex: 5, ey: 3 }),
    content: {
      value: {
        id: blockId,
        type: 2,
        value: { engine: 'wysiwyg', source: html, html, textAttributes: [] },
      },
    },
  };
}

function makeSections(
  ...blocks: GridContent[]
): PageSection[] {
  return [
    {
      id: 'section-1',
      sectionName: 'FLUID_ENGINE',
      fluidEngineContext: {
        gridContents: blocks,
        gridSettings: {
          breakpointSettings: {
            desktop: { columns: 24 },
            mobile: { columns: 8 },
          },
        },
      },
    },
  ];
}

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return {
    id: 'ps-id-1',
    websiteId: 'web-1',
    collectionId: 'coll-1',
    sections,
  };
}

function mockFetchGetThenPut(data: PageSectionsData) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ContentSaveClient — mobile layout methods', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
    (client as any)._checkForConflict = async () => null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── hideOnMobile ───────────────────────────────────────────────────────────

  describe('hideOnMobile', () => {
    it('sets layout.mobile.visible = false', async () => {
      const block = makeTextBlock('block-1', '<p>Hello world</p>');
      const data = makePageSectionsData(makeSections(block));
      const fetchSpy = mockFetchGetThenPut(data);

      const result = await client.hideOnMobile('ps-1', 'coll-1', 'Hello world');

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('block-1');
      expect(result.visible).toBe(false);

      // Verify the PUT body contains visible: false
      const putBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
      const mobileLayout = putBody.sections[0].fluidEngineContext.gridContents[0].layout.mobile;
      expect(mobileLayout.visible).toBe(false);

      fetchSpy.mockRestore();
    });

    it('returns error when block not found', async () => {
      const block = makeTextBlock('block-1', '<p>Other text</p>');
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.hideOnMobile('ps-1', 'coll-1', 'nonexistent text');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');
    });

    it('returns error when block has no mobile layout', async () => {
      const block: GridContent = {
        layout: { mobile: undefined as unknown as BlockLayout['mobile'], desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 3 } } },
        content: { value: { id: 'block-no-mobile', type: 2, value: { html: '<p>No mobile</p>', source: '<p>No mobile</p>' } } },
      };
      const data = makePageSectionsData(makeSections(block));
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.hideOnMobile('ps-1', 'coll-1', 'No mobile');

      expect(result.success).toBe(false);
      expect(result.error).toContain('no mobile layout');
    });
  });

  // ── showOnMobile ───────────────────────────────────────────────────────────

  describe('showOnMobile', () => {
    it('sets layout.mobile.visible = true', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Hidden block</p>',
        makeLayout({ sx: 1, sy: 0, ex: 5, ey: 3, visible: false }),
      );
      const data = makePageSectionsData(makeSections(block));
      const fetchSpy = mockFetchGetThenPut(data);

      const result = await client.showOnMobile('ps-1', 'coll-1', 'Hidden block');

      expect(result.success).toBe(true);
      expect(result.visible).toBe(true);

      const putBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
      const mobileLayout = putBody.sections[0].fluidEngineContext.gridContents[0].layout.mobile;
      expect(mobileLayout.visible).toBe(true);

      fetchSpy.mockRestore();
    });

    it('returns error when block not found', async () => {
      const data = makePageSectionsData(makeSections(makeTextBlock('b1', '<p>text</p>')));
      mockFetchGetThenPut(data);

      const result = await client.showOnMobile('ps-1', 'coll-1', 'does not exist');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');
    });
  });

  // ── setMobileLayout ────────────────────────────────────────────────────────

  describe('setMobileLayout', () => {
    it('updates start and end coordinates', async () => {
      const block = makeTextBlock('block-1', '<p>Positioned block</p>');
      const data = makePageSectionsData(makeSections(block));
      const fetchSpy = mockFetchGetThenPut(data);

      const result = await client.setMobileLayout('ps-1', 'coll-1', 'Positioned block', {
        start: { x: 1, y: 5 },
        end: { x: 6, y: 8 },
      });

      expect(result.success).toBe(true);
      expect(result.newLayout?.start).toEqual({ x: 1, y: 5 });
      expect(result.newLayout?.end).toEqual({ x: 6, y: 8 });
      expect(result.clamped).toBe(false);

      const putBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
      const mobileLayout = putBody.sections[0].fluidEngineContext.gridContents[0].layout.mobile;
      expect(mobileLayout.start).toEqual({ x: 1, y: 5 });
      expect(mobileLayout.end).toEqual({ x: 6, y: 8 });

      fetchSpy.mockRestore();
    });

    it('updates only visible when only visible is provided', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Visibility test</p>',
        makeLayout({ sx: 2, sy: 1, ex: 6, ey: 4 }),
      );
      const data = makePageSectionsData(makeSections(block));
      const fetchSpy = mockFetchGetThenPut(data);

      const result = await client.setMobileLayout('ps-1', 'coll-1', 'Visibility test', {
        visible: false,
      });

      expect(result.success).toBe(true);
      expect(result.newLayout?.visible).toBe(false);
      // Coordinates should be unchanged
      expect(result.newLayout?.start).toEqual({ x: 2, y: 1 });
      expect(result.newLayout?.end).toEqual({ x: 6, y: 4 });

      fetchSpy.mockRestore();
    });

    it('clamps start.x < 1 by shifting block right', async () => {
      const block = makeTextBlock('block-1', '<p>Clamped block</p>');
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.setMobileLayout('ps-1', 'coll-1', 'Clamped block', {
        start: { x: -1, y: 0 },
        end: { x: 3, y: 3 },
      });

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newLayout?.start.x).toBe(1);
      expect(result.newLayout?.end.x).toBe(5); // shifted by 2
    });

    it('clamps end.x > mobileColumns+1 by shifting block left', async () => {
      const block = makeTextBlock('block-1', '<p>Right overflow</p>');
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      // end.x = 11 on an 8-col grid (max = 9)
      const result = await client.setMobileLayout('ps-1', 'coll-1', 'Right overflow', {
        start: { x: 7, y: 0 },
        end: { x: 11, y: 3 },
      });

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newLayout?.end.x).toBe(9); // mobileColumns + 1
    });

    it('returns error when end.x <= start.x', async () => {
      const block = makeTextBlock('block-1', '<p>Invalid size</p>');
      const data = makePageSectionsData(makeSections(block));
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.setMobileLayout('ps-1', 'coll-1', 'Invalid size', {
        start: { x: 5, y: 0 },
        end: { x: 3, y: 3 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('end.x must be greater than start.x');
    });

    it('returns error when block not found', async () => {
      const data = makePageSectionsData(makeSections(makeTextBlock('b1', '<p>text</p>')));
      mockFetchGetThenPut(data);

      const result = await client.setMobileLayout('ps-1', 'coll-1', 'nonexistent', {
        start: { x: 1, y: 0 },
        end: { x: 5, y: 3 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');
    });
  });

  // ── moveBlockMobile ────────────────────────────────────────────────────────

  describe('moveBlockMobile', () => {
    it('moves block right by its own width (default step)', async () => {
      // Block is at x:1-5 (width=4), y:0-3
      const block = makeTextBlock(
        'block-1',
        '<p>Move me</p>',
        makeLayout({ sx: 1, sy: 0, ex: 5, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.moveBlockMobile('ps-1', 'coll-1', 'Move me', 'right');

      expect(result.success).toBe(true);
      expect(result.oldPosition?.mobile.start).toEqual({ x: 1, y: 0 });
      expect(result.newPosition?.mobile.start).toEqual({ x: 5, y: 0 }); // shifted by width=4
      expect(result.newPosition?.mobile.end).toEqual({ x: 9, y: 3 });
      expect(result.clamped).toBe(false);
    });

    it('moves block down by its own height (default step)', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Move down</p>',
        makeLayout({ sx: 1, sy: 0, ex: 5, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.moveBlockMobile('ps-1', 'coll-1', 'Move down', 'down');

      expect(result.success).toBe(true);
      expect(result.newPosition?.mobile.start.y).toBe(3); // shifted by height=3
      expect(result.newPosition?.mobile.end.y).toBe(6);
    });

    it('moves block up by explicit step', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Move up</p>',
        makeLayout({ sx: 1, sy: 5, ex: 5, ey: 8 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.moveBlockMobile('ps-1', 'coll-1', 'Move up', 'up', 2);

      expect(result.success).toBe(true);
      expect(result.newPosition?.mobile.start.y).toBe(3);
      expect(result.newPosition?.mobile.end.y).toBe(6);
    });

    it('clamps to left boundary (start.x >= 1)', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Left edge</p>',
        makeLayout({ sx: 1, sy: 0, ex: 4, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.moveBlockMobile('ps-1', 'coll-1', 'Left edge', 'left');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newPosition?.mobile.start.x).toBe(1);
    });

    it('clamps to right boundary (end.x <= mobileColumns+1)', async () => {
      // Block at x:6-9 (3 wide), moving right — would put end.x at 12, clamped to 9
      const block = makeTextBlock(
        'block-1',
        '<p>Right edge</p>',
        makeLayout({ sx: 6, sy: 0, ex: 9, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.moveBlockMobile('ps-1', 'coll-1', 'Right edge', 'right');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newPosition?.mobile.end.x).toBe(9); // mobileColumns + 1
    });

    it('clamps to top boundary (start.y >= 0)', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Top edge</p>',
        makeLayout({ sx: 1, sy: 0, ex: 5, ey: 2 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.moveBlockMobile('ps-1', 'coll-1', 'Top edge', 'up');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newPosition?.mobile.start.y).toBe(0);
    });

    it('returns error when block not found', async () => {
      const data = makePageSectionsData(makeSections(makeTextBlock('b1', '<p>text</p>')));
      mockFetchGetThenPut(data);

      const result = await client.moveBlockMobile('ps-1', 'coll-1', 'missing', 'right');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');
    });
  });

  // ── resizeBlockMobile ──────────────────────────────────────────────────────

  describe('resizeBlockMobile', () => {
    it('makes block wider by 2 columns', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Resize me</p>',
        makeLayout({ sx: 1, sy: 0, ex: 5, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'Resize me', 'larger');

      expect(result.success).toBe(true);
      expect(result.oldSize?.width).toBe(4);
      expect(result.newSize?.width).toBe(6);
      expect(result.clamped).toBe(false);
    });

    it('makes block narrower by 2 columns', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Shrink me</p>',
        makeLayout({ sx: 1, sy: 0, ex: 7, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'Shrink me', 'smaller');

      expect(result.success).toBe(true);
      expect(result.newSize?.width).toBe(4);
    });

    it('makes block full width (spans all 8 mobile columns)', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Full width</p>',
        makeLayout({ sx: 2, sy: 0, ex: 5, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      const fetchSpy = mockFetchGetThenPut(data);

      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'Full width', 'full');

      expect(result.success).toBe(true);
      expect(result.newSize?.mobile.start.x).toBe(1);
      expect(result.newSize?.mobile.end.x).toBe(9); // 8 + 1

      const putBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
      const mobileLayout = putBody.sections[0].fluidEngineContext.gridContents[0].layout.mobile;
      expect(mobileLayout.start.x).toBe(1);
      expect(mobileLayout.end.x).toBe(9);

      fetchSpy.mockRestore();
    });

    it('makes block taller by 1 row', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Taller block</p>',
        makeLayout({ sx: 1, sy: 0, ex: 5, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'Taller block', undefined, 'taller');

      expect(result.success).toBe(true);
      expect(result.oldSize?.height).toBe(3);
      expect(result.newSize?.height).toBe(4);
    });

    it('makes block shorter by 1 row', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Shorter block</p>',
        makeLayout({ sx: 1, sy: 0, ex: 5, ey: 4 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'Shorter block', undefined, 'shorter');

      expect(result.success).toBe(true);
      expect(result.newSize?.height).toBe(3);
    });

    it('enforces minimum width of 1 when shrinking too small', async () => {
      // Block is only 2 cols wide — shrinking by 2 would leave 0
      const block = makeTextBlock(
        'block-1',
        '<p>Min width</p>',
        makeLayout({ sx: 1, sy: 0, ex: 3, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'Min width', 'smaller');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newSize?.width).toBe(1);
    });

    it('enforces minimum height of 1 when shortening too small', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Min height</p>',
        makeLayout({ sx: 1, sy: 0, ex: 5, ey: 1 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'Min height', undefined, 'shorter');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newSize?.height).toBe(1);
    });

    it('clamps to right boundary when growing past 8 columns', async () => {
      // Block at x:6-8 (2 wide), growing larger adds 2 → end.x=10, clamped to 9
      const block = makeTextBlock(
        'block-1',
        '<p>Clamp right</p>',
        makeLayout({ sx: 6, sy: 0, ex: 8, ey: 3 }),
      );
      const data = makePageSectionsData(makeSections(block));
      mockFetchGetThenPut(data);

      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'Clamp right', 'larger');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newSize?.mobile.end.x).toBe(9);
    });

    it('returns error when neither width nor height provided', async () => {
      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'text');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Must provide at least width or height');
    });

    it('returns error when block not found', async () => {
      const data = makePageSectionsData(makeSections(makeTextBlock('b1', '<p>text</p>')));
      mockFetchGetThenPut(data);

      const result = await client.resizeBlockMobile('ps-1', 'coll-1', 'missing', 'larger');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');
    });
  });

  // ── Cross-method: desktop layout unaffected ─────────────────────────────────

  describe('desktop layout preserved', () => {
    it('hideOnMobile does not change desktop layout', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Desktop safe</p>',
        makeLayout({ sx: 1, sy: 0, ex: 5, ey: 3 }, { sx: 1, sy: 0, ex: 13, ey: 5 }),
      );
      const data = makePageSectionsData(makeSections(block));
      const fetchSpy = mockFetchGetThenPut(data);

      await client.hideOnMobile('ps-1', 'coll-1', 'Desktop safe');

      const putBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
      const desktopLayout = putBody.sections[0].fluidEngineContext.gridContents[0].layout.desktop;
      expect(desktopLayout.start).toEqual({ x: 1, y: 0 });
      expect(desktopLayout.end).toEqual({ x: 13, y: 5 });

      fetchSpy.mockRestore();
    });

    it('moveBlockMobile does not change desktop layout', async () => {
      const block = makeTextBlock(
        'block-1',
        '<p>Desktop intact</p>',
        makeLayout({ sx: 1, sy: 0, ex: 4, ey: 3 }, { sx: 3, sy: 2, ex: 15, ey: 7 }),
      );
      const data = makePageSectionsData(makeSections(block));
      const fetchSpy = mockFetchGetThenPut(data);

      await client.moveBlockMobile('ps-1', 'coll-1', 'Desktop intact', 'right');

      const putBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string);
      const desktopLayout = putBody.sections[0].fluidEngineContext.gridContents[0].layout.desktop;
      expect(desktopLayout.start).toEqual({ x: 3, y: 2 });
      expect(desktopLayout.end).toEqual({ x: 15, y: 7 });

      fetchSpy.mockRestore();
    });
  });
});
