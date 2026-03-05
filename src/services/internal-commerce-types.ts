// src/services/internal-commerce-types.ts

// ── Request Types ─────────────────────────────────────────────────────────

export interface CreateProductShellRequest {
  productType: number; // 1 = PHYSICAL, 2 = DIGITAL, 3 = SERVICE, 4 = GIFT_CARD
  name: string;
  description: string;
  displayIndex: number;
  visibility: { state: 'HIDDEN'; visibleOn: string };
  variantOptionOrdering: string[];
  variantOrderBySkus: string[];
  useCustomAddButtonText: boolean;
  featuredProduct: boolean;
  shareStates: unknown[];
  createdVariants: CreateVariantRequest[];
}

export interface CreateVariantRequest {
  id?: string; // client-generated UUID (for new variants in update)
  sku: string;
  price: { decimalValue: string; currencyCode: string };
  salePrice: { decimalValue: string; currencyCode: string };
  onSale: boolean;
  quantityInStock?: number;
  stock?: { unlimited: boolean; quantity?: number };
  unlimited: boolean;
  optionValues: { optionName: string; value: string }[];
  attributes?: Record<string, string>;
  shippingWeight?: { value: number; unit: string };
  shippingSize?: { unit: string; length: number; width: number; height: number };
  width?: number;
  height?: number;
  length?: number;
  weight?: number;
}

export interface UpdateProductRequest {
  name?: string;
  description?: string;
  visibility?: { state: 'VISIBLE' | 'HIDDEN'; visibleOn?: string };
  tags?: string[];
  categories?: string[];
  newImageOrder?: string[];
  variantOptionOrdering?: string[];
  variantOrderBySkus?: string[];
  useCustomAddButtonText?: boolean;
  customAddButtonText?: string;
  featuredProduct?: boolean;
  shareStates?: unknown[];
  urlId?: string;
  regenerateUrlId?: boolean;
  createdVariants?: CreateVariantRequest[];
  updatedVariants?: UpdateVariantRequest[];
  deletedVariants?: { id: string }[];
  productAddOnsConfiguration?: { productAddOns: unknown[] };
}

export interface UpdateVariantRequest {
  id: string;
  sku: string;
  price?: { decimalValue: string; currencyCode: string };
  salePrice?: { decimalValue: string; currencyCode: string };
  onSale?: boolean;
  quantityChange?: number;
  unlimited?: boolean;
  optionValues?: { optionName: string; value: string }[];
  width?: number;
  height?: number;
  length?: number;
  weight?: number;
}

export interface AssetReferenceRequest {
  authorId: string;
  systemDataId: string;
}

export interface ProductImageUpdateRequest {
  title?: string;
  focalPoint?: { x: number; y: number };
}

// ── Response Types ────────────────────────────────────────────────────────

export interface InternalProduct {
  id: string;
  websiteId: string;
  collectionId: string;
  url: { fullPath: string; productPath: string; collectionPath: string };
  visibility: { state: string; visibleOn?: string };
  name: string;
  description: string;
  images: InternalProductImage[];
  thumbnailImage?: InternalProductImage;
  addedOn: string;
  updatedOn: string;
  featuredProduct: boolean;
  tags: string[];
  categories: string[];
  categoryIds: string[];
  priceRange: { min: { currency: string; value: string }; max: { currency: string; value: string } };
  customAddButtonText: string;
  useCustomAddButtonText: boolean;
  variantAttributeNames: string[];
  variants: InternalProductVariant[];
  subscribable: boolean;
  fulfilledExternally: boolean;
  productType: number;
}

export interface InternalProductVariant {
  id: string;
  sku: string;
  price: { currencyCode: string; value: number; decimalValue: string; fractionalDigits: number };
  salePrice: { currencyCode: string; value: number; decimalValue: string; fractionalDigits: number };
  onSale: boolean;
  stock: { unlimited: boolean; quantity?: number };
  attributes: Record<string, string>;
  shippingWeight: { value: number; unit: string };
  shippingSize: { unit: string; width: number; height: number; len: number };
}

export interface InternalProductImage {
  id: string;
  title?: string;
  systemDataId: string;
  type: string;
  urls: { http: string; https: string };
  originalSize?: { width: number; height: number };
  sizes: { width: number; height?: number }[];
  focalPoint: { x: number; y: number };
  url: string;
}

export interface AssetReferenceResponse {
  id: string;
  urls: { http: string; https: string };
  sizes: { width: number; height?: number }[];
  focalPoint: { x: number; y: number };
  url: string;
}

// ── Result Types ──────────────────────────────────────────────────────────

export interface CommerceResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
