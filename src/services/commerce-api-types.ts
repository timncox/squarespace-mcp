/**
 * Squarespace Commerce API Types
 *
 * TypeScript interfaces for the Squarespace Commerce API (v1.0 + v2).
 * This is a completely separate REST API from the Content Save API —
 * uses Bearer auth with API keys, not session cookies.
 *
 * Docs: https://developers.squarespace.com/commerce-apis
 */

// ── Generic response wrappers ────────────────────────────────────────────────

export interface CommerceApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

export interface PaginatedResponse<T> extends CommerceApiResponse<T> {
  pagination: {
    nextPageCursor?: string;
    nextPageUrl?: string;
    hasNextPage: boolean;
  };
}

// ── Store pages ──────────────────────────────────────────────────────────────

export interface StorePage {
  id: string;
  title: string;
  isEnabled: boolean;
  url: string;
}

// ── Products ─────────────────────────────────────────────────────────────────

export interface Product {
  id: string;
  type: string;
  storePageId: string;
  name: string;
  description: string;
  url: string;
  urlSlug: string;
  tags: string[];
  isVisible: boolean;
  variants: ProductVariant[];
  images: ProductImage[];
  createdOn: string;
  modifiedOn: string;
}

export interface ProductVariant {
  id: string;
  sku: string;
  pricing: {
    basePrice: { value: string; currency: string };
    salePrice?: { value: string; currency: string };
    onSale: boolean;
  };
  stock: {
    quantity: number;
    unlimited: boolean;
  };
  attributes: Record<string, string>;
}

export interface ProductImage {
  id: string;
  url: string;
  altText: string;
  orderIndex: number;
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface Order {
  id: string;
  orderNumber: string;
  createdOn: string;
  modifiedOn: string;
  customerEmail: string;
  fulfillmentStatus: string;
  subtotal: { value: string; currency: string };
  shippingTotal: { value: string; currency: string };
  discountTotal: { value: string; currency: string };
  taxTotal: { value: string; currency: string };
  grandTotal: { value: string; currency: string };
  lineItems: OrderLineItem[];
  shippingAddress: OrderAddress;
  billingAddress: OrderAddress;
}

export interface OrderLineItem {
  id: string;
  productId: string;
  productName: string;
  variantId: string;
  sku: string;
  quantity: number;
  unitPricePaid: { value: string; currency: string };
}

export interface OrderAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  countryCode: string;
  postalCode: string;
  phone?: string;
}

// ── Fulfillment ──────────────────────────────────────────────────────────────

export interface FulfillmentData {
  shipDate: string;
  carrierName?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  shouldSendNotification?: boolean;
}

// ── Inventory ────────────────────────────────────────────────────────────────

export interface InventoryItem {
  variantId: string;
  sku: string;
  quantity: number;
  isUnlimited: boolean;
  descriptor: string;
}

export interface StockAdjustment {
  variantId: string;
  quantity?: number;
  quantityDelta?: number;
}

// ── Profiles ─────────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  isCustomer: boolean;
  hasAccount: boolean;
  createdOn: string;
  orderCount: number;
}

// ── Transactions ─────────────────────────────────────────────────────────────

export interface Transaction {
  id: string;
  createdOn: string;
  modifiedOn: string;
  customerEmail: string;
  total: { value: string; currency: string };
  salesTotal: { value: string; currency: string };
  taxTotal: { value: string; currency: string };
  shippingTotal: { value: string; currency: string };
  discountTotal: { value: string; currency: string };
  refundedTotal: { value: string; currency: string };
}

// ── Create/Update DTOs ───────────────────────────────────────────────────────

export interface CreateVariantData {
  sku: string;
  pricing: {
    basePrice: { value: string; currency: string };
  };
  stock?: {
    quantity?: number;
  };
  attributes?: Record<string, string>;
}

export interface CreateProductData {
  storePageId: string;
  type: 'PHYSICAL' | 'DIGITAL' | 'SERVICE' | 'GIFT_CARD';
  name: string;
  description?: string;
  tags?: string[];
  isVisible?: boolean;
  variants: CreateVariantData[];
}

export interface UpdateProductData {
  name?: string;
  description?: string;
  tags?: string[];
  isVisible?: boolean;
  url?: string;
  urlSlug?: string;
}
