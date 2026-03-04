/**
 * Squarespace Commerce API Client
 *
 * REST client for the Squarespace Commerce API (v1.0 + v2).
 * Completely separate from the Content Save API — uses Bearer auth
 * with API keys, not session cookies.
 *
 * Base URL: https://api.squarespace.com/{version}/commerce/...
 *   - Products: v2  → /2/commerce/products/...
 *   - Everything else: v1.0 → /1.0/commerce/orders/...
 *
 * Rate limit: 300 requests/minute sliding window.
 * We proactively wait when >250 requests in the last 60s.
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import type {
  CommerceApiResponse,
  StorePage,
  Product,
  CreateProductData,
  UpdateProductData,
  Order,
  FulfillmentData,
  InventoryItem,
  StockAdjustment,
  Profile,
  Transaction,
} from './commerce-api-types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.squarespace.com';
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;
const RATE_LIMIT_PROACTIVE_THRESHOLD = 250;

// ── Client ───────────────────────────────────────────────────────────────────

export class CommerceApiClient {
  private apiKey: string;
  private siteId: string;
  private requestTimestamps: number[] = [];

  constructor(apiKey: string, siteId: string) {
    this.apiKey = apiKey;
    this.siteId = siteId;
  }

  // ── HTTP foundation ──────────────────────────────────────────────────────

  /**
   * Build standard headers for Commerce API requests.
   */
  buildHeaders(options?: { idempotencyKey?: string }): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': 'SquarespaceHelper/1.0',
      'Content-Type': 'application/json',
    };
    if (options?.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    return headers;
  }

  /**
   * Sliding-window rate limiter. Waits if we're approaching the 300 req/min limit.
   */
  async checkRateLimit(): Promise<void> {
    const now = Date.now();

    // Prune timestamps older than the window
    this.requestTimestamps = this.requestTimestamps.filter(
      (ts) => now - ts < RATE_LIMIT_WINDOW_MS
    );

    if (this.requestTimestamps.length >= RATE_LIMIT_PROACTIVE_THRESHOLD) {
      // Wait until the oldest relevant timestamp falls outside the window
      const oldest = this.requestTimestamps[0];
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldest) + 100; // +100ms buffer
      if (waitMs > 0) {
        logger.warn({ requestsInWindow: this.requestTimestamps.length, waitMs }, 'Commerce API rate limit: proactive wait');
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    this.requestTimestamps.push(Date.now());
  }

  /**
   * Core HTTP request method. All API calls flow through here.
   */
  async request<T>(
    method: string,
    path: string,
    options?: { body?: unknown; apiVersion?: string; idempotencyKey?: string }
  ): Promise<CommerceApiResponse<T>> {
    const version = options?.apiVersion ?? '1.0';
    const url = `${BASE_URL}/${version}/commerce${path}`;

    try {
      await this.checkRateLimit();

      const fetchOptions: RequestInit = {
        method,
        headers: this.buildHeaders({ idempotencyKey: options?.idempotencyKey }),
      };

      if (options?.body !== undefined) {
        fetchOptions.body = JSON.stringify(options.body);
      }

      logger.debug({ method, url }, 'Commerce API request');

      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { method, url, status: response.status, errorBody },
          'Commerce API error response'
        );
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorBody || response.statusText}`,
          statusCode: response.status,
        };
      }

      // 204 No Content — no body to parse
      if (response.status === 204) {
        return { success: true, statusCode: 204 };
      }

      const data = (await response.json()) as T;
      return { success: true, data, statusCode: response.status };
    } catch (err) {
      logger.error({ method, url, error: errMsg(err) }, 'Commerce API request failed');
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Fetch all pages of a paginated endpoint. Follows `nextPageCursor` until done.
   */
  async fetchAllPages<T>(
    path: string,
    dataKey: string,
    options?: { apiVersion?: string; maxPages?: number }
  ): Promise<T[]> {
    const allItems: T[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    const maxPages = options?.maxPages ?? 100;

    do {
      const separator = path.includes('?') ? '&' : '?';
      const cursorPath = cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path;

      const result = await this.request<Record<string, unknown>>(
        'GET',
        cursorPath,
        { apiVersion: options?.apiVersion }
      );

      if (!result.success || !result.data) break;

      const items = result.data[dataKey];
      if (Array.isArray(items)) {
        allItems.push(...(items as T[]));
      }

      // Extract pagination cursor
      const pagination = result.data.pagination as
        | { nextPageCursor?: string; hasNextPage?: boolean }
        | undefined;

      cursor = pagination?.nextPageCursor;
      pageCount++;
    } while (cursor && pageCount < maxPages);

    return allItems;
  }

  // ── Products (API v2) ────────────────────────────────────────────────────

  async getStorePages(): Promise<CommerceApiResponse<StorePage[]>> {
    const result = await this.request<{ storePages: StorePage[] }>(
      'GET',
      '/store_pages',
      { apiVersion: '2' }
    );
    if (!result.success) return { success: false, error: result.error, statusCode: result.statusCode };
    return { success: true, data: result.data?.storePages ?? [], statusCode: result.statusCode };
  }

  async getProducts(options?: {
    type?: string;
    modifiedAfter?: string;
    modifiedBefore?: string;
    cursor?: string;
  }): Promise<CommerceApiResponse<{ products: Product[]; pagination: unknown }>> {
    const params = new URLSearchParams();
    if (options?.type) params.set('type', options.type);
    if (options?.modifiedAfter) params.set('modifiedAfter', options.modifiedAfter);
    if (options?.modifiedBefore) params.set('modifiedBefore', options.modifiedBefore);
    if (options?.cursor) params.set('cursor', options.cursor);

    const query = params.toString();
    const path = `/products${query ? `?${query}` : ''}`;

    return this.request('GET', path, { apiVersion: '2' });
  }

  async getProduct(productId: string): Promise<CommerceApiResponse<Product>> {
    return this.request('GET', `/products/${productId}`, { apiVersion: '2' });
  }

  async createProduct(data: CreateProductData): Promise<CommerceApiResponse<Product>> {
    return this.request('POST', '/products', { body: data, apiVersion: '2' });
  }

  async updateProduct(productId: string, data: UpdateProductData): Promise<CommerceApiResponse<Product>> {
    return this.request('POST', `/products/${productId}`, { body: data, apiVersion: '2' });
  }

  async deleteProduct(productId: string): Promise<CommerceApiResponse<void>> {
    return this.request('DELETE', `/products/${productId}`, { apiVersion: '2' });
  }

  // ── Orders (API v1.0) ────────────────────────────────────────────────────

  async getOrders(options?: {
    fulfillmentStatus?: string;
    customerId?: string;
    modifiedAfter?: string;
    cursor?: string;
  }): Promise<CommerceApiResponse<{ result: Order[]; pagination: unknown }>> {
    const params = new URLSearchParams();
    if (options?.fulfillmentStatus) params.set('fulfillmentStatus', options.fulfillmentStatus);
    if (options?.customerId) params.set('customerId', options.customerId);
    if (options?.modifiedAfter) params.set('modifiedAfter', options.modifiedAfter);
    if (options?.cursor) params.set('cursor', options.cursor);

    const query = params.toString();
    const path = `/orders${query ? `?${query}` : ''}`;

    return this.request('GET', path, { apiVersion: '1.0' });
  }

  async getOrder(orderId: string): Promise<CommerceApiResponse<Order>> {
    return this.request('GET', `/orders/${orderId}`, { apiVersion: '1.0' });
  }

  async fulfillOrder(orderId: string, data: FulfillmentData): Promise<CommerceApiResponse<Order>> {
    const idempotencyKey = randomUUID();
    return this.request('POST', `/orders/${orderId}/fulfillments`, {
      body: { shipments: [data] },
      apiVersion: '1.0',
      idempotencyKey,
    });
  }

  // ── Inventory (API v1.0) ─────────────────────────────────────────────────

  async getInventory(cursor?: string): Promise<
    CommerceApiResponse<{ inventory: InventoryItem[]; pagination: unknown }>
  > {
    const path = cursor
      ? `/inventory?cursor=${encodeURIComponent(cursor)}`
      : '/inventory';
    return this.request('GET', path, { apiVersion: '1.0' });
  }

  async adjustStock(
    adjustments: StockAdjustment[],
    idempotencyKey?: string
  ): Promise<CommerceApiResponse<void>> {
    const key = idempotencyKey ?? randomUUID();
    return this.request('POST', '/inventory/adjustments', {
      body: { incrementOperations: adjustments },
      apiVersion: '1.0',
      idempotencyKey: key,
    });
  }

  // ── Profiles (API v1.0) ──────────────────────────────────────────────────

  async getProfiles(options?: {
    filter?: string;
    sortField?: string;
    sortDirection?: string;
    cursor?: string;
  }): Promise<CommerceApiResponse<{ profiles: Profile[]; pagination: unknown }>> {
    const params = new URLSearchParams();
    if (options?.filter) params.set('filter', options.filter);
    if (options?.sortField) params.set('sortField', options.sortField);
    if (options?.sortDirection) params.set('sortDirection', options.sortDirection);
    if (options?.cursor) params.set('cursor', options.cursor);

    const query = params.toString();
    const path = `/profiles${query ? `?${query}` : ''}`;

    return this.request('GET', path, { apiVersion: '1.0' });
  }

  // ── Transactions (API v1.0) ──────────────────────────────────────────────

  async getTransactions(options?: {
    modifiedAfter?: string;
    modifiedBefore?: string;
    cursor?: string;
  }): Promise<CommerceApiResponse<{ documents: Transaction[]; pagination: unknown }>> {
    const params = new URLSearchParams();
    if (options?.modifiedAfter) params.set('modifiedAfter', options.modifiedAfter);
    if (options?.modifiedBefore) params.set('modifiedBefore', options.modifiedBefore);
    if (options?.cursor) params.set('cursor', options.cursor);

    const query = params.toString();
    const path = `/transactions${query ? `?${query}` : ''}`;

    return this.request('GET', path, { apiVersion: '1.0' });
  }
}
