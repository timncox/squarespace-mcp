import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent, PageSectionsData, BlockLayout, HeaderFooterConfig } from '../content-save.js';

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
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })), // 1 hour old
}));

// ── Test data helpers ─────────────────────────────────────────────────────

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

function makeFooterSections(...blocks: GridContent[]): PageSection[] {
  return [
    {
      id: 'footer-section-1',
      sectionName: 'FOOTER',
      fluidEngineContext: {
        gridContents: blocks,
      },
    },
  ];
}

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return {
    id: 'footer-psid-1',
    websiteId: 'website-id-1',
    collectionId: 'collection-id-1',
    sections,
  };
}

function makeHeaderFooterConfig(footerPsId: string): HeaderFooterConfig {
  return {
    header: { enabled: true },
    footer: {
      pageSectionsId: footerPsId,
      enabled: true,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ContentSaveClient — Footer API', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getHeaderFooter ────────────────────────────────────────────────────

  describe('getHeaderFooter', () => {
    it('makes GET request to /api/site-header-footer', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }));

      const result = await client.getHeaderFooter();

      expect(result.success).toBe(true);
      expect(result.config).toBeDefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe('https://test-site.squarespace.com/api/site-header-footer');

      const calledOptions = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(calledOptions.method).toBe('GET');

      fetchSpy.mockRestore();
    });

    it('returns config on success', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }));

      const result = await client.getHeaderFooter();

      expect(result.success).toBe(true);
      expect(result.config?.footer?.pageSectionsId).toBe('footer-psid-1');
      expect(result.config?.header).toBeDefined();

      fetchSpy.mockRestore();
    });

    it('returns error on 401', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));

      const result = await client.getHeaderFooter();

      expect(result.success).toBe(false);
      expect(result.error).toContain('401');

      fetchSpy.mockRestore();
    });

    it('returns error on 404', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Not Found', { status: 404, statusText: 'Not Found' }));

      const result = await client.getHeaderFooter();

      expect(result.success).toBe(false);
      expect(result.error).toContain('404');

      fetchSpy.mockRestore();
    });

    it('returns error on network failure', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await client.getHeaderFooter();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');

      fetchSpy.mockRestore();
    });
  });

  // ── getFooterSections ──────────────────────────────────────────────────

  describe('getFooterSections', () => {
    it('extracts section data from header-footer config', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      const footerSections = makeFooterSections(
        makeTextBlock('f-block-1', '<p>Mon-Fri: 9am-5pm</p>'),
        makeTextBlock('f-block-2', '<p>123 Main Street</p>'),
      );
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // First call: GET /api/site-header-footer
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        // Second call: GET /api/page-sections/footer-psid-1
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }));

      const result = await client.getFooterSections();

      expect(result.success).toBe(true);
      expect(result.sections).toHaveLength(1);
      expect(result.pageSectionsId).toBe('footer-psid-1');
      expect(result.sections![0].fluidEngineContext?.gridContents).toHaveLength(2);

      fetchSpy.mockRestore();
    });

    it('returns error when header-footer config fails', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));

      const result = await client.getFooterSections();

      expect(result.success).toBe(false);
      expect(result.error).toContain('401');

      fetchSpy.mockRestore();
    });

    it('returns error when footer pageSectionsId is missing', async () => {
      const config = { header: { enabled: true }, footer: { enabled: true } };

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }));

      const result = await client.getFooterSections();

      expect(result.success).toBe(false);
      expect(result.error).toContain('pageSectionsId not found');

      fetchSpy.mockRestore();
    });

    it('handles embedded footer sections in config', async () => {
      // Some Squarespace versions embed sections directly in the footer config
      const embeddedSections = makeFooterSections(
        makeTextBlock('e-block-1', '<p>Embedded footer text</p>'),
      );
      const config = {
        header: { enabled: true },
        footer: {
          enabled: true,
          sections: embeddedSections,
        },
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }));

      const result = await client.getFooterSections();

      expect(result.success).toBe(true);
      expect(result.sections).toHaveLength(1);

      fetchSpy.mockRestore();
    });
  });

  // ── updateFooterTextBlock ──────────────────────────────────────────────

  describe('updateFooterTextBlock', () => {
    it('finds and replaces text in footer', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      const footerSections = makeFooterSections(
        makeTextBlock('f-block-1', '<p>Mon-Fri: 9am-5pm</p>'),
        makeTextBlock('f-block-2', '<p>123 Main Street</p>'),
      );
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // getFooterSections: GET config, GET page-sections
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }))
        // savePageSections: PUT
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateFooterTextBlock(
        'Mon-Fri: 9am-5pm',
        'Mon-Sat: 10am-6pm',
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('f-block-1');
      expect(result.oldText).toContain('Mon-Fri: 9am-5pm');

      fetchSpy.mockRestore();
    });

    it('returns error when text not found in footer', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      const footerSections = makeFooterSections(
        makeTextBlock('f-block-1', '<p>Some other text</p>'),
      );
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }));

      const result = await client.updateFooterTextBlock(
        'Nonexistent text',
        'New text',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No text block found in the footer');

      fetchSpy.mockRestore();
    });

    it('handles empty footer config gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));

      const result = await client.updateFooterTextBlock('hours', 'new hours');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      fetchSpy.mockRestore();
    });
  });

  // ── patchFooterTextBlock ───────────────────────────────────────────────

  describe('patchFooterTextBlock', () => {
    it('does surgical find-and-replace in footer', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      const footerSections = makeFooterSections(
        makeTextBlock('f-block-1', '<p>Hours: Mon-Fri 9am-5pm | Sat 10am-2pm</p>'),
      );
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.patchFooterTextBlock(
        '9am-5pm',
        '10am-6pm',
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('f-block-1');
      expect(result.newHtml).toContain('10am-6pm');
      // The rest of the block should be preserved
      expect(result.newHtml).toContain('Mon-Fri');
      expect(result.newHtml).toContain('Sat 10am-2pm');

      fetchSpy.mockRestore();
    });

    it('preserves other content in the block', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      const footerSections = makeFooterSections(
        makeTextBlock('f-block-1', '<p>123 Main Street, City, ST 12345</p><p>Phone: (555) 123-4567</p>'),
      );
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.patchFooterTextBlock(
        '(555) 123-4567',
        '(555) 987-6543',
      );

      expect(result.success).toBe(true);
      // Address should be unchanged
      expect(result.newHtml).toContain('123 Main Street');
      // Phone should be updated
      expect(result.newHtml).toContain('(555) 987-6543');
      // Old phone should NOT be present
      expect(result.newHtml).not.toContain('(555) 123-4567');

      fetchSpy.mockRestore();
    });

    it('handles case-insensitive matching in patch', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      const footerSections = makeFooterSections(
        makeTextBlock('f-block-1', '<p>OPEN Monday Through Friday</p>'),
      );
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.patchFooterTextBlock(
        'Monday Through Friday',
        'Monday Through Saturday',
      );

      expect(result.success).toBe(true);
      expect(result.newHtml).toContain('Monday Through Saturday');

      fetchSpy.mockRestore();
    });

    it('returns error when search text not found in footer', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      const footerSections = makeFooterSections(
        makeTextBlock('f-block-1', '<p>Some content</p>'),
      );
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }));

      const result = await client.patchFooterTextBlock(
        'nonexistent text',
        'replacement',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No text block found in the footer');

      fetchSpy.mockRestore();
    });

    it('handles missing/empty footer config gracefully', async () => {
      const config = { header: {} };

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }));

      const result = await client.patchFooterTextBlock('hours', 'new hours');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      fetchSpy.mockRestore();
    });

    it('handles footer with no text blocks gracefully', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      // Footer has sections but no text blocks
      const footerSections: PageSection[] = [{
        id: 'footer-section-empty',
        sectionName: 'FOOTER',
        fluidEngineContext: {
          gridContents: [{
            layout: STUB_LAYOUT,
            content: {
              value: {
                id: 'img-block-1',
                type: 1337, // image, not text
                value: { title: 'logo' },
              },
            },
          }],
        },
      }];
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }));

      const result = await client.patchFooterTextBlock('hours', 'new hours');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No text block found');

      fetchSpy.mockRestore();
    });
  });

  // ── Multi-section footer ───────────────────────────────────────────────

  describe('multi-section footer', () => {
    it('finds text across multiple footer sections', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      const footerSections: PageSection[] = [
        {
          id: 'footer-section-1',
          sectionName: 'FOOTER_HOURS',
          fluidEngineContext: {
            gridContents: [
              makeTextBlock('f-block-1', '<p>Business Hours</p>'),
            ],
          },
        },
        {
          id: 'footer-section-2',
          sectionName: 'FOOTER_CONTACT',
          fluidEngineContext: {
            gridContents: [
              makeTextBlock('f-block-2', '<p>Contact: info@example.com</p>'),
            ],
          },
        },
      ];
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      // Find text in the second section
      const result = await client.patchFooterTextBlock(
        'info@example.com',
        'contact@example.com',
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('f-block-2');
      expect(result.newHtml).toContain('contact@example.com');

      fetchSpy.mockRestore();
    });
  });

  // ── Embedded footer sections path ──────────────────────────────────────
  // These tests cover the case where config.footer.sections is an inline
  // array rather than pointing to a separate pageSectionsId resource.

  describe('patchFooterTextBlock — embedded sections path', () => {
    function makeEmbeddedConfig(sections: PageSection[]) {
      return {
        header: { enabled: true },
        footer: {
          enabled: true,
          // No pageSectionsId — sections are embedded directly
          sections,
        },
      };
    }

    it('saves via saveHeaderFooter when pageSectionsId is absent', async () => {
      const embeddedSections = makeFooterSections(
        makeTextBlock('e-block-1', '<p>Call us: (555) 111-2222</p>'),
      );
      const config = makeEmbeddedConfig(embeddedSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // getFooterSections: GET /api/site-header-footer (returns embedded sections)
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        // patchFooterTextBlock re-fetches config before saving: GET /api/site-header-footer
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        // saveHeaderFooter: PUT /api/site-header-footer
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.patchFooterTextBlock('(555) 111-2222', '(555) 999-8888');

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('e-block-1');
      expect(result.newHtml).toContain('(555) 999-8888');
      expect(result.newHtml).not.toContain('(555) 111-2222');

      // Verify that the PUT went to /api/site-header-footer (not page-sections)
      const putCall = fetchSpy.mock.calls.find(
        (call) => (call[1] as RequestInit)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(putCall![0] as string).toContain('/api/site-header-footer');

      fetchSpy.mockRestore();
    });

    it('does NOT call savePageSections for the embedded path', async () => {
      const embeddedSections = makeFooterSections(
        makeTextBlock('e-block-2', '<p>Hours: 9am-5pm</p>'),
      );
      const config = makeEmbeddedConfig(embeddedSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.patchFooterTextBlock('9am-5pm', '10am-6pm');

      // None of the fetch calls should be to /api/page-sections/...
      const pageSecCalls = fetchSpy.mock.calls.filter(
        (call) => (call[0] as string).includes('/api/page-sections/'),
      );
      expect(pageSecCalls).toHaveLength(0);

      fetchSpy.mockRestore();
    });

    it('returns error when saveHeaderFooter fails on embedded path', async () => {
      const embeddedSections = makeFooterSections(
        makeTextBlock('e-block-3', '<p>Address: 99 Test St</p>'),
      );
      const config = makeEmbeddedConfig(embeddedSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        // saveHeaderFooter fails
        .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }));

      const result = await client.patchFooterTextBlock('99 Test St', '100 New St');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      fetchSpy.mockRestore();
    });

    it('puts updated sections into footer.sections on save', async () => {
      const embeddedSections = makeFooterSections(
        makeTextBlock('e-block-4', '<p>Old phone: (555) 000-0000</p>'),
      );
      const config = makeEmbeddedConfig(embeddedSections);

      let capturedPutBody: Record<string, unknown> | null = null;
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockImplementationOnce(async (_url, init) => {
          capturedPutBody = JSON.parse((init as RequestInit).body as string);
          return new Response('{}', { status: 200 });
        });

      await client.patchFooterTextBlock('(555) 000-0000', '(555) 123-4567');

      // The PUT body should have the updated text in footer.sections
      expect(capturedPutBody).not.toBeNull();
      const footer = (capturedPutBody as Record<string, unknown>).footer as Record<string, unknown>;
      expect(footer).toBeDefined();
      const savedSections = footer.sections as PageSection[];
      expect(savedSections).toBeDefined();
      const savedHtml = savedSections[0].fluidEngineContext?.gridContents[0].content.value.value?.html ?? '';
      expect(savedHtml).toContain('(555) 123-4567');
      expect(savedHtml).not.toContain('(555) 000-0000');

      fetchSpy.mockRestore();
    });
  });

  describe('updateFooterTextBlock — embedded sections path', () => {
    function makeEmbeddedConfig(sections: PageSection[]) {
      return {
        header: { enabled: true },
        footer: {
          enabled: true,
          sections,
        },
      };
    }

    it('saves via saveHeaderFooter when pageSectionsId is absent', async () => {
      const embeddedSections = makeFooterSections(
        makeTextBlock('u-block-1', '<p>Old business hours</p>'),
      );
      const config = makeEmbeddedConfig(embeddedSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        // getFooterSections: GET /api/site-header-footer
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        // updateFooterTextBlock re-fetches config: GET /api/site-header-footer
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        // saveHeaderFooter: PUT /api/site-header-footer
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateFooterTextBlock(
        'Old business hours',
        'New business hours: Mon-Sat 9am-7pm',
      );

      expect(result.success).toBe(true);
      expect(result.blockId).toBe('u-block-1');
      expect(result.newHtml).toContain('New business hours');

      // Verify the PUT went to /api/site-header-footer
      const putCall = fetchSpy.mock.calls.find(
        (call) => (call[1] as RequestInit)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(putCall![0] as string).toContain('/api/site-header-footer');

      fetchSpy.mockRestore();
    });

    it('does NOT call savePageSections for the embedded path', async () => {
      const embeddedSections = makeFooterSections(
        makeTextBlock('u-block-2', '<p>Contact email: old@example.com</p>'),
      );
      const config = makeEmbeddedConfig(embeddedSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await client.updateFooterTextBlock('old@example.com', 'new@example.com');

      const pageSecCalls = fetchSpy.mock.calls.filter(
        (call) => (call[0] as string).includes('/api/page-sections/'),
      );
      expect(pageSecCalls).toHaveLength(0);

      fetchSpy.mockRestore();
    });

    it('regular pageSectionsId path still uses savePageSections', async () => {
      const config = makeHeaderFooterConfig('footer-psid-1');
      const footerSections = makeFooterSections(
        makeTextBlock('r-block-1', '<p>Regular footer text</p>'),
      );
      const footerData = makePageSectionsData(footerSections);

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(config), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(footerData), { status: 200 }))
        // savePageSections PUT
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const result = await client.updateFooterTextBlock(
        'Regular footer text',
        'Updated regular footer text',
      );

      expect(result.success).toBe(true);

      // The PUT should go to /api/page-sections/... not /api/site-header-footer
      const putCall = fetchSpy.mock.calls.find(
        (call) => (call[1] as RequestInit)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(putCall![0] as string).toContain('/api/page-sections/');

      fetchSpy.mockRestore();
    });
  });
});
