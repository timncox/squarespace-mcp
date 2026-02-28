import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent, PageSectionsData, BlockLayout, GridSettings } from '../content-save.js';

// ── Mock session file ─────────────────────────────────────────────────────

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'SS_ANALYTICS_ID', value: 'analytics456', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
    { name: 'member-session', value: 'member789', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

// ── Mock fs module ────────────────────────────────────────────────────────

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })), // 1 hour old by default
}));

// ── Sample sections data (matches real Squarespace API structure) ────────

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

function makeImageBlock(blockId: string): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 1337,
        value: {
          layout: 'caption-below',
          linkTo: '',
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

describe('ContentSaveClient', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Cookie loading ────────────────────────────────────────────────────

  describe('loadSessionCookies', () => {
    it('loads cookies and extracts crumb token', () => {
      expect(() => client.loadSessionCookies('/fake/session.json')).not.toThrow();
    });

    it('throws when session file does not exist', async () => {
      const fs = await import('fs');
      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValueOnce(false);

      const newClient = new ContentSaveClient('test-site');
      expect(() => newClient.loadSessionCookies('/nonexistent.json')).toThrow('Session file not found');

      existsSpy.mockRestore();
    });
  });

  // ── findTextBlock (via updateTextBlock) ────────────────────────────────

  describe('text block finding', () => {
    it('finds text block by plain text match', async () => {
      const sections = makeSections(
        makeTextBlock('block-1', '<h1>Welcome to our site</h1>'),
        makeTextBlock('block-2', '<p>Contact us for more information</p>'),
      );
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateTextBlock(
        'psid-1', 'cid-1', 'Contact us', '<p>Reach out today</p>'
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('block-2');
      expect(result.oldText).toContain('Contact us');

      fetchSpy.mockRestore();
    });

    it('matches case-insensitively', async () => {
      const sections = makeSections(
        makeTextBlock('block-1', '<h1>WELCOME HOME</h1>'),
      );
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateTextBlock(
        'psid-1', 'cid-1', 'welcome home', '<h1>Hello World</h1>'
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('block-1');

      fetchSpy.mockRestore();
    });

    it('returns error when text not found', async () => {
      const sections = makeSections(
        makeTextBlock('block-1', '<p>Some other text</p>'),
      );
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.updateTextBlock(
        'psid-1', 'cid-1', 'nonexistent text', '<p>New</p>'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No text block found');

      fetchSpy.mockRestore();
    });

    it('skips non-text blocks (type !== 2)', async () => {
      const sections = makeSections(
        makeImageBlock('img-1'),
        makeTextBlock('block-1', '<p>Find me</p>'),
      );
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateTextBlock(
        'psid-1', 'cid-1', 'Find me', '<p>Found</p>'
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('block-1');

      fetchSpy.mockRestore();
    });
  });

  // ── HTML handling ─────────────────────────────────────────────────────

  describe('HTML formatting', () => {
    it('strips HTML tags and entities for text matching', async () => {
      const sections = makeSections(
        makeTextBlock('block-1', '<h1>Hello &amp; <strong>World</strong></h1>'),
      );
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateTextBlock(
        'psid-1', 'cid-1', 'Hello & World', '<h1>New</h1>'
      );

      expect(result.success).toBe(true);
      expect(result.oldText).toBe('Hello & World');

      fetchSpy.mockRestore();
    });

    it('wraps plain text in Squarespace paragraph format', async () => {
      const sections = makeSections(
        makeTextBlock('block-1', '<p>Old text</p>'),
      );
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateTextBlock(
        'psid-1', 'cid-1', 'Old text', 'New plain text'
      );

      expect(result.success).toBe(true);
      expect(result.newHtml).toBe('<p class="" style="white-space:pre-wrap;">New plain text</p>');

      fetchSpy.mockRestore();
    });

    it('passes through HTML as-is when tags are present', async () => {
      const sections = makeSections(
        makeTextBlock('block-1', '<p>Old</p>'),
      );
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateTextBlock(
        'psid-1', 'cid-1', 'Old', '<h2>Custom HTML</h2>'
      );

      expect(result.success).toBe(true);
      expect(result.newHtml).toBe('<h2>Custom HTML</h2>');

      fetchSpy.mockRestore();
    });
  });

  // ── Save flow ─────────────────────────────────────────────────────────

  describe('savePageSections', () => {
    it('includes crumb token in PUT URL', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Test</p>'));

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.savePageSections('psid-1', 'cid-1', sections);

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('crumb=crumb-token-abc');
      expect(calledUrl).toContain('/collection/cid-1');

      fetchSpy.mockRestore();
    });

    it('sends PUT with JSON body containing sections', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Test</p>'));

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.savePageSections('psid-1', 'cid-1', sections);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(options.method).toBe('PUT');
      expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body as string);
      expect(body.sections).toHaveLength(1);
      expect(body.sections[0].sectionName).toBe('FLUID_ENGINE');

      fetchSpy.mockRestore();
    });

    it('returns error on non-200 response', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Test</p>'));

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));

      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(false);
      expect(result.error).toContain('403');

      fetchSpy.mockRestore();
    });
  });

  // ── getPageSections ───────────────────────────────────────────────────

  describe('getPageSections', () => {
    it('uses GET without /collection/ suffix', async () => {
      const data = makePageSectionsData(
        makeSections(makeTextBlock('b1', '<p>Hello</p>')),
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      await client.getPageSections('psid-1');

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/page-sections/psid-1');
      expect(calledUrl).not.toContain('/collection/');

      fetchSpy.mockRestore();
    });

    it('fetches and returns sections data', async () => {
      const data = makePageSectionsData(
        makeSections(makeTextBlock('b1', '<p>Hello</p>')),
      );

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.getPageSections('psid-1');

      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].fluidEngineContext?.gridContents[0].content.value.value?.html).toBe('<p>Hello</p>');

      fetchSpy.mockRestore();
    });

    it('throws on fetch failure', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      await expect(client.getPageSections('psid-1'))
        .rejects.toThrow('Failed to fetch page sections');

      fetchSpy.mockRestore();
    });
  });

  // ── updateTextBlock (full flow) ───────────────────────────────────────

  describe('updateTextBlock', () => {
    it('performs read-modify-write cycle and updates both html and source', async () => {
      const sections = makeSections(
        makeTextBlock('block-1', '<p>Old text here</p>'),
      );
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateTextBlock(
        'psid-1', 'cid-1', 'Old text', '<p>New text here</p>'
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('block-1');

      // Verify the PUT body contains the modified content in both html and source
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blockContent = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
      expect(blockContent.html).toBe('<p>New text here</p>');
      expect(blockContent.source).toBe('<p>New text here</p>');

      fetchSpy.mockRestore();
    });

    it('handles fetch errors gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await client.updateTextBlock(
        'psid-1', 'cid-1', 'text', '<p>new</p>'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');

      fetchSpy.mockRestore();
    });
  });

  // ── Block layout helpers ──────────────────────────────────────────────

  function makeBlockWithLayout(
    blockId: string,
    html: string,
    desktopStart: { x: number; y: number },
    desktopEnd: { x: number; y: number },
    mobileStart = { x: 1, y: 0 },
    mobileEnd = { x: 9, y: 3 },
  ): GridContent {
    return {
      layout: {
        desktop: { start: { ...desktopStart }, end: { ...desktopEnd } },
        mobile: { start: { ...mobileStart }, end: { ...mobileEnd } },
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

  function makeImageBlockWithLayout(
    blockId: string,
    title: string,
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
          type: 1337,
          value: {
            layout: 'caption-below',
            title: `<p>${title}</p>`,
          },
        },
      },
    };
  }

  function makeSectionsWithGrid(
    blocks: GridContent[],
    desktopColumns = 24,
  ): PageSection[] {
    return [
      {
        id: 'section-1',
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: {
          gridContents: blocks,
          gridSettings: {
            breakpointSettings: {
              desktop: { columns: desktopColumns },
              mobile: { columns: 8 },
            },
          },
        },
      },
    ];
  }

  // ── findBlock ─────────────────────────────────────────────────────────

  describe('findBlock', () => {
    it('finds text blocks by stripped HTML', () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<h1>Welcome Home</h1>', { x: 1, y: 0 }, { x: 13, y: 3 }),
        makeBlockWithLayout('b2', '<p>Contact us for info</p>', { x: 1, y: 3 }, { x: 13, y: 6 }),
      ]);
      const result = client.findBlock(sections, 'Contact us');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('b2');
      expect(result!.blockIndex).toBe(1);
    });

    it('finds image blocks by title', () => {
      const sections = makeSectionsWithGrid([
        makeImageBlockWithLayout('img1', 'Team Photo', { x: 1, y: 0 }, { x: 13, y: 6 }),
      ]);
      const result = client.findBlock(sections, 'Team Photo');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('img1');
    });

    it('finds block by ID prefix', () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('abc123def', '<p>Text</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
      ]);
      const result = client.findBlock(sections, 'abc123');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('abc123def');
    });

    it('is case-insensitive', () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<h1>WELCOME HOME</h1>', { x: 1, y: 0 }, { x: 13, y: 3 }),
      ]);
      const result = client.findBlock(sections, 'welcome home');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('b1');
    });

    it('returns gridSettings from the section', () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Text</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
      ], 24);
      const result = client.findBlock(sections, 'Text');
      expect(result).not.toBeNull();
      expect(result!.gridSettings?.breakpointSettings?.desktop?.columns).toBe(24);
    });

    it('returns null when no match', () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Hello</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
      ]);
      const result = client.findBlock(sections, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  // ── moveBlock ─────────────────────────────────────────────────────────

  describe('moveBlock', () => {
    function mockGetAndPut(sections: PageSection[]) {
      const data = makePageSectionsData(sections);
      return vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    }

    it('moves block right', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.moveBlock('psid-1', 'cid-1', 'Move me', 'right');

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('b1');
      expect(result.direction).toBe('right');
      // Block is 6 cols wide (1→7), default step = 6
      expect(result.oldPosition?.desktop.start.x).toBe(1);
      expect(result.newPosition?.desktop.start.x).toBe(7);
      expect(result.newPosition?.desktop.end.x).toBe(13);

      fetchSpy.mockRestore();
    });

    it('moves block left', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 7, y: 0 }, { x: 13, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.moveBlock('psid-1', 'cid-1', 'Move me', 'left');

      expect(result.success).toBe(true);
      expect(result.newPosition?.desktop.start.x).toBe(1);
      expect(result.newPosition?.desktop.end.x).toBe(7);

      fetchSpy.mockRestore();
    });

    it('moves block down', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.moveBlock('psid-1', 'cid-1', 'Move me', 'down');

      expect(result.success).toBe(true);
      // Block is 3 rows tall (0→3), default step = 3
      expect(result.newPosition?.desktop.start.y).toBe(3);
      expect(result.newPosition?.desktop.end.y).toBe(6);

      fetchSpy.mockRestore();
    });

    it('moves block up', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 1, y: 3 }, { x: 7, y: 6 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.moveBlock('psid-1', 'cid-1', 'Move me', 'up');

      expect(result.success).toBe(true);
      expect(result.newPosition?.desktop.start.y).toBe(0);
      expect(result.newPosition?.desktop.end.y).toBe(3);

      fetchSpy.mockRestore();
    });

    it('clamps to left boundary', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.moveBlock('psid-1', 'cid-1', 'Move me', 'left');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      // Already at x=1, can't go further left
      expect(result.newPosition?.desktop.start.x).toBe(1);
      expect(result.newPosition?.desktop.end.x).toBe(7);

      fetchSpy.mockRestore();
    });

    it('clamps to right boundary', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 19, y: 0 }, { x: 25, y: 3 }),
      ], 24);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.moveBlock('psid-1', 'cid-1', 'Move me', 'right');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      // Block is 6 wide, max col = 24, so end.x can be at most 25
      expect(result.newPosition?.desktop.end.x).toBe(25);
      expect(result.newPosition?.desktop.start.x).toBe(19);

      fetchSpy.mockRestore();
    });

    it('clamps to top boundary', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 1, y: 1 }, { x: 7, y: 4 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.moveBlock('psid-1', 'cid-1', 'Move me', 'up');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newPosition?.desktop.start.y).toBe(0);
      expect(result.newPosition?.desktop.end.y).toBe(3);

      fetchSpy.mockRestore();
    });

    it('uses custom gridSteps', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.moveBlock('psid-1', 'cid-1', 'Move me', 'right', 2);

      expect(result.success).toBe(true);
      expect(result.newPosition?.desktop.start.x).toBe(3);
      expect(result.newPosition?.desktop.end.x).toBe(9);

      fetchSpy.mockRestore();
    });

    it('preserves mobile layout', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }, { x: 1, y: 0 }, { x: 9, y: 5 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      await client.moveBlock('psid-1', 'cid-1', 'Move me', 'right');

      // Verify PUT body has unchanged mobile layout
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const layout = putBody.sections[0].fluidEngineContext.gridContents[0].layout;
      expect(layout.mobile.start).toEqual({ x: 1, y: 0 });
      expect(layout.mobile.end).toEqual({ x: 9, y: 5 });

      fetchSpy.mockRestore();
    });

    it('returns error when block not found', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Hello</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const data = makePageSectionsData(sections);
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.moveBlock('psid-1', 'cid-1', 'nonexistent', 'right');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');

      fetchSpy.mockRestore();
    });

    it('performs read-modify-write (GET then PUT)', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Move me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      await client.moveBlock('psid-1', 'cid-1', 'Move me', 'down');

      // First call should be GET
      expect(fetchSpy.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
      const getUrl = fetchSpy.mock.calls[0][0] as string;
      expect(getUrl).toContain('/api/page-sections/psid-1');
      expect(getUrl).not.toContain('/collection/');

      // Second call should be PUT
      const [putUrl, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(putOptions.method).toBe('PUT');
      expect(putUrl).toContain('/collection/cid-1');

      fetchSpy.mockRestore();
    });
  });

  // ── swapBlocks ────────────────────────────────────────────────────────

  describe('swapBlocks', () => {
    it('swaps desktop and mobile layouts between two blocks', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Block A</p>', { x: 1, y: 0 }, { x: 7, y: 3 }, { x: 1, y: 0 }, { x: 5, y: 2 }),
        makeBlockWithLayout('b2', '<p>Block B</p>', { x: 13, y: 0 }, { x: 19, y: 6 }, { x: 1, y: 2 }, { x: 9, y: 8 }),
      ]);
      const data = makePageSectionsData(sections);
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.swapBlocks('psid-1', 'cid-1', 'Block A', 'Block B');

      expect(result.success).toBe(true);
      expect(result.blockId).toContain('b1');
      expect(result.blockId).toContain('b2');

      // Verify PUT body has swapped layouts
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blocks = putBody.sections[0].fluidEngineContext.gridContents;

      // Block A should now have Block B's original layout
      expect(blocks[0].layout.desktop.start).toEqual({ x: 13, y: 0 });
      expect(blocks[0].layout.desktop.end).toEqual({ x: 19, y: 6 });
      expect(blocks[0].layout.mobile.start).toEqual({ x: 1, y: 2 });
      expect(blocks[0].layout.mobile.end).toEqual({ x: 9, y: 8 });

      // Block B should now have Block A's original layout
      expect(blocks[1].layout.desktop.start).toEqual({ x: 1, y: 0 });
      expect(blocks[1].layout.desktop.end).toEqual({ x: 7, y: 3 });
      expect(blocks[1].layout.mobile.start).toEqual({ x: 1, y: 0 });
      expect(blocks[1].layout.mobile.end).toEqual({ x: 5, y: 2 });

      fetchSpy.mockRestore();
    });

    it('returns error when first block not found', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Block A</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const data = makePageSectionsData(sections);
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.swapBlocks('psid-1', 'cid-1', 'Nonexistent', 'Block A');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Nonexistent');

      fetchSpy.mockRestore();
    });

    it('returns error when second block not found', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Block A</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const data = makePageSectionsData(sections);
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.swapBlocks('psid-1', 'cid-1', 'Block A', 'Nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Nonexistent');

      fetchSpy.mockRestore();
    });
  });

  // ── resizeBlock ───────────────────────────────────────────────────────

  describe('resizeBlock', () => {
    function mockGetAndPut(sections: PageSection[]) {
      const data = makePageSectionsData(sections);
      return vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    }

    it('makes block wider (larger)', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Resize me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.resizeBlock('psid-1', 'cid-1', 'Resize me', 'larger');

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('b1');
      expect(result.oldSize?.width).toBe(6);
      expect(result.newSize?.width).toBe(8); // +2 cols
      expect(result.newSize?.desktop.end.x).toBe(9);

      fetchSpy.mockRestore();
    });

    it('makes block narrower (smaller)', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Resize me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.resizeBlock('psid-1', 'cid-1', 'Resize me', 'smaller');

      expect(result.success).toBe(true);
      expect(result.oldSize?.width).toBe(6);
      expect(result.newSize?.width).toBe(4); // -2 cols
      expect(result.newSize?.desktop.end.x).toBe(5);

      fetchSpy.mockRestore();
    });

    it('makes block full width', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Resize me</p>', { x: 5, y: 0 }, { x: 13, y: 3 }),
      ], 24);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.resizeBlock('psid-1', 'cid-1', 'Resize me', 'full');

      expect(result.success).toBe(true);
      expect(result.newSize?.desktop.start.x).toBe(1);
      expect(result.newSize?.desktop.end.x).toBe(25); // 24 cols + 1
      expect(result.newSize?.width).toBe(24);

      fetchSpy.mockRestore();
    });

    it('makes block taller', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Resize me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.resizeBlock('psid-1', 'cid-1', 'Resize me', undefined, 'taller');

      expect(result.success).toBe(true);
      expect(result.oldSize?.height).toBe(3);
      expect(result.newSize?.height).toBe(4); // +1 row

      fetchSpy.mockRestore();
    });

    it('makes block shorter', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Resize me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.resizeBlock('psid-1', 'cid-1', 'Resize me', undefined, 'shorter');

      expect(result.success).toBe(true);
      expect(result.oldSize?.height).toBe(3);
      expect(result.newSize?.height).toBe(2); // -1 row

      fetchSpy.mockRestore();
    });

    it('applies both width and height changes together', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Resize me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.resizeBlock('psid-1', 'cid-1', 'Resize me', 'larger', 'taller');

      expect(result.success).toBe(true);
      expect(result.newSize?.width).toBe(8); // +2 cols
      expect(result.newSize?.height).toBe(4); // +1 row

      fetchSpy.mockRestore();
    });

    it('clamps minimum width to 1 column', async () => {
      const sections = makeSectionsWithGrid([
        // Block is only 2 cols wide — shrinking by 2 would make it 0
        makeBlockWithLayout('b1', '<p>Tiny</p>', { x: 1, y: 0 }, { x: 3, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.resizeBlock('psid-1', 'cid-1', 'Tiny', 'smaller');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newSize?.width).toBe(1); // minimum 1 col

      fetchSpy.mockRestore();
    });

    it('clamps minimum height to 1 row', async () => {
      const sections = makeSectionsWithGrid([
        // Block is only 1 row tall — shrinking would make it 0
        makeBlockWithLayout('b1', '<p>Flat</p>', { x: 1, y: 0 }, { x: 7, y: 1 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.resizeBlock('psid-1', 'cid-1', 'Flat', undefined, 'shorter');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newSize?.height).toBe(1); // can't go below 1

      fetchSpy.mockRestore();
    });

    it('clamps right edge to grid boundary on larger', async () => {
      const sections = makeSectionsWithGrid([
        // Block at far right — growing would exceed grid
        makeBlockWithLayout('b1', '<p>Edge</p>', { x: 21, y: 0 }, { x: 25, y: 3 }),
      ], 24);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.resizeBlock('psid-1', 'cid-1', 'Edge', 'larger');

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newSize?.desktop.end.x).toBe(25); // maxColumns + 1

      fetchSpy.mockRestore();
    });

    it('preserves mobile layout', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Resize me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }, { x: 1, y: 0 }, { x: 9, y: 5 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      await client.resizeBlock('psid-1', 'cid-1', 'Resize me', 'larger');

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const layout = putBody.sections[0].fluidEngineContext.gridContents[0].layout;
      expect(layout.mobile.start).toEqual({ x: 1, y: 0 });
      expect(layout.mobile.end).toEqual({ x: 9, y: 5 });

      fetchSpy.mockRestore();
    });

    it('returns error when neither width nor height provided', async () => {
      const result = await client.resizeBlock('psid-1', 'cid-1', 'text');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Must provide at least width or height');
    });

    it('returns error when block not found', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Hello</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const data = makePageSectionsData(sections);
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.resizeBlock('psid-1', 'cid-1', 'nonexistent', 'larger');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');

      fetchSpy.mockRestore();
    });
  });

  // ── setBlockPosition ─────────────────────────────────────────────────

  describe('setBlockPosition', () => {
    function mockGetAndPut(sections: PageSection[]) {
      const data = makePageSectionsData(sections);
      return vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    }

    it('sets exact position on a block', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Position me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.setBlockPosition('psid-1', 'cid-1', 'Position me', {
        start: { x: 5, y: 2 },
        end: { x: 17, y: 8 },
      });

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('b1');
      expect(result.oldPosition?.desktop.start).toEqual({ x: 1, y: 0 });
      expect(result.oldPosition?.desktop.end).toEqual({ x: 7, y: 3 });
      expect(result.newPosition?.desktop.start).toEqual({ x: 5, y: 2 });
      expect(result.newPosition?.desktop.end).toEqual({ x: 17, y: 8 });
      expect(result.clamped).toBe(false);

      fetchSpy.mockRestore();
    });

    it('clamps start.x below 1 to 1 and shifts end', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Clamp me</p>', { x: 5, y: 0 }, { x: 11, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.setBlockPosition('psid-1', 'cid-1', 'Clamp me', {
        start: { x: -2, y: 0 },
        end: { x: 4, y: 3 },
      });

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newPosition?.desktop.start.x).toBe(1);
      expect(result.newPosition?.desktop.end.x).toBe(7); // shifted by 3

      fetchSpy.mockRestore();
    });

    it('clamps end.x beyond maxColumns+1 and shifts start', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Clamp right</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ], 24);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.setBlockPosition('psid-1', 'cid-1', 'Clamp right', {
        start: { x: 20, y: 0 },
        end: { x: 30, y: 3 },
      });

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newPosition?.desktop.end.x).toBe(25); // maxColumns + 1
      expect(result.newPosition?.desktop.start.x).toBe(15); // shifted by 5

      fetchSpy.mockRestore();
    });

    it('clamps start.y below 0 to 0 and shifts end', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Clamp top</p>', { x: 1, y: 3 }, { x: 7, y: 6 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.setBlockPosition('psid-1', 'cid-1', 'Clamp top', {
        start: { x: 1, y: -2 },
        end: { x: 7, y: 1 },
      });

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newPosition?.desktop.start.y).toBe(0);
      expect(result.newPosition?.desktop.end.y).toBe(3); // shifted by 2

      fetchSpy.mockRestore();
    });

    it('returns error when end.x <= start.x (zero or negative width)', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Bad width</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(makePageSectionsData(sections)), { status: 200 }));

      const result = await client.setBlockPosition('psid-1', 'cid-1', 'Bad width', {
        start: { x: 5, y: 0 },
        end: { x: 5, y: 3 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('width');
    });

    it('returns error when end.y <= start.y (zero or negative height)', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Bad height</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(makePageSectionsData(sections)), { status: 200 }));

      const result = await client.setBlockPosition('psid-1', 'cid-1', 'Bad height', {
        start: { x: 1, y: 4 },
        end: { x: 7, y: 4 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('height');
    });

    it('returns error when block not found', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Some block</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(makePageSectionsData(sections)), { status: 200 }));

      const result = await client.setBlockPosition('psid-1', 'cid-1', 'nonexistent', {
        start: { x: 1, y: 0 },
        end: { x: 7, y: 3 },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');
    });

    it('does not modify mobile layout', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Position me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }, { x: 1, y: 0 }, { x: 9, y: 5 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      await client.setBlockPosition('psid-1', 'cid-1', 'Position me', {
        start: { x: 5, y: 2 },
        end: { x: 17, y: 8 },
      });

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const layout = putBody.sections[0].fluidEngineContext.gridContents[0].layout;
      expect(layout.mobile.start).toEqual({ x: 1, y: 0 });
      expect(layout.mobile.end).toEqual({ x: 9, y: 5 });

      fetchSpy.mockRestore();
    });
  });

  // ── setBlockSize ─────────────────────────────────────────────────────

  describe('setBlockSize', () => {
    function mockGetAndPut(sections: PageSection[]) {
      const data = makePageSectionsData(sections);
      return vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    }

    it('sets exact width and height without changing start position', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Size me</p>', { x: 3, y: 2 }, { x: 9, y: 5 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.setBlockSize('psid-1', 'cid-1', 'Size me', { width: 12, height: 6 });

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('b1');
      expect(result.oldSize?.width).toBe(6);
      expect(result.oldSize?.height).toBe(3);
      expect(result.newSize?.width).toBe(12);
      expect(result.newSize?.height).toBe(6);
      // start position must not change
      expect(result.newSize?.desktop.start).toEqual({ x: 3, y: 2 });
      expect(result.newSize?.desktop.end).toEqual({ x: 15, y: 8 });
      expect(result.clamped).toBe(false);

      fetchSpy.mockRestore();
    });

    it('can set width only, leaving height unchanged', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Size me</p>', { x: 1, y: 0 }, { x: 7, y: 4 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.setBlockSize('psid-1', 'cid-1', 'Size me', { width: 10 });

      expect(result.success).toBe(true);
      expect(result.newSize?.width).toBe(10);
      expect(result.newSize?.height).toBe(4); // unchanged

      fetchSpy.mockRestore();
    });

    it('can set height only, leaving width unchanged', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Size me</p>', { x: 1, y: 0 }, { x: 7, y: 4 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.setBlockSize('psid-1', 'cid-1', 'Size me', { height: 8 });

      expect(result.success).toBe(true);
      expect(result.newSize?.width).toBe(6); // unchanged
      expect(result.newSize?.height).toBe(8);

      fetchSpy.mockRestore();
    });

    it('clamps end.x to maxColumns+1 when width exceeds grid', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Wide</p>', { x: 5, y: 0 }, { x: 11, y: 3 }),
      ], 24);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.setBlockSize('psid-1', 'cid-1', 'Wide', { width: 30 });

      expect(result.success).toBe(true);
      expect(result.clamped).toBe(true);
      expect(result.newSize?.desktop.start.x).toBe(5); // start unchanged
      expect(result.newSize?.desktop.end.x).toBe(25); // maxColumns + 1

      fetchSpy.mockRestore();
    });

    it('returns error when width is zero or negative', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Bad</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(makePageSectionsData(sections)), { status: 200 }));

      const result = await client.setBlockSize('psid-1', 'cid-1', 'Bad', { width: 0 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('width');
    });

    it('returns error when height is zero or negative', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Bad</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(makePageSectionsData(sections)), { status: 200 }));

      const result = await client.setBlockSize('psid-1', 'cid-1', 'Bad', { height: -1 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('height');
    });

    it('returns error when neither width nor height provided', async () => {
      const result = await client.setBlockSize('psid-1', 'cid-1', 'Bad', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('width or height');
    });

    it('returns error when block not found', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Some block</p>', { x: 1, y: 0 }, { x: 7, y: 3 }),
      ]);
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(makePageSectionsData(sections)), { status: 200 }));

      const result = await client.setBlockSize('psid-1', 'cid-1', 'nonexistent', { width: 6, height: 3 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');
    });

    it('does not modify mobile layout', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Size me</p>', { x: 1, y: 0 }, { x: 7, y: 3 }, { x: 1, y: 0 }, { x: 9, y: 5 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      await client.setBlockSize('psid-1', 'cid-1', 'Size me', { width: 12, height: 6 });

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const layout = putBody.sections[0].fluidEngineContext.gridContents[0].layout;
      expect(layout.mobile.start).toEqual({ x: 1, y: 0 });
      expect(layout.mobile.end).toEqual({ x: 9, y: 5 });

      fetchSpy.mockRestore();
    });
  });

  // ── removeBlock ──────────────────────────────────────────────────────

  describe('removeBlock', () => {
    function mockGetAndPut(sections: PageSection[]) {
      const data = makePageSectionsData(sections);
      return vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    }

    it('removes a text block by search text', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Keep me</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
        makeBlockWithLayout('b2', '<p>Delete me</p>', { x: 1, y: 3 }, { x: 13, y: 6 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.removeBlock('psid-1', 'cid-1', 'Delete me');

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('b2');
      expect(result.blockType).toBe(2);
      expect(result.sectionId).toBe('section-1');

      // Verify PUT body has only the kept block
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blocks = putBody.sections[0].fluidEngineContext.gridContents;
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content.value.id).toBe('b1');

      fetchSpy.mockRestore();
    });

    it('removes an image block by title', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Some text</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
        makeImageBlockWithLayout('img1', 'Hero Image', { x: 1, y: 3 }, { x: 13, y: 9 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.removeBlock('psid-1', 'cid-1', 'Hero Image');

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('img1');
      expect(result.blockType).toBe(1337);

      // Verify only text block remains
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blocks = putBody.sections[0].fluidEngineContext.gridContents;
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content.value.id).toBe('b1');

      fetchSpy.mockRestore();
    });

    it('returns error when block not found', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Hello</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
      ]);
      const data = makePageSectionsData(sections);
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.removeBlock('psid-1', 'cid-1', 'nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');

      fetchSpy.mockRestore();
    });

    it('preserves other blocks in the section when removing middle block', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>First</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
        makeBlockWithLayout('b2', '<p>Middle</p>', { x: 1, y: 3 }, { x: 13, y: 6 }),
        makeBlockWithLayout('b3', '<p>Last</p>', { x: 1, y: 6 }, { x: 13, y: 9 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.removeBlock('psid-1', 'cid-1', 'Middle');

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('b2');

      // Verify 2 blocks remain: First and Last
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blocks = putBody.sections[0].fluidEngineContext.gridContents;
      expect(blocks).toHaveLength(2);
      expect(blocks[0].content.value.id).toBe('b1');
      expect(blocks[1].content.value.id).toBe('b3');

      fetchSpy.mockRestore();
    });

    it('works when section has only 1 block (empty gridContents after removal)', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Only block</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.removeBlock('psid-1', 'cid-1', 'Only block');

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('b1');

      // Verify gridContents is now empty
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blocks = putBody.sections[0].fluidEngineContext.gridContents;
      expect(blocks).toHaveLength(0);

      fetchSpy.mockRestore();
    });

    it('performs read-modify-write (GET then PUT)', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Remove me</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      await client.removeBlock('psid-1', 'cid-1', 'Remove me');

      // First call should be GET
      expect(fetchSpy.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
      const getUrl = fetchSpy.mock.calls[0][0] as string;
      expect(getUrl).toContain('/api/page-sections/psid-1');
      expect(getUrl).not.toContain('/collection/');

      // Second call should be PUT
      const [putUrl, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(putOptions.method).toBe('PUT');
      expect(putUrl).toContain('/collection/cid-1');

      fetchSpy.mockRestore();
    });
  });

  // ── moveSection ──────────────────────────────────────────────────────

  describe('moveSection', () => {
    function makeMultiSectionData(sectionConfigs: Array<{ id: string; blockId: string; text: string }>) {
      const sections: PageSection[] = sectionConfigs.map((cfg) => ({
        id: cfg.id,
        sectionName: 'FLUID_ENGINE',
        fluidEngineContext: {
          gridContents: [
            makeBlockWithLayout(cfg.blockId, `<p>${cfg.text}</p>`, { x: 1, y: 0 }, { x: 13, y: 3 }),
          ],
          gridSettings: {
            breakpointSettings: {
              desktop: { columns: 24 },
              mobile: { columns: 8 },
            },
          },
        },
      }));
      const data = makePageSectionsData(sections);
      return vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    }

    it('moves section down', async () => {
      const fetchSpy = makeMultiSectionData([
        { id: 'sec-1', blockId: 'b1', text: 'Header' },
        { id: 'sec-2', blockId: 'b2', text: 'Content' },
        { id: 'sec-3', blockId: 'b3', text: 'Footer' },
      ]);

      const result = await client.moveSection('psid-1', 'cid-1', 'Header', 'down');

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('sec-1');
      expect(result.oldIndex).toBe(0);
      expect(result.newIndex).toBe(1);

      // Verify section order in PUT body
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      expect(putBody.sections[0].id).toBe('sec-2');
      expect(putBody.sections[1].id).toBe('sec-1');
      expect(putBody.sections[2].id).toBe('sec-3');

      fetchSpy.mockRestore();
    });

    it('moves section up', async () => {
      const fetchSpy = makeMultiSectionData([
        { id: 'sec-1', blockId: 'b1', text: 'Header' },
        { id: 'sec-2', blockId: 'b2', text: 'Content' },
        { id: 'sec-3', blockId: 'b3', text: 'Footer' },
      ]);

      const result = await client.moveSection('psid-1', 'cid-1', 'Footer', 'up');

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('sec-3');
      expect(result.oldIndex).toBe(2);
      expect(result.newIndex).toBe(1);

      // Verify section order in PUT body
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      expect(putBody.sections[0].id).toBe('sec-1');
      expect(putBody.sections[1].id).toBe('sec-3');
      expect(putBody.sections[2].id).toBe('sec-2');

      fetchSpy.mockRestore();
    });

    it('returns success with same index when already at top', async () => {
      const fetchSpy = makeMultiSectionData([
        { id: 'sec-1', blockId: 'b1', text: 'Header' },
        { id: 'sec-2', blockId: 'b2', text: 'Content' },
      ]);

      const result = await client.moveSection('psid-1', 'cid-1', 'Header', 'up');

      expect(result.success).toBe(true);
      expect(result.oldIndex).toBe(0);
      expect(result.newIndex).toBe(0);

      // Should only GET (no PUT needed since position unchanged)
      expect(fetchSpy.mock.calls).toHaveLength(1);

      fetchSpy.mockRestore();
    });

    it('returns success with same index when already at bottom', async () => {
      const fetchSpy = makeMultiSectionData([
        { id: 'sec-1', blockId: 'b1', text: 'Header' },
        { id: 'sec-2', blockId: 'b2', text: 'Content' },
      ]);

      const result = await client.moveSection('psid-1', 'cid-1', 'Content', 'down');

      expect(result.success).toBe(true);
      expect(result.oldIndex).toBe(1);
      expect(result.newIndex).toBe(1);

      // Should only GET (no PUT needed)
      expect(fetchSpy.mock.calls).toHaveLength(1);

      fetchSpy.mockRestore();
    });

    it('returns error when search text not found in any section', async () => {
      const fetchSpy = makeMultiSectionData([
        { id: 'sec-1', blockId: 'b1', text: 'Header' },
        { id: 'sec-2', blockId: 'b2', text: 'Content' },
      ]);

      const result = await client.moveSection('psid-1', 'cid-1', 'nonexistent', 'up');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No section found');

      fetchSpy.mockRestore();
    });

    it('moves middle section up in 3-section page', async () => {
      const fetchSpy = makeMultiSectionData([
        { id: 'sec-1', blockId: 'b1', text: 'Header' },
        { id: 'sec-2', blockId: 'b2', text: 'Content' },
        { id: 'sec-3', blockId: 'b3', text: 'Footer' },
      ]);

      const result = await client.moveSection('psid-1', 'cid-1', 'Content', 'up');

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('sec-2');
      expect(result.oldIndex).toBe(1);
      expect(result.newIndex).toBe(0);

      // Verify order: Content, Header, Footer
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      expect(putBody.sections[0].id).toBe('sec-2');
      expect(putBody.sections[1].id).toBe('sec-1');
      expect(putBody.sections[2].id).toBe('sec-3');

      fetchSpy.mockRestore();
    });

    it('moves middle section down in 3-section page', async () => {
      const fetchSpy = makeMultiSectionData([
        { id: 'sec-1', blockId: 'b1', text: 'Header' },
        { id: 'sec-2', blockId: 'b2', text: 'Content' },
        { id: 'sec-3', blockId: 'b3', text: 'Footer' },
      ]);

      const result = await client.moveSection('psid-1', 'cid-1', 'Content', 'down');

      expect(result.success).toBe(true);
      expect(result.oldIndex).toBe(1);
      expect(result.newIndex).toBe(2);

      // Verify order: Header, Footer, Content
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      expect(putBody.sections[0].id).toBe('sec-1');
      expect(putBody.sections[1].id).toBe('sec-3');
      expect(putBody.sections[2].id).toBe('sec-2');

      fetchSpy.mockRestore();
    });
  });

  // ── updateImageBlock ────────────────────────────────────────────────────

  describe('updateImageBlock', () => {
    function mockGetAndPut(sections: PageSection[]) {
      const data = makePageSectionsData(sections);
      return vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    }

    it('updates title on image block', async () => {
      const sections = makeSectionsWithGrid([
        makeImageBlockWithLayout('img1', 'Old Title', { x: 1, y: 0 }, { x: 13, y: 6 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.updateImageBlock(
        'psid-1', 'cid-1', 'Old Title', { title: '<p>New Title</p>' }
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('img1');
      expect(result.updatedFields).toEqual(['title']);

      // Verify PUT body has the updated title
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
      expect(blockValue.title).toBe('<p>New Title</p>');

      fetchSpy.mockRestore();
    });

    it('updates description on image block', async () => {
      const sections = makeSectionsWithGrid([
        makeImageBlockWithLayout('img1', 'My Image', { x: 1, y: 0 }, { x: 13, y: 6 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.updateImageBlock(
        'psid-1', 'cid-1', 'My Image', { description: '<p>A lovely photo</p>' }
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('img1');
      expect(result.updatedFields).toEqual(['description']);

      // Verify PUT body has the updated description
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
      expect(blockValue.description).toBe('<p>A lovely photo</p>');

      fetchSpy.mockRestore();
    });

    it('updates multiple fields at once', async () => {
      const sections = makeSectionsWithGrid([
        makeImageBlockWithLayout('img1', 'Photo', { x: 1, y: 0 }, { x: 13, y: 6 }),
      ]);
      const fetchSpy = mockGetAndPut(sections);

      const result = await client.updateImageBlock(
        'psid-1', 'cid-1', 'Photo', {
          title: '<p>Updated Title</p>',
          description: '<p>Updated Description</p>',
          altText: 'Accessible alt text',
        }
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('img1');
      expect(result.updatedFields).toEqual(['title', 'description', 'altText']);

      // Verify PUT body
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const block = putBody.sections[0].fluidEngineContext.gridContents[0].content.value;
      expect(block.value.title).toBe('<p>Updated Title</p>');
      expect(block.value.description).toBe('<p>Updated Description</p>');
      // altText is at block level (content.value.altText)
      expect(block.altText).toBe('Accessible alt text');

      fetchSpy.mockRestore();
    });

    it('returns error when block not found', async () => {
      const sections = makeSectionsWithGrid([
        makeImageBlockWithLayout('img1', 'Existing', { x: 1, y: 0 }, { x: 13, y: 6 }),
      ]);
      const data = makePageSectionsData(sections);
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.updateImageBlock(
        'psid-1', 'cid-1', 'nonexistent', { title: 'New' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No block found');

      fetchSpy.mockRestore();
    });

    it('returns error when block is not an image type', async () => {
      const sections = makeSectionsWithGrid([
        makeBlockWithLayout('b1', '<p>Text block</p>', { x: 1, y: 0 }, { x: 13, y: 3 }),
      ]);
      const data = makePageSectionsData(sections);
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.updateImageBlock(
        'psid-1', 'cid-1', 'Text block', { title: 'New' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not an image block');
      expect(result.error).toContain('1337');

      fetchSpy.mockRestore();
    });

    it('preserves other image fields when updating one', async () => {
      const sections = makeSectionsWithGrid([
        makeImageBlockWithLayout('img1', 'Original Title', { x: 1, y: 0 }, { x: 13, y: 6 }),
      ]);
      // Add description to the image block before mocking
      sections[0].fluidEngineContext!.gridContents[0].content.value.value!.description = '<p>Original Description</p>';
      sections[0].fluidEngineContext!.gridContents[0].content.value.value!.subtitle = '<p>Original Subtitle</p>';

      const fetchSpy = mockGetAndPut(sections);

      // Only update title — description and subtitle should be preserved
      const result = await client.updateImageBlock(
        'psid-1', 'cid-1', 'Original Title', { title: '<p>New Title</p>' }
      );

      expect(result.success).toBe(true);
      expect(result.updatedFields).toEqual(['title']);

      // Verify PUT body preserved the other fields
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const blockValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
      expect(blockValue.title).toBe('<p>New Title</p>');
      expect(blockValue.description).toBe('<p>Original Description</p>');
      expect(blockValue.subtitle).toBe('<p>Original Subtitle</p>');

      fetchSpy.mockRestore();
    });
  });

  // ── Session Health ──────────────────────────────────────────────────────

  describe('session health', () => {
    it('checkSessionHealth returns exists: false for missing file', async () => {
      const fs = await import('fs');
      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValueOnce(false);

      const result = ContentSaveClient.checkSessionHealth('/nonexistent/session.json');

      expect(result.exists).toBe(false);
      expect(result.ageHours).toBe(-1);
      expect(result.isStale).toBe(true);
      expect(result.hasCrumb).toBe(false);

      existsSpy.mockRestore();
    });

    it('checkSessionHealth returns correct structure for valid session file', async () => {
      const fs = await import('fs');
      // Session file is 2 hours old
      const statSpy = vi.spyOn(fs, 'statSync').mockReturnValueOnce({ mtimeMs: Date.now() - 2 * 3600_000 } as ReturnType<typeof fs.statSync>);

      const result = ContentSaveClient.checkSessionHealth('/fake/session.json');

      expect(result.exists).toBe(true);
      expect(result.ageHours).toBeGreaterThan(1.9);
      expect(result.ageHours).toBeLessThan(2.1);
      expect(result.isStale).toBe(false);
      expect(result.hasCrumb).toBe(true);

      statSpy.mockRestore();
    });

    it('checkSessionHealth detects stale session (>24h)', async () => {
      const fs = await import('fs');
      // Session file is 48 hours old
      const statSpy = vi.spyOn(fs, 'statSync').mockReturnValueOnce({ mtimeMs: Date.now() - 48 * 3600_000 } as ReturnType<typeof fs.statSync>);

      const result = ContentSaveClient.checkSessionHealth('/fake/session.json');

      expect(result.exists).toBe(true);
      expect(result.isStale).toBe(true);
      expect(result.ageHours).toBeGreaterThan(47);

      statSpy.mockRestore();
    });

    it('checkSessionHealth detects missing crumb in session', async () => {
      const fs = await import('fs');
      const noCrumbSession = {
        cookies: [
          { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
        ],
      };
      const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(JSON.stringify(noCrumbSession));
      const statSpy = vi.spyOn(fs, 'statSync').mockReturnValueOnce({ mtimeMs: Date.now() - 3600_000 } as ReturnType<typeof fs.statSync>);

      const result = ContentSaveClient.checkSessionHealth('/fake/session.json');

      expect(result.exists).toBe(true);
      expect(result.hasCrumb).toBe(false);

      readSpy.mockRestore();
      statSpy.mockRestore();
    });

    it('getSessionAge returns null before cookies are loaded', () => {
      const freshClient = new ContentSaveClient('test-site');
      expect(freshClient.getSessionAge()).toBeNull();
    });

    it('getSessionAge returns age info after cookies are loaded', () => {
      // client already has cookies loaded from beforeEach (statSync mock returns 1hr old)
      const age = client.getSessionAge();
      expect(age).not.toBeNull();
      expect(age!.ageHours).toBeGreaterThan(0);
      expect(age!.isStale).toBe(false);
      expect(age!.lastRefreshed).toBeInstanceOf(Date);
    });

    it('getSessionAge returns stale for old sessions', async () => {
      const fs = await import('fs');
      // 48 hours old
      const statSpy = vi.spyOn(fs, 'statSync').mockReturnValueOnce({ mtimeMs: Date.now() - 48 * 3600_000 } as ReturnType<typeof fs.statSync>);

      const oldClient = new ContentSaveClient('test-site');
      oldClient.loadSessionCookies('/fake/session.json');
      const age = oldClient.getSessionAge();

      expect(age).not.toBeNull();
      expect(age!.isStale).toBe(true);
      expect(age!.ageHours).toBeGreaterThan(47);

      statSpy.mockRestore();
    });

    it('crumb failure error includes session age', async () => {
      const sections = makeSections(makeTextBlock('b1', '<p>Test</p>'));

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('{"crumbFail":true}', { status: 200 }));

      const result = await client.savePageSections('psid-1', 'cid-1', sections);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session age:');
      expect(result.error).toContain('Run a browser session to refresh cookies');

      fetchSpy.mockRestore();
    });
  });
});
