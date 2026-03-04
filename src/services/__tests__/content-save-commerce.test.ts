import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeClient(): ContentSaveClient {
  const client = new ContentSaveClient('test-site');
  // Force cookies loaded
  (client as any).siteCookieHeader = 'test=cookie';
  (client as any).crumbToken = 'test-crumb';
  (client as any).memberAccountIdCache = 'member-123';
  (client as any).websiteIdCache = 'website-456';
  return client;
}

describe('ContentSaveClient — Commerce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createProductShell', () => {
    it('creates an empty product and returns product ID + default variant ID', async () => {
      const responseData = {
        id: 'prod-abc',
        collectionId: 'store-123',
        variants: [{ id: 'var-default', sku: 'SQ0000001' }],
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => responseData,
      });

      const client = makeClient();
      const result = await client.createProductShell('store-123');

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('prod-abc');
      expect(result.data?.variants[0].id).toBe('var-default');

      // Verify request
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test-site.squarespace.com/api/commerce/products/store-123');
      expect(opts.method).toBe('POST');
      expect(opts.headers['X-CSRF-Token']).toBe('test-crumb');
      const body = JSON.parse(opts.body);
      expect(body.productType).toBe(1);
      expect(body.visibility.state).toBe('HIDDEN');
      expect(body.createdVariants).toHaveLength(1);
    });

    it('returns error on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      });

      const client = makeClient();
      const result = await client.createProductShell('store-123');
      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });
  });

  describe('getProduct', () => {
    it('fetches product by ID', async () => {
      const product = { id: 'prod-abc', name: 'Test', variants: [] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => product,
      });

      const client = makeClient();
      const result = await client.getProduct('prod-abc');

      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('Test');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test-site.squarespace.com/api/commerce/products/prod-abc');
    });
  });

  describe('updateProduct', () => {
    it('sends PUT with product details', async () => {
      const updated = { id: 'prod-abc', name: 'Blue Hat', variants: [] };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => updated,
      });

      const client = makeClient();
      const result = await client.updateProduct('prod-abc', {
        name: 'Blue Hat',
        description: '<p>Nice hat</p>',
        visibility: { state: 'VISIBLE' },
      });

      expect(result.success).toBe(true);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://test-site.squarespace.com/api/commerce/products/prod-abc');
      expect(opts.method).toBe('PUT');
      const body = JSON.parse(opts.body);
      expect(body.name).toBe('Blue Hat');
      expect(body.visibility.state).toBe('VISIBLE');
    });
  });

  describe('deleteProduct', () => {
    it('sends DELETE request', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });

      const client = makeClient();
      const result = await client.deleteProduct('prod-abc');

      expect(result.success).toBe(true);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/commerce/products/prod-abc');
      expect(opts.method).toBe('DELETE');
    });
  });
});
