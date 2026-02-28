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

function makeVideoBlock(blockId: string, url: string, title?: string, description?: string): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 32,
        value: {
          url,
          title,
          description,
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

describe('ContentSaveClient — addDividerBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds a divider block to an empty section', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.addDividerBlock('psid-1', 'cid-1', 0);

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);
    expect(result.sectionId).toBe('section-1');
    expect(result.sectionIndex).toBe(0);

    // Verify the PUT body contains the new divider block
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(47);
    expect(gridContents[0].content.value.value).toEqual({});

    fetchSpy.mockRestore();
  });

  it('uses default layout: 24 cols wide, 1 row tall', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addDividerBlock('psid-1', 'cid-1', 0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Full width (24 cols): x: 1 to 25
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(25);
    // 1 row tall
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(1);
    // Visible with alignment
    expect(newBlock.layout.desktop.visible).toBe(true);
    expect(newBlock.layout.desktop.verticalAlignment).toBe('top');

    fetchSpy.mockRestore();
  });

  it('stacks below existing blocks with gap', async () => {
    const existingBlocks = [
      makeBlockWithLayout('b1', '<p>First</p>', { x: 1, y: 0 }, { x: 25, y: 3 }),
    ];
    const sections = makeSections(...existingBlocks);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addDividerBlock('psid-1', 'cid-1', 0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];

    // Stacks below: maxY=3, gapRows=2 (default for non-empty), so startY=5, endY=6 (1 row)
    expect(newBlock.layout.desktop.start.y).toBe(5);
    expect(newBlock.layout.desktop.end.y).toBe(6);

    fetchSpy.mockRestore();
  });

  it('respects custom layout overrides', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addDividerBlock('psid-1', 'cid-1', 0, {
      columns: 12,
      rowHeight: 2,
    });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(13); // 1 + 12
    expect(newBlock.layout.desktop.end.y).toBe(2); // rowHeight=2

    fetchSpy.mockRestore();
  });

  it('returns error for invalid section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addDividerBlock('psid-1', 'cid-1', 5);

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

    const result = await client.addDividerBlock('psid-1', 'cid-1', 0);

    expect(result.success).toBe(false);
    expect(result.error).toContain('no fluidEngineContext');

    fetchSpy.mockRestore();
  });

  it('backfills verticalAlignment and zIndex on existing blocks', async () => {
    // Block without verticalAlignment or zIndex
    const blockWithoutAlignment: GridContent = {
      layout: {
        desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 3 } },
        mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 } },
      },
      content: { value: { id: 'old-block', type: 2, value: { html: '<p>Old</p>' } } },
    };
    const sections = makeSections(blockWithoutAlignment);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addDividerBlock('psid-1', 'cid-1', 0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const existingBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Should have been backfilled
    expect(existingBlock.layout.desktop.verticalAlignment).toBe('top');
    expect(existingBlock.layout.desktop.zIndex).toBe(0);

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — addVideoBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds a video block to an empty section', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addVideoBlock('psid-1', 'cid-1', 0, 'https://www.youtube.com/watch?v=abc123');

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);
    expect(result.sectionId).toBe('section-1');
    expect(result.sectionIndex).toBe(0);

    // Verify the PUT body
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(32);
    expect(gridContents[0].content.value.value.url).toBe('https://www.youtube.com/watch?v=abc123');

    fetchSpy.mockRestore();
  });

  it('uses default layout: 24 cols wide, 8 rows tall', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addVideoBlock('psid-1', 'cid-1', 0, 'https://vimeo.com/123456');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Full width: x: 1 to 25
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(25);
    // 8 rows tall
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(8);
    expect(newBlock.layout.desktop.visible).toBe(true);

    fetchSpy.mockRestore();
  });

  it('includes title and description when provided', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addVideoBlock('psid-1', 'cid-1', 0, 'https://www.youtube.com/watch?v=xyz', {
      title: 'My Video',
      description: 'A great video about something',
    });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

    expect(blockValue.url).toBe('https://www.youtube.com/watch?v=xyz');
    expect(blockValue.title).toBe('My Video');
    expect(blockValue.description).toBe('A great video about something');

    fetchSpy.mockRestore();
  });

  it('omits title and description when not provided', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addVideoBlock('psid-1', 'cid-1', 0, 'https://vimeo.com/999');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

    expect(blockValue.url).toBe('https://vimeo.com/999');
    expect(blockValue.title).toBeUndefined();
    expect(blockValue.description).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('respects custom layout overrides', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addVideoBlock('psid-1', 'cid-1', 0, 'https://youtube.com/watch?v=test', {
      layout: { columns: 16, rowHeight: 12 },
    });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(17); // 1 + 16
    expect(newBlock.layout.desktop.end.y).toBe(12); // rowHeight=12

    fetchSpy.mockRestore();
  });

  it('stacks below existing blocks with gap', async () => {
    const existingBlocks = [
      makeBlockWithLayout('b1', '<p>Text above</p>', { x: 1, y: 0 }, { x: 25, y: 5 }),
    ];
    const sections = makeSections(...existingBlocks);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addVideoBlock('psid-1', 'cid-1', 0, 'https://youtube.com/watch?v=below');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];

    // maxY=5, gapRows=2 (default for non-empty), startY=7, endY=15 (8 rows)
    expect(newBlock.layout.desktop.start.y).toBe(7);
    expect(newBlock.layout.desktop.end.y).toBe(15);

    fetchSpy.mockRestore();
  });

  it('returns error for invalid section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addVideoBlock('psid-1', 'cid-1', 3, 'https://youtube.com/watch?v=test');

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

    const result = await client.addVideoBlock('psid-1', 'cid-1', 0, 'https://youtube.com/watch?v=test');

    expect(result.success).toBe(false);
    expect(result.error).toContain('no fluidEngineContext');

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — updateVideoBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully updates a video block URL', async () => {
    const sections = makeSections(
      makeVideoBlock('video-1', 'https://youtube.com/watch?v=old', 'Old Title', 'Old description'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.updateVideoBlock('psid-1', 'cid-1', 'Old Title', {
      url: 'https://youtube.com/watch?v=new',
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('video-1');
    expect(result.updatedFields).toEqual(['url']);

    // Verify the PUT body has the new URL
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.url).toBe('https://youtube.com/watch?v=new');
    // Other fields unchanged
    expect(blockValue.title).toBe('Old Title');
    expect(blockValue.description).toBe('Old description');

    fetchSpy.mockRestore();
  });

  it('successfully updates title and description', async () => {
    const sections = makeSections(
      makeVideoBlock('video-2', 'https://vimeo.com/123', 'Untitled', 'No desc'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateVideoBlock('psid-1', 'cid-1', 'Untitled', {
      title: 'New Title',
      description: 'New description',
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('video-2');
    expect(result.updatedFields).toEqual(['title', 'description']);

    fetchSpy.mockRestore();
  });

  it('updates all fields at once', async () => {
    const sections = makeSections(
      makeVideoBlock('video-3', 'https://youtube.com/watch?v=old', 'Old', 'Old desc'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateVideoBlock('psid-1', 'cid-1', 'Old', {
      url: 'https://vimeo.com/new',
      title: 'New Title',
      description: 'New description',
    });

    expect(result.success).toBe(true);
    expect(result.updatedFields).toEqual(['url', 'title', 'description']);

    fetchSpy.mockRestore();
  });

  it('returns error when no block matches searchText', async () => {
    const sections = makeSections(
      makeTextBlock('text-1', '<p>Some text</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateVideoBlock('psid-1', 'cid-1', 'Nonexistent Video', {
      url: 'https://youtube.com/new',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No block found matching');

    fetchSpy.mockRestore();
  });

  it('returns error when matched block is not a video block', async () => {
    const sections = makeSections(
      makeTextBlock('text-1', '<p>Some text with video keyword</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateVideoBlock('psid-1', 'cid-1', 'video keyword', {
      url: 'https://youtube.com/new',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a video block');
    expect(result.error).toContain('expected 32');

    fetchSpy.mockRestore();
  });

  it('returns error when no update fields provided', async () => {
    const result = await client.updateVideoBlock('psid-1', 'cid-1', 'Some Video', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Must provide at least');
  });

  it('handles partial update (only title)', async () => {
    const sections = makeSections(
      makeVideoBlock('video-4', 'https://youtube.com/watch?v=keep', 'Change Me', 'Keep this'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateVideoBlock('psid-1', 'cid-1', 'Change Me', {
      title: 'Updated Title',
    });

    expect(result.success).toBe(true);
    expect(result.updatedFields).toEqual(['title']);

    // Verify only title changed, url and description preserved
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.url).toBe('https://youtube.com/watch?v=keep');
    expect(blockValue.title).toBe('Updated Title');
    expect(blockValue.description).toBe('Keep this');

    fetchSpy.mockRestore();
  });

  it('handles PUT failure gracefully', async () => {
    const sections = makeSections(
      makeVideoBlock('video-5', 'https://youtube.com/watch?v=fail', 'Fail Test'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 })); // PUT fails

    const result = await client.updateVideoBlock('psid-1', 'cid-1', 'Fail Test', {
      url: 'https://youtube.com/watch?v=newurl',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    fetchSpy.mockRestore();
  });
});
