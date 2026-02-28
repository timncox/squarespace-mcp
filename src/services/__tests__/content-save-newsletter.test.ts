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

function makeNewsletterBlock(blockId: string, description: string): GridContent {
  const descHtml = `<p>${description}</p>`;
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 4 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 4 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 51,
        value: {
          alignment: 'alignCenter',
          captchaEnabled: false,
          captchaTheme: 1,
          captchaAlignment: 2,
          description: { engine: 'wysiwyg', html: descHtml, source: descHtml },
          submitButtonText: 'Sign Up',
          title: 'Subscribe',
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

describe('ContentSaveClient — addNewsletterBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully adds newsletter block with description', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.addNewsletterBlock('psid-1', 'cid-1', 0, {
      description: 'Subscribe for updates',
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);

    // Verify the PUT body has correct type and description as an object
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(51);
    expect(gridContents[0].content.value.value.description).toEqual({
      engine: 'wysiwyg',
      html: '<p>Subscribe for updates</p>',
      source: '<p>Subscribe for updates</p>',
    });

    fetchSpy.mockRestore();
  });

  it('uses default layout: 24 cols wide, 4 rows tall', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addNewsletterBlock('psid-1', 'cid-1', 0);

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

    const result = await client.addNewsletterBlock('psid-1', 'cid-1', 5);

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('captchaEnabled option is passed through', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addNewsletterBlock('psid-1', 'cid-1', 0, { captchaEnabled: true });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

    expect(blockValue.captchaEnabled).toBe(true);

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — updateNewsletterBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully updates description', async () => {
    const sections = makeSections(
      makeNewsletterBlock('newsletter-1', 'Original description'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.updateNewsletterBlock('psid-1', 'cid-1', 'Original description', {
      description: 'New description text',
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('newsletter-1');

    // Verify the PUT body has the new description as an object
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.description).toEqual({
      engine: 'wysiwyg',
      html: '<p>New description text</p>',
      source: '<p>New description text</p>',
    });

    fetchSpy.mockRestore();
  });

  it('returns error when block is not a newsletter block', async () => {
    const sections = makeSections(
      makeTextBlock('text-1', '<p>Some text content</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateNewsletterBlock('psid-1', 'cid-1', 'Some text content', {
      description: 'New description',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a newsletter block');

    fetchSpy.mockRestore();
  });

  it('returns error when no update fields provided', async () => {
    const result = await client.updateNewsletterBlock('psid-1', 'cid-1', 'some text', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Must provide');
  });
});
