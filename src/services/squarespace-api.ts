/**
 * Squarespace Commerce API client.
 *
 * Typed REST client for product management, image upload, inventory, and orders.
 * Image upload via API bypasses fragile Playwright UI automation.
 *
 * Auth: Bearer token via SQUARESPACE_API_KEY env var.
 * Rate limit: 300 req/min — auto-retries on 429.
 */

import { createReadStream, statSync } from 'fs';
import { basename } from 'path';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.squarespace.com';
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif']);
const RATE_LIMIT_WAIT_MS = 60_000; // Wait 1 minute on 429
const MAX_RATE_RETRIES = 2;
const IMAGE_POLL_INTERVAL_MS = 2_000;
const IMAGE_POLL_TIMEOUT_MS = 120_000; // 2 minutes default

// ─── Types ───────────────────────────────────────────────────────────────────

// Products

export interface SquarespaceProduct {
  id: string;
  type: string;
  storePageId: string;
  name: string;
  description: string;
  url: string;
  urlSlug: string;
  tags: string[];
  isVisible: boolean;
  createdOn: string;
  modifiedOn: string;
  variants: SquarespaceVariant[];
  images: SquarespaceProductImage[];
}

export interface SquarespaceVariant {
  id: string;
  sku: string;
  pricing: {
    basePrice: { value: string; currency: string };
    salePrice?: { value: string; currency: string };
    onSale: boolean;
  };
  stock: { quantity: number; unlimited: boolean };
  attributes: Record<string, string>;
  shippingMeasurements?: {
    weight: { value: number; unit: string };
    dimensions?: { length: number; width: number; height: number; unit: string };
  };
}

export interface SquarespaceProductImage {
  id: string;
  url: string;
  originalSize: { width: number; height: number };
  availableFormats: string[];
  altText?: string;
}

export interface CreateProductData {
  type: 'PHYSICAL' | 'DIGITAL' | 'SERVICE';
  storePageId: string;
  name: string;
  description?: string;
  tags?: string[];
  isVisible?: boolean;
  variants: CreateVariantData[];
}

export interface CreateVariantData {
  sku: string;
  pricing: {
    basePrice: { value: string; currency: string };
    salePrice?: { value: string; currency: string };
    onSale?: boolean;
  };
  stock?: { quantity: number; unlimited?: boolean };
  attributes?: Record<string, string>;
}

export interface UpdateProductData {
  name?: string;
  description?: string;
  tags?: string[];
  isVisible?: boolean;
  variants?: CreateVariantData[];
}

export interface ProductListResponse {
  products: SquarespaceProduct[];
  pagination?: { nextPageUrl?: string; nextPageCursor?: string; hasNextPage: boolean };
}

// Image upload

export interface ImageUploadResponse {
  imageId: string;
}

export interface ImageStatusResponse {
  imageId: string;
  status: 'QUEUED' | 'PROCESSING' | 'READY' | 'FAILED';
  url?: string;
  failureReason?: string;
}

// Inventory

export interface InventoryItem {
  variantId: string;
  sku: string;
  quantity: number;
  isUnlimited: boolean;
}

export interface InventoryResponse {
  inventory: InventoryItem[];
  pagination?: { nextPageUrl?: string; nextPageCursor?: string; hasNextPage: boolean };
}

export interface StockAdjustment {
  variantId: string;
  quantity: number;
}

// Orders

export interface SquarespaceOrder {
  id: string;
  orderNumber: string;
  createdOn: string;
  modifiedOn: string;
  channel: string;
  customerEmail: string;
  fulfillmentStatus: string;
  lineItems: OrderLineItem[];
  grandTotal: { value: string; currency: string };
  shippingAddress?: OrderAddress;
}

export interface OrderLineItem {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPricePaid: { value: string; currency: string };
}

export interface OrderAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state?: string;
  countryCode: string;
  postalCode: string;
  phone?: string;
}

export interface OrderListResponse {
  result: SquarespaceOrder[];
  pagination?: { nextPageUrl?: string; nextPageCursor?: string; hasNextPage: boolean };
}

export interface OrderListFilters {
  cursor?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  fulfillmentStatus?: 'PENDING' | 'FULFILLED' | 'CANCELED';
}

export interface Shipment {
  shipDate?: string;
  carrierName?: string;
  service?: string;
  trackingNumber?: string;
  trackingUrl?: string;
}

// Site info

