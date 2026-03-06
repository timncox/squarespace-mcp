import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock session dependencies ────────────────────────────────────────────────

const mockGetClient = vi.fn();

vi.mock('../session.js', () => ({
  getClient: (...args: any[]) => mockGetClient(...args),
}));

import { registerCommerceTools } from '../tools/commerce.js';

// ── Mock MCP server ──────────────────────────────────────────────────────────

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

// ── Helper to create a mock client ───────────────────────────────────────────

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    createProductShell: vi.fn().mockResolvedValue({ success: true, data: { id: 'prod-1', variants: [{ id: 'v1', sku: 'SQ0000001' }] } }),
    getProduct: vi.fn().mockResolvedValue({ success: true, data: { id: 'prod-1', name: 'Hat' } }),
    updateProduct: vi.fn().mockResolvedValue({ success: true, data: { id: 'prod-1', name: 'Hat' } }),
    deleteProduct: vi.fn().mockResolvedValue({ success: true }),
    attachProductImage: vi.fn().mockResolvedValue({ success: true, data: { id: 'img-1' } }),
    setProductThumbnail: vi.fn().mockResolvedValue({ success: true, data: { id: 'prod-1' } }),
    updateProductImage: vi.fn().mockResolvedValue({ success: true, data: { id: 'img-1' } }),
    createStorePage: vi.fn().mockResolvedValue({ success: true, data: { id: 'store-1', urlId: 'store' } }),
    listProducts: vi.fn().mockResolvedValue({ success: true, data: { products: [] } }),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Commerce MCP Tools (Internal API)', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerCommerceTools(server as any);
  });

  it('registers all expected tools', () => {
    const toolNames = [...server.tools.keys()];
    expect(toolNames).toContain('sq_create_store_page');
    expect(toolNames).toContain('sq_create_product');
    expect(toolNames).toContain('sq_update_product');
    expect(toolNames).toContain('sq_get_product');
    expect(toolNames).toContain('sq_delete_product');
    expect(toolNames).toContain('sq_list_products');
    expect(toolNames).toContain('sq_attach_product_image');
    expect(toolNames).toContain('sq_set_product_thumbnail');
  });

  it('sq_create_product creates shell then updates with details', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    const result = await server.callTool('sq_create_product', {
      siteId: 'test',
      collectionId: 'store-1',
      name: 'Blue Hat',
      price: '35.00',
      description: 'Nice hat',
    });

    expect(mockClient.createProductShell).toHaveBeenCalledWith('store-1', 1);
    expect(mockClient.updateProduct).toHaveBeenCalled();
    const updateArgs = mockClient.updateProduct.mock.calls[0][1];
    expect(updateArgs.name).toBe('Blue Hat');
  });

  it('sq_create_product handles variants', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    await server.callTool('sq_create_product', {
      siteId: 'test',
      collectionId: 'store-1',
      name: 'Hoodie',
      price: '75.00',
      variants: [
        { attributes: { Size: 'Small' }, price: '75.00' },
        { attributes: { Size: 'Medium' }, price: '75.00' },
        { attributes: { Size: 'Large' }, price: '75.00' },
      ],
    });

    const updateArgs = mockClient.updateProduct.mock.calls[0][1];
    expect(updateArgs.createdVariants).toHaveLength(3);
    expect(updateArgs.deletedVariants).toHaveLength(1); // deletes default variant
    expect(updateArgs.variantOptionOrdering).toContain('Size');
  });

  it('sq_attach_product_image calls attachProductImage + setProductThumbnail', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    await server.callTool('sq_attach_product_image', {
      siteId: 'test',
      productId: 'prod-1',
      assetId: 'timestamp-RANDOM',
      setAsThumbnail: true,
    });

    expect(mockClient.attachProductImage).toHaveBeenCalledWith('prod-1', 'timestamp-RANDOM');
    expect(mockClient.setProductThumbnail).toHaveBeenCalledWith('prod-1', 'timestamp-RANDOM');
  });

  it('sq_attach_product_image removes existing images when replaceExisting is true', async () => {
    const mockClient = createMockClient({
      getProduct: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: 'prod-1',
          name: 'Hat',
          images: [
            { id: 'old-img-1', systemDataId: 'sys-1' },
            { id: 'old-img-2', systemDataId: 'sys-2' },
          ],
        },
      }),
      removeProductImage: vi.fn().mockResolvedValue({ success: true }),
    });
    mockGetClient.mockReturnValue(mockClient);

    await server.callTool('sq_attach_product_image', {
      siteId: 'test',
      productId: 'prod-1',
      assetId: 'new-asset',
      replaceExisting: true,
    });

    expect(mockClient.getProduct).toHaveBeenCalledWith('prod-1');
    expect(mockClient.removeProductImage).toHaveBeenCalledTimes(2);
    expect(mockClient.removeProductImage).toHaveBeenCalledWith('prod-1', 'old-img-1');
    expect(mockClient.removeProductImage).toHaveBeenCalledWith('prod-1', 'old-img-2');
    expect(mockClient.attachProductImage).toHaveBeenCalledWith('prod-1', 'new-asset');
  });

  it('sq_attach_product_image does not remove images when replaceExisting is false', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    await server.callTool('sq_attach_product_image', {
      siteId: 'test',
      productId: 'prod-1',
      assetId: 'new-asset',
      replaceExisting: false,
    });

    expect(mockClient.getProduct).not.toHaveBeenCalled();
    expect(mockClient.removeProductImage).toBeUndefined();
    expect(mockClient.attachProductImage).toHaveBeenCalledWith('prod-1', 'new-asset');
  });

  it('sq_attach_product_image does not remove images when replaceExisting is omitted', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    await server.callTool('sq_attach_product_image', {
      siteId: 'test',
      productId: 'prod-1',
      assetId: 'new-asset',
    });

    expect(mockClient.getProduct).not.toHaveBeenCalled();
    expect(mockClient.attachProductImage).toHaveBeenCalledWith('prod-1', 'new-asset');
  });

  it('sq_attach_product_image skips thumbnail when not requested', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    await server.callTool('sq_attach_product_image', {
      siteId: 'test',
      productId: 'prod-1',
      assetId: 'timestamp-RANDOM',
    });

    expect(mockClient.attachProductImage).toHaveBeenCalled();
    expect(mockClient.setProductThumbnail).not.toHaveBeenCalled();
  });

  it('sq_create_store_page calls createStorePage', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    const result = await server.callTool('sq_create_store_page', { siteId: 'test' });

    expect(mockClient.createStorePage).toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ id: 'store-1' });
  });

  it('sq_update_product passes variant updates', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    await server.callTool('sq_update_product', {
      siteId: 'test',
      productId: 'prod-1',
      name: 'Updated Hat',
      updatedVariants: [{ id: 'v1', sku: 'SQ001', price: '40.00' }],
    });

    expect(mockClient.updateProduct).toHaveBeenCalled();
    const args = mockClient.updateProduct.mock.calls[0][1];
    expect(args.name).toBe('Updated Hat');
    expect(args.updatedVariants[0].price.decimalValue).toBe('40.00');
  });

  it('sq_get_product fetches product by ID', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    const result = await server.callTool('sq_get_product', {
      siteId: 'test',
      productId: 'prod-1',
    });

    expect(mockClient.getProduct).toHaveBeenCalledWith('prod-1');
    expect(JSON.parse(result.content[0].text).name).toBe('Hat');
  });

  it('sq_delete_product deletes a product', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    const result = await server.callTool('sq_delete_product', {
      siteId: 'test',
      productId: 'prod-1',
    });

    expect(mockClient.deleteProduct).toHaveBeenCalledWith('prod-1');
    expect(JSON.parse(result.content[0].text).success).toBe(true);
  });

  it('sq_list_products lists products', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    const result = await server.callTool('sq_list_products', { siteId: 'test' });

    expect(mockClient.listProducts).toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).products).toEqual([]);
  });

  it('sq_set_product_thumbnail sets thumbnail', async () => {
    const mockClient = createMockClient();
    mockGetClient.mockReturnValue(mockClient);

    await server.callTool('sq_set_product_thumbnail', {
      siteId: 'test',
      productId: 'prod-1',
      assetId: 'timestamp-RANDOM',
    });

    expect(mockClient.setProductThumbnail).toHaveBeenCalledWith('prod-1', 'timestamp-RANDOM');
  });

  it('handles errors gracefully', async () => {
    const mockClient = createMockClient({
      getProduct: vi.fn().mockResolvedValue({ success: false, error: 'Not found' }),
    });
    mockGetClient.mockReturnValue(mockClient);

    const result = await server.callTool('sq_get_product', {
      siteId: 'test',
      productId: 'bad-id',
    });

    expect(result.isError).toBe(true);
  });
});
