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

function makeMarqueeBlock(
  blockId: string,
  items: Array<{ text: string; linkTo?: string }>,
): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 4 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 4 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 70,
        value: {
          marqueeItems: items,
          animationDirection: 'left',
          animationSpeed: 1,
          textStyle: 'heading-1',
          pausedOnHover: false,
          fadeEdges: false,
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

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return {
    id: 'page-sections-id-1',
    websiteId: 'website-id-1',
    collectionId: 'collection-id-1',
    sections,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ContentSaveClient — addMarqueeBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds marquee with items', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const items = [
      { text: 'Hello World' },
      { text: 'Welcome to our site' },
      { text: 'Check out our services' },
    ];

    const result = await client.addMarqueeBlock('psid-1', 'cid-1', 0, items);

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);

    // Verify the PUT body has correct type and items
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(70);
    expect(gridContents[0].content.value.value.marqueeItems).toHaveLength(3);
    expect(gridContents[0].content.value.value.marqueeItems[0].text).toBe('Hello World');

    fetchSpy.mockRestore();
  });

  it('uses full width default: 24 cols wide, 4 rows tall', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addMarqueeBlock('psid-1', 'cid-1', 0, [{ text: 'Test item' }]);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Full width (24 cols): x: 1 to 25
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(25);
    // 4 rows tall
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(4);

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addMarqueeBlock('psid-1', 'cid-1', 5, [{ text: 'Test' }]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('animationDirection option is passed through', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addMarqueeBlock(
      'psid-1',
      'cid-1',
      0,
      [{ text: 'Scrolling text' }],
      { animationDirection: 'right' },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

    expect(blockValue.animationDirection).toBe('right');

    fetchSpy.mockRestore();
  });

  it('textStyle option is passed through', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addMarqueeBlock(
      'psid-1',
      'cid-1',
      0,
      [{ text: 'Scrolling text' }],
      { textStyle: 'heading-2' },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

    expect(blockValue.textStyle).toBe('heading-2');

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — updateMarqueeBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully updates marquee items', async () => {
    const sections = makeSections(
      makeMarqueeBlock('marquee-1', [{ text: 'Old text item' }]),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const newItems = [{ text: 'New text item 1' }, { text: 'New text item 2' }];

    const result = await client.updateMarqueeBlock('psid-1', 'cid-1', 'Old text item', {
      items: newItems,
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('marquee-1');

    // Verify the PUT body has the updated items
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.marqueeItems).toHaveLength(2);
    expect(blockValue.marqueeItems[0].text).toBe('New text item 1');

    fetchSpy.mockRestore();
  });

  it('returns error when block not found', async () => {
    const sections = makeSections(
      makeTextBlock('text-1', '<p>Some text</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateMarqueeBlock('psid-1', 'cid-1', 'Nonexistent marquee text', {
      items: [{ text: 'New item' }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No block found');

    fetchSpy.mockRestore();
  });
});
