import { ContentSaveClient, FETCH_TIMEOUT_MS } from './client.js';
import type {
  InternalProduct,
  UpdateProductRequest,
  AssetReferenceResponse,
  InternalProductImage,
  ProductImageUpdateRequest,
  CommerceResult,
} from '../internal-commerce-types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    createProductShell(
      collectionId: string,
      productType?: number,
    ): Promise<CommerceResult<InternalProduct>>;
    getProduct(productId: string): Promise<CommerceResult<InternalProduct>>;
    updateProduct(
      productId: string,
      updates: UpdateProductRequest,
    ): Promise<CommerceResult<InternalProduct>>;
    deleteProduct(productId: string): Promise<CommerceResult<void>>;
    attachProductImage(
      productId: string,
      systemDataId: string,
    ): Promise<CommerceResult<AssetReferenceResponse>>;
    setProductThumbnail(
      productId: string,
      systemDataId: string,
    ): Promise<CommerceResult<AssetReferenceResponse>>;
    updateProductImage(
      productId: string,
      imageId: string,
      updates: ProductImageUpdateRequest,
    ): Promise<CommerceResult<InternalProductImage>>;
    removeProductImage(
      productId: string,
      imageId: string,
    ): Promise<CommerceResult<void>>;
    createStorePage(
      navPlacement?: 'mainNav' | '_hidden',
    ): Promise<CommerceResult<{ id: string; urlId: string }>>;
    listProducts(
      params?: { pageSize?: number; cursor?: string },
    ): Promise<CommerceResult<{ products: InternalProduct[] }>>;
  }
}

// ── Prototype methods ───────────────────────────────────────────────────────

