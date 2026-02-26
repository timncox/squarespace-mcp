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

// ── Mock menu-parser module (used by updateMenuBlock dynamic import) ──────
// The dynamic import in content-save.ts uses `await import('./menu-parser.js')`.
// vitest resolves vi.mock paths relative to the test file, so '../menu-parser.js'
// from __tests__/ resolves to the same module as './menu-parser.js' from content-save.ts.

vi.mock('../menu-parser.js', () => ({
  serializeMenu: vi.fn((menus: any[]) => menus.map((t: any) => t.title).join('\n')),
}));

// ── Sample data helpers ──────────────────────────────────────────────────

const STUB_LAYOUT: BlockLayout = {
  mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 } },
  desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 3 } },
};

function makeMenuBlock(blockId: string, menus: any[], raw?: string, extras?: Record<string, unknown>): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 18,
        value: {
          menus,
          raw: raw ?? 'some menu text',
          menuStyle: 1,
          currencySymbol: '$',
          ...extras,
        },
      },
    },
  };
}

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

// Sample menus for testing
const SAMPLE_MENUS = [
  {
    title: 'Lunch',
    description: null,
    sections: [
      {
        title: 'Appetizers',
        description: null,
        items: [
          { title: 'Caesar Salad', description: 'Romaine, croutons, parmesan', variants: [{ price: '14' }] },
          { title: 'Soup of the Day', description: null, variants: [{ price: '10' }] },
        ],
      },
      {
        title: 'Mains',
        description: null,
        items: [
          { title: 'Grilled Salmon', description: 'With vegetables', variants: [{ price: '28' }] },
        ],
      },
    ],
  },
  {
    title: 'Dinner',
    description: 'Available after 5pm',
    sections: [
      {
        title: 'Starters',
        description: null,
        items: [
          { title: 'Oysters', description: 'Half dozen', variants: [{ price: '22' }] },
        ],
      },
    ],
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Menu Block Methods', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── findBlock with menu blocks ──────────────────────────────────────

  describe('findBlock with menu blocks', () => {
    it('finds menu block by tab title', () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(menuBlock);

      const result = client.findBlock(sections, 'Lunch');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('menu-1');
      expect(result!.sectionIndex).toBe(0);
      expect(result!.blockIndex).toBe(0);
    });

    it('finds menu block by section title within a tab', () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(menuBlock);

      const result = client.findBlock(sections, 'Appetizers');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('menu-1');
    });

    it('finds menu block by item title', () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(menuBlock);

      const result = client.findBlock(sections, 'Caesar Salad');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('menu-1');
    });

    it('finds menu block by raw text content', () => {
      const menuBlock = makeMenuBlock('menu-1', [], 'Lunch specials available daily');
      const sections = makeSections(menuBlock);

      const result = client.findBlock(sections, 'lunch specials');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('menu-1');
    });

    it('returns null when searchText not found in menu', () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(menuBlock);

      const result = client.findBlock(sections, 'nonexistent dish');
      expect(result).toBeNull();
    });

    it('does NOT match non-menu blocks against menu-specific search', () => {
      // A text block containing "Lunch" should be found by the text block path, not menu path
      const textBlock = makeTextBlock('text-1', '<p>Lunch menu coming soon</p>');
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(textBlock, menuBlock);

      // "Lunch menu coming soon" should match the text block first
      const result = client.findBlock(sections, 'Lunch menu coming soon');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('text-1');
      expect(result!.gridContent.content.value.type).toBe(2);
    });

    it('finds menu block with case-insensitive search', () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(menuBlock);

      const result = client.findBlock(sections, 'GRILLED SALMON');
      expect(result).not.toBeNull();
      expect(result!.gridContent.content.value.id).toBe('menu-1');
    });
  });

  // ── findMenuBlock ──────────────────────────────────────────────────

  describe('findMenuBlock', () => {
    it('returns menuValue for type 18 blocks', () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS, 'raw text');
      const sections = makeSections(menuBlock);

      const result = client.findMenuBlock(sections, 'Lunch');
      expect(result).not.toBeNull();
      expect(result!.menuValue).toBeDefined();
      expect(result!.menuValue.menus).toEqual(SAMPLE_MENUS);
      expect(result!.menuValue.menuStyle).toBe(1);
      expect(result!.menuValue.currencySymbol).toBe('$');
      expect(result!.menuValue.raw).toBe('raw text');
    });

    it('returns null for text blocks (type 2) even if text matches', () => {
      // Text block with text "Lunch" — findBlock would match it, but findMenuBlock should reject (not type 18)
      const textBlock = makeTextBlock('text-1', '<p>Lunch</p>');
      const sections = makeSections(textBlock);

      const result = client.findMenuBlock(sections, 'Lunch');
      expect(result).toBeNull();
    });

    it('returns null when no block found', () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(menuBlock);

      const result = client.findMenuBlock(sections, 'totally not in menu');
      expect(result).toBeNull();
    });

    it('includes section and block indexes', () => {
      const textBlock = makeTextBlock('text-1', '<p>Some text</p>');
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(textBlock, menuBlock);

      const result = client.findMenuBlock(sections, 'Lunch');
      expect(result).not.toBeNull();
      expect(result!.sectionIndex).toBe(0);
      expect(result!.blockIndex).toBe(1);
    });
  });

  // ── getMenuBlock ──────────────────────────────────────────────────

  describe('getMenuBlock', () => {
    it('returns current menus, menuStyle, currencySymbol, blockId', async () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS, 'raw text');
      const sections = makeSections(menuBlock);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.getMenuBlock('psid-1', 'Lunch');

      expect(result.success).toBe(true);
      expect(result.menus).toEqual(SAMPLE_MENUS);
      expect(result.menuStyle).toBe(1);
      expect(result.currencySymbol).toBe('$');
      expect(result.blockId).toBe('menu-1');
      expect(result.raw).toBe('raw text');

      fetchSpy.mockRestore();
    });

    it('returns error when menu block not found', async () => {
      const textBlock = makeTextBlock('text-1', '<p>Hello</p>');
      const sections = makeSections(textBlock);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.getMenuBlock('psid-1', 'Lunch');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Menu block not found');

      fetchSpy.mockRestore();
    });

    it('returns empty menus array when block has no menus', async () => {
      const menuBlock = makeMenuBlock('menu-1', [], 'raw text');
      // Override to have undefined menus
      (menuBlock.content.value.value as any).menus = undefined;
      const sections = makeSections(menuBlock);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      // Search by raw text since there are no menus
      const result = await client.getMenuBlock('psid-1', 'raw text');

      expect(result.success).toBe(true);
      expect(result.menus).toEqual([]);

      fetchSpy.mockRestore();
    });

    it('returns error when fetch fails', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await client.getMenuBlock('psid-1', 'Lunch');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');

      fetchSpy.mockRestore();
    });
  });

  // ── updateMenuBlock ───────────────────────────────────────────────

  describe('updateMenuBlock', () => {
    it('replaces menus array and regenerates raw via serializeMenu', async () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS, 'old raw text');
      const sections = makeSections(menuBlock);
      const data = makePageSectionsData(sections);

      const newMenus = [
        {
          title: 'Brunch',
          description: null,
          sections: [
            {
              title: 'Eggs',
              description: null,
              items: [
                { title: 'Benedict', description: null, variants: [{ price: '18' }] },
              ],
            },
          ],
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))  // GET
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));                  // PUT

      const result = await client.updateMenuBlock('psid-1', 'cid-1', 'Lunch', newMenus);

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('menu-1');
      expect(result.sectionId).toBe('section-1');

      // Verify PUT body has updated menus
      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const updatedBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(updatedBlock.content.value.value.menus).toEqual(newMenus);

      // Verify raw was regenerated (mock serializeMenu joins tab titles)
      expect(updatedBlock.content.value.value.raw).toBe('Brunch');

      fetchSpy.mockRestore();
    });

    it('preserves menuStyle and currencySymbol', async () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(menuBlock);
      const data = makePageSectionsData(sections);

      const newMenus = [{ title: 'Updated', sections: [], description: null }];

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.updateMenuBlock('psid-1', 'cid-1', 'Lunch', newMenus);

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const menuValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
      expect(menuValue.menuStyle).toBe(1);
      expect(menuValue.currencySymbol).toBe('$');

      fetchSpy.mockRestore();
    });

    it('reports correct oldTabCount/newTabCount/oldItemCount/newItemCount', async () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(menuBlock);
      const data = makePageSectionsData(sections);

      const newMenus = [
        {
          title: 'Brunch',
          description: null,
          sections: [
            {
              title: 'Eggs',
              description: null,
              items: [
                { title: 'Benedict', description: null, variants: [{ price: '18' }] },
                { title: 'Scrambled', description: null, variants: [{ price: '12' }] },
                { title: 'Omelette', description: null, variants: [{ price: '16' }] },
              ],
            },
          ],
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateMenuBlock('psid-1', 'cid-1', 'Lunch', newMenus);

      expect(result.success).toBe(true);
      // SAMPLE_MENUS has 2 tabs: Lunch (3 items) and Dinner (1 item)
      expect(result.oldTabCount).toBe(2);
      expect(result.newTabCount).toBe(1);
      // Old: Caesar Salad + Soup of the Day + Grilled Salmon + Oysters = 4
      expect(result.oldItemCount).toBe(4);
      // New: Benedict + Scrambled + Omelette = 3
      expect(result.newItemCount).toBe(3);

      fetchSpy.mockRestore();
    });

    it('returns error when block not found', async () => {
      const textBlock = makeTextBlock('text-1', '<p>Hello</p>');
      const sections = makeSections(textBlock);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

      const result = await client.updateMenuBlock('psid-1', 'cid-1', 'Lunch', []);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Menu block not found');

      fetchSpy.mockRestore();
    });

    it('returns error when save fails', async () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS);
      const sections = makeSections(menuBlock);
      const data = makePageSectionsData(sections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))   // GET
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));         // PUT fails

      const result = await client.updateMenuBlock('psid-1', 'cid-1', 'Lunch', []);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Save failed');

      fetchSpy.mockRestore();
    });

    it('preserveRaw option skips raw regeneration', async () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS, 'original raw text');
      const sections = makeSections(menuBlock);
      const data = makePageSectionsData(sections);

      const newMenus = [{ title: 'Updated', sections: [], description: null }];

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.updateMenuBlock('psid-1', 'cid-1', 'Lunch', newMenus, { preserveRaw: true });

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const menuValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

      // raw should be the original value, not regenerated
      expect(menuValue.raw).toBe('original raw text');

      fetchSpy.mockRestore();
    });

    it('preserves unknown fields in the menu value (spread)', async () => {
      const menuBlock = makeMenuBlock('menu-1', SAMPLE_MENUS, 'raw', { customField: 'keep me', specialConfig: 42 });
      const sections = makeSections(menuBlock);
      const data = makePageSectionsData(sections);

      const newMenus = [{ title: 'Updated', sections: [], description: null }];

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.updateMenuBlock('psid-1', 'cid-1', 'Lunch', newMenus);

      const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const putBody = JSON.parse(putOptions.body as string);
      const menuValue = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;

      // Unknown fields should be preserved via spread
      expect(menuValue.customField).toBe('keep me');
      expect(menuValue.specialConfig).toBe(42);
      expect(menuValue.menus).toEqual(newMenus);

      fetchSpy.mockRestore();
    });

    it('handles menu block with empty menus array', async () => {
      const menuBlock = makeMenuBlock('menu-1', [], 'empty menu');
      const sections = makeSections(menuBlock);
      const data = makePageSectionsData(sections);

      const newMenus = [
        {
          title: 'New Tab',
          description: null,
          sections: [
            { title: 'Section A', description: null, items: [{ title: 'Item 1', description: null, variants: [] }] },
          ],
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateMenuBlock('psid-1', 'cid-1', 'empty menu', newMenus);

      expect(result.success).toBe(true);
      expect(result.oldTabCount).toBe(0);
      expect(result.newTabCount).toBe(1);
      expect(result.oldItemCount).toBe(0);
      expect(result.newItemCount).toBe(1);

      fetchSpy.mockRestore();
    });

    it('handles fetch error gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.updateMenuBlock('psid-1', 'cid-1', 'Lunch', []);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');

      fetchSpy.mockRestore();
    });
  });
});
