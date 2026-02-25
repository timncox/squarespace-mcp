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

function makeSections(...blocks: GridContent[]): PageSection[] {
  return [
    {
      id: 'section-1',
      sectionName: 'FLUID_ENGINE',
      fluidEngineContext: {
        gridContents: blocks,
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

describe('ContentSaveClient.patchTextBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces substring within a single paragraph', async () => {
    const sections = makeSections(
      makeTextBlock('block-1', '<p class="" style="white-space:pre-wrap;">Open Monday to Friday 9am-5pm</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.patchTextBlock(
      'psid-1', 'cid-1', '9am-5pm', '8am-6pm'
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('block-1');

    // Verify the PUT payload has the patched HTML
    const putCall = fetchSpy.mock.calls[1];
    const putBody = JSON.parse(putCall[1]?.body as string);
    const patchedHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;
    expect(patchedHtml).toContain('8am-6pm');
    expect(patchedHtml).toContain('Open Monday to Friday');
    expect(patchedHtml).not.toContain('9am-5pm');

    fetchSpy.mockRestore();
  });

  it('preserves other paragraphs when replacing text in one', async () => {
    const html = [
      '<p class="" style="white-space:pre-wrap;">GIFT CARDS</p>',
      '<p class="" style="white-space:pre-wrap;">info@salon.com</p>',
      '<p class="" style="white-space:pre-wrap;">Open 9am-5pm</p>',
      '<p class="" style="white-space:pre-wrap;">123 Main Street</p>',
    ].join('');

    const sections = makeSections(makeTextBlock('block-footer', html));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.patchTextBlock(
      'psid-1', 'cid-1', 'Open 9am-5pm', 'Open 8am-6pm'
    );

    expect(result.success).toBe(true);

    const putCall = fetchSpy.mock.calls[1];
    const putBody = JSON.parse(putCall[1]?.body as string);
    const patchedHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;

    // All other paragraphs preserved
    expect(patchedHtml).toContain('GIFT CARDS');
    expect(patchedHtml).toContain('info@salon.com');
    expect(patchedHtml).toContain('123 Main Street');
    // The target paragraph is updated
    expect(patchedHtml).toContain('Open 8am-6pm');
    expect(patchedHtml).not.toContain('Open 9am-5pm');

    fetchSpy.mockRestore();
  });

  it('preserves HTML tags and attributes around replaced text', async () => {
    const html = '<p class="sqsrte-large" style="white-space:pre-wrap;">Welcome to our <strong>amazing</strong> salon</p>';

    const sections = makeSections(makeTextBlock('block-1', html));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.patchTextBlock(
      'psid-1', 'cid-1', 'Welcome to our', 'Come visit our'
    );

    expect(result.success).toBe(true);

    const putCall = fetchSpy.mock.calls[1];
    const putBody = JSON.parse(putCall[1]?.body as string);
    const patchedHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;

    // Tags and attributes preserved
    expect(patchedHtml).toContain('sqsrte-large');
    expect(patchedHtml).toContain('<strong>amazing</strong>');
    expect(patchedHtml).toContain('Come visit our');
    expect(patchedHtml).not.toContain('Welcome to our');

    fetchSpy.mockRestore();
  });

  it('handles text that spans an entire paragraph (replaces full paragraph content)', async () => {
    const html = [
      '<p class="" style="white-space:pre-wrap;">First paragraph</p>',
      '<p class="" style="white-space:pre-wrap;">Replace this entirely</p>',
      '<p class="" style="white-space:pre-wrap;">Third paragraph</p>',
    ].join('');

    const sections = makeSections(makeTextBlock('block-1', html));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.patchTextBlock(
      'psid-1', 'cid-1', 'Replace this entirely', 'Brand new content here'
    );

    expect(result.success).toBe(true);

    const putCall = fetchSpy.mock.calls[1];
    const putBody = JSON.parse(putCall[1]?.body as string);
    const patchedHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;

    expect(patchedHtml).toContain('First paragraph');
    expect(patchedHtml).toContain('Brand new content here');
    expect(patchedHtml).toContain('Third paragraph');
    expect(patchedHtml).not.toContain('Replace this entirely');

    fetchSpy.mockRestore();
  });

  it('handles HTML entities in search text', async () => {
    const html = '<p class="" style="white-space:pre-wrap;">Tom &amp; Jerry&#39;s Salon</p>';

    const sections = makeSections(makeTextBlock('block-1', html));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    // Search for the decoded text (as a user would type it)
    const result = await client.patchTextBlock(
      'psid-1', 'cid-1', "Tom & Jerry's Salon", "Tom & Jerry's Barbershop"
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('block-1');

    // Verify the patched content
    const putCall = fetchSpy.mock.calls[1];
    const putBody = JSON.parse(putCall[1]?.body as string);
    const patchedHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;
    expect(patchedHtml).toContain('Barbershop');
    expect(patchedHtml).not.toContain('Salon');

    fetchSpy.mockRestore();
  });

  it('fails gracefully when searchText not found', async () => {
    const sections = makeSections(
      makeTextBlock('block-1', '<p>Some completely different text</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.patchTextBlock(
      'psid-1', 'cid-1', 'nonexistent text', 'new text'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No text block found');

    fetchSpy.mockRestore();
  });

  it('replaces text in block with links, preserving the links', async () => {
    const html = '<p>Visit us at <a href="https://salon.com">our website</a> or call 555-1234</p>';

    const sections = makeSections(makeTextBlock('block-1', html));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.patchTextBlock(
      'psid-1', 'cid-1', 'call 555-1234', 'call 555-5678'
    );

    expect(result.success).toBe(true);

    const putCall = fetchSpy.mock.calls[1];
    const putBody = JSON.parse(putCall[1]?.body as string);
    const patchedHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;

    // Link preserved
    expect(patchedHtml).toContain('<a href="https://salon.com">our website</a>');
    // Text replaced
    expect(patchedHtml).toContain('call 555-5678');
    expect(patchedHtml).not.toContain('call 555-1234');

    fetchSpy.mockRestore();
  });

  it('with HTML newText inserts raw HTML', async () => {
    const html = [
      '<p class="" style="white-space:pre-wrap;">Opening Hours</p>',
      '<p class="" style="white-space:pre-wrap;">9am-5pm</p>',
    ].join('');

    const sections = makeSections(makeTextBlock('block-1', html));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.patchTextBlock(
      'psid-1', 'cid-1', '9am-5pm', '<p class="sqsrte-large" style="white-space:pre-wrap;">8am-6pm weekdays<br>10am-4pm weekends</p>'
    );

    expect(result.success).toBe(true);

    const putCall = fetchSpy.mock.calls[1];
    const putBody = JSON.parse(putCall[1]?.body as string);
    const patchedHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;

    // The opening hours paragraph is preserved
    expect(patchedHtml).toContain('Opening Hours');
    // The old single-line hours replaced with new rich HTML
    expect(patchedHtml).toContain('8am-6pm weekdays');
    expect(patchedHtml).toContain('10am-4pm weekends');
    expect(patchedHtml).not.toContain('>9am-5pm<');

    fetchSpy.mockRestore();
  });
});

// ── patchHtmlSegment unit tests (directly testing the core logic) ─────────

describe('ContentSaveClient.patchHtmlSegment', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when searchText is not found', () => {
    const html = '<p>Hello World</p>';
    const result = client.patchHtmlSegment(html, 'nonexistent', 'replacement');
    expect(result).toBeNull();
  });

  it('patches text within a single <p> tag', () => {
    const html = '<p class="test">Hello World</p>';
    const result = client.patchHtmlSegment(html, 'World', 'Universe');
    expect(result).not.toBeNull();
    expect(result!.html).toBe('<p class="test">Hello Universe</p>');
  });

  it('patches text in the correct paragraph among multiple', () => {
    const html = '<p>First paragraph</p><p>Second paragraph</p><p>Third paragraph</p>';
    const result = client.patchHtmlSegment(html, 'Second', 'Modified');
    expect(result).not.toBeNull();
    expect(result!.html).toContain('<p>First paragraph</p>');
    expect(result!.html).toContain('Modified paragraph');
    expect(result!.html).toContain('<p>Third paragraph</p>');
  });

  it('patches text within heading tags', () => {
    const html = '<h1>Welcome Home</h1><p>Some content below</p>';
    const result = client.patchHtmlSegment(html, 'Welcome', 'Hello');
    expect(result).not.toBeNull();
    expect(result!.html).toContain('Hello Home');
    expect(result!.html).toContain('<p>Some content below</p>');
  });

  it('preserves inline tags (strong, em, a) within the patched segment', () => {
    const html = '<p>Contact us at <strong>info@test.com</strong> for details</p>';
    const result = client.patchHtmlSegment(html, 'for details', 'for more info');
    expect(result).not.toBeNull();
    expect(result!.html).toContain('<strong>info@test.com</strong>');
    expect(result!.html).toContain('for more info');
  });

  it('handles HTML without block-level tags (raw text)', () => {
    const html = 'Just some plain text here';
    const result = client.patchHtmlSegment(html, 'plain text', 'formatted text');
    expect(result).not.toBeNull();
    expect(result!.html).toBe('Just some formatted text here');
  });

  it('replaces segment with raw HTML when newText starts with <', () => {
    const html = '<p>Old content</p><p>Keep this</p>';
    const result = client.patchHtmlSegment(html, 'Old content', '<p class="new">New content</p>');
    expect(result).not.toBeNull();
    expect(result!.html).toContain('New content');
    expect(result!.html).toContain('<p>Keep this</p>');
  });

  it('is case-insensitive when matching searchText', () => {
    const html = '<p>GIFT CARDS Available</p>';
    const result = client.patchHtmlSegment(html, 'gift cards', 'VOUCHERS');
    expect(result).not.toBeNull();
    expect(result!.html).toContain('VOUCHERS');
  });
});

// ── tryContentSaveApi substring detection tests ───────────────────────────

describe('tryContentSaveApi substring detection', () => {
  // These tests verify the logic pattern used in handler-utils.ts.
  // We test the findBlock + comparison logic directly since tryContentSaveApi
  // requires a live Playwright page object.

  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects substring vs full replacement correctly', () => {
    const sections = makeSections(
      makeTextBlock('block-1', '<p>GIFT CARDS</p><p>info@salon.com</p><p>Open 9am-5pm</p><p>123 Main Street</p>'),
    );

    const match = client.findBlock(sections, '9am-5pm');
    expect(match).not.toBeNull();

    const blockHtml = match!.gridContent.content.value.value?.html ?? '';
    const blockPlainText = blockHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();

    // "9am-5pm" is a substring of the full block text
    const searchText = '9am-5pm';
    const isSubstring = blockPlainText.toLowerCase() !== searchText.toLowerCase()
      && blockPlainText.toLowerCase().includes(searchText.toLowerCase());

    expect(isSubstring).toBe(true);
  });

  it('detects full block replacement when searchText matches entire block', () => {
    const sections = makeSections(
      makeTextBlock('block-1', '<p>Simple heading</p>'),
    );

    const match = client.findBlock(sections, 'Simple heading');
    expect(match).not.toBeNull();

    const blockHtml = match!.gridContent.content.value.value?.html ?? '';
    const blockPlainText = blockHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();

    const searchText = 'Simple heading';
    const isSubstring = blockPlainText.toLowerCase() !== searchText.toLowerCase()
      && blockPlainText.toLowerCase().includes(searchText.toLowerCase());

    expect(isSubstring).toBe(false);
  });

  it('calls patchTextBlock for substring edits via mock', async () => {
    const html = '<p>GIFT CARDS</p><p>info@salon.com</p><p>Open 9am-5pm</p>';
    const sections = makeSections(makeTextBlock('block-1', html));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    // patchTextBlock should preserve other paragraphs
    const result = await client.patchTextBlock(
      'psid-1', 'cid-1', '9am-5pm', '8am-6pm'
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('block-1');

    const putCall = fetchSpy.mock.calls[1];
    const putBody = JSON.parse(putCall[1]?.body as string);
    const patchedHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;

    expect(patchedHtml).toContain('GIFT CARDS');
    expect(patchedHtml).toContain('info@salon.com');
    expect(patchedHtml).toContain('8am-6pm');

    fetchSpy.mockRestore();
  });
});