export interface SiteInfo {
  id: string;
  title: string;
  domain: string;
  siteUrl: string;
  createdOn: string;
}

// ─── API Error ───────────────────────────────────────────────────────────────

export class SquarespaceAPIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'SquarespaceAPIError';
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class SquarespaceAPI {
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.SQUARESPACE_API_KEY;
    if (!key) {
      throw new Error(
        'Missing Squarespace API key. Set SQUARESPACE_API_KEY in .env or pass it to the constructor.',
      );
    }
    this.apiKey = key;
  }

  // ── Products ─────────────────────────────────────────────────────────────

  async listProducts(cursor?: string): Promise<ProductListResponse> {
    const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request<ProductListResponse>('GET', `/v2/commerce/products${params}`);
  }

  async getProduct(id: string): Promise<SquarespaceProduct> {
    return this.request<SquarespaceProduct>('GET', `/v2/commerce/products/${id}`);
  }

  async createProduct(data: CreateProductData): Promise<SquarespaceProduct> {
    logger.info({ name: data.name, type: data.type }, 'Creating product');
    return this.request<SquarespaceProduct>('POST', '/v2/commerce/products', data);
  }

  async updateProduct(id: string, data: UpdateProductData): Promise<SquarespaceProduct> {
    logger.info({ productId: id, fields: Object.keys(data) }, 'Updating product');
    return this.request<SquarespaceProduct>('POST', `/v2/commerce/products/${id}`, data);
  }

  async deleteProduct(id: string): Promise<void> {
    logger.info({ productId: id }, 'Deleting product');
    await this.request<void>('DELETE', `/v2/commerce/products/${id}`);
  }

  // ── Product Images ───────────────────────────────────────────────────────

  async uploadProductImage(productId: string, filePath: string): Promise<ImageUploadResponse> {
    // Validate file exists and is within size limit
    const stat = statSync(filePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 20MB)`);
    }

    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported image type: ${ext} (allowed: JPEG, PNG, GIF)`);
    }

    logger.info({ productId, filePath, sizeBytes: stat.size }, 'Uploading product image');

    const fileName = basename(filePath);
    const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';

    // Build multipart form data
    const blob = await this.fileToBlob(filePath, mimeType);
    const formData = new FormData();
    formData.append('file', blob, fileName);

    const url = `${BASE_URL}/v2/commerce/products/${productId}/images`;
    const response = await this.rawRequest(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (response.status !== 202 && response.status !== 200) {
      const body = await this.safeReadBody(response);
      throw new SquarespaceAPIError(
        `Image upload failed (${response.status})`,
        response.status,
        body,
      );
    }

    const result = (await response.json()) as ImageUploadResponse;
    logger.info({ productId, imageId: result.imageId }, 'Image upload accepted');
    return result;
  }

  async checkImageStatus(productId: string, imageId: string): Promise<ImageStatusResponse> {
    return this.request<ImageStatusResponse>(
      'GET',
      `/v2/commerce/products/${productId}/images/${imageId}/status`,
    );
  }

  async waitForImageUpload(
    productId: string,
    imageId: string,
    timeoutMs: number = IMAGE_POLL_TIMEOUT_MS,
  ): Promise<ImageStatusResponse> {
    const start = Date.now();
    logger.info({ productId, imageId, timeoutMs }, 'Polling image upload status');

    while (Date.now() - start < timeoutMs) {
      const status = await this.checkImageStatus(productId, imageId);

      if (status.status === 'READY') {
        logger.info({ productId, imageId, url: status.url }, 'Image upload complete');
        return status;
      }

      if (status.status === 'FAILED') {
        throw new SquarespaceAPIError(
          `Image processing failed: ${status.failureReason ?? 'unknown reason'}`,
          500,
          status,
        );
      }

      // Still QUEUED or PROCESSING — wait and retry
      await new Promise((r) => setTimeout(r, IMAGE_POLL_INTERVAL_MS));
    }

    throw new Error(
      `Image upload timed out after ${timeoutMs}ms (productId=${productId}, imageId=${imageId})`,
    );
  }

  async reorderProductImages(productId: string, imageIds: string[]): Promise<void> {
    logger.info({ productId, imageCount: imageIds.length }, 'Reordering product images');
    await this.request<void>(
      'POST',
      `/v2/commerce/products/${productId}/images/reorder`,
      { imageIds },
    );
  }

  async deleteProductImage(productId: string, imageId: string): Promise<void> {
    logger.info({ productId, imageId }, 'Deleting product image');
    await this.request<void>(
      'DELETE',
      `/v2/commerce/products/${productId}/images/${imageId}`,
    );
  }

  // ── Inventory (v1.0) ─────────────────────────────────────────────────────

  async getInventory(cursor?: string): Promise<InventoryResponse> {
    const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request<InventoryResponse>('GET', `/1.0/commerce/inventory${params}`);
  }

  async adjustStock(variantId: string, quantity: number): Promise<void> {
    logger.info({ variantId, quantity }, 'Adjusting stock');
    await this.request<void>('POST', '/1.0/commerce/inventory', {
      incrementOperations: [{ variantId, quantity }],
    });
  }

  // ── Orders (v1.0) ────────────────────────────────────────────────────────

  async listOrders(filters?: OrderListFilters): Promise<OrderListResponse> {
    const params = new URLSearchParams();
    if (filters?.cursor) params.set('cursor', filters.cursor);
    if (filters?.modifiedAfter) params.set('modifiedAfter', filters.modifiedAfter);
    if (filters?.modifiedBefore) params.set('modifiedBefore', filters.modifiedBefore);
    if (filters?.fulfillmentStatus) params.set('fulfillmentStatus', filters.fulfillmentStatus);
    const qs = params.toString();
    return this.request<OrderListResponse>('GET', `/1.0/commerce/orders${qs ? `?${qs}` : ''}`);
  }

  async getOrder(id: string): Promise<SquarespaceOrder> {
    return this.request<SquarespaceOrder>('GET', `/1.0/commerce/orders/${id}`);
  }

  async fulfillOrder(id: string, shipments: Shipment[]): Promise<void> {
    logger.info({ orderId: id, shipmentCount: shipments.length }, 'Fulfilling order');
    await this.request<void>('POST', `/1.0/commerce/orders/${id}/fulfill`, {
      shipments,
      shouldSendNotification: true,
    });
  }

  // ── Site Info (v1.0) ─────────────────────────────────────────────────────

  async getSiteInfo(): Promise<SiteInfo> {
    return this.request<SiteInfo>('GET', '/1.0/authorization/website');
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Core JSON request method with rate-limit retry.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${BASE_URL}${path}`;

    for (let attempt = 0; attempt <= MAX_RATE_RETRIES; attempt++) {
      const response = await this.rawRequest(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SquarespaceHelper/1.0',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Rate limited — wait and retry
      if (response.status === 429) {
        if (attempt < MAX_RATE_RETRIES) {
          logger.warn(
            { attempt: attempt + 1, waitMs: RATE_LIMIT_WAIT_MS, path },
            'Rate limited by Squarespace API, waiting',
          );
          await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS));
          continue;
        }
        throw new SquarespaceAPIError('Rate limit exceeded after retries', 429);
      }

      // No content (204, or DELETE returning 200 with no body)
      if (response.status === 204 || (method === 'DELETE' && response.status === 200)) {
        return undefined as T;
      }

      // Success
      if (response.ok) {
        return (await response.json()) as T;
      }

      // Error
      const errorBody = await this.safeReadBody(response);
      throw new SquarespaceAPIError(
        `Squarespace API error: ${response.status} ${response.statusText} on ${method} ${path}`,
        response.status,
        errorBody,
      );
    }

    // Unreachable, but TypeScript needs it
    throw new SquarespaceAPIError('Rate limit exceeded after retries', 429);
  }

  /**
   * Thin wrapper around fetch so we can mock it in tests.
   */
  private rawRequest(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }

  /**
   * Read a file into a Blob for multipart upload.
   */
  private async fileToBlob(filePath: string, mimeType: string): Promise<Blob> {
    const { readFile } = await import('fs/promises');
    const buffer = await readFile(filePath);
    return new Blob([buffer], { type: mimeType });
  }

  /**
   * Safely read response body for error messages.
   */
  private async safeReadBody(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      try {
        return await response.text();
      } catch {
        return null;
      }
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance: SquarespaceAPI | null = null;

/**
 * Returns the shared SquarespaceAPI client instance.
 * Creates it on first call (reads SQUARESPACE_API_KEY from env).
 */
export function getSquarespaceAPI(): SquarespaceAPI {
  if (!_instance) {
    _instance = new SquarespaceAPI();
  }
  return _instance;
}
