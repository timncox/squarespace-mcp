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

// ── buildRichHtml Tests ──────────────────────────────────────────────────

describe('ContentSaveClient.buildRichHtml', () => {
  it('builds simple paragraph from text', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Hello world' },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;">Hello world</p>',
    );
  });

  it('builds h2 heading', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'About Us', tag: 'h2' },
    ]);
    expect(result).toBe(
      '<h2 class="" style="white-space:pre-wrap;">About Us</h2>',
    );
  });

  it('builds h1 heading with center alignment', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Welcome', tag: 'h1', style: { 'text-align': 'center' } },
    ]);
    expect(result).toBe(
      '<h1 class="" style="white-space:pre-wrap;text-align:center;">Welcome</h1>',
    );
  });

  it('applies bold formatting with <strong>', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Important', bold: true },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;"><strong>Important</strong></p>',
    );
  });

  it('applies italic formatting with <em>', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Emphasis', italic: true },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;"><em>Emphasis</em></p>',
    );
  });

  it('applies both bold and italic', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Bold italic', bold: true, italic: true },
    ]);
    // Bold wraps italic which wraps text
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;"><strong><em>Bold italic</em></strong></p>',
    );
  });

  it('creates link with href', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Visit us', link: { href: '/about' } },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;"><a href="/about">Visit us</a></p>',
    );
  });

  it('creates link with target="_blank"', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'External', link: { href: 'https://example.com', target: '_blank' } },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;"><a href="https://example.com" target="_blank">External</a></p>',
    );
  });

  it('merges custom styles with white-space:pre-wrap', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Styled', style: { 'color': 'red', 'font-size': '18px' } },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;color:red;font-size:18px;">Styled</p>',
    );
  });

  it('adds className to class attribute', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Classed', className: 'sqsrte-large' },
    ]);
    expect(result).toBe(
      '<p class="sqsrte-large" style="white-space:pre-wrap;">Classed</p>',
    );
  });

  it('handles multiple elements concatenated', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Title', tag: 'h2' },
      { text: 'Body text here.', tag: 'p' },
      { text: 'Click me', tag: 'p', bold: true, link: { href: '/page' } },
    ]);
    expect(result).toBe(
      '<h2 class="" style="white-space:pre-wrap;">Title</h2>'
      + '<p class="" style="white-space:pre-wrap;">Body text here.</p>'
      + '<p class="" style="white-space:pre-wrap;"><strong><a href="/page">Click me</a></strong></p>',
    );
  });

  it('wraps consecutive li elements in <ul>', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Item 1', tag: 'li' },
      { text: 'Item 2', tag: 'li' },
      { text: 'Item 3', tag: 'li' },
    ]);
    expect(result).toBe(
      '<ul>'
      + '<li class="" style="white-space:pre-wrap;">Item 1</li>'
      + '<li class="" style="white-space:pre-wrap;">Item 2</li>'
      + '<li class="" style="white-space:pre-wrap;">Item 3</li>'
      + '</ul>',
    );
  });

  it('separates non-consecutive li groups into separate <ul>s', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'First list:', tag: 'p' },
      { text: 'A', tag: 'li' },
      { text: 'B', tag: 'li' },
      { text: 'Second list:', tag: 'p' },
      { text: 'C', tag: 'li' },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;">First list:</p>'
      + '<ul>'
      + '<li class="" style="white-space:pre-wrap;">A</li>'
      + '<li class="" style="white-space:pre-wrap;">B</li>'
      + '</ul>'
      + '<p class="" style="white-space:pre-wrap;">Second list:</p>'
      + '<ul>'
      + '<li class="" style="white-space:pre-wrap;">C</li>'
      + '</ul>',
    );
  });

  it('handles empty text gracefully', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: '' },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;"></p>',
    );
  });

  it('preserves special characters (& < > ")', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Tom & Jerry <heroes> say "hello"' },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;">Tom &amp; Jerry &lt;heroes&gt; say &quot;hello&quot;</p>',
    );
  });

  it('returns empty string for empty array', () => {
    expect(ContentSaveClient.buildRichHtml([])).toBe('');
  });

  it('returns empty string for null/undefined-like input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(ContentSaveClient.buildRichHtml(null as any)).toBe('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(ContentSaveClient.buildRichHtml(undefined as any)).toBe('');
  });

  it('applies bold link correctly (bold wraps link)', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Visit our menu', tag: 'p', link: { href: '/menus' }, bold: true },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;"><strong><a href="/menus">Visit our menu</a></strong></p>',
    );
  });

  it('applies italic link correctly', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'See more', tag: 'p', link: { href: '/more' }, italic: true },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;"><em><a href="/more">See more</a></em></p>',
    );
  });

  it('applies all formatting: bold + italic + link', () => {
    const result = ContentSaveClient.buildRichHtml([
      { text: 'Click here', bold: true, italic: true, link: { href: '/target' } },
    ]);
    expect(result).toBe(
      '<p class="" style="white-space:pre-wrap;"><strong><em><a href="/target">Click here</a></em></strong></p>',
    );
  });
});

