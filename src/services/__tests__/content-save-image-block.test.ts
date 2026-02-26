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

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return {
    id: 'page-sections-id-1',
    websiteId: 'website-id-1',
    collectionId: 'collection-id-1',
    sections,
  };
}

// ── addImageBlock Tests ──────────────────────────────────────────────────

describe('ContentSaveClient — addImageBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds an image block to an empty section', async () => {
    const sections = makeSections(); // no blocks
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.addImageBlock(
      'psid-1', 'cid-1', 0, 'https://images.squarespace-cdn.com/content/v1/abc/def.jpg',
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);
    expect(result.sectionId).toBe('section-1');
    expect(result.sectionIndex).toBe(0);

    // Verify the PUT body contains the new image block
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(1337);
    expect(gridContents[0].content.value.value.assetUrl).toBe('https://images.squarespace-cdn.com/content/v1/abc/def.jpg');

    fetchSpy.mockRestore();
  });

  it('adds an image below existing blocks (Y position stacking)', async () => {
    const existingBlocks = [
      makeBlockWithLayout('b1', '<p>First</p>', { x: 1, y: 0 }, { x: 25, y: 3 }),
      makeBlockWithLayout('b2', '<p>Second</p>', { x: 1, y: 3 }, { x: 25, y: 6 }),
    ];
    const sections = makeSections(...existingBlocks);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addImageBlock(
      'psid-1', 'cid-1', 0, 'https://images.squarespace-cdn.com/content/v1/img.jpg',
    );

    expect(result.success).toBe(true);

    // Verify: new block starts at y=8 (maxY=6 + 2 gap rows), height=8
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(3);
    const newBlock = gridContents[2];
    expect(newBlock.layout.desktop.start.y).toBe(8); // 6 + 2 gap rows
    expect(newBlock.layout.desktop.end.y).toBe(16); // 8 + 8 row height (image default)

    fetchSpy.mockRestore();
  });

  it('uses default image width of 12 columns (x: 1–13)', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlock('psid-1', 'cid-1', 0, 'https://example.com/img.jpg');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(13); // 1 + 12 columns

    fetchSpy.mockRestore();
  });

  it('uses default image height of 8 rows', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlock('psid-1', 'cid-1', 0, 'https://example.com/img.jpg');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(newBlock.layout.desktop.start.y).toBe(0); // first block, no gap
    expect(newBlock.layout.desktop.end.y).toBe(8); // 0 + 8 row height

    fetchSpy.mockRestore();
  });

  it('accepts custom layout params (startX, endX, startY, endY)', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlock(
      'psid-1', 'cid-1', 0, 'https://example.com/img.jpg',
      { layout: { startX: 5, endX: 15, startY: 10, endY: 18 } },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(newBlock.layout.desktop.start.x).toBe(5);
    expect(newBlock.layout.desktop.end.x).toBe(15);
    expect(newBlock.layout.desktop.start.y).toBe(10);
    expect(newBlock.layout.desktop.end.y).toBe(18);

    fetchSpy.mockRestore();
  });

  it('accepts custom gapRows and rowHeight', async () => {
    const existingBlocks = [
      makeBlockWithLayout('b1', '<p>Existing</p>', { x: 1, y: 0 }, { x: 25, y: 4 }),
    ];
    const sections = makeSections(...existingBlocks);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlock(
      'psid-1', 'cid-1', 0, 'https://example.com/img.jpg',
      { layout: { gapRows: 5, rowHeight: 10 } },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
    expect(newBlock.layout.desktop.start.y).toBe(9); // 4 + 5 gap
    expect(newBlock.layout.desktop.end.y).toBe(19); // 9 + 10 height

    fetchSpy.mockRestore();
  });

  it('backfills verticalAlignment and zIndex on existing blocks', async () => {
    // Block without verticalAlignment or zIndex
    const bareBlock: GridContent = {
      layout: {
        desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 3 } },
        mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 } },
      },
      content: {
        value: {
          id: 'bare-block',
          type: 2,
          value: { html: '<p>Bare</p>' },
        },
      },
    };
    const sections = makeSections(bareBlock);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlock('psid-1', 'cid-1', 0, 'https://example.com/img.jpg');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const existingBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(existingBlock.layout.desktop.verticalAlignment).toBe('top');
    expect(existingBlock.layout.desktop.zIndex).toBe(0);
    expect(existingBlock.layout.mobile.verticalAlignment).toBe('top');
    expect(existingBlock.layout.mobile.zIndex).toBe(0);

    fetchSpy.mockRestore();
  });

  it('clamps explicit X coordinates to grid boundaries', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlock(
      'psid-1', 'cid-1', 0, 'https://example.com/img.jpg',
      { layout: { startX: -5, endX: 30 } },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(newBlock.layout.desktop.start.x).toBe(1); // clamped from -5
    expect(newBlock.layout.desktop.end.x).toBe(25); // clamped from 30 (24 cols → end=25)

    fetchSpy.mockRestore();
  });

  it('returns error for invalid section index', async () => {
    const sections = makeSections(makeTextBlock('b1', '<p>Text</p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addImageBlock(
      'psid-1', 'cid-1', 5, 'https://example.com/img.jpg',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('returns error for section without fluidEngineContext', async () => {
    const sections: PageSection[] = [
      { id: 'section-no-fluid', sectionName: 'GALLERY' },
    ];
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addImageBlock(
      'psid-1', 'cid-1', 0, 'https://example.com/img.jpg',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no fluidEngineContext');

    fetchSpy.mockRestore();
  });

  it('creates correct GridContent structure (type=1337, assetUrl, mobile+desktop layout)', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlock(
      'psid-1', 'cid-1', 0, 'https://images.squarespace-cdn.com/content/v1/photo.jpg',
      { altText: 'A photo', title: 'My Photo' },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Block type
    expect(newBlock.content.value.type).toBe(1337);
    expect(newBlock.content.value.id).toHaveLength(20);

    // Content
    expect(newBlock.content.value.value.assetUrl).toBe('https://images.squarespace-cdn.com/content/v1/photo.jpg');
    expect(newBlock.content.value.value.layout).toBe('caption-below');
    expect(newBlock.content.value.value.linkTo).toBe('');
    expect(newBlock.content.value.value.title).toBe('My Photo');
    expect(newBlock.content.value.altText).toBe('A photo');

    // Desktop layout
    expect(newBlock.layout.desktop.visible).toBe(true);
    expect(newBlock.layout.desktop.verticalAlignment).toBe('top');
    expect(typeof newBlock.layout.desktop.zIndex).toBe('number');

    // Mobile layout
    expect(newBlock.layout.mobile.visible).toBe(true);
    expect(newBlock.layout.mobile.verticalAlignment).toBe('top');

    fetchSpy.mockRestore();
  });

  it('sets 0 gap rows for first block in empty section', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlock('psid-1', 'cid-1', 0, 'https://example.com/img.jpg');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    // First block: gap=0, so starts at y=0
    expect(newBlock.layout.desktop.start.y).toBe(0);

    fetchSpy.mockRestore();
  });

  it('stores optional metadata fields (description, subtitle, linkTo)', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlock(
      'psid-1', 'cid-1', 0, 'https://example.com/img.jpg',
      {
        title: 'Sunset',
        description: 'A beautiful sunset',
        subtitle: 'By Tim',
        altText: 'Sunset over ocean',
        linkTo: 'https://example.com/gallery',
      },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    expect(newBlock.content.value.value.title).toBe('Sunset');
    expect(newBlock.content.value.value.description).toBe('A beautiful sunset');
    expect(newBlock.content.value.value.subtitle).toBe('By Tim');
    expect(newBlock.content.value.value.linkTo).toBe('https://example.com/gallery');
    expect(newBlock.content.value.altText).toBe('Sunset over ocean');

    fetchSpy.mockRestore();
  });

  it('handles PUT failure gracefully', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    const result = await client.addImageBlock(
      'psid-1', 'cid-1', 0, 'https://example.com/img.jpg',
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    fetchSpy.mockRestore();
  });
});

// ── addImageBlockBatch Tests ────────────────────────────────────────────

describe('ContentSaveClient — addImageBlockBatch', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds multiple images in a single GET+PUT cycle', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addImageBlockBatch('psid-1', 'cid-1', 0, [
      { assetUrl: 'https://example.com/img1.jpg' },
      { assetUrl: 'https://example.com/img2.jpg' },
      { assetUrl: 'https://example.com/img3.jpg' },
    ]);

    expect(result.success).toBe(true);
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks[0].assetUrl).toBe('https://example.com/img1.jpg');
    expect(result.blocks[1].assetUrl).toBe('https://example.com/img2.jpg');
    expect(result.blocks[2].assetUrl).toBe('https://example.com/img3.jpg');

    // Only 1 GET + 1 PUT
    expect(fetchSpy.mock.calls).toHaveLength(2);

    // All 3 blocks in the PUT body
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(3);

    fetchSpy.mockRestore();
  });

  it('stacks images vertically with correct gaps', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlockBatch('psid-1', 'cid-1', 0, [
      { assetUrl: 'https://example.com/img1.jpg' },
      { assetUrl: 'https://example.com/img2.jpg' },
    ]);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;

    // First image: y=0 (no gap for first block in empty section), height=8
    expect(gridContents[0].layout.desktop.start.y).toBe(0);
    expect(gridContents[0].layout.desktop.end.y).toBe(8);

    // Second image: y=10 (8 + 2 gap), height=8
    expect(gridContents[1].layout.desktop.start.y).toBe(10);
    expect(gridContents[1].layout.desktop.end.y).toBe(18);

    fetchSpy.mockRestore();
  });

  it('adds images after existing blocks', async () => {
    const existingBlocks = [
      makeBlockWithLayout('b1', '<p>Text</p>', { x: 1, y: 0 }, { x: 25, y: 5 }),
    ];
    const sections = makeSections(...existingBlocks);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlockBatch('psid-1', 'cid-1', 0, [
      { assetUrl: 'https://example.com/img1.jpg' },
    ]);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(2);

    // Image below existing block: y=7 (maxY=5 + 2 gap)
    const newBlock = gridContents[1];
    expect(newBlock.layout.desktop.start.y).toBe(7);
    expect(newBlock.layout.desktop.end.y).toBe(15); // 7 + 8

    fetchSpy.mockRestore();
  });

  it('each block gets unique ID and incrementing zIndex', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlockBatch('psid-1', 'cid-1', 0, [
      { assetUrl: 'https://example.com/img1.jpg' },
      { assetUrl: 'https://example.com/img2.jpg' },
    ]);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;

    // Different IDs
    expect(gridContents[0].content.value.id).not.toBe(gridContents[1].content.value.id);
    // Both 20 chars
    expect(gridContents[0].content.value.id).toHaveLength(20);
    expect(gridContents[1].content.value.id).toHaveLength(20);
    // Incrementing zIndex
    expect(gridContents[1].layout.desktop.zIndex).toBeGreaterThan(gridContents[0].layout.desktop.zIndex);

    fetchSpy.mockRestore();
  });

  it('supports per-image layout overrides', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlockBatch('psid-1', 'cid-1', 0, [
      { assetUrl: 'https://example.com/img1.jpg', layout: { startX: 1, endX: 13, startY: 0, endY: 10 } },
      { assetUrl: 'https://example.com/img2.jpg', layout: { startX: 13, endX: 25, startY: 0, endY: 10 } },
    ]);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;

    // Side-by-side layout
    expect(gridContents[0].layout.desktop.start.x).toBe(1);
    expect(gridContents[0].layout.desktop.end.x).toBe(13);
    expect(gridContents[1].layout.desktop.start.x).toBe(13);
    expect(gridContents[1].layout.desktop.end.x).toBe(25);
    // Both at same Y
    expect(gridContents[0].layout.desktop.start.y).toBe(0);
    expect(gridContents[1].layout.desktop.start.y).toBe(0);

    fetchSpy.mockRestore();
  });

  it('returns error for empty images array', async () => {
    const result = await client.addImageBlockBatch('psid-1', 'cid-1', 0, []);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No images provided');
    expect(result.blocks).toHaveLength(0);
  });

  it('returns error for invalid section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addImageBlockBatch('psid-1', 'cid-1', 5, [
      { assetUrl: 'https://example.com/img.jpg' },
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('supports altText and title per image', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addImageBlockBatch('psid-1', 'cid-1', 0, [
      { assetUrl: 'https://example.com/img1.jpg', altText: 'Photo 1', title: 'Sunset' },
      { assetUrl: 'https://example.com/img2.jpg', altText: 'Photo 2' },
    ]);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;

    expect(gridContents[0].content.value.altText).toBe('Photo 1');
    expect(gridContents[0].content.value.value.title).toBe('Sunset');
    expect(gridContents[1].content.value.altText).toBe('Photo 2');

    fetchSpy.mockRestore();
  });
});
