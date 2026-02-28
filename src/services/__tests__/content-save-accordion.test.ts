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

function makeAccordionBlock(
  blockId: string,
  items: Array<{ title: string; description: string }>,
): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 8 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 8 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 69,
        value: {
          accordionItems: items,
          isExpandedFirstItem: false,
          shouldAllowMultipleOpenItems: false,
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

describe('ContentSaveClient — addAccordionBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds accordion with items', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const items = [
      { title: 'FAQ 1', description: 'Answer to FAQ 1' },
      { title: 'FAQ 2', description: 'Answer to FAQ 2' },
    ];

    const result = await client.addAccordionBlock('psid-1', 'cid-1', 0, items);

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);

    // Verify the PUT body has correct type and items
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(69);
    expect(gridContents[0].content.value.value.accordionItems).toHaveLength(2);
    expect(gridContents[0].content.value.value.accordionItems[0].title).toBe('FAQ 1');

    fetchSpy.mockRestore();
  });

  it('uses full width by default: 24 cols wide', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const items = [{ title: 'Q1', description: 'A1' }];
    await client.addAccordionBlock('psid-1', 'cid-1', 0, items);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Full width (24 cols): x: 1 to 25
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(25);
    // 1 item → rowHeight = max(4, 1*2) = 4
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(4);

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addAccordionBlock('psid-1', 'cid-1', 5, [
      { title: 'Q', description: 'A' },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('isExpandedFirstItem option is passed through', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const items = [{ title: 'Q1', description: 'A1' }];
    await client.addAccordionBlock('psid-1', 'cid-1', 0, items, { isExpandedFirstItem: true });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

    expect(blockValue.isExpandedFirstItem).toBe(true);

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — updateAccordionBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully updates accordion items', async () => {
    const originalItems = [
      { title: 'Old FAQ 1', description: 'Old Answer 1' },
    ];
    const sections = makeSections(
      makeAccordionBlock('accordion-1', originalItems),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const newItems = [
      { title: 'New FAQ 1', description: 'New Answer 1' },
      { title: 'New FAQ 2', description: 'New Answer 2' },
    ];

    const result = await client.updateAccordionBlock('psid-1', 'cid-1', 'Old FAQ 1', {
      items: newItems,
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('accordion-1');

    // Verify the PUT body has the updated items
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.accordionItems).toHaveLength(2);
    expect(blockValue.accordionItems[0].title).toBe('New FAQ 1');

    fetchSpy.mockRestore();
  });

  it('returns error when block not found', async () => {
    const sections = makeSections(
      makeTextBlock('text-1', '<p>Some text</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateAccordionBlock('psid-1', 'cid-1', 'Nonexistent FAQ', {
      items: [{ title: 'Q', description: 'A' }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No block found');

    fetchSpy.mockRestore();
  });
});
