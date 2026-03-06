import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent, PageSectionsData } from '../content-save.js';

// ── Mock session file ─────────────────────────────────────────────────────

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMapBlock(blockId: string, lat: number, lng: number, zoom = 14): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 12 } },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 12 } },
    },
    content: {
      value: {
        id: blockId,
        type: 1337,
        value: {
          location: { mapLat: lat, mapLng: lng, mapZoom: zoom },
          vSize: 12,
          style: 2,
          labels: true,
          terrain: false,
          controls: false,
        },
      },
    },
  };
}

function makeTextBlock(blockId: string, html: string): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 13, y: 3 } },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 } },
    },
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
        gridSettings: {
          breakpointSettings: {
            desktop: { columns: 24, rows: 8 },
            mobile: { columns: 8, rows: 6 },
          },
        },
      },
    },
  ];
}

function makePageSectionsData(sections: PageSection[]): PageSectionsData {
  return {
    id: 'ps-1',
    websiteId: 'ws-1',
    collectionId: 'col-1',
    sections,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Map Block — buildMapBlockContent', () => {
  it('should build map block content with defaults', () => {
    const content = ContentSaveClient.buildMapBlockContent('map-001', 40.72, -74.0);

    expect(content.value.type).toBe(1337);
    expect(content.value.id).toBe('map-001');
    expect(content.value.value.location.mapLat).toBe(40.72);
    expect(content.value.value.location.mapLng).toBe(-74.0);
    expect(content.value.value.location.mapZoom).toBe(14);
    expect(content.value.value.vSize).toBe(12);
    expect(content.value.value.style).toBe(2);
    expect(content.value.value.labels).toBe(true);
    expect(content.value.value.terrain).toBe(false);
    expect(content.value.value.controls).toBe(false);
  });

  it('should accept custom options', () => {
    const content = ContentSaveClient.buildMapBlockContent('map-002', 51.5, -0.12, {
      zoom: 18,
      style: 3,
      labels: false,
      terrain: true,
      controls: true,
    });

    expect(content.value.value.location.mapZoom).toBe(18);
    expect(content.value.value.style).toBe(3);
    expect(content.value.value.labels).toBe(false);
    expect(content.value.value.terrain).toBe(true);
    expect(content.value.value.controls).toBe(true);
  });
});

describe('Map Block — addMapBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should add a map block with default layout (24 cols × 12 rows)', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addMapBlock('ps-1', 'col-1', 0, 40.72, -74.0);

    expect(result.success).toBe(true);
    expect(result.blockId).toBeTruthy();
    expect(result.sectionIndex).toBe(0);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const addedBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    expect(addedBlock.content.value.type).toBe(1337);
    expect(addedBlock.content.value.value.location.mapLat).toBe(40.72);
    expect(addedBlock.content.value.value.location.mapLng).toBe(-74.0);
    expect(addedBlock.layout.desktop.start.x).toBe(1);
    expect(addedBlock.layout.desktop.end.x).toBe(25);
    expect(addedBlock.layout.desktop.end.y - addedBlock.layout.desktop.start.y).toBe(12);
  });

  it('should place map block below existing blocks', async () => {
    const existingBlock = makeTextBlock('text-1', 'Hello');
    existingBlock.layout.desktop = { start: { x: 1, y: 0 }, end: { x: 13, y: 5 } };
    existingBlock.layout.mobile = { start: { x: 1, y: 0 }, end: { x: 9, y: 5 } };
    const sections = makeSections(existingBlock);
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.addMapBlock('ps-1', 'col-1', 0, 40.72, -74.0);

    expect(result.success).toBe(true);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const mapBlock = putBody.sections[0].fluidEngineContext.gridContents[1];

    expect(mapBlock.layout.desktop.start.y).toBe(7); // 5 + 2 gap
    expect(mapBlock.layout.desktop.end.y).toBe(19); // 7 + 12
  });

  it('should return error for invalid section index', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.addMapBlock('ps-1', 'col-1', 5, 40.72, -74.0);

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');
  });

  it('should accept custom zoom and style', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addMapBlock('ps-1', 'col-1', 0, 40.72, -74.0, {
      zoom: 18,
      style: 3,
      labels: false,
    });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const mapBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    expect(mapBlock.content.value.value.location.mapZoom).toBe(18);
    expect(mapBlock.content.value.value.style).toBe(3);
    expect(mapBlock.content.value.value.labels).toBe(false);
  });
});

describe('Map Block — updateMapBlock', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should update map block location', async () => {
    const sections = makeSections(makeMapBlock('map-001', 40.72, -74.0));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateMapBlock('ps-1', 'col-1', 'map', {
      lat: 51.5074,
      lng: -0.1278,
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('map-001');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.location.mapLat).toBe(51.5074);
    expect(block.content.value.value.location.mapLng).toBe(-0.1278);
  });

  it('should update zoom and style without changing location', async () => {
    const sections = makeSections(makeMapBlock('map-001', 40.72, -74.0, 14));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.updateMapBlock('ps-1', 'col-1', '', {
      zoom: 18,
      style: 3,
      labels: false,
      terrain: true,
    });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];

    expect(block.content.value.value.location.mapLat).toBe(40.72);
    expect(block.content.value.value.location.mapZoom).toBe(18);
    expect(block.content.value.value.style).toBe(3);
    expect(block.content.value.value.labels).toBe(false);
    expect(block.content.value.value.terrain).toBe(true);
  });

  it('should find map block by ID prefix', async () => {
    const sections = makeSections(
      makeTextBlock('text-1', 'Hello'),
      makeMapBlock('map-specific-001', 40.72, -74.0),
    );
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateMapBlock('ps-1', 'col-1', 'map-specific', {
      zoom: 16,
    });

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('map-specific-001');
  });

  it('should return error when no map block found', async () => {
    const sections = makeSections(makeTextBlock('text-1', 'Hello'));
    const data = makePageSectionsData(sections);

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));

    const result = await client.updateMapBlock('ps-1', 'col-1', 'map', {
      zoom: 16,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No map block found');
  });
});