// ── updateTextBlockHtml Tests ────────────────────────────────────────────

describe('ContentSaveClient.updateTextBlockHtml', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets source and html directly without formatHtml processing', async () => {
    const rawHtml = '<h2 class="" style="white-space:pre-wrap;text-align:center;">About Us</h2>'
      + '<p class="" style="white-space:pre-wrap;">We are a family restaurant.</p>';

    const sections = makeSections(
      makeTextBlock('b1', '<p class="" style="white-space:pre-wrap;">Placeholder text</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 })) // GET
      .mockResolvedValueOnce(new Response('{}', { status: 200 })); // PUT

    const result = await client.updateTextBlockHtml(
      'psid-1', 'cid-1', 'Placeholder text', rawHtml,
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('b1');
    expect(result.newHtml).toBe(rawHtml);

    // Verify PUT body has the raw HTML, not wrapped in extra <p> tags
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const updatedBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(updatedBlock.content.value.value.html).toBe(rawHtml);
    expect(updatedBlock.content.value.value.source).toBe(rawHtml);

    fetchSpy.mockRestore();
  });

  it('preserves raw HTML tags in output', async () => {
    const rawHtml = '<h1 class="hero" style="white-space:pre-wrap;"><strong>Bold Title</strong></h1>';

    const sections = makeSections(
      makeTextBlock('b1', '<p>Old content</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateTextBlockHtml(
      'psid-1', 'cid-1', 'Old content', rawHtml,
    );

    expect(result.success).toBe(true);

    // The HTML should be stored as-is, not wrapped in <p> tags
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const updatedBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(updatedBlock.content.value.value.html).toBe(rawHtml);

    fetchSpy.mockRestore();
  });

  it('finds block by searchText and replaces content', async () => {
    const sections = makeSections(
      makeTextBlock('b1', '<p>First block</p>'),
      makeTextBlock('b2', '<p>Target block to update</p>'),
      makeTextBlock('b3', '<p>Third block</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateTextBlockHtml(
      'psid-1', 'cid-1', 'Target block', '<h2>New heading</h2><p>New body</p>',
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('b2');
    expect(result.oldText).toBe('Target block to update');

    fetchSpy.mockRestore();
  });

  it('fails gracefully when block not found', async () => {
    const sections = makeSections(
      makeTextBlock('b1', '<p>Only block here</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateTextBlockHtml(
      'psid-1', 'cid-1', 'Nonexistent text', '<p>New content</p>',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No text block found');
    expect(result.error).toContain('Nonexistent text');

    fetchSpy.mockRestore();
  });

  it('handles fetch errors gracefully', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Network timeout'));

    const result = await client.updateTextBlockHtml(
      'psid-1', 'cid-1', 'any text', '<p>New</p>',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network timeout');

    fetchSpy.mockRestore();
  });

  it('works with buildRichHtml output end-to-end', async () => {
    // Build HTML using buildRichHtml
    const richHtml = ContentSaveClient.buildRichHtml([
      { text: 'Our Story', tag: 'h2', style: { 'text-align': 'center' } },
      { text: 'Founded in 2020, we have been serving the community.', tag: 'p' },
      { text: 'Learn more', tag: 'p', bold: true, link: { href: '/about' } },
    ]);

    const sections = makeSections(
      makeTextBlock('b1', '<p>Placeholder</p>'),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateTextBlockHtml(
      'psid-1', 'cid-1', 'Placeholder', richHtml,
    );

    expect(result.success).toBe(true);

    // Verify the stored HTML matches the buildRichHtml output exactly
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.html).toBe(richHtml);
    expect(block.content.value.value.html).toContain('<h2');
    expect(block.content.value.value.html).toContain('<strong>');
    expect(block.content.value.value.html).toContain('<a href="/about">');

    fetchSpy.mockRestore();
  });
});
