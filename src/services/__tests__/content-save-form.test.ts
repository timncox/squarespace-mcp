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

describe('ContentSaveClient — getAvailableForms', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns form list from { formSummaries: [...] } response shape', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          formSummaries: [
            { id: 'aabbccddee0011223344aabb', title: 'Contact Us' },
            { id: 'bbccddee0011223344aabbcc', title: 'Newsletter Signup' },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await client.getAvailableForms();

    expect(result.success).toBe(true);
    expect(result.forms).toHaveLength(2);
    expect(result.forms[0]).toEqual({ id: 'aabbccddee0011223344aabb', name: 'Contact Us' });
    expect(result.forms[1]).toEqual({ id: 'bbccddee0011223344aabbcc', name: 'Newsletter Signup' });

    fetchSpy.mockRestore();
  });

  it('returns empty list when formSummaries is null (no forms on site)', async () => {
    // This is the real response shape from grey-yellow-hbxc when no forms are created
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ formSummaries: null }), { status: 200 }),
    );

    const result = await client.getAvailableForms();

    expect(result.success).toBe(true);
    expect(result.forms).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('returns form list from flat array response shape (fallback)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: 'aabbccddee0011223344aabb', title: 'Booking Form' },
          { formId: 'bbccddee0011223344aabbcc', name: 'Quote Request' },
        ]),
        { status: 200 },
      ),
    );

    const result = await client.getAvailableForms();

    expect(result.success).toBe(true);
    expect(result.forms).toHaveLength(2);
    expect(result.forms[0]).toEqual({ id: 'aabbccddee0011223344aabb', name: 'Booking Form' });
    expect(result.forms[1]).toEqual({ id: 'bbccddee0011223344aabbcc', name: 'Quote Request' });

    fetchSpy.mockRestore();
  });

  it('returns empty list when API returns empty formSummaries array', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ formSummaries: [] }), { status: 200 }),
    );

    const result = await client.getAvailableForms();

    expect(result.success).toBe(true);
    expect(result.forms).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('returns empty list when API returns empty flat array', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 }),
    );

    const result = await client.getAvailableForms();

    expect(result.success).toBe(true);
    expect(result.forms).toHaveLength(0);

    fetchSpy.mockRestore();
  });

  it('returns { success: false } on HTTP 401', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    const result = await client.getAvailableForms();

    expect(result.success).toBe(false);
    expect(result.forms).toHaveLength(0);
    expect(result.error).toBe('HTTP 401');

    fetchSpy.mockRestore();
  });

  it('returns { success: false } on HTTP 404', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not Found', { status: 404 }),
    );

    const result = await client.getAvailableForms();

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 404');

    fetchSpy.mockRestore();
  });

  it('returns { success: false } on network error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('fetch failed'),
    );

    const result = await client.getAvailableForms();

    expect(result.success).toBe(false);
    expect(result.error).toBe('fetch failed');

    fetchSpy.mockRestore();
  });

  it('prefers title over name field for the form name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          formSummaries: [{ id: 'aabbccddee0011223344aabb', title: 'My Title', name: 'My Name' }],
        }),
        { status: 200 },
      ),
    );

    const result = await client.getAvailableForms();

    expect(result.forms[0].name).toBe('My Title');

    fetchSpy.mockRestore();
  });

  it('falls back to name field when title is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ formSummaries: [{ id: 'aabbccddee0011223344aabb', name: 'Fallback Name' }] }),
        { status: 200 },
      ),
    );

    const result = await client.getAvailableForms();

    expect(result.forms[0].name).toBe('Fallback Name');

    fetchSpy.mockRestore();
  });

  it('calls the correct endpoint URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ formSummaries: [] }), { status: 200 }),
    );

    await client.getAvailableForms();

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-site.squarespace.com/api/rolodex/1/forms');

    fetchSpy.mockRestore();
  });

  it('uses formId field as id fallback when id is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ formSummaries: [{ formId: 'ccddee001122334455aabbcc', title: 'Legacy Form' }] }),
        { status: 200 },
      ),
    );

    const result = await client.getAvailableForms();

    expect(result.forms[0].id).toBe('ccddee001122334455aabbcc');

    fetchSpy.mockRestore();
  });
});
