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

// ── Mock fs module ────────────────────────────────────────────────────────

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })), // 1 hour old
}));

// ── Sample data helpers ──────────────────────────────────────────────────

const STUB_LAYOUT: BlockLayout = {
  mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 } },
  desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 3 } },
};

function makeTextBlock(blockId: string, html: string): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 2,
        value: {
          engine: 'wysiwyg',
          source: html,
          html,
          textAttributes: [],
        },
      },
    },
  };
}

function makeBlockWithLayout(
  blockId: string,
  html: string,
  desktopStart: { x: number; y: number },
  desktopEnd: { x: number; y: number },
): GridContent {
  return {
    layout: {
      desktop: { start: { ...desktopStart }, end: { ...desktopEnd } },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 } },
    },
    content: {
      value: {
        id: blockId,
        type: 2,
        value: {
          engine: 'wysiwyg',
          source: html,
          html,
          textAttributes: [],
        },
      },
    },
  };
}

function makeSections(...blocks: GridContent[]): PageSection[] {
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

function makeSectionsMultiple(...sectionBlocks: GridContent[][]): PageSection[] {
  return sectionBlocks.map((blocks, i) => ({
    id: `section-${i + 1}`,
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
  }));
}

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return {
    id: 'page-sections-id-1',
    websiteId: 'website-id-1',
    collectionId: 'collection-id-1',
    sections,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ContentSaveClient — addTextBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── generateBlockId ──────────────────────────────────────────────────

  describe('generateBlockId', () => {
    it('returns a 20-character hex string', () => {
      const id = ContentSaveClient.generateBlockId();
      expect(id).toHaveLength(20);
    });

    it('each call produces a unique ID', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(ContentSaveClient.generateBlockId());
      }
      expect(ids.size).toBe(100);
    });

    it('only contains hex characters (0-9, a-f)', () => {
      for (let i = 0; i < 20; i++) {
        const id = ContentSaveClient.generateBlockId();
        expect(id).toMatch(/^[0-9a-f]{20}$/);
      }
    });
  });

  // ── addTextBlock ────────────────────────────────────────────────────

  describe('addTextBlock', () => {
    it('successfully adds a block to an empty section', async () => {
      const sections = makeSections(); // no blocks
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
        .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

      const result = await client.addTextBlock(
        'psid-1', 'cid-1', 0, '<p>Hello World</p>',
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBeDefined();
      expect(result.blockId).toHaveLength(20);
      expect(result.sectionId).toBe('section-1');
      expect(result.sectionIndex).toBe(0);

      // Verify the PUT body contains the new block
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
      expect(gridContents).toHaveLength(1);
      expect(gridContents[0].content.value.type).toBe(2);
      expect(gridContents[0].content.value.value.html).toBe('<p>Hello World</p>');

      fetchSpy.mockRestore();
    });

    it('adds a block below existing blocks (Y position stacking)', async () => {
      const existingBlocks = [
        makeBlockWithLayout('b1', '<p>First</p>', { x: 1, y: 0 }, { x: 25, y: 3 }),
        makeBlockWithLayout('b2', '<p>Second</p>', { x: 1, y: 3 }, { x: 25, y: 6 }),
      ];
      const sections = makeSections(...existingBlocks);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.addTextBlock(
        'psid-1', 'cid-1', 0, '<p>Third block</p>',
      );

      expect(result.success).toBe(true);

      // Verify the new block starts at y=6 (below existing blocks whose max endY is 6)
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
      expect(gridContents).toHaveLength(3); // 2 existing + 1 new
      const newBlock = gridContents[2];
      expect(newBlock.layout.desktop.start.y).toBe(8); // 6 + 2 gap rows
      expect(newBlock.layout.desktop.end.y).toBe(11); // 8 + 3 row height

      fetchSpy.mockRestore();
    });

    it('wraps plain text in Squarespace paragraph format', async () => {
      const sections = makeSections();
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock(
        'psid-1', 'cid-1', 0, 'Plain text content',
      );

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blockHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;
      expect(blockHtml).toBe('<p class="" style="white-space:pre-wrap;">Plain text content</p>');

      fetchSpy.mockRestore();
    });

    it('passes through raw HTML unchanged', async () => {
      const sections = makeSections();
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock(
        'psid-1', 'cid-1', 0, '<h2>Custom HTML heading</h2>',
      );

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blockHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;
      expect(blockHtml).toBe('<h2>Custom HTML heading</h2>');

      fetchSpy.mockRestore();
    });

    it('returns error for negative section index', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Text</p>'));
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.addTextBlock(
        'psid-1', 'cid-1', -1, '<p>New</p>',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');

      fetchSpy.mockRestore();
    });

    it('returns error for section index too large', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Text</p>'));
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.addTextBlock(
        'psid-1', 'cid-1', 5, '<p>New</p>',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');
      expect(result.error).toContain('0-0');

      fetchSpy.mockRestore();
    });

    it('returns error for section without fluidEngineContext', async () => {
      const sections: PageSection[] = [
        { id: 'section-no-fluid', sectionName: 'GALLERY' },
      ];
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.addTextBlock(
        'psid-1', 'cid-1', 0, '<p>New</p>',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('no fluidEngineContext');
      expect(result.error).toContain('not a Fluid Engine section');

      fetchSpy.mockRestore();
    });

    it('creates correct GridContent structure (type=2, engine=wysiwyg, mobile+desktop layout)', async () => {
      const sections = makeSections();
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock(
        'psid-1', 'cid-1', 0, '<p>Test</p>',
      );

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

      // Block type
      expect(newBlock.content.value.type).toBe(2);
      expect(newBlock.content.value.value.engine).toBe('wysiwyg');
      expect(newBlock.content.value.value.textAttributes).toEqual([]);
      expect(newBlock.content.value.value.source).toBe('<p>Test</p>');
      expect(newBlock.content.value.value.html).toBe('<p>Test</p>');

      // Block ID
      expect(newBlock.content.value.id).toHaveLength(20);
      expect(newBlock.content.value.id).toMatch(/^[0-9a-f]{20}$/);

      // Desktop layout
      expect(newBlock.layout.desktop).toBeDefined();
      expect(newBlock.layout.desktop.start).toEqual({ x: 1, y: 0 });
      expect(newBlock.layout.desktop.visible).toBe(true);

      // Mobile layout
      expect(newBlock.layout.mobile).toBeDefined();
      expect(newBlock.layout.mobile.start).toEqual({ x: 1, y: 0 });
      expect(newBlock.layout.mobile.end).toEqual({ x: 9, y: 3 });
      expect(newBlock.layout.mobile.visible).toBe(true);

      fetchSpy.mockRestore();
    });

    it('default layout is full-width (x: 1 to maxColumns+1)', async () => {
      const sections = makeSections(); // gridSettings has desktop columns = 24
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock(
        'psid-1', 'cid-1', 0, '<p>Full width</p>',
      );

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

      // Full width: startX=1, endX=25 (24 columns + 1 since end is exclusive)
      expect(newBlock.layout.desktop.start.x).toBe(1);
      expect(newBlock.layout.desktop.end.x).toBe(25);

      fetchSpy.mockRestore();
    });

    it('respects custom column layout', async () => {
      const sections = makeSections();
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock(
        'psid-1', 'cid-1', 0, '<p>Half width</p>', { columns: 12 },
      );

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

      expect(newBlock.layout.desktop.start.x).toBe(1);
      expect(newBlock.layout.desktop.end.x).toBe(13); // 1 + 12

      fetchSpy.mockRestore();
    });

    it('handles fetch errors gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await client.addTextBlock(
        'psid-1', 'cid-1', 0, '<p>New</p>',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');

      fetchSpy.mockRestore();
    });

    it('returns error when PUT save fails', async () => {
      const sections = makeSections();
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

      const result = await client.addTextBlock(
        'psid-1', 'cid-1', 0, '<p>New</p>',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('403');

      fetchSpy.mockRestore();
    });

    it('first block has no gap (gapRows defaults to 0)', async () => {
      const sections = makeSections(); // empty — no existing blocks
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock('psid-1', 'cid-1', 0, '<p>First block</p>');

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(newBlock.layout.desktop.start.y).toBe(0); // no gap for first block
      expect(newBlock.layout.desktop.end.y).toBe(3);   // default 3 rows

      fetchSpy.mockRestore();
    });

    it('non-first block gets 2-row gap by default', async () => {
      const existingBlocks = [
        makeBlockWithLayout('b1', '<p>Existing</p>', { x: 1, y: 0 }, { x: 25, y: 4 }),
      ];
      const sections = makeSections(...existingBlocks);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock('psid-1', 'cid-1', 0, '<p>Second</p>');

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
      expect(newBlock.layout.desktop.start.y).toBe(6); // 4 + 2 gap
      expect(newBlock.layout.desktop.end.y).toBe(9);   // 6 + 3 rows

      fetchSpy.mockRestore();
    });

    it('respects custom gapRows', async () => {
      const existingBlocks = [
        makeBlockWithLayout('b1', '<p>Existing</p>', { x: 1, y: 0 }, { x: 25, y: 3 }),
      ];
      const sections = makeSections(...existingBlocks);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock('psid-1', 'cid-1', 0, '<p>Custom gap</p>', { gapRows: 5 });

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
      expect(newBlock.layout.desktop.start.y).toBe(8); // 3 + 5 gap
      expect(newBlock.layout.desktop.end.y).toBe(11);  // 8 + 3 default height

      fetchSpy.mockRestore();
    });

    it('respects custom rowHeight', async () => {
      const sections = makeSections();
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock('psid-1', 'cid-1', 0, '<p>Tall block</p>', { rowHeight: 6 });

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(newBlock.layout.desktop.start.y).toBe(0);
      expect(newBlock.layout.desktop.end.y).toBe(6); // 0 + 6 row height

      fetchSpy.mockRestore();
    });

    it('explicit gapRows=0 overrides default gap for non-first block', async () => {
      const existingBlocks = [
        makeBlockWithLayout('b1', '<p>Existing</p>', { x: 1, y: 0 }, { x: 25, y: 3 }),
      ];
      const sections = makeSections(...existingBlocks);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock('psid-1', 'cid-1', 0, '<p>Tight</p>', { gapRows: 0 });

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
      expect(newBlock.layout.desktop.start.y).toBe(3); // 3 + 0 gap (no gap)
      expect(newBlock.layout.desktop.end.y).toBe(6);   // 3 + 3 height

      fetchSpy.mockRestore();
    });

    it('applies gapRows and rowHeight to mobile layout too', async () => {
      const block = makeBlockWithLayout('b1', '<p>Existing</p>', { x: 1, y: 0 }, { x: 25, y: 4 });
      // Also set mobile layout
      block.layout!.mobile = { start: { x: 1, y: 0 }, end: { x: 9, y: 5 } };
      const existingBlocks = [block];
      const sections = makeSections(...existingBlocks);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.addTextBlock('psid-1', 'cid-1', 0, '<p>Mobile test</p>', { rowHeight: 4, gapRows: 1 });

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
      // Mobile: maxMobileY=5, gap=1, height=4
      expect(newBlock.layout.mobile.start.y).toBe(6);  // 5 + 1 gap
      expect(newBlock.layout.mobile.end.y).toBe(10);    // 6 + 4 height

      fetchSpy.mockRestore();
    });

    it('adds to correct section when multiple sections exist', async () => {
      const sections = makeSectionsMultiple(
        [makeTextBlock('b1', '<p>Section 0</p>')],
        [makeTextBlock('b2', '<p>Section 1</p>')],
      );
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.addTextBlock(
        'psid-1', 'cid-1', 1, '<p>New in section 1</p>',
      );

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('section-2');
      expect(result.sectionIndex).toBe(1);

      // Verify block was added to section 1 (index 1), not section 0
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      expect(putBody.sections[0].fluidEngineContext.gridContents).toHaveLength(1); // section 0 unchanged
      expect(putBody.sections[1].fluidEngineContext.gridContents).toHaveLength(2); // section 1 has new block

      fetchSpy.mockRestore();
    });
  });
});

