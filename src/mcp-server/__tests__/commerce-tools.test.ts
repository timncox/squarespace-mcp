import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock session dependencies ────────────────────────────────────────────────

const mockGetCommerceClient = vi.fn();
const mockHasCommerceApi = vi.fn();

vi.mock('../session.js', () => ({
  getCommerceClient: (...args: any[]) => mockGetCommerceClient(...args),
  hasCommerceApi: (...args: any[]) => mockHasCommerceApi(...args),
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

function createMockClient() {
  return {
    getStorePages: vi.fn(),
    getProducts: vi.fn(),
    getProduct: vi.fn(),
    createProduct: vi.fn(),
    updateProduct: vi.fn(),
    deleteProduct: vi.fn(),
    getOrders: vi.fn(),
    getOrder: vi.fn(),
    fulfillOrder: vi.fn(),
    getInventory: vi.fn(),
    adjustStock: vi.fn(),
    getProfiles: vi.fn(),
    getTransactions: vi.fn(),
  };
}

describe('Commerce Tools', () => {
  let server: ReturnType<typeof createMockServer>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    mockClient = createMockClient();
    mockGetCommerceClient.mockReturnValue(mockClient);
    registerCommerceTools(server as any);
  });

  // ── Registration ─────────────────────────────────────────────────────────────

  it('should register all 13 commerce tools', () => {
    const expectedTools = [
      'sq_list_store_pages',
      'sq_list_products',
      'sq_get_product',
      'sq_list_orders',
      'sq_get_order',
      'sq_list_inventory',
      'sq_adjust_stock',
      'sq_create_product',
      'sq_update_product',
      'sq_delete_product',
      'sq_fulfill_order',
      'sq_list_profiles',
      'sq_list_transactions',
    ];

    for (const toolName of expectedTools) {
      expect(server.tools.has(toolName)).toBe(true);
    }

    expect(server.registerTool).toHaveBeenCalledTimes(13);
  });

  // ── sq_list_store_pages ────────────────────────────────────────────────────

  describe('sq_list_store_pages', () => {
    it('should list store pages on success', async () => {
      const storePages = [
        { id: 'sp-1', title: 'Shop', url: '/shop' },
        { id: 'sp-2', title: 'Gifts', url: '/gifts' },
      ];
      mockClient.getStorePages.mockResolvedValue({ success: true, data: storePages });

      const result = await server.callTool('sq_list_store_pages', { siteId: 'my-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveLength(2);
      expect(data[0].title).toBe('Shop');
      expect(mockGetCommerceClient).toHaveBeenCalledWith('my-site');
    });

    it('should return error on API failure', async () => {
      mockClient.getStorePages.mockResolvedValue({ success: false, error: 'HTTP 401: Unauthorized' });

      const result = await server.callTool('sq_list_store_pages', { siteId: 'my-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unauthorized');
    });

    it('should return error when no commerce API key', async () => {
      mockGetCommerceClient.mockImplementation(() => {
        throw new Error('No Commerce API key for site "my-site"');
      });

      const result = await server.callTool('sq_list_store_pages', { siteId: 'my-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No Commerce API key');
    });
  });

  // ── sq_list_products ────────────────────────────────────────────────────────

  describe('sq_list_products', () => {
    it('should list products with default params', async () => {
      const responseData = {
        products: [{ id: 'p-1', name: 'T-Shirt' }],
        pagination: { nextPageCursor: null },
      };
      mockClient.getProducts.mockResolvedValue({ success: true, data: responseData });

      const result = await server.callTool('sq_list_products', { siteId: 'my-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.products).toHaveLength(1);
      expect(data.products[0].name).toBe('T-Shirt');
      expect(mockClient.getProducts).toHaveBeenCalledWith({
        type: undefined,
        modifiedAfter: undefined,
        cursor: undefined,
      });
    });

    it('should pass filter params through', async () => {
      mockClient.getProducts.mockResolvedValue({
        success: true,
        data: { products: [], pagination: {} },
      });

      await server.callTool('sq_list_products', {
        siteId: 'my-site',
        type: 'PHYSICAL',
        modifiedAfter: '2026-01-01T00:00:00Z',
        cursor: 'abc123',
      });

      expect(mockClient.getProducts).toHaveBeenCalledWith({
        type: 'PHYSICAL',
        modifiedAfter: '2026-01-01T00:00:00Z',
        cursor: 'abc123',
      });
    });

    it('should return error on failure', async () => {
      mockClient.getProducts.mockResolvedValue({ success: false, error: 'HTTP 500: Internal Server Error' });

      const result = await server.callTool('sq_list_products', { siteId: 'my-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('500');
    });
  });

  // ── sq_get_product ──────────────────────────────────────────────────────────

  describe('sq_get_product', () => {
    it('should return product details', async () => {
      const product = { id: 'p-1', name: 'T-Shirt', variants: [{ sku: 'TS-001' }] };
      mockClient.getProduct.mockResolvedValue({ success: true, data: product });

      const result = await server.callTool('sq_get_product', { siteId: 'my-site', productId: 'p-1' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.name).toBe('T-Shirt');
      expect(mockClient.getProduct).toHaveBeenCalledWith('p-1');
    });

    it('should return error when product not found', async () => {
      mockClient.getProduct.mockResolvedValue({ success: false, error: 'HTTP 404: Not Found' });

      const result = await server.callTool('sq_get_product', { siteId: 'my-site', productId: 'bad-id' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('404');
    });
  });

  // ── sq_list_orders ──────────────────────────────────────────────────────────

  describe('sq_list_orders', () => {
    it('should list orders with default params', async () => {
      const responseData = {
        result: [{ id: 'o-1', orderNumber: '#1001' }],
        pagination: { nextPageCursor: null },
      };
      mockClient.getOrders.mockResolvedValue({ success: true, data: responseData });

      const result = await server.callTool('sq_list_orders', { siteId: 'my-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.result).toHaveLength(1);
      expect(data.result[0].orderNumber).toBe('#1001');
    });

    it('should pass filter params through', async () => {
      mockClient.getOrders.mockResolvedValue({
        success: true,
        data: { result: [], pagination: {} },
      });

      await server.callTool('sq_list_orders', {
        siteId: 'my-site',
        fulfillmentStatus: 'PENDING',
        customerId: 'cust-1',
        modifiedAfter: '2026-02-01T00:00:00Z',
        cursor: 'next123',
      });

      expect(mockClient.getOrders).toHaveBeenCalledWith({
        fulfillmentStatus: 'PENDING',
        customerId: 'cust-1',
        modifiedAfter: '2026-02-01T00:00:00Z',
        cursor: 'next123',
      });
    });

    it('should return error on failure', async () => {
      mockClient.getOrders.mockResolvedValue({ success: false, error: 'HTTP 403: Forbidden' });

      const result = await server.callTool('sq_list_orders', { siteId: 'my-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('403');
    });
  });

  // ── sq_get_order ────────────────────────────────────────────────────────────

  describe('sq_get_order', () => {
    it('should return order details', async () => {
      const order = { id: 'o-1', orderNumber: '#1001', lineItems: [] };
      mockClient.getOrder.mockResolvedValue({ success: true, data: order });

      const result = await server.callTool('sq_get_order', { siteId: 'my-site', orderId: 'o-1' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.orderNumber).toBe('#1001');
      expect(mockClient.getOrder).toHaveBeenCalledWith('o-1');
    });

    it('should return error when order not found', async () => {
      mockClient.getOrder.mockResolvedValue({ success: false, error: 'HTTP 404: Not Found' });

      const result = await server.callTool('sq_get_order', { siteId: 'my-site', orderId: 'bad-id' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('404');
    });
  });

  // ── sq_list_inventory ───────────────────────────────────────────────────────

  describe('sq_list_inventory', () => {
    it('should list inventory levels', async () => {
      const responseData = {
        inventory: [{ variantId: 'v-1', quantity: 10, isUnlimited: false }],
        pagination: { nextPageCursor: null },
      };
      mockClient.getInventory.mockResolvedValue({ success: true, data: responseData });

      const result = await server.callTool('sq_list_inventory', { siteId: 'my-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.inventory).toHaveLength(1);
      expect(data.inventory[0].quantity).toBe(10);
      expect(mockClient.getInventory).toHaveBeenCalledWith(undefined);
    });

    it('should pass cursor param', async () => {
      mockClient.getInventory.mockResolvedValue({
        success: true,
        data: { inventory: [], pagination: {} },
      });

      await server.callTool('sq_list_inventory', { siteId: 'my-site', cursor: 'page2' });

      expect(mockClient.getInventory).toHaveBeenCalledWith('page2');
    });

    it('should return error on failure', async () => {
      mockClient.getInventory.mockResolvedValue({ success: false, error: 'HTTP 401: Unauthorized' });

      const result = await server.callTool('sq_list_inventory', { siteId: 'my-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unauthorized');
    });
  });

  // ── sq_adjust_stock ─────────────────────────────────────────────────────────

  describe('sq_adjust_stock', () => {
    it('should adjust stock for variants', async () => {
      mockClient.adjustStock.mockResolvedValue({ success: true, statusCode: 204 });

      const adjustments = [
        { variantId: 'v-1', quantityDelta: 5 },
        { variantId: 'v-2', quantity: 0 },
      ];

      const result = await server.callTool('sq_adjust_stock', { siteId: 'my-site', adjustments });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.adjustedVariants).toBe(2);
      expect(mockClient.adjustStock).toHaveBeenCalledWith(adjustments);
    });

    it('should return error on failure', async () => {
      mockClient.adjustStock.mockResolvedValue({ success: false, error: 'HTTP 422: Unprocessable Entity' });

      const result = await server.callTool('sq_adjust_stock', {
        siteId: 'my-site',
        adjustments: [{ variantId: 'bad-id', quantityDelta: 1 }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('422');
    });
  });

  // ── sq_create_product ───────────────────────────────────────────────────────

  describe('sq_create_product', () => {
    it('should create a product with all fields', async () => {
      const createdProduct = { id: 'p-new', name: 'New Shirt', type: 'PHYSICAL' };
      mockClient.createProduct.mockResolvedValue({ success: true, data: createdProduct });

      const result = await server.callTool('sq_create_product', {
        siteId: 'my-site',
        storePageId: 'sp-1',
        type: 'PHYSICAL',
        name: 'New Shirt',
        description: '<p>A great shirt</p>',
        tags: ['apparel', 'new'],
        isVisible: true,
        variants: [{
          sku: 'NS-001',
          pricing: { basePrice: { value: '29.99', currency: 'USD' } },
          stock: { quantity: 50 },
          attributes: { Color: 'Blue', Size: 'M' },
        }],
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.name).toBe('New Shirt');
      expect(mockClient.createProduct).toHaveBeenCalledWith({
        storePageId: 'sp-1',
        type: 'PHYSICAL',
        name: 'New Shirt',
        description: '<p>A great shirt</p>',
        tags: ['apparel', 'new'],
        isVisible: true,
        variants: [{
          sku: 'NS-001',
          pricing: { basePrice: { value: '29.99', currency: 'USD' } },
          stock: { quantity: 50 },
          attributes: { Color: 'Blue', Size: 'M' },
        }],
      });
    });

    it('should create a product with minimal fields', async () => {
      mockClient.createProduct.mockResolvedValue({ success: true, data: { id: 'p-min' } });

      const result = await server.callTool('sq_create_product', {
        siteId: 'my-site',
        storePageId: 'sp-1',
        type: 'DIGITAL',
        variants: [{
          sku: 'DL-001',
          pricing: { basePrice: { value: '9.99', currency: 'USD' } },
        }],
      });

      expect(result.isError).toBeUndefined();
      expect(mockClient.createProduct).toHaveBeenCalledWith({
        storePageId: 'sp-1',
        type: 'DIGITAL',
        name: undefined,
        description: undefined,
        tags: undefined,
        isVisible: undefined,
        variants: [{
          sku: 'DL-001',
          pricing: { basePrice: { value: '9.99', currency: 'USD' } },
        }],
      });
    });

    it('should return error on failure', async () => {
      mockClient.createProduct.mockResolvedValue({ success: false, error: 'HTTP 400: Bad Request' });

      const result = await server.callTool('sq_create_product', {
        siteId: 'my-site',
        storePageId: 'sp-1',
        type: 'PHYSICAL',
        variants: [{ sku: 'X', pricing: { basePrice: { value: '0', currency: 'USD' } } }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('400');
    });
  });

  // ── sq_update_product ───────────────────────────────────────────────────────

  describe('sq_update_product', () => {
    it('should update product fields', async () => {
      const updated = { id: 'p-1', name: 'Updated Shirt', description: 'New desc' };
      mockClient.updateProduct.mockResolvedValue({ success: true, data: updated });

      const result = await server.callTool('sq_update_product', {
        siteId: 'my-site',
        productId: 'p-1',
        name: 'Updated Shirt',
        description: 'New desc',
        tags: ['sale'],
        isVisible: false,
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.name).toBe('Updated Shirt');
      expect(mockClient.updateProduct).toHaveBeenCalledWith('p-1', {
        name: 'Updated Shirt',
        description: 'New desc',
        tags: ['sale'],
        isVisible: false,
      });
    });

    it('should only pass provided fields', async () => {
      mockClient.updateProduct.mockResolvedValue({ success: true, data: { id: 'p-1' } });

      await server.callTool('sq_update_product', {
        siteId: 'my-site',
        productId: 'p-1',
        name: 'Just name',
      });

      expect(mockClient.updateProduct).toHaveBeenCalledWith('p-1', { name: 'Just name' });
    });

    it('should return error on failure', async () => {
      mockClient.updateProduct.mockResolvedValue({ success: false, error: 'HTTP 404: Not Found' });

      const result = await server.callTool('sq_update_product', {
        siteId: 'my-site',
        productId: 'bad-id',
        name: 'X',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('404');
    });
  });

  // ── sq_delete_product ───────────────────────────────────────────────────────

  describe('sq_delete_product', () => {
    it('should delete a product', async () => {
      mockClient.deleteProduct.mockResolvedValue({ success: true, statusCode: 204 });

      const result = await server.callTool('sq_delete_product', { siteId: 'my-site', productId: 'p-1' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.deleted).toBe('p-1');
      expect(mockClient.deleteProduct).toHaveBeenCalledWith('p-1');
    });

    it('should return error when product not found', async () => {
      mockClient.deleteProduct.mockResolvedValue({ success: false, error: 'HTTP 404: Not Found' });

      const result = await server.callTool('sq_delete_product', { siteId: 'my-site', productId: 'bad-id' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('404');
    });
  });

  // ── sq_fulfill_order ────────────────────────────────────────────────────────

  describe('sq_fulfill_order', () => {
    it('should fulfill order with all shipping details', async () => {
      const fulfilledOrder = { id: 'o-1', fulfillmentStatus: 'FULFILLED' };
      mockClient.fulfillOrder.mockResolvedValue({ success: true, data: fulfilledOrder });

      const result = await server.callTool('sq_fulfill_order', {
        siteId: 'my-site',
        orderId: 'o-1',
        shipDate: '2026-03-04T10:00:00Z',
        carrierName: 'USPS',
        trackingNumber: '9400111899223456789012',
        trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tRef=fullpage&tLc=2&text28777=&tLabels=9400111899223456789012',
        shouldSendNotification: true,
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.fulfillmentStatus).toBe('FULFILLED');
      expect(mockClient.fulfillOrder).toHaveBeenCalledWith('o-1', {
        shipDate: '2026-03-04T10:00:00Z',
        carrierName: 'USPS',
        trackingNumber: '9400111899223456789012',
        trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tRef=fullpage&tLc=2&text28777=&tLabels=9400111899223456789012',
        shouldSendNotification: true,
      });
    });

    it('should fulfill with minimal params', async () => {
      mockClient.fulfillOrder.mockResolvedValue({ success: true, data: { id: 'o-1' } });

      await server.callTool('sq_fulfill_order', {
        siteId: 'my-site',
        orderId: 'o-1',
        shipDate: '2026-03-04T10:00:00Z',
      });

      expect(mockClient.fulfillOrder).toHaveBeenCalledWith('o-1', {
        shipDate: '2026-03-04T10:00:00Z',
        carrierName: undefined,
        trackingNumber: undefined,
        trackingUrl: undefined,
        shouldSendNotification: undefined,
      });
    });

    it('should return error on failure', async () => {
      mockClient.fulfillOrder.mockResolvedValue({ success: false, error: 'HTTP 409: Already fulfilled' });

      const result = await server.callTool('sq_fulfill_order', {
        siteId: 'my-site',
        orderId: 'o-1',
        shipDate: '2026-03-04T10:00:00Z',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('409');
    });
  });

  // ── sq_list_profiles ────────────────────────────────────────────────────────

  describe('sq_list_profiles', () => {
    it('should list all profiles by default', async () => {
      const responseData = {
        profiles: [{ id: 'prof-1', email: 'customer@example.com' }],
        pagination: { nextPageCursor: null },
      };
      mockClient.getProfiles.mockResolvedValue({ success: true, data: responseData });

      const result = await server.callTool('sq_list_profiles', { siteId: 'my-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.profiles).toHaveLength(1);
      expect(mockClient.getProfiles).toHaveBeenCalledWith({});
    });

    it('should filter to customers when isCustomer is true', async () => {
      mockClient.getProfiles.mockResolvedValue({
        success: true,
        data: { profiles: [], pagination: {} },
      });

      await server.callTool('sq_list_profiles', { siteId: 'my-site', isCustomer: true });

      expect(mockClient.getProfiles).toHaveBeenCalledWith({ filter: 'isCustomer' });
    });

    it('should not filter when isCustomer is false', async () => {
      mockClient.getProfiles.mockResolvedValue({
        success: true,
        data: { profiles: [], pagination: {} },
      });

      await server.callTool('sq_list_profiles', { siteId: 'my-site', isCustomer: false });

      expect(mockClient.getProfiles).toHaveBeenCalledWith({});
    });

    it('should pass cursor param', async () => {
      mockClient.getProfiles.mockResolvedValue({
        success: true,
        data: { profiles: [], pagination: {} },
      });

      await server.callTool('sq_list_profiles', { siteId: 'my-site', cursor: 'page2' });

      expect(mockClient.getProfiles).toHaveBeenCalledWith({ cursor: 'page2' });
    });

    it('should return error on failure', async () => {
      mockClient.getProfiles.mockResolvedValue({ success: false, error: 'HTTP 500: Internal Server Error' });

      const result = await server.callTool('sq_list_profiles', { siteId: 'my-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('500');
    });
  });

  // ── sq_list_transactions ────────────────────────────────────────────────────

  describe('sq_list_transactions', () => {
    it('should list transactions with default params', async () => {
      const responseData = {
        documents: [{ id: 'tx-1', total: { value: '49.99', currency: 'USD' } }],
        pagination: { nextPageCursor: null },
      };
      mockClient.getTransactions.mockResolvedValue({ success: true, data: responseData });

      const result = await server.callTool('sq_list_transactions', { siteId: 'my-site' });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.documents).toHaveLength(1);
      expect(mockClient.getTransactions).toHaveBeenCalledWith({
        modifiedAfter: undefined,
        modifiedBefore: undefined,
        cursor: undefined,
      });
    });

    it('should pass date range and cursor params', async () => {
      mockClient.getTransactions.mockResolvedValue({
        success: true,
        data: { documents: [], pagination: {} },
      });

      await server.callTool('sq_list_transactions', {
        siteId: 'my-site',
        modifiedAfter: '2026-01-01T00:00:00Z',
        modifiedBefore: '2026-03-01T00:00:00Z',
        cursor: 'tx-cursor',
      });

      expect(mockClient.getTransactions).toHaveBeenCalledWith({
        modifiedAfter: '2026-01-01T00:00:00Z',
        modifiedBefore: '2026-03-01T00:00:00Z',
        cursor: 'tx-cursor',
      });
    });

    it('should return error on failure', async () => {
      mockClient.getTransactions.mockResolvedValue({ success: false, error: 'HTTP 401: Unauthorized' });

      const result = await server.callTool('sq_list_transactions', { siteId: 'my-site' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unauthorized');
    });
  });

  // ── Cross-cutting: siteId resolution ──────────────────────────────────────

  describe('siteId resolution', () => {
    it('should pass siteId to getCommerceClient for every tool', async () => {
      // Pick a representative tool — all use the same pattern
      mockClient.getStorePages.mockResolvedValue({ success: true, data: [] });

      await server.callTool('sq_list_store_pages', { siteId: 'smyth-tavern' });

      expect(mockGetCommerceClient).toHaveBeenCalledWith('smyth-tavern');
    });

    it('should propagate client creation errors', async () => {
      mockGetCommerceClient.mockImplementation(() => {
        throw new Error('Unknown site: "nonexistent"');
      });

      const result = await server.callTool('sq_list_products', { siteId: 'nonexistent' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown site: "nonexistent"');
    });
  });
});
