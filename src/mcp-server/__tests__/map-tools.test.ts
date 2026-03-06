import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  addMapBlock: vi.fn(),
  updateMapBlock: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async () => ({ pageSectionsId: 'ps-1', collectionId: 'col-1' })),
}));

vi.mock('../../services/geocoding.js', () => ({
  geocodeAddress: vi.fn(async (address: string) => {
    if (address === 'FAIL') throw new Error('No geocoding results found for address: "FAIL"');
    return { lat: 40.7207559, lng: -74.0007613 };
  }),
}));

import { registerBlockTools } from '../tools/blocks.js';
import { geocodeAddress } from '../../services/geocoding.js';

function createMockServer() {
  const tools = new Map<string, { config: any; handler: Function }>();
  return {
    registerTool: vi.fn((name: string, config: any, handler: Function) => {
      tools.set(name, { config, handler });
    }),
    tools,
    callTool: async (name: string, params: any) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(params);
    },
  };
}

describe('Map MCP Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerBlockTools(server as any);
  });

  it('should register sq_add_map and sq_update_map', () => {
    expect(server.tools.has('sq_add_map')).toBe(true);
    expect(server.tools.has('sq_update_map')).toBe(true);
  });

  // ── sq_add_map ──────────────────────────────────────────────────────────

  describe('sq_add_map', () => {
    it('should geocode address and add map block', async () => {
      mockClient.addMapBlock.mockResolvedValue({
        success: true,
        blockId: 'map-001',
        sectionId: 'section-1',
        sectionIndex: 0,
      });

      const result = await server.callTool('sq_add_map', {
        siteId: 'test-site',
        pageSlug: 'contact',
        sectionIndex: 0,
        address: '80 Spring St, New York, NY',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('map-001');
      expect(data.geocoded.lat).toBeCloseTo(40.72);
      expect(data.geocoded.lng).toBeCloseTo(-74.0);

      // Verify geocodeAddress was called
      expect(geocodeAddress).toHaveBeenCalledWith('80 Spring St, New York, NY');

      // Verify addMapBlock was called with geocoded coords
      expect(mockClient.addMapBlock).toHaveBeenCalledWith(
        'ps-1', 'col-1', 0, 40.7207559, -74.0007613,
        expect.objectContaining({}),
      );
    });

    it('should pass zoom and style options', async () => {
      mockClient.addMapBlock.mockResolvedValue({ success: true, blockId: 'map-002' });

      await server.callTool('sq_add_map', {
        siteId: 'test-site',
        pageSlug: 'contact',
        sectionIndex: 0,
        address: '123 Main St',
        zoom: 18,
        style: 3,
        labels: false,
        terrain: true,
      });

      expect(mockClient.addMapBlock).toHaveBeenCalledWith(
        'ps-1', 'col-1', 0, 40.7207559, -74.0007613,
        expect.objectContaining({ zoom: 18, style: 3, labels: false, terrain: true }),
      );
    });

    it('should return error when geocoding fails', async () => {
      const result = await server.callTool('sq_add_map', {
        siteId: 'test-site',
        pageSlug: 'contact',
        sectionIndex: 0,
        address: 'FAIL',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No geocoding results');
      expect(mockClient.addMapBlock).not.toHaveBeenCalled();
    });

    it('should resolve offsetColumns to startX/endX', async () => {
      mockClient.addMapBlock.mockResolvedValue({ success: true, blockId: 'map-003' });

      await server.callTool('sq_add_map', {
        siteId: 'test-site',
        pageSlug: 'contact',
        sectionIndex: 0,
        address: '123 Main St',
        layout: { offsetColumns: 4, columns: 16 },
      });

      const call = mockClient.addMapBlock.mock.calls[0];
      const opts = call[5];
      expect(opts.layout.startX).toBe(5); // offsetColumns + 1
      expect(opts.layout.endX).toBe(21); // 5 + 16
    });
  });

  // ── sq_update_map ───────────────────────────────────────────────────────

  describe('sq_update_map', () => {
    it('should geocode new address and update map', async () => {
      mockClient.updateMapBlock.mockResolvedValue({ success: true, blockId: 'map-001' });

      const result = await server.callTool('sq_update_map', {
        siteId: 'test-site',
        pageSlug: 'contact',
        address: '10 Downing Street, London',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);

      expect(geocodeAddress).toHaveBeenCalledWith('10 Downing Street, London');
      expect(mockClient.updateMapBlock).toHaveBeenCalledWith(
        'ps-1', 'col-1', '',
        expect.objectContaining({ lat: 40.7207559, lng: -74.0007613 }),
      );
    });

    it('should update zoom only without geocoding', async () => {
      mockClient.updateMapBlock.mockResolvedValue({ success: true, blockId: 'map-001' });

      await server.callTool('sq_update_map', {
        siteId: 'test-site',
        pageSlug: 'contact',
        zoom: 18,
      });

      expect(geocodeAddress).not.toHaveBeenCalled();
      expect(mockClient.updateMapBlock).toHaveBeenCalledWith(
        'ps-1', 'col-1', '',
        { zoom: 18 },
      );
    });

    it('should return error when geocoding fails', async () => {
      const result = await server.callTool('sq_update_map', {
        siteId: 'test-site',
        pageSlug: 'contact',
        address: 'FAIL',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No geocoding results');
    });
  });
});
