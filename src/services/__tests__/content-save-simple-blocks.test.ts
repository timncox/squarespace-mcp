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

// ── Shared data helpers ───────────────────────────────────────────────────

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
        value: { engine: 'wysiwyg', source: html, html, textAttributes: [] },
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
        gridSettings: { breakpointSettings: { desktop: { columns: 24 }, mobile: { columns: 8 } } },
      },
    },
  ];
}

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return { id: 'page-sections-id-1', websiteId: 'website-id-1', collectionId: 'collection-id-1', sections };
}

// ── Block-specific helpers ────────────────────────────────────────────────

function makeAccordionBlock(blockId: string, items: Array<{ title: string; description: string }>): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 8 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 8 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 69,
        value: { accordionItems: items, isExpandedFirstItem: false, shouldAllowMultipleOpenItems: false },
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

function makeEmbedBlock(blockId: string, html?: string): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 6 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 6 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 22,
        value: html ? { html } : {},
        containerStyles: { backgroundEnabled: false, stretchedToFill: false },
      },
    },
  };
}

function makeMarqueeBlock(blockId: string, items: Array<{ text: string; linkTo?: string }>): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 4 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 4 }, visible: true, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 70,
        value: { marqueeItems: items, animationDirection: 'left', animationSpeed: 1, textStyle: 'heading-1', pausedOnHover: false, fadeEdges: false },
      },
    },
  };
}

