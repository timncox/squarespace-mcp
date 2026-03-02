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

function makeButtonBlock(blockId: string, label: string, url: string): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 46,
        value: { label, url },
      },
    },
  };
}

/** Type 1337 (new format) button block — matches real Squarespace output */
function makeNewButtonBlock(
  blockId: string,
  buttonText: string,
  buttonLink: string,
  options?: { size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean },
): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 1337,
        value: {
          buttonText,
          buttonLink,
          newWindow: options?.newWindow ?? false,
          buttonAlignment: options?.alignment ?? 'center',
          buttonSize: options?.size ?? 'medium',
          ...(options?.style ? { buttonStyle: options.style } : {}),
          ...(options?.variant ? { buttonVariant: options.variant } : {}),
          containerStyles: { stretchedToFill: true },
          transforms: {
            rotation: { value: 0, unit: 'deg' },
            scale: { x: { value: 100, unit: '%' }, y: { value: 100, unit: '%' } },
            opacity: { value: 100, unit: '%' },
            offset: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } },
            origin: { x: { value: 50, unit: '%' }, y: { value: 50, unit: '%' } },
            skew: { x: { value: 0, unit: 'deg' }, y: { value: 0, unit: 'deg' } },
          },
          animations: [],
          breakpointOverrides: {},
        },
        containerStyles: { backgroundEnabled: false, stretchedToFill: false },
        definitionName: 'website.components.button',
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ContentSaveClient — addButtonBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds a button block to an empty section', async () => {
    const sections = makeSections(); // no blocks
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.addButtonBlock(
      'psid-1', 'cid-1', 0, 'Reserve Now', 'https://example.com/reserve',
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);
    expect(result.sectionId).toBe('section-1');
    expect(result.sectionIndex).toBe(0);

    // Verify the PUT body contains the new button block
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(46);
    expect(gridContents[0].content.value.value.label).toBe('Reserve Now');
    expect(gridContents[0].content.value.value.url).toBe('https://example.com/reserve');

    fetchSpy.mockRestore();
  });

  it('adds a button below existing blocks (Y position stacking)', async () => {
    const existingBlocks = [
      makeBlockWithLayout('b1', '<p>First</p>', { x: 1, y: 0 }, { x: 25, y: 3 }),
      makeBlockWithLayout('b2', '<p>Second</p>', { x: 1, y: 3 }, { x: 25, y: 6 }),
    ];
    const sections = makeSections(...existingBlocks);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addButtonBlock(
      'psid-1', 'cid-1', 0, 'Click Me', 'https://example.com',
    );

    expect(result.success).toBe(true);

    // Verify the new block starts at y=8 (maxY=6 + 2 gap rows), height=2
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(3);
    const newBlock = gridContents[2];
    expect(newBlock.layout.desktop.start.y).toBe(8); // 6 + 2 gap rows
    expect(newBlock.layout.desktop.end.y).toBe(10); // 8 + 2 row height (button default)

    fetchSpy.mockRestore();
  });

  it('uses default button width of 7 columns (x: 1–8)', async () => {
    const sections = makeSections(); // empty section
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addButtonBlock('psid-1', 'cid-1', 0, 'Button', 'https://example.com');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(8); // 1 + 7 columns

    fetchSpy.mockRestore();
  });

  it('uses default button height of 2 rows', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addButtonBlock('psid-1', 'cid-1', 0, 'Button', 'https://example.com');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(newBlock.layout.desktop.start.y).toBe(0); // first block, no gap
    expect(newBlock.layout.desktop.end.y).toBe(2); // 0 + 2 row height

    fetchSpy.mockRestore();
  });

  it('accepts custom layout params (startX, endX, startY, endY)', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addButtonBlock(
      'psid-1', 'cid-1', 0, 'Custom Btn', 'https://example.com',
      { startX: 5, endX: 15, startY: 10, endY: 13 },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(newBlock.layout.desktop.start.x).toBe(5);
    expect(newBlock.layout.desktop.end.x).toBe(15);
    expect(newBlock.layout.desktop.start.y).toBe(10);
    expect(newBlock.layout.desktop.end.y).toBe(13);

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

    await client.addButtonBlock(
      'psid-1', 'cid-1', 0, 'Spaced Btn', 'https://example.com',
      { gapRows: 5, rowHeight: 4 },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
    expect(newBlock.layout.desktop.start.y).toBe(9); // 4 + 5 gap
    expect(newBlock.layout.desktop.end.y).toBe(13); // 9 + 4 height

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

    await client.addButtonBlock('psid-1', 'cid-1', 0, 'Btn', 'https://example.com');

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

    await client.addButtonBlock(
      'psid-1', 'cid-1', 0, 'Wide Btn', 'https://example.com',
      { startX: -5, endX: 30 },
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

    const result = await client.addButtonBlock(
      'psid-1', 'cid-1', 5, 'Btn', 'https://example.com',
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

    const result = await client.addButtonBlock(
      'psid-1', 'cid-1', 0, 'Btn', 'https://example.com',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('no fluidEngineContext');

    fetchSpy.mockRestore();
  });

  it('creates correct GridContent structure (type=46, label, url, mobile+desktop layout)', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addButtonBlock(
      'psid-1', 'cid-1', 0, 'Book Now', 'https://example.com/book',
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Block type
    expect(newBlock.content.value.type).toBe(46);
    expect(newBlock.content.value.id).toHaveLength(20);

    // Content
    expect(newBlock.content.value.value.label).toBe('Book Now');
    expect(newBlock.content.value.value.url).toBe('https://example.com/book');

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

    await client.addButtonBlock('psid-1', 'cid-1', 0, 'Btn', 'https://example.com');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    // First block: gap=0, so starts at y=0
    expect(newBlock.layout.desktop.start.y).toBe(0);

    fetchSpy.mockRestore();
  });
});

// ── updateButtonBlock ─────────────────────────────────────────────────────

describe('ContentSaveClient — updateButtonBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates button label only', async () => {
    const sections = makeSections(makeButtonBlock('btn-1', 'Old Label', 'https://example.com'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Old Label', { newLabel: 'New Label' },
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('btn-1');
    expect(result.oldLabel).toBe('Old Label');
    expect(result.newLabel).toBe('New Label');
    expect(result.oldUrl).toBe('https://example.com');
    expect(result.newUrl).toBe('https://example.com'); // unchanged

    // Verify PUT body
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.label).toBe('New Label');
    expect(block.content.value.value.url).toBe('https://example.com');

    fetchSpy.mockRestore();
  });

  it('updates button URL only', async () => {
    const sections = makeSections(makeButtonBlock('btn-1', 'Click Here', 'https://old-url.com'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Click Here', { url: 'https://new-url.com' },
    );

    expect(result.success).toBe(true);
    expect(result.oldUrl).toBe('https://old-url.com');
    expect(result.newUrl).toBe('https://new-url.com');
    expect(result.oldLabel).toBe('Click Here');
    expect(result.newLabel).toBe('Click Here'); // unchanged

    fetchSpy.mockRestore();
  });

  it('updates both label and URL', async () => {
    const sections = makeSections(makeButtonBlock('btn-1', 'Old CTA', 'https://old.com'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Old CTA', { newLabel: 'New CTA', url: 'https://new.com' },
    );

    expect(result.success).toBe(true);
    expect(result.oldLabel).toBe('Old CTA');
    expect(result.newLabel).toBe('New CTA');
    expect(result.oldUrl).toBe('https://old.com');
    expect(result.newUrl).toBe('https://new.com');

    // Verify PUT body
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.label).toBe('New CTA');
    expect(block.content.value.value.url).toBe('https://new.com');

    fetchSpy.mockRestore();
  });

  it('returns error when button not found', async () => {
    const sections = makeSections(makeTextBlock('t1', '<p>Just text</p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Nonexistent Button', { newLabel: 'New' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No block found');

    fetchSpy.mockRestore();
  });

  it('returns error when block is not a button type', async () => {
    // findBlock will match on text content, but it's a text block (type 2), not button (type 46)
    const sections = makeSections(makeTextBlock('t1', '<p>Click Here</p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Click Here', { newLabel: 'New Label' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a button block');
    expect(result.error).toContain('type 2');

    fetchSpy.mockRestore();
  });

  it('returns error when no updates provided', async () => {
    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Some Button', {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Must provide at least');
  });

  it('finds button among multiple blocks in a section', async () => {
    const blocks = [
      makeTextBlock('t1', '<p>Some text above</p>'),
      makeButtonBlock('btn-1', 'Contact Us', 'https://example.com/contact'),
      makeTextBlock('t2', '<p>Some text below</p>'),
    ];
    const sections = makeSections(...blocks);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Contact Us', { url: 'https://example.com/new-contact' },
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('btn-1');
    expect(result.newUrl).toBe('https://example.com/new-contact');

    fetchSpy.mockRestore();
  });

  it('handles PUT failure gracefully', async () => {
    const sections = makeSections(makeButtonBlock('btn-1', 'Button', 'https://example.com'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Button', { newLabel: 'Updated' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    fetchSpy.mockRestore();
  });
});

// ── Button type detection helpers ──────────────────────────────────────────

describe('ContentSaveClient — button type helpers', () => {
  it('isButtonBlock returns true for type 46', () => {
    const block = makeButtonBlock('btn-1', 'Click', 'https://example.com');
    expect(ContentSaveClient.isButtonBlock(block.content.value)).toBe(true);
  });

  it('isButtonBlock returns true for type 1337 with button definitionName', () => {
    const block = makeNewButtonBlock('btn-2', 'Click', 'https://example.com');
    expect(ContentSaveClient.isButtonBlock(block.content.value)).toBe(true);
  });

  it('isButtonBlock returns false for type 1337 image block', () => {
    const imageBlock: GridContent = {
      layout: { ...STUB_LAYOUT },
      content: {
        value: {
          id: 'img-1',
          type: 1337,
          value: { title: 'Photo', assetUrl: 'https://images.squarespace-cdn.com/test.jpg' },
        },
      },
    };
    expect(ContentSaveClient.isButtonBlock(imageBlock.content.value)).toBe(false);
  });

  it('isButtonBlock returns false for text block', () => {
    const block = makeTextBlock('t1', '<p>Text</p>');
    expect(ContentSaveClient.isButtonBlock(block.content.value)).toBe(false);
  });

  it('getButtonFields normalizes type 46 fields', () => {
    const block = makeButtonBlock('btn-1', 'Book Now', 'https://example.com/book');
    const fields = ContentSaveClient.getButtonFields(block.content.value);
    expect(fields).toEqual({
      text: 'Book Now',
      url: 'https://example.com/book',
    });
  });

  it('getButtonFields normalizes type 1337 fields', () => {
    const block = makeNewButtonBlock('btn-2', 'Reserve', 'https://example.com/reserve', {
      size: 'large', style: 'secondary', alignment: 'left', variant: 'outline', newWindow: true,
    });
    const fields = ContentSaveClient.getButtonFields(block.content.value);
    expect(fields).toEqual({
      text: 'Reserve',
      url: 'https://example.com/reserve',
      size: 'large',
      style: 'secondary',
      alignment: 'left',
      variant: 'outline',
      newWindow: true,
    });
  });

  it('getButtonFields returns null for non-button', () => {
    const block = makeTextBlock('t1', '<p>Text</p>');
    expect(ContentSaveClient.getButtonFields(block.content.value)).toBeNull();
  });

  it('setButtonFields updates type 46 label and url', () => {
    const block = makeButtonBlock('btn-1', 'Old', 'https://old.com');
    const bv = block.content.value;
    ContentSaveClient.setButtonFields(bv, { text: 'New', url: 'https://new.com' });
    expect(bv.value.label).toBe('New');
    expect(bv.value.url).toBe('https://new.com');
  });

  it('setButtonFields updates type 1337 buttonText, buttonLink, and design fields', () => {
    const block = makeNewButtonBlock('btn-2', 'Old', 'https://old.com');
    const bv = block.content.value;
    ContentSaveClient.setButtonFields(bv, {
      text: 'New', url: 'https://new.com',
      size: 'small', style: 'tertiary', alignment: 'right', variant: 'outline',
    });
    expect(bv.value.buttonText).toBe('New');
    expect(bv.value.buttonLink).toBe('https://new.com');
    expect(bv.value.buttonSize).toBe('small');
    expect(bv.value.buttonStyle).toBe('tertiary');
    expect(bv.value.buttonAlignment).toBe('right');
    expect(bv.value.buttonVariant).toBe('outline');
  });

  it('setButtonFields skips undefined fields', () => {
    const block = makeNewButtonBlock('btn-2', 'Keep', 'https://keep.com', { size: 'large' });
    const bv = block.content.value;
    ContentSaveClient.setButtonFields(bv, { text: 'Changed' });
    expect(bv.value.buttonText).toBe('Changed');
    expect(bv.value.buttonLink).toBe('https://keep.com'); // unchanged
    expect(bv.value.buttonSize).toBe('large'); // unchanged
  });
});
