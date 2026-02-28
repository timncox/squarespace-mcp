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

function makeSocialLinksBlock(blockId: string, options?: {
  iconAlignment?: string;
  iconSize?: string;
  iconStyle?: string;
  iconColor?: string;
}): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 3 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 54,
        value: {
          iconAlignment: options?.iconAlignment ?? 'center',
          iconSize: options?.iconSize ?? 'small',
          iconStyle: options?.iconStyle ?? 'icon-only',
          iconColor: options?.iconColor ?? 'black',
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

describe('ContentSaveClient — addSocialLinksBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds social links block with default options', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.addSocialLinksBlock('psid-1', 'cid-1', 0);

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);
    expect(result.sectionIndex).toBe(0);

    // Verify PUT body has correct type 54 and default display options
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(54);
    expect(gridContents[0].content.value.value.iconAlignment).toBe('center');
    expect(gridContents[0].content.value.value.iconSize).toBe('small');
    expect(gridContents[0].content.value.value.iconStyle).toBe('icon-only');
    expect(gridContents[0].content.value.value.iconColor).toBe('black');

    fetchSpy.mockRestore();
  });

  it('passes custom display options through to the block', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addSocialLinksBlock('psid-1', 'cid-1', 0, {
      iconAlignment: 'left',
      iconSize: 'large',
      iconStyle: 'icon-text',
      iconColor: 'white',
    });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

    expect(blockValue.iconAlignment).toBe('left');
    expect(blockValue.iconSize).toBe('large');
    expect(blockValue.iconStyle).toBe('icon-text');
    expect(blockValue.iconColor).toBe('white');

    fetchSpy.mockRestore();
  });

  it('uses default layout: 12 cols wide, 3 rows tall', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addSocialLinksBlock('psid-1', 'cid-1', 0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Default: 12 cols wide starting at x=1, so end x = 13
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(13);
    // 3 rows tall, starting at y=0 (empty section, no gap)
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(3);

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addSocialLinksBlock('psid-1', 'cid-1', 5);

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — updateSocialLinksBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully updates iconSize', async () => {
    const sections = makeSections(
      makeSocialLinksBlock('social-1', { iconSize: 'small' }),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.updateSocialLinksBlock('psid-1', 'cid-1', 'social-1', {
      iconSize: 'large',
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('social-1');
    expect(result.updatedFields).toContain('iconSize');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.iconSize).toBe('large');

    fetchSpy.mockRestore();
  });

  it('returns error when no update fields are provided', async () => {
    const result = await client.updateSocialLinksBlock('psid-1', 'cid-1', 'social-1', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Must provide');
  });

  it('returns error when no social links block is found', async () => {
    const sections = makeSections(
      makeTextBlock('text-1', '<p>Some text content</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateSocialLinksBlock('psid-1', 'cid-1', 'nonexistent-block', {
      iconSize: 'large',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No social links block');

    fetchSpy.mockRestore();
  });
});
