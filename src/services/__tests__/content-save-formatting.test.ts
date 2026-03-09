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

describe('ContentSaveClient — formatHtml', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
    (client as any)._checkForConflict = async () => null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('with no formatting options uses default <p> tag', () => {
    const result = client.formatHtml('Hello world');
    expect(result).toBe('<p class="" style="white-space:pre-wrap;">Hello world</p>');
  });

  it('with tag: "h2" produces <h2> wrapper', () => {
    const result = client.formatHtml('About Us', { tag: 'h2' });
    expect(result).toBe('<h2 class="" style="white-space:pre-wrap;">About Us</h2>');
  });

  it('with tag: "h1" produces <h1> wrapper', () => {
    const result = client.formatHtml('Main Heading', { tag: 'h1' });
    expect(result).toBe('<h1 class="" style="white-space:pre-wrap;">Main Heading</h1>');
  });

  it('with tag: "h3" produces <h3> wrapper', () => {
    const result = client.formatHtml('Sub Heading', { tag: 'h3' });
    expect(result).toBe('<h3 class="" style="white-space:pre-wrap;">Sub Heading</h3>');
  });

  it('with tag: "h4" produces <h4> wrapper', () => {
    const result = client.formatHtml('Small Heading', { tag: 'h4' });
    expect(result).toBe('<h4 class="" style="white-space:pre-wrap;">Small Heading</h4>');
  });

  it('with alignment: "center" adds text-align:center to style', () => {
    const result = client.formatHtml('Centered text', { alignment: 'center' });
    expect(result).toBe('<p class="" style="white-space:pre-wrap;text-align:center;">Centered text</p>');
  });

  it('with alignment: "right" adds text-align:right to style', () => {
    const result = client.formatHtml('Right aligned', { alignment: 'right' });
    expect(result).toBe('<p class="" style="white-space:pre-wrap;text-align:right;">Right aligned</p>');
  });

  it('with alignment: "left" adds text-align:left to style', () => {
    const result = client.formatHtml('Left aligned', { alignment: 'left' });
    expect(result).toBe('<p class="" style="white-space:pre-wrap;text-align:left;">Left aligned</p>');
  });

  it('with bold: true wraps content in <strong>', () => {
    const result = client.formatHtml('Bold text', { bold: true });
    expect(result).toBe('<p class="" style="white-space:pre-wrap;"><strong>Bold text</strong></p>');
  });

  it('with italic: true wraps content in <em>', () => {
    const result = client.formatHtml('Italic text', { italic: true });
    expect(result).toBe('<p class="" style="white-space:pre-wrap;"><em>Italic text</em></p>');
  });

  it('with bold + italic wraps in both <strong><em>', () => {
    const result = client.formatHtml('Bold italic', { bold: true, italic: true });
    expect(result).toBe('<p class="" style="white-space:pre-wrap;"><strong><em>Bold italic</em></strong></p>');
  });

  it('with tag + alignment + bold combines all three', () => {
    const result = client.formatHtml('Featured', { tag: 'h2', alignment: 'center', bold: true });
    expect(result).toBe('<h2 class="" style="white-space:pre-wrap;text-align:center;"><strong>Featured</strong></h2>');
  });

  it('preserves existing HTML (starts with <) without re-wrapping', () => {
    const html = '<h2>Already formatted</h2>';
    const result = client.formatHtml(html, { tag: 'h3', bold: true });
    expect(result).toBe(html);
  });

  it('preserves existing HTML with leading whitespace', () => {
    const html = '  <p>Indented HTML</p>';
    const result = client.formatHtml(html, { tag: 'h2' });
    expect(result).toBe(html);
  });

  it('with className adds class to the tag', () => {
    const result = client.formatHtml('Styled', { className: 'preFade fadeIn' });
    expect(result).toBe('<p class="preFade fadeIn" style="white-space:pre-wrap;">Styled</p>');
  });

  it('with className + tag + alignment combines all', () => {
    const result = client.formatHtml('Title', { tag: 'h1', className: 'highlight', alignment: 'center' });
    expect(result).toBe('<h1 class="highlight" style="white-space:pre-wrap;text-align:center;">Title</h1>');
  });

  it('with empty formatting object uses defaults', () => {
    const result = client.formatHtml('Default text', {});
    expect(result).toBe('<p class="" style="white-space:pre-wrap;">Default text</p>');
  });

  it('handles special characters in text content', () => {
    const result = client.formatHtml('Prices & Menus — "2026"', { tag: 'h2' });
    expect(result).toBe('<h2 class="" style="white-space:pre-wrap;">Prices & Menus — "2026"</h2>');
  });
});

// ── addTextBlock with formatting integration tests ────────────────────────

describe('ContentSaveClient — addTextBlock with formatting', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
    (client as any)._checkForConflict = async () => null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes formatting to formatHtml, producing h2 block', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.addTextBlock(
      'psid-1', 'cid-1', 0, 'About Us',
      undefined, // no layout override
      { tag: 'h2', alignment: 'center' },
    );

    expect(result.success).toBe(true);

    // Verify the PUT body contains h2-formatted HTML
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;
    expect(blockHtml).toBe('<h2 class="" style="white-space:pre-wrap;text-align:center;">About Us</h2>');

    fetchSpy.mockRestore();
  });

  it('with h2 formatting creates properly formatted block (source + html match)', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addTextBlock(
      'psid-1', 'cid-1', 0, 'Our Team',
      undefined,
      { tag: 'h2' },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Both source and html should have the formatted content
    const expectedHtml = '<h2 class="" style="white-space:pre-wrap;">Our Team</h2>';
    expect(block.content.value.value.source).toBe(expectedHtml);
    expect(block.content.value.value.html).toBe(expectedHtml);

    // Block metadata should still be correct
    expect(block.content.value.type).toBe(2);
    expect(block.content.value.value.engine).toBe('wysiwyg');

    fetchSpy.mockRestore();
  });

  it('with bold + italic formatting wraps text correctly', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addTextBlock(
      'psid-1', 'cid-1', 0, 'Important note',
      undefined,
      { bold: true, italic: true },
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;
    expect(blockHtml).toBe('<p class="" style="white-space:pre-wrap;"><strong><em>Important note</em></strong></p>');

    fetchSpy.mockRestore();
  });

  it('without formatting still wraps plain text in default <p> tag', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addTextBlock(
      'psid-1', 'cid-1', 0, 'Plain text',
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;
    expect(blockHtml).toBe('<p class="" style="white-space:pre-wrap;">Plain text</p>');

    fetchSpy.mockRestore();
  });

  it('with raw HTML input ignores formatting options', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addTextBlock(
      'psid-1', 'cid-1', 0, '<h3>Pre-formatted</h3>',
      undefined,
      { tag: 'h1', bold: true }, // should be ignored
    );

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const blockHtml = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html;
    expect(blockHtml).toBe('<h3>Pre-formatted</h3>');

    fetchSpy.mockRestore();
  });
});
