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

function makeQuoteBlock(blockId: string, quoteText: string, source?: string): GridContent {
  const value: Record<string, unknown> = {
    quote: quoteText,
    blockAnimation: 'site-default',
    vSize: null,
    hSize: null,
    schemaName: null,
    aspectRatio: null,
    floatDir: null,
  };
  if (source !== undefined) value.source = source;
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 31,
        value,
      },
    },
  };
}

function makeCodeBlock(blockId: string, html: string, mode?: string): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 1337,
        value: { wysiwyg: { engine: 'code', mode: mode ?? 'htmlmixed', isSource: false, source: html }, html },
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

describe('ContentSaveClient — addQuoteBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds a quote block to an empty section', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.addQuoteBlock(
      'psid-1', 'cid-1', 0, 'The only limit is your imagination.',
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
    expect(gridContents[0].content.value.type).toBe(31);
    expect(gridContents[0].content.value.value.quote).toBe('The only limit is your imagination.');

    fetchSpy.mockRestore();
  });

  it('adds a quote block with attribution', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addQuoteBlock(
      'psid-1', 'cid-1', 0, 'Be the change you wish to see.', 'Mahatma Gandhi',
    );

    expect(result.success).toBe(true);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.quote).toBe('Be the change you wish to see.');
    expect(block.content.value.value.source).toBe('Mahatma Gandhi');

    fetchSpy.mockRestore();
  });

  it('adds quote block without attribution (source field omitted)', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addQuoteBlock('psid-1', 'cid-1', 0, 'A simple quote.');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.quote).toBe('A simple quote.');
    expect(block.content.value.value.source).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it('stacks below existing blocks with gap', async () => {
    const existingBlocks = [
      makeBlockWithLayout('b1', '<p>Existing</p>', { x: 1, y: 0 }, { x: 25, y: 4 }),
    ];
    const sections = makeSections(...existingBlocks);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addQuoteBlock('psid-1', 'cid-1', 0, 'A quote below.');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
    expect(newBlock.layout.desktop.start.y).toBe(6); // 4 + 2 gap
    expect(newBlock.layout.desktop.end.y).toBe(9);   // 6 + 3 row height

    fetchSpy.mockRestore();
  });

  it('respects custom layout parameters', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addQuoteBlock('psid-1', 'cid-1', 0, 'Custom layout quote.', undefined, {
      columns: 12, rowHeight: 5, gapRows: 1,
    });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.layout.desktop.start.x).toBe(1);
    expect(block.layout.desktop.end.x).toBe(13); // 1 + 12
    expect(block.layout.desktop.end.y - block.layout.desktop.start.y).toBe(5); // rowHeight

    fetchSpy.mockRestore();
  });

  it('returns error for invalid section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addQuoteBlock('psid-1', 'cid-1', 5, 'Out of range.');
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

    const result = await client.addQuoteBlock('psid-1', 'cid-1', 0, 'No fluid engine.');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no fluidEngineContext');

    fetchSpy.mockRestore();
  });

  it('handles fetch errors gracefully', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Network error'));

    const result = await client.addQuoteBlock('psid-1', 'cid-1', 0, 'Will fail.');
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

    const result = await client.addQuoteBlock('psid-1', 'cid-1', 0, 'Will fail on save.');
    expect(result.success).toBe(false);
    expect(result.error).toContain('403');

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — updateQuoteBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates quote text successfully', async () => {
    const sections = makeSections(makeQuoteBlock('q1', 'Old quote text', 'Author'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateQuoteBlock(
      'psid-1', 'cid-1', 'Old quote', { quoteText: 'New quote text' },
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('q1');
    expect(result.oldQuote).toBe('Old quote text');
    expect(result.newQuote).toBe('New quote text');

    // Verify PUT body
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.quote).toBe('New quote text');
    // Attribution should be preserved
    expect(block.content.value.value.source).toBe('Author');

    fetchSpy.mockRestore();
  });

  it('updates attribution only', async () => {
    const sections = makeSections(makeQuoteBlock('q1', 'Quote text', 'Old Author'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateQuoteBlock(
      'psid-1', 'cid-1', 'Quote text', { attribution: 'New Author' },
    );

    expect(result.success).toBe(true);
    expect(result.newQuote).toBe('Quote text'); // unchanged

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.source).toBe('New Author');
    expect(block.content.value.value.quote).toBe('Quote text'); // unchanged

    fetchSpy.mockRestore();
  });

  it('updates both quote text and attribution', async () => {
    const sections = makeSections(makeQuoteBlock('q1', 'Old quote', 'Old Author'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateQuoteBlock(
      'psid-1', 'cid-1', 'Old quote', { quoteText: 'New quote', attribution: 'New Author' },
    );

    expect(result.success).toBe(true);
    expect(result.newQuote).toBe('New quote');

    fetchSpy.mockRestore();
  });

  it('returns error when no block found', async () => {
    const sections = makeSections(makeTextBlock('t1', '<p>Some text</p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateQuoteBlock(
      'psid-1', 'cid-1', 'nonexistent quote', { quoteText: 'New text' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No block found');

    fetchSpy.mockRestore();
  });

  it('returns error when block is not a quote type', async () => {
    const sections = makeSections(makeTextBlock('t1', '<p>Some text</p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateQuoteBlock(
      'psid-1', 'cid-1', 'Some text', { quoteText: 'New text' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a quote block');
    expect(result.error).toContain('expected 31');

    fetchSpy.mockRestore();
  });

  it('returns error when no updates provided', async () => {
    const result = await client.updateQuoteBlock(
      'psid-1', 'cid-1', 'some text', {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Must provide');
  });

  it('finds quote by attribution text', async () => {
    const sections = makeSections(makeQuoteBlock('q1', 'Some wisdom', 'Famous Person'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateQuoteBlock(
      'psid-1', 'cid-1', 'Famous Person', { quoteText: 'Updated wisdom' },
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('q1');

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — addCodeBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds a code block to an empty section', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addCodeBlock(
      'psid-1', 'cid-1', 0, 'console.log("hello");',
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);
    expect(result.sectionId).toBe('section-1');
    expect(result.sectionIndex).toBe(0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(1337);
    expect(gridContents[0].content.value.value.html).toBe('console.log("hello");');
    expect(gridContents[0].content.value.value.wysiwyg.engine).toBe('code');
    expect(gridContents[0].content.value.value.wysiwyg.mode).toBe('htmlmixed');

    fetchSpy.mockRestore();
  });

  it('adds a code block with specified language', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addCodeBlock(
      'psid-1', 'cid-1', 0, 'def hello():\n  print("hi")', 'python',
    );

    expect(result.success).toBe(true);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.html).toBe('def hello():\n  print("hi")');
    expect(block.content.value.value.wysiwyg.mode).toBe('python');

    fetchSpy.mockRestore();
  });

  it('defaults language to plain when not specified', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addCodeBlock('psid-1', 'cid-1', 0, 'some code');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.wysiwyg.mode).toBe('htmlmixed');

    fetchSpy.mockRestore();
  });

  it('stacks below existing blocks with gap', async () => {
    const existingBlocks = [
      makeBlockWithLayout('b1', '<p>Existing</p>', { x: 1, y: 0 }, { x: 25, y: 5 }),
    ];
    const sections = makeSections(...existingBlocks);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addCodeBlock('psid-1', 'cid-1', 0, 'code below');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
    expect(newBlock.layout.desktop.start.y).toBe(7); // 5 + 2 gap
    expect(newBlock.layout.desktop.end.y).toBe(10);  // 7 + 3 row height

    fetchSpy.mockRestore();
  });

  it('respects custom layout parameters', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addCodeBlock('psid-1', 'cid-1', 0, 'code', 'javascript', {
      columns: 16, rowHeight: 6,
    });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.layout.desktop.start.x).toBe(1);
    expect(block.layout.desktop.end.x).toBe(17); // 1 + 16
    expect(block.layout.desktop.end.y - block.layout.desktop.start.y).toBe(6); // rowHeight

    fetchSpy.mockRestore();
  });

  it('returns error for invalid section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addCodeBlock('psid-1', 'cid-1', 3, 'code');
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('handles fetch errors gracefully', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Connection refused'));

    const result = await client.addCodeBlock('psid-1', 'cid-1', 0, 'code');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Connection refused');

    fetchSpy.mockRestore();
  });

  it('returns error when PUT save fails', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    const result = await client.addCodeBlock('psid-1', 'cid-1', 0, 'code');
    expect(result.success).toBe(false);
    expect(result.error).toContain('500');

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — updateCodeBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates code content successfully', async () => {
    const sections = makeSections(makeCodeBlock('c1', 'console.log("old");', 'javascript'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateCodeBlock(
      'psid-1', 'cid-1', 'console.log', { code: 'console.log("new");' },
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('c1');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.html).toBe('console.log("new");');
    expect(block.content.value.value.wysiwyg.source).toBe('console.log("new");');
    // Language should be preserved
    expect(block.content.value.value.wysiwyg.mode).toBe('javascript');

    fetchSpy.mockRestore();
  });

  it('updates language only', async () => {
    const sections = makeSections(makeCodeBlock('c1', 'print("hello")', 'python'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateCodeBlock(
      'psid-1', 'cid-1', 'print("hello")', { language: 'ruby' },
    );

    expect(result.success).toBe(true);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.wysiwyg.mode).toBe('ruby');
    expect(block.content.value.value.html).toBe('print("hello")'); // unchanged

    fetchSpy.mockRestore();
  });

  it('updates both code and language', async () => {
    const sections = makeSections(makeCodeBlock('c1', 'old code', 'plain'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateCodeBlock(
      'psid-1', 'cid-1', 'old code', { code: 'fn main() {}', language: 'rust' },
    );

    expect(result.success).toBe(true);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.html).toBe('fn main() {}');
    expect(block.content.value.value.wysiwyg.mode).toBe('rust');

    fetchSpy.mockRestore();
  });

  it('returns error when no block found', async () => {
    const sections = makeSections(makeTextBlock('t1', '<p>Not code</p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateCodeBlock(
      'psid-1', 'cid-1', 'nonexistent code', { code: 'new code' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No block found');

    fetchSpy.mockRestore();
  });

  it('returns error when block is not a code type', async () => {
    const sections = makeSections(makeTextBlock('t1', '<p>Some text</p>'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateCodeBlock(
      'psid-1', 'cid-1', 'Some text', { code: 'new code' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a code block');
    expect(result.error).toContain('expected 1337');

    fetchSpy.mockRestore();
  });

  it('returns error when no updates provided', async () => {
    const result = await client.updateCodeBlock(
      'psid-1', 'cid-1', 'some code', {},
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Must provide');
  });
});

describe('ContentSaveClient — findBlock integration for quote and code', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('findBlock finds quote block by html content', async () => {
    const sections = makeSections(
      makeTextBlock('t1', '<p>Normal text</p>'),
      makeQuoteBlock('q1', 'Wisdom is the beginning', 'Socrates'),
    );

    // findBlock is a public method, test it directly
    const match = client.findBlock(sections, 'Wisdom is');
    expect(match).not.toBeNull();
    expect(match!.gridContent.content.value.id).toBe('q1');
    expect(match!.gridContent.content.value.type).toBe(31);
  });

  it('findBlock finds quote block by attribution', async () => {
    const sections = makeSections(
      makeQuoteBlock('q1', 'Some quote', 'Albert Einstein'),
    );

    const match = client.findBlock(sections, 'Einstein');
    expect(match).not.toBeNull();
    expect(match!.gridContent.content.value.id).toBe('q1');
  });

  it('findBlock finds code block by code content', async () => {
    const sections = makeSections(
      makeTextBlock('t1', '<p>Description</p>'),
      makeCodeBlock('c1', 'function greet() { return "hello"; }', 'javascript'),
    );

    const match = client.findBlock(sections, 'function greet');
    expect(match).not.toBeNull();
    expect(match!.gridContent.content.value.id).toBe('c1');
    expect(match!.gridContent.content.value.type).toBe(1337);
  });

  it('findBlock returns null for unmatched search in quote/code blocks', async () => {
    const sections = makeSections(
      makeQuoteBlock('q1', 'A famous quote', 'Author'),
      makeCodeBlock('c1', 'let x = 1;', 'javascript'),
    );

    const match = client.findBlock(sections, 'completely unrelated text xyz');
    expect(match).toBeNull();
  });
});