function makeSocialLinksBlock(blockId: string, options?: {
  iconAlignment?: string; iconSize?: string; iconStyle?: string; iconColor?: string;
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

// ═══════════════════════════════════════════════════════════════════════════
// Accordion (type 69)
// ═══════════════════════════════════════════════════════════════════════════

describe('ContentSaveClient — addAccordionBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('successfully adds accordion with items', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const items = [
      { title: 'FAQ 1', description: 'Answer to FAQ 1' },
      { title: 'FAQ 2', description: 'Answer to FAQ 2' },
    ];
    const result = await client.addAccordionBlock('psid-1', 'cid-1', 0, items);

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);

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
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addAccordionBlock('psid-1', 'cid-1', 0, [{ title: 'Q1', description: 'A1' }]);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const newBlock = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0];
    // Full width (24 cols): x: 1 to 25
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(25);
    // 1 item → rowHeight = max(4, 1*2) = 4
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(4);

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addAccordionBlock('psid-1', 'cid-1', 5, [{ title: 'Q', description: 'A' }]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('isExpandedFirstItem option is passed through', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addAccordionBlock('psid-1', 'cid-1', 0, [{ title: 'Q1', description: 'A1' }], { isExpandedFirstItem: true });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
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

  afterEach(() => { vi.restoreAllMocks(); });

  it('successfully updates accordion items', async () => {
    const data = makePageSectionsData(makeSections(makeAccordionBlock('accordion-1', [{ title: 'Old FAQ 1', description: 'Old Answer 1' }])));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const newItems = [{ title: 'New FAQ 1', description: 'New Answer 1' }, { title: 'New FAQ 2', description: 'New Answer 2' }];
    const result = await client.updateAccordionBlock('psid-1', 'cid-1', 'Old FAQ 1', { items: newItems });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('accordion-1');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.accordionItems).toHaveLength(2);
    expect(blockValue.accordionItems[0].title).toBe('New FAQ 1');

    fetchSpy.mockRestore();
  });

  it('returns error when block not found', async () => {
    const data = makePageSectionsData(makeSections(makeTextBlock('text-1', '<p>Some text</p>')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateAccordionBlock('psid-1', 'cid-1', 'Nonexistent FAQ', { items: [{ title: 'Q', description: 'A' }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No block found');

    fetchSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Newsletter (type 51)
// ═══════════════════════════════════════════════════════════════════════════

describe('ContentSaveClient — addNewsletterBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('successfully adds newsletter block with description', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addNewsletterBlock('psid-1', 'cid-1', 0, { description: 'Subscribe for updates' });

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const gridContents = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents;
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
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addNewsletterBlock('psid-1', 'cid-1', 0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const newBlock = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0];
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(25);
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(4);

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addNewsletterBlock('psid-1', 'cid-1', 5);
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('captchaEnabled option is passed through', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addNewsletterBlock('psid-1', 'cid-1', 0, { captchaEnabled: true });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
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

  afterEach(() => { vi.restoreAllMocks(); });

  it('successfully updates description', async () => {
    const data = makePageSectionsData(makeSections(makeNewsletterBlock('newsletter-1', 'Original description')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateNewsletterBlock('psid-1', 'cid-1', 'Original description', { description: 'New description text' });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('newsletter-1');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.description).toEqual({
      engine: 'wysiwyg',
      html: '<p>New description text</p>',
      source: '<p>New description text</p>',
    });

    fetchSpy.mockRestore();
  });

  it('returns error when block is not a newsletter block', async () => {
    const data = makePageSectionsData(makeSections(makeTextBlock('text-1', '<p>Some text content</p>')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateNewsletterBlock('psid-1', 'cid-1', 'Some text content', { description: 'New description' });
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

// ═══════════════════════════════════════════════════════════════════════════
// Embed (type 22)
// ═══════════════════════════════════════════════════════════════════════════

describe('ContentSaveClient — addEmbedBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('adds embed block with empty value when no html provided', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addEmbedBlock('psid-1', 'cid-1', 0);

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);
    expect(result.sectionIndex).toBe(0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const gridContents = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(22);
    expect(gridContents[0].content.value.value).toEqual({});

    fetchSpy.mockRestore();
  });

  it('adds embed block with html when provided', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const html = '<iframe src="https://www.youtube.com/embed/abc" width="560" height="315"></iframe>';
    const result = await client.addEmbedBlock('psid-1', 'cid-1', 0, html);

    expect(result.success).toBe(true);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.html).toBe(html);

    fetchSpy.mockRestore();
  });

  it('uses default layout: 12 cols wide, 6 rows tall', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addEmbedBlock('psid-1', 'cid-1', 0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const newBlock = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0];
    // Default: 12 cols wide starting at x=1, so end x = 13
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(13);
    // 6 rows tall, starting at y=0 (empty section, no gap)
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(6);

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addEmbedBlock('psid-1', 'cid-1', 5);
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });
});

describe('ContentSaveClient — updateEmbedBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('successfully updates embed html', async () => {
    const data = makePageSectionsData(makeSections(makeEmbedBlock('embed-1')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const newHtml = '<script src="https://platform.twitter.com/widgets.js"></script>';
    const result = await client.updateEmbedBlock('psid-1', 'cid-1', 'embed-1', newHtml);

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('embed-1');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.html).toBe(newHtml);

    fetchSpy.mockRestore();
  });

  it('falls back to first type 22 block when searchText does not match', async () => {
    const data = makePageSectionsData(makeSections(
      makeTextBlock('text-1', '<p>Some content</p>'),
      makeEmbedBlock('embed-1', '<iframe src="https://example.com"></iframe>'),
    ));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateEmbedBlock('psid-1', 'cid-1', 'nonexistent-search', '<p>new</p>');
    expect(result.success).toBe(true);
    expect(result.blockId).toBe('embed-1');

    fetchSpy.mockRestore();
  });

  it('returns error when no embed block is found', async () => {
    const data = makePageSectionsData(makeSections(makeTextBlock('text-1', '<p>Some text content</p>')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateEmbedBlock('psid-1', 'cid-1', 'nonexistent-block', '<p>html</p>');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No embed block');

    fetchSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Marquee (type 70)
// ═══════════════════════════════════════════════════════════════════════════

describe('ContentSaveClient — addMarqueeBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('successfully adds marquee with items', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const items = [{ text: 'Hello World' }, { text: 'Welcome to our site' }, { text: 'Check out our services' }];
    const result = await client.addMarqueeBlock('psid-1', 'cid-1', 0, items);

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const gridContents = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(70);
    expect(gridContents[0].content.value.value.marqueeItems).toHaveLength(3);
    expect(gridContents[0].content.value.value.marqueeItems[0].text).toBe('Hello World');

    fetchSpy.mockRestore();
  });

  it('uses full width default: 24 cols wide, 4 rows tall', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addMarqueeBlock('psid-1', 'cid-1', 0, [{ text: 'Test item' }]);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const newBlock = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0];
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(25);
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(4);

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addMarqueeBlock('psid-1', 'cid-1', 5, [{ text: 'Test' }]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');

    fetchSpy.mockRestore();
  });

  it('animationDirection option is passed through', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addMarqueeBlock('psid-1', 'cid-1', 0, [{ text: 'Scrolling text' }], { animationDirection: 'right' });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.animationDirection).toBe('right');

    fetchSpy.mockRestore();
  });

  it('textStyle option is passed through', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addMarqueeBlock('psid-1', 'cid-1', 0, [{ text: 'Scrolling text' }], { textStyle: 'heading-2' });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
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

  afterEach(() => { vi.restoreAllMocks(); });

  it('successfully updates marquee items', async () => {
    const data = makePageSectionsData(makeSections(makeMarqueeBlock('marquee-1', [{ text: 'Old text item' }])));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const newItems = [{ text: 'New text item 1' }, { text: 'New text item 2' }];
    const result = await client.updateMarqueeBlock('psid-1', 'cid-1', 'Old text item', { items: newItems });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('marquee-1');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.marqueeItems).toHaveLength(2);
    expect(blockValue.marqueeItems[0].text).toBe('New text item 1');

    fetchSpy.mockRestore();
  });

  it('returns error when block not found', async () => {
    const data = makePageSectionsData(makeSections(makeTextBlock('text-1', '<p>Some text</p>')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateMarqueeBlock('psid-1', 'cid-1', 'Nonexistent marquee text', { items: [{ text: 'New item' }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No block found');

    fetchSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Social Links (type 54)
// ═══════════════════════════════════════════════════════════════════════════

describe('ContentSaveClient — addSocialLinksBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('successfully adds social links block with default options', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addSocialLinksBlock('psid-1', 'cid-1', 0);

    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();
    expect(result.blockId).toHaveLength(20);
    expect(result.sectionIndex).toBe(0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const gridContents = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents;
    expect(gridContents).toHaveLength(1);
    expect(gridContents[0].content.value.type).toBe(54);
    expect(gridContents[0].content.value.value.iconAlignment).toBe('center');
    expect(gridContents[0].content.value.value.iconSize).toBe('small');
    expect(gridContents[0].content.value.value.iconStyle).toBe('icon-only');
    expect(gridContents[0].content.value.value.iconColor).toBe('black');

    fetchSpy.mockRestore();
  });

  it('passes custom display options through to the block', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addSocialLinksBlock('psid-1', 'cid-1', 0, { iconAlignment: 'left', iconSize: 'large', iconStyle: 'icon-text', iconColor: 'white' });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.iconAlignment).toBe('left');
    expect(blockValue.iconSize).toBe('large');
    expect(blockValue.iconStyle).toBe('icon-text');
    expect(blockValue.iconColor).toBe('white');

    fetchSpy.mockRestore();
  });

  it('uses default layout: 12 cols wide, 3 rows tall', async () => {
    const data = makePageSectionsData(makeSections());
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addSocialLinksBlock('psid-1', 'cid-1', 0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const newBlock = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0];
    // Default: 12 cols wide starting at x=1, so end x = 13
    expect(newBlock.layout.desktop.start.x).toBe(1);
    expect(newBlock.layout.desktop.end.x).toBe(13);
    // 3 rows tall, starting at y=0 (empty section, no gap)
    expect(newBlock.layout.desktop.start.y).toBe(0);
    expect(newBlock.layout.desktop.end.y).toBe(3);

    fetchSpy.mockRestore();
  });

  it('returns error for out-of-range section index', async () => {
    const data = makePageSectionsData(makeSections());
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

  afterEach(() => { vi.restoreAllMocks(); });

  it('successfully updates iconSize', async () => {
    const data = makePageSectionsData(makeSections(makeSocialLinksBlock('social-1', { iconSize: 'small' })));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateSocialLinksBlock('psid-1', 'cid-1', 'social-1', { iconSize: 'large' });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('social-1');
    expect(result.updatedFields).toContain('iconSize');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const blockValue = JSON.parse(putOptions.body as string).sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(blockValue.iconSize).toBe('large');

    fetchSpy.mockRestore();
  });

  it('returns error when no update fields are provided', async () => {
    const result = await client.updateSocialLinksBlock('psid-1', 'cid-1', 'social-1', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Must provide');
  });

  it('returns error when no social links block is found', async () => {
    const data = makePageSectionsData(makeSections(makeTextBlock('text-1', '<p>Some text content</p>')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateSocialLinksBlock('psid-1', 'cid-1', 'nonexistent-block', { iconSize: 'large' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No social links block');

    fetchSpy.mockRestore();
  });
});