ContentSaveClient.prototype.createProductShell = async function (
  this: ContentSaveClient,
  collectionId: string,
  productType: number = 1,
): Promise<CommerceResult<InternalProduct>> {
  this.ensureCookies();
  try {
    const url = `https://${this.siteSubdomain}.squarespace.com/api/commerce/products/${collectionId}`;
    const sku = `SQ${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
    const body = JSON.stringify({
      productType,
      name: '',
      description: '',
      displayIndex: 0,
      visibility: { state: 'HIDDEN', visibleOn: new Date().toISOString() },
      variantOptionOrdering: [],
      variantOrderBySkus: [],
      useCustomAddButtonText: false,
      featuredProduct: false,
      shareStates: [],
      createdVariants: [{
        sku,
        price: { decimalValue: '0', currencyCode: 'USD' },
        salePrice: { decimalValue: '0', currencyCode: 'USD' },
        onSale: false,
        quantityInStock: 1,
        unlimited: true,
        optionValues: [],
      }],
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, errBody, `API returned ${response.status}: ${errBody.slice(0, 200)}`) };
    }

    const data = (await response.json()) as InternalProduct;
    logger.info({ collectionId, productId: data.id }, 'createProductShell: product created');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/** Get a product by ID. */
ContentSaveClient.prototype.getProduct = async function (
  this: ContentSaveClient,
  productId: string,
): Promise<CommerceResult<InternalProduct>> {
  this.ensureCookies();
  try {
    const url = `https://${this.siteSubdomain}.squarespace.com/api/commerce/products/${productId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { success: false, error: `API returned ${response.status}: ${errBody.slice(0, 200)}` };
    }
    const data = (await response.json()) as InternalProduct;
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/** Update a product (name, variants, price, visibility, images, etc). */
ContentSaveClient.prototype.updateProduct = async function (
  this: ContentSaveClient,
  productId: string,
  updates: UpdateProductRequest,
): Promise<CommerceResult<InternalProduct>> {
  this.ensureCookies();
  try {
    const url = `https://${this.siteSubdomain}.squarespace.com/api/commerce/products/${productId}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: JSON.stringify(updates),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, errBody, `API returned ${response.status}: ${errBody.slice(0, 200)}`) };
    }
    const data = (await response.json()) as InternalProduct;
    logger.info({ productId, name: data.name }, 'updateProduct: product updated');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/** Delete a product by ID. */
ContentSaveClient.prototype.deleteProduct = async function (
  this: ContentSaveClient,
  productId: string,
): Promise<CommerceResult<void>> {
  this.ensureCookies();
  try {
    const url = `https://${this.siteSubdomain}.squarespace.com/api/commerce/products/${productId}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        ...this.buildHeaders(),
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 204) {
      const errBody = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, errBody, `API returned ${response.status}: ${errBody.slice(0, 200)}`) };
    }
    logger.info({ productId }, 'deleteProduct: product deleted');
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/** Attach a media library image to a product. Uses assetId from MediaUploadClient as systemDataId. */
ContentSaveClient.prototype.attachProductImage = async function (
  this: ContentSaveClient,
  productId: string,
  systemDataId: string,
): Promise<CommerceResult<AssetReferenceResponse>> {
  this.ensureCookies();
  try {
    const url = `https://${this.siteSubdomain}.squarespace.com/api/commerce/products/${productId}/images/asset-reference`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: JSON.stringify({
        authorId: this.memberAccountIdCache ?? '',
        systemDataId,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, errBody, `API returned ${response.status}: ${errBody.slice(0, 200)}`) };
    }
    const data = (await response.json()) as AssetReferenceResponse;
    logger.info({ productId, imageId: data.id }, 'attachProductImage: image attached');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/** Set a product's thumbnail image. Uses assetId from MediaUploadClient as systemDataId. */
ContentSaveClient.prototype.setProductThumbnail = async function (
  this: ContentSaveClient,
  productId: string,
  systemDataId: string,
): Promise<CommerceResult<AssetReferenceResponse>> {
  this.ensureCookies();
  try {
    const url = `https://${this.siteSubdomain}.squarespace.com/api/commerce/products/${productId}/thumbnail-image/asset-reference`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: JSON.stringify({
        authorId: this.memberAccountIdCache ?? '',
        systemDataId,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, errBody, `API returned ${response.status}: ${errBody.slice(0, 200)}`) };
    }
    const data = (await response.json()) as AssetReferenceResponse;
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/** Update product image metadata (title, focalPoint). Uses v2 API path. */
ContentSaveClient.prototype.updateProductImage = async function (
  this: ContentSaveClient,
  productId: string,
  imageId: string,
  updates: ProductImageUpdateRequest,
): Promise<CommerceResult<InternalProductImage>> {
  this.ensureCookies();
  try {
    const url = `https://${this.siteSubdomain}.squarespace.com/api/2/commerce/products/${productId}/images/${imageId}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: JSON.stringify(updates),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, errBody, `API returned ${response.status}: ${errBody.slice(0, 200)}`) };
    }
    const data = (await response.json()) as InternalProductImage;
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/** Remove an image from a product. */
ContentSaveClient.prototype.removeProductImage = async function (
  this: ContentSaveClient,
  productId: string,
  imageId: string,
): Promise<CommerceResult<void>> {
  this.ensureCookies();
  try {
    const url = `https://${this.siteSubdomain}.squarespace.com/api/commerce/products/${productId}/images/${imageId}`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        ...this.buildHeaders(),
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 204) {
      const errBody = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, errBody, `API returned ${response.status}: ${errBody.slice(0, 200)}`) };
    }
    logger.info({ productId, imageId }, 'removeProductImage: image removed');
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/**
 * Create a store page (collection) and add it to site navigation.
 * Two API calls: copy empty-store template, then update navigation.
 */
ContentSaveClient.prototype.createStorePage = async function (
  this: ContentSaveClient,
  navPlacement: 'mainNav' | '_hidden' = 'mainNav',
): Promise<CommerceResult<{ id: string; urlId: string }>> {
  this.ensureCookies();
  try {
    // Step 1: Create store collection from template
    const copyUrl = `https://${this.siteSubdomain}.squarespace.com/api/content/copy/collection/empty-store`;
    const copyResponse = await fetch(copyUrl, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!copyResponse.ok) {
      const errBody = await copyResponse.text().catch(() => '');
      return { success: false, error: this.enhanceError(copyResponse.status, errBody, `Create store failed ${copyResponse.status}: ${errBody.slice(0, 200)}`) };
    }
    const storeData = (await copyResponse.json()) as { id: string; urlId: string };

    // Step 2: Get current navigation layout
    const layoutUrl = `https://${this.siteSubdomain}.squarespace.com/api/commondata/GetSiteLayout`;
    const layoutResponse = await fetch(layoutUrl, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!layoutResponse.ok) {
      // Store was created but nav update failed — still return success with warning
      logger.warn({ storeId: storeData.id }, 'createStorePage: store created but nav layout fetch failed');
      return { success: true, data: storeData };
    }
    const layout = (await layoutResponse.json()) as Record<string, unknown>;

    // Step 3: Add store to navigation
    const navUrl = `https://${this.siteSubdomain}.squarespace.com/api/widget/UpdateNavigation`;
    const currentNav = (layout as any)?.layout ?? layout;
    const navSection = (currentNav as any)?.[navPlacement] ?? [];
    const updatedNav = {
      ...currentNav,
      [navPlacement]: [...navSection, { collectionId: storeData.id }],
    };

    await fetch(navUrl, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: JSON.stringify(updatedNav),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    logger.info({ storeId: storeData.id, urlId: storeData.urlId }, 'createStorePage: store page created');
    return { success: true, data: storeData };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/** List products in the store. */
ContentSaveClient.prototype.listProducts = async function (
  this: ContentSaveClient,
  params?: { pageSize?: number; cursor?: string },
): Promise<CommerceResult<{ products: InternalProduct[] }>> {
  this.ensureCookies();
  try {
    const qs = new URLSearchParams();
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params?.cursor) qs.set('cursor', params.cursor);
    const qsStr = qs.toString() ? `?${qs.toString()}` : '';
    const url = `https://${this.siteSubdomain}.squarespace.com/api/3/commerce/products${qsStr}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { success: false, error: `API returned ${response.status}: ${errBody.slice(0, 200)}` };
    }
    const data = (await response.json()) as { products: InternalProduct[] };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