// ── fillLastTextBlockInSection Tests ──────────────────────────────────────

function makeImageBlock(blockId: string, title?: string): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 1337,
        value: {
          title: title ?? '',
        },
      },
    },
  };
}

describe('ContentSaveClient — fillLastTextBlockInSection', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills the last short text block in a section', async () => {
    const sections = makeSections(
      makeTextBlock('b1', '<p>Long content that is definitely more than fifty characters in total length here ok</p>'),
      makeTextBlock('b2', '<p>Placeholder</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, '<p>Actual content</p>',
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('b2');

    // Verify PUT body has the updated content
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const filledBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
    expect(filledBlock.content.value.value.html).toBe('<p>Actual content</p>');

    fetchSpy.mockRestore();
  });

  it('selects last text block when multiple short text blocks exist', async () => {
    const sections = makeSections(
      makeTextBlock('b1', '<p>Short A</p>'),
      makeTextBlock('b2', '<p>Short B</p>'),
      makeTextBlock('b3', '<p>Short C</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, '<p>Filled</p>',
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('b3'); // last one

    fetchSpy.mockRestore();
  });

  it('fills empty text block (empty string content)', async () => {
    const sections = makeSections(
      makeTextBlock('b1', ''),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, '<p>New content</p>',
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('b1');

    fetchSpy.mockRestore();
  });

  it('wraps plain text in Squarespace paragraph format', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p></p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, 'Plain text',
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.html).toBe(
      '<p class="" style="white-space:pre-wrap;">Plain text</p>',
    );

    fetchSpy.mockRestore();
  });

  it('returns error when no matching block found (all text blocks have long content)', async () => {
    const sections = makeSections(
      makeTextBlock('b1', '<p>This is a long text block with lots of content that exceeds fifty characters easily</p>'),
      makeTextBlock('b2', '<p>Another long text block that also has content exceeding the fifty character threshold value</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, '<p>New content</p>',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('text block(s)');
    expect(result.error).toContain('longer than 50');

    fetchSpy.mockRestore();
  });

  it('returns error when section has only image blocks', async () => {
    const sections: PageSection[] = [{
      id: 'section-1',
      sectionName: 'FLUID_ENGINE',
      fluidEngineContext: {
        gridContents: [
          makeImageBlock('img1', 'Photo 1'),
          makeImageBlock('img2', 'Photo 2'),
        ],
        gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
      },
    }];
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, '<p>Content</p>',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('none are text blocks');
    expect(result.error).toContain('1337');

    fetchSpy.mockRestore();
  });

  it('returns error when section has no blocks', async () => {
    const sections = makeSections(); // empty gridContents
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, '<p>Content</p>',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no blocks');

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p>Hello</p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 5, '<p>Content</p>',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('returns error when section has no gridContents', async () => {
    const sections: PageSection[] = [
      { id: 'section-no-grid', sectionName: 'GALLERY' },
    ];
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, '<p>Content</p>',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no gridContents');

    fetchSpy.mockRestore();
  });

  it('handles fetch errors gracefully', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Network error'));

    const result = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, '<p>Content</p>',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');

    fetchSpy.mockRestore();
  });

  it('addTextBlock 500 then fillLastTextBlockInSection succeeds (fallback scenario)', async () => {
    // Simulate: addTextBlock fails with 500...
    const sections = makeSections(makeTextBlock('b1', '<p>Existing</p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // addTextBlock GET
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 })); // addTextBlock PUT fails

    const addResult = await client.addTextBlock('psid-1', 'cid-1', 0, '<p>New</p>');
    expect(addResult.success).toBe(false);
    expect(addResult.error).toContain('500');

    // ...then UI adds a block (server-generated ID), and fillLastTextBlockInSection fills it
    const sectionsAfterUI = makeSections(
      makeTextBlock('b1', '<p>Existing</p>'),
      makeTextBlock('a1b2c3d4e5f6a7b8c9d0', '<p></p>'), // placeholder from UI-added block
    );
    const dataAfterUI = makePageSectionsData(sectionsAfterUI);

    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify(dataAfterUI), { status: 200 })) // fill GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // fill PUT

    const fillResult = await client.fillLastTextBlockInSection(
      'psid-1', 'cid-1', 0, '<p>New content via fallback</p>',
    );

    expect(fillResult.success).toBe(true);
    expect(fillResult.blockId).toBe('a1b2c3d4e5f6a7b8c9d0');

    // Verify the PUT body has the correct content
    const [, putOptions] = fetchSpy.mock.calls[3] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const filledBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
    expect(filledBlock.content.value.value.html).toBe('<p>New content via fallback</p>');

    fetchSpy.mockRestore();
  });
});
