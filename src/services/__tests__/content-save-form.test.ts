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

/**
 * Create a form block (type 1337 with buttonVariant discriminator field).
 * The findBlock() method locates form blocks by formId substring match.
 */
function makeFormBlock(
  blockId: string,
  formId: string,
  buttonVariant: 'primary' | 'secondary' | 'tertiary' = 'primary',
): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 17, y: 8 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 8 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 1337,
        value: {
          buttonAlignment: 'left',
          buttonVariant,
          formId,
          useLightbox: false,
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

describe('ContentSaveClient — addFormBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds form block with formId and default buttonVariant', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.addFormBlock('psid-1', 'cid-1', 0, 'my-form-id');

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);

    // Verify the PUT body has correct type, formId, and default buttonVariant
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(1337);
    expect(gridContents[0].content.value.value.formId).toBe('my-form-id');
    expect(gridContents[0].content.value.value.buttonVariant).toBe('primary');

    fetchSpy.mockRestore();
  });

  it('buttonVariant option is passed through', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addFormBlock('psid-1', 'cid-1', 0, 'my-form-id', { buttonVariant: 'secondary' });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

    expect(blockValue.buttonVariant).toBe('secondary');

    fetchSpy.mockRestore();
  });

  it('uses 16 cols wide by default: x: 1 to 17, 8 rows tall', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addFormBlock('psid-1', 'cid-1', 0, 'form-abc');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // 16 cols wide: x: 1 to 17 (1 + 16 = 17)
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(17);
    // 8 rows tall
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(8);

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addFormBlock('psid-1', 'cid-1', 5, 'form-xyz');

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — updateFormBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully updates buttonVariant', async () => {
    const sections = makeSections(
      makeFormBlock('form-block-1', 'contact-form-id', 'primary'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.updateFormBlock('psid-1', 'cid-1', 'contact-form-id', {
      buttonVariant: 'secondary',
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('form-block-1');

    // Verify the PUT body has the updated buttonVariant
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.buttonVariant).toBe('secondary');

    fetchSpy.mockRestore();
  });

  it('returns error when no update fields provided', async () => {
    const result = await client.updateFormBlock('psid-1', 'cid-1', 'some-form', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Must provide');
  });
});
