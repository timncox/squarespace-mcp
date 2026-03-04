import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommerceApiClient } from '../commerce-api.js';
import type {
  CreateProductData,
  UpdateProductData,
  FulfillmentData,
  StockAdjustment,
} from '../commerce-api-types.js';

// ── Mock logger ──────────────────────────────────────────────────────────────

vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Mock crypto.randomUUID ───────────────────────────────────────────────────

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const API_KEY = 'test-api-key-abc123';
const SITE_ID = 'site-id-xyz';

let client: CommerceApiClient;
let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `Error ${status}`,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  };
}

function mockFetch204() {
  return {
    ok: true,
    status: 204,
    statusText: 'No Content',
    json: vi.fn(),
    text: vi.fn().mockResolvedValue(''),
  };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  client = new CommerceApiClient(API_KEY, SITE_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CommerceApiClient', () => {
  describe('constructor', () => {
    it('stores apiKey and siteId', () => {
      // Access private fields via cast to verify construction
      expect((client as any).apiKey).toBe(API_KEY);
      expect((client as any).siteId).toBe(SITE_ID);
    });
  });

  describe('buildHeaders()', () => {
    it('includes Bearer auth and User-Agent', () => {
      const headers = client.buildHeaders();
      expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
      expect(headers['User-Agent']).toBe('SquarespaceHelper/1.0');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('includes Idempotency-Key when provided', () => {
      const headers = client.buildHeaders({ idempotencyKey: 'my-key' });
      expect(headers['Idempotency-Key']).toBe('my-key');
    });

    it('omits Idempotency-Key when not provided', () => {
      const headers = client.buildHeaders();
      expect(headers['Idempotency-Key']).toBeUndefined();
    });
  });

  describe('request()', () => {
    it('makes GET request with correct v2 URL', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ storePages: [] }));

      await client.request('GET', '/store_pages', { apiVersion: '2' });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/2/commerce/store_pages',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('makes GET request with correct v1.0 URL', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ result: [] }));

      await client.request('GET', '/orders', { apiVersion: '1.0' });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/1.0/commerce/orders',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('defaults to v1.0 when no apiVersion specified', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}));

      await client.request('GET', '/test');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/1.0/commerce/test',
        expect.anything()
      );
    });

    it('sends JSON body for POST requests', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ id: 'prod-1' }));

      await client.request('POST', '/products', {
        body: { name: 'Test Product' },
        apiVersion: '2',
      });

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.body).toBe(JSON.stringify({ name: 'Test Product' }));
    });

    it('returns success with data on 200', async () => {
      const payload = { id: '123', name: 'Widget' };
      fetchMock.mockResolvedValueOnce(mockFetchResponse(payload));

      const result = await client.request('GET', '/products/123', { apiVersion: '2' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(payload);
      expect(result.statusCode).toBe(200);
    });

    it('returns success with no data on 204', async () => {
      fetchMock.mockResolvedValueOnce(mockFetch204());

      const result = await client.request('DELETE', '/products/123', { apiVersion: '2' });

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(204);
    });

    it('returns error on non-OK response', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ message: 'Not found' }, 404));

      const result = await client.request('GET', '/products/bad-id', { apiVersion: '2' });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
      expect(result.error).toContain('404');
    });

    it('returns error on network failure', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network unreachable'));

      const result = await client.request('GET', '/products', { apiVersion: '2' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network unreachable');
    });
  });

  // ── Store Pages ────────────────────────────────────────────────────────

  describe('getStorePages()', () => {
    it('calls correct endpoint and returns store pages', async () => {
      const pages = [{ id: 'sp-1', title: 'Shop', isEnabled: true, url: '/shop' }];
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ storePages: pages }));

      const result = await client.getStorePages();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/2/commerce/store_pages',
        expect.anything()
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual(pages);
    });

    it('returns empty array when no store pages', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ storePages: [] }));

      const result = await client.getStorePages();
      expect(result.data).toEqual([]);
    });
  });

  // ── Products ───────────────────────────────────────────────────────────

  describe('getProducts()', () => {
    it('calls correct endpoint without filters', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ products: [], pagination: { hasNextPage: false } })
      );

      await client.getProducts();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/2/commerce/products',
        expect.anything()
      );
    });

    it('appends query params when filters provided', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ products: [], pagination: { hasNextPage: false } })
      );

      await client.getProducts({
        type: 'PHYSICAL',
        modifiedAfter: '2026-01-01T00:00:00Z',
        cursor: 'abc123',
      });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('type=PHYSICAL');
      expect(url).toContain('modifiedAfter=2026-01-01T00%3A00%3A00Z');
      expect(url).toContain('cursor=abc123');
    });

    it('returns products data', async () => {
      const products = [{ id: 'p-1', name: 'Widget', type: 'PHYSICAL' }];
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ products, pagination: { hasNextPage: false } })
      );

      const result = await client.getProducts();
      expect(result.success).toBe(true);
      expect(result.data?.products).toEqual(products);
    });
  });

  describe('getProduct()', () => {
    it('calls correct endpoint with product ID', async () => {
      const product = { id: 'p-1', name: 'Widget' };
      fetchMock.mockResolvedValueOnce(mockFetchResponse(product));

      const result = await client.getProduct('p-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/2/commerce/products/p-1',
        expect.anything()
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual(product);
    });
  });

  describe('createProduct()', () => {
    it('sends POST with product data', async () => {
      const data: CreateProductData = {
        storePageId: 'sp-1',
        type: 'PHYSICAL',
        name: 'New Widget',
        description: 'A fine widget',
        variants: [
          { sku: 'W-001', pricing: { basePrice: { value: '19.99', currency: 'USD' } } },
        ],
      };

      fetchMock.mockResolvedValueOnce(mockFetchResponse({ id: 'p-new', ...data }));

      const result = await client.createProduct(data);

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.squarespace.com/2/commerce/products');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual(data);
      expect(result.success).toBe(true);
    });
  });

  describe('updateProduct()', () => {
    it('sends POST with update data to product ID endpoint', async () => {
      const data: UpdateProductData = { name: 'Updated Widget', isVisible: false };

      fetchMock.mockResolvedValueOnce(mockFetchResponse({ id: 'p-1', ...data }));

      const result = await client.updateProduct('p-1', data);

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.squarespace.com/2/commerce/products/p-1');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual(data);
      expect(result.success).toBe(true);
    });
  });

  describe('deleteProduct()', () => {
    it('sends DELETE to product ID endpoint', async () => {
      fetchMock.mockResolvedValueOnce(mockFetch204());

      const result = await client.deleteProduct('p-1');

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.squarespace.com/2/commerce/products/p-1');
      expect(opts.method).toBe('DELETE');
      expect(result.success).toBe(true);
    });
  });

  // ── Orders ─────────────────────────────────────────────────────────────

  describe('getOrders()', () => {
    it('calls correct endpoint without filters', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ result: [], pagination: { hasNextPage: false } })
      );

      await client.getOrders();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/1.0/commerce/orders',
        expect.anything()
      );
    });

    it('appends query params when filters provided', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ result: [], pagination: { hasNextPage: false } })
      );

      await client.getOrders({
        fulfillmentStatus: 'PENDING',
        customerId: 'cust-1',
        modifiedAfter: '2026-01-01',
      });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('fulfillmentStatus=PENDING');
      expect(url).toContain('customerId=cust-1');
      expect(url).toContain('modifiedAfter=2026-01-01');
    });
  });

  describe('getOrder()', () => {
    it('calls correct endpoint with order ID', async () => {
      const order = { id: 'o-1', orderNumber: '1001' };
      fetchMock.mockResolvedValueOnce(mockFetchResponse(order));

      const result = await client.getOrder('o-1');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/1.0/commerce/orders/o-1',
        expect.anything()
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual(order);
    });
  });

  describe('fulfillOrder()', () => {
    it('sends POST with fulfillment data and idempotency key', async () => {
      const fulfillment: FulfillmentData = {
        shipDate: '2026-03-04T12:00:00Z',
        carrierName: 'UPS',
        trackingNumber: '1Z999AA10123456784',
        shouldSendNotification: true,
      };

      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ id: 'o-1', fulfillmentStatus: 'FULFILLED' })
      );

      const result = await client.fulfillOrder('o-1', fulfillment);

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.squarespace.com/1.0/commerce/orders/o-1/fulfillments');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ shipments: [fulfillment] });
      expect(opts.headers['Idempotency-Key']).toBe('test-uuid-1234');
      expect(result.success).toBe(true);
    });
  });

  // ── Inventory ──────────────────────────────────────────────────────────

  describe('getInventory()', () => {
    it('calls correct endpoint without cursor', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ inventory: [], pagination: { hasNextPage: false } })
      );

      await client.getInventory();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/1.0/commerce/inventory',
        expect.anything()
      );
    });

    it('appends cursor when provided', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ inventory: [], pagination: { hasNextPage: false } })
      );

      await client.getInventory('cursor-abc');

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('cursor=cursor-abc');
    });
  });

  describe('adjustStock()', () => {
    it('sends POST with adjustments and idempotency key', async () => {
      const adjustments: StockAdjustment[] = [
        { variantId: 'v-1', quantityDelta: -2 },
        { variantId: 'v-2', quantity: 100 },
      ];

      fetchMock.mockResolvedValueOnce(mockFetch204());

      const result = await client.adjustStock(adjustments);

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.squarespace.com/1.0/commerce/inventory/adjustments');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ incrementOperations: adjustments });
      expect(opts.headers['Idempotency-Key']).toBe('test-uuid-1234');
      expect(result.success).toBe(true);
    });

    it('uses provided idempotency key instead of generating one', async () => {
      fetchMock.mockResolvedValueOnce(mockFetch204());

      await client.adjustStock([{ variantId: 'v-1', quantityDelta: 1 }], 'custom-key');

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers['Idempotency-Key']).toBe('custom-key');
    });
  });

  // ── Profiles ───────────────────────────────────────────────────────────

  describe('getProfiles()', () => {
    it('calls correct endpoint without filters', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ profiles: [], pagination: { hasNextPage: false } })
      );

      await client.getProfiles();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/1.0/commerce/profiles',
        expect.anything()
      );
    });

    it('appends query params when filters provided', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ profiles: [], pagination: { hasNextPage: false } })
      );

      await client.getProfiles({
        filter: 'CUSTOMERS',
        sortField: 'createdOn',
        sortDirection: 'DESC',
        cursor: 'next-page',
      });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('filter=CUSTOMERS');
      expect(url).toContain('sortField=createdOn');
      expect(url).toContain('sortDirection=DESC');
      expect(url).toContain('cursor=next-page');
    });
  });

  // ── Transactions ───────────────────────────────────────────────────────

  describe('getTransactions()', () => {
    it('calls correct endpoint without filters', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ documents: [], pagination: { hasNextPage: false } })
      );

      await client.getTransactions();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.squarespace.com/1.0/commerce/transactions',
        expect.anything()
      );
    });

    it('appends date filters', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ documents: [], pagination: { hasNextPage: false } })
      );

      await client.getTransactions({
        modifiedAfter: '2026-01-01',
        modifiedBefore: '2026-03-01',
      });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('modifiedAfter=2026-01-01');
      expect(url).toContain('modifiedBefore=2026-03-01');
    });
  });

  // ── fetchAllPages ──────────────────────────────────────────────────────

  describe('fetchAllPages()', () => {
    it('fetches single page when no pagination', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          products: [{ id: 'p-1' }, { id: 'p-2' }],
          pagination: { hasNextPage: false },
        })
      );

      const items = await client.fetchAllPages('/products', 'products', { apiVersion: '2' });

      expect(items).toEqual([{ id: 'p-1' }, { id: 'p-2' }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('follows pagination across multiple pages', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse({
            products: [{ id: 'p-1' }],
            pagination: { hasNextPage: true, nextPageCursor: 'cursor-2' },
          })
        )
        .mockResolvedValueOnce(
          mockFetchResponse({
            products: [{ id: 'p-2' }],
            pagination: { hasNextPage: true, nextPageCursor: 'cursor-3' },
          })
        )
        .mockResolvedValueOnce(
          mockFetchResponse({
            products: [{ id: 'p-3' }],
            pagination: { hasNextPage: false },
          })
        );

      const items = await client.fetchAllPages('/products', 'products', { apiVersion: '2' });

      expect(items).toEqual([{ id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // Verify cursor is appended to subsequent requests
      const secondUrl = fetchMock.mock.calls[1][0] as string;
      expect(secondUrl).toContain('cursor=cursor-2');

      const thirdUrl = fetchMock.mock.calls[2][0] as string;
      expect(thirdUrl).toContain('cursor=cursor-3');
    });

    it('respects maxPages limit', async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockFetchResponse({
            products: [{ id: 'p-1' }],
            pagination: { hasNextPage: true, nextPageCursor: 'cursor-2' },
          })
        )
        .mockResolvedValueOnce(
          mockFetchResponse({
            products: [{ id: 'p-2' }],
            pagination: { hasNextPage: true, nextPageCursor: 'cursor-3' },
          })
        );

      const items = await client.fetchAllPages('/products', 'products', {
        apiVersion: '2',
        maxPages: 2,
      });

      expect(items).toEqual([{ id: 'p-1' }, { id: 'p-2' }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns empty array on failure', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ message: 'Unauthorized' }, 401));

      const items = await client.fetchAllPages('/products', 'products', { apiVersion: '2' });

      expect(items).toEqual([]);
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────────────

  describe('checkRateLimit()', () => {
    it('does not wait when under threshold', async () => {
      const start = Date.now();
      await client.checkRateLimit();
      const elapsed = Date.now() - start;

      // Should be nearly instant
      expect(elapsed).toBeLessThan(100);
    });

    it('prunes old timestamps outside the window', async () => {
      // Inject old timestamps that should be pruned
      const old = Date.now() - 120_000; // 2 minutes ago
      (client as any).requestTimestamps = Array(260).fill(old);

      const start = Date.now();
      await client.checkRateLimit();
      const elapsed = Date.now() - start;

      // Old timestamps pruned, should not wait
      expect(elapsed).toBeLessThan(100);
      // Should only have 1 timestamp (the new one added by checkRateLimit)
      expect((client as any).requestTimestamps.length).toBe(1);
    });

    it('waits when at proactive threshold with recent timestamps', async () => {
      vi.useFakeTimers();
      try {
        const now = Date.now();
        // Fill with recent timestamps to trigger proactive wait
        (client as any).requestTimestamps = Array(250).fill(now - 100);

        // Start the rate limit check (will call setTimeout internally)
        const promise = client.checkRateLimit();

        // Advance timers past the wait period
        await vi.advanceTimersByTimeAsync(61_000);

        await promise;

        // 250 existing (recent, not pruned) + 1 new
        expect((client as any).requestTimestamps.length).toBe(251);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe('error handling', () => {
    it('handles 401 Unauthorized', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ message: 'Invalid API key' }, 401)
      );

      const result = await client.getProducts();
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error).toContain('401');
    });

    it('handles 403 Forbidden', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ message: 'Forbidden' }, 403)
      );

      const result = await client.getProducts();
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(403);
    });

    it('handles 404 Not Found', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ message: 'Not found' }, 404)
      );

      const result = await client.getProduct('nonexistent');
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(404);
    });

    it('handles 500 Internal Server Error', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ message: 'Internal error' }, 500)
      );

      const result = await client.getOrders();
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
    });

    it('handles network error (fetch throws)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await client.getStorePages();
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
      expect(result.statusCode).toBeUndefined();
    });

    it('handles non-Error thrown values', async () => {
      fetchMock.mockRejectedValueOnce('string error');

      const result = await client.getProducts();
      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });
  });
});
