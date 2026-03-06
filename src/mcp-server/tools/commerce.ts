/**
 * MCP Tools — Internal Commerce API (Products, Images, Store Pages)
 *
 * Uses ContentSaveClient (session cookie auth) instead of the public Commerce API.
 * Supports product images, mutable variants, and store page creation.
 *
 * Tools:
 * sq_create_store_page: Create a new store page on a site
 * sq_create_product: Create a product (shell → images → update with details)
 * sq_update_product: Update product name, description, variants, visibility
 * sq_get_product: Get product details by ID
 * sq_delete_product: Delete a product
 * sq_list_products: List products in the store
 * sq_attach_product_image: Attach image to a product (from media library upload)
 * sq_set_product_thumbnail: Set a product's thumbnail image
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient } from '../session.js';
import type { UpdateProductRequest, CreateVariantRequest } from '../../services/internal-commerce-types.js';

export function registerCommerceTools(server: McpServer) {
  // ── sq_create_store_page ─────────────────────────────────────────────────────
  server.registerTool('sq_create_store_page', {
    description:
      'Create a new store page on a Squarespace site and add it to navigation. ' +
      'Optionally set a custom title and URL slug (otherwise defaults to "Store"). ' +
      'Returns the store collection ID and URL slug.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      title: z.string().optional().describe('Store page title (e.g. "Merch"). Defaults to auto-generated name.'),
      slug: z.string().optional().describe('Custom URL slug (e.g. "store", "merch"). Defaults to auto-generated.'),
      navPlacement: z.enum(['mainNav', '_hidden']).optional().describe('Where to place in navigation (default: mainNav)'),
    },
  }, async ({ siteId, title, slug, navPlacement }) => {
    try {
      const client = getClient(siteId);
      const result = await client.createStorePage(navPlacement ?? 'mainNav');
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }

      // Rename store page if title or slug provided
      if ((title || slug) && result.data) {
        const metaUpdates: Record<string, unknown> = {};
        if (title) metaUpdates.title = title;
        if (slug) metaUpdates.urlId = slug;
        const renameResult = await client.updatePageMetadata(result.data.id, metaUpdates as any);
        if (renameResult.success) {
          if (title) result.data.urlId = slug ?? result.data.urlId;
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_create_product ────────────────────────────────────────────────────────
  server.registerTool('sq_create_product', {
    description:
      'Create a new product on a Squarespace store. Creates a hidden product shell, optionally attaches an image, ' +
      'then updates with name, price, description, and variants. For multi-variant products, pass the variants array ' +
      'with attributes and prices. The default variant is automatically deleted when custom variants are provided.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      collectionId: z.string().describe('Store collection ID (from sq_create_store_page or sq_list_pages)'),
      name: z.string().describe('Product name'),
      price: z.string().describe('Base price as decimal string (e.g. "35.00")'),
      description: z.string().optional().describe('Product description (HTML supported)'),
      productType: z.number().optional().describe('Product type: 1=PHYSICAL (default), 2=DIGITAL, 3=SERVICE, 4=GIFT_CARD'),
      imageAssetId: z.string().optional().describe('Asset ID from sq_upload_image to attach as product image and thumbnail'),
      visible: z.boolean().optional().describe('Make product visible immediately (default: true)'),
      slug: z.string().optional().describe('Custom URL slug (e.g. "white-hat"). Auto-generated from name if omitted.'),
      tags: z.array(z.string()).optional().describe('Product tags'),
      categories: z.array(z.string()).optional().describe('Product categories'),
      variants: z.array(z.object({
        attributes: z.record(z.string()).describe('Variant attributes (e.g. {"Size": "Large", "Color": "Red"})'),
        price: z.string().describe('Variant price as decimal string'),
        sku: z.string().optional().describe('SKU (auto-generated if omitted)'),
        unlimited: z.boolean().optional().describe('Unlimited stock (default: true)'),
        quantityInStock: z.number().optional().describe('Stock quantity (only used when unlimited is false)'),
      })).optional().describe('Custom variants — if provided, the default variant is replaced'),
    },
  }, async ({ siteId, collectionId, name, price, description, productType, imageAssetId, visible, slug, tags, categories, variants }) => {
    try {
      const client = getClient(siteId);

      // Step 1: Create product shell
      const shellResult = await client.createProductShell(collectionId, productType ?? 1);
      if (!shellResult.success || !shellResult.data) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(shellResult) }], isError: true };
      }
      const productId = shellResult.data.id;
      const defaultVariantId = shellResult.data.variants[0]?.id;

      // Step 2: Attach image if provided
      if (imageAssetId) {
        await client.attachProductImage(productId, imageAssetId);
        await client.setProductThumbnail(productId, imageAssetId);
      }

      // Step 3: Build update request
      const update: UpdateProductRequest = {
        name,
        description: description ?? '',
        visibility: { state: visible === false ? 'HIDDEN' : 'VISIBLE' },
        tags: tags ?? [],
        categories: categories ?? [],
      };
      if (slug) update.urlId = slug;

      if (variants && variants.length > 0) {
        // Multi-variant: delete default, create new variants
        const optionNames = new Set<string>();
        const createdVariants: CreateVariantRequest[] = variants.map((v, i) => {
          Object.keys(v.attributes).forEach(k => optionNames.add(k));
          return {
            sku: v.sku ?? `SQ${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`,
            price: { decimalValue: v.price, currencyCode: 'USD' },
            salePrice: { decimalValue: '0', currencyCode: 'USD' },
            onSale: false,
            unlimited: v.unlimited !== false,
            ...(v.quantityInStock !== undefined ? { quantityInStock: v.quantityInStock } : {}),
            optionValues: Object.entries(v.attributes).map(([optionName, value]) => ({ optionName, value })),
          };
        });

        update.createdVariants = createdVariants;
        update.deletedVariants = defaultVariantId ? [{ id: defaultVariantId }] : [];
        update.variantOptionOrdering = [...optionNames];
      } else {
        // Simple product: update default variant with price
        if (defaultVariantId) {
          update.updatedVariants = [{
            id: defaultVariantId,
            sku: shellResult.data.variants[0]?.sku ?? 'SQ0000001',
            price: { decimalValue: price, currencyCode: 'USD' },
          }];
        }
      }

      // Step 4: Update product
      const updateResult = await client.updateProduct(productId, update);
      if (!updateResult.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(updateResult) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(updateResult.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_update_product ────────────────────────────────────────────────────────
  server.registerTool('sq_update_product', {
    description:
      'Update an existing product. Can change name, description, slug, visibility, tags, and variants. ' +
      'For variant price changes, pass updatedVariants with variant ID, SKU, and new price.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      productId: z.string().describe('Product ID to update'),
      name: z.string().optional().describe('New product name'),
      description: z.string().optional().describe('New product description (HTML supported)'),
      slug: z.string().optional().describe('Custom URL slug (e.g. "white-hat")'),
      visible: z.boolean().optional().describe('Product visibility'),
      tags: z.array(z.string()).optional().describe('Product tags (replaces existing)'),
      categories: z.array(z.string()).optional().describe('Product categories (replaces existing)'),
      updatedVariants: z.array(z.object({
        id: z.string().describe('Variant ID'),
        sku: z.string().describe('Variant SKU'),
        price: z.string().optional().describe('New price as decimal string'),
        unlimited: z.boolean().optional().describe('Toggle unlimited stock'),
        quantityChange: z.number().optional().describe('Stock quantity delta (+5 adds 5, -3 removes 3). Only applies when unlimited is false.'),
      })).optional().describe('Variants to update (price, stock, etc.)'),
      createdVariants: z.array(z.object({
        attributes: z.record(z.string()).describe('Variant attributes'),
        price: z.string().describe('Variant price'),
        sku: z.string().optional().describe('SKU (auto-generated if omitted)'),
        unlimited: z.boolean().optional().describe('Unlimited stock (default: true)'),
        quantityInStock: z.number().optional().describe('Stock quantity (only used when unlimited is false)'),
      })).optional().describe('New variants to add'),
      deletedVariants: z.array(z.string()).optional().describe('Variant IDs to delete'),
    },
  }, async ({ siteId, productId, name, description, slug, visible, tags, categories, updatedVariants, createdVariants, deletedVariants }) => {
    try {
      const client = getClient(siteId);
      const update: UpdateProductRequest = {};

      if (name !== undefined) update.name = name;
      if (description !== undefined) update.description = description;
      if (slug !== undefined) update.urlId = slug;
      if (visible !== undefined) update.visibility = { state: visible ? 'VISIBLE' : 'HIDDEN' };
      if (tags !== undefined) update.tags = tags;
      if (categories !== undefined) update.categories = categories;

      if (updatedVariants) {
        update.updatedVariants = updatedVariants.map(v => ({
          id: v.id,
          sku: v.sku,
          ...(v.price !== undefined ? { price: { decimalValue: v.price, currencyCode: 'USD' } } : {}),
          ...(v.unlimited !== undefined ? { unlimited: v.unlimited } : {}),
          ...(v.quantityChange !== undefined ? { quantityChange: v.quantityChange } : {}),
        }));
      }

      if (createdVariants) {
        update.createdVariants = createdVariants.map(v => ({
          sku: v.sku ?? `SQ${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`,
          price: { decimalValue: v.price, currencyCode: 'USD' },
          salePrice: { decimalValue: '0', currencyCode: 'USD' },
          onSale: false,
          unlimited: v.unlimited !== false,
          ...(v.quantityInStock !== undefined ? { quantityInStock: v.quantityInStock } : {}),
          optionValues: Object.entries(v.attributes).map(([optionName, value]) => ({ optionName, value })),
        }));
      }

      if (deletedVariants) {
        update.deletedVariants = deletedVariants.map(id => ({ id }));
      }

      const result = await client.updateProduct(productId, update);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_get_product ─────────────────────────────────────────────────────────
  server.registerTool('sq_get_product', {
    description:
      'Get full details for a single product by its ID. Returns name, description, variants, pricing, images, and stock info.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      productId: z.string().describe('Product ID'),
    },
  }, async ({ siteId, productId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getProduct(productId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_delete_product ──────────────────────────────────────────────────────
  server.registerTool('sq_delete_product', {
    description:
      'Delete a product from the store. This is permanent and cannot be undone.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      productId: z.string().describe('Product ID to delete'),
    },
  }, async ({ siteId, productId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.deleteProduct(productId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deleted: productId }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_list_products ───────────────────────────────────────────────────────
  server.registerTool('sq_list_products', {
    description:
      'List products from the store. Returns products array with IDs, names, prices, and variants.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      pageSize: z.number().optional().describe('Number of products to return (default: all)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
  }, async ({ siteId, pageSize, cursor }) => {
    try {
      const client = getClient(siteId);
      const result = await client.listProducts({ pageSize, cursor });
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_remove_product_image ────────────────────────────────────────────────
  server.registerTool('sq_remove_product_image', {
    description:
      'Remove an image from a product. Use sq_get_product to find image IDs in the images array.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      productId: z.string().describe('Product ID'),
      imageId: z.string().describe('Image ID to remove (from sq_get_product images array)'),
    },
  }, async ({ siteId, productId, imageId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.removeProductImage(productId, imageId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, removed: imageId, productId }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_attach_product_image ────────────────────────────────────────────────
  server.registerTool('sq_attach_product_image', {
    description:
      'Attach an uploaded image to a product. Use sq_upload_image first to get the assetId, ' +
      'then pass it here. Optionally set as the product thumbnail.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      productId: z.string().describe('Product ID to attach image to'),
      assetId: z.string().describe('Asset ID from sq_upload_image (the systemDataId)'),
      setAsThumbnail: z.boolean().optional().describe('Also set this image as the product thumbnail (default: false)'),
    },
  }, async ({ siteId, productId, assetId, setAsThumbnail }) => {
    try {
      const client = getClient(siteId);
      const result = await client.attachProductImage(productId, assetId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }

      if (setAsThumbnail) {
        await client.setProductThumbnail(productId, assetId);
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_set_product_thumbnail ───────────────────────────────────────────────
  server.registerTool('sq_set_product_thumbnail', {
    description:
      'Set a product\'s thumbnail image. The assetId must be from a previously uploaded image (sq_upload_image).',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      productId: z.string().describe('Product ID'),
      assetId: z.string().describe('Asset ID from sq_upload_image (the systemDataId)'),
    },
  }, async ({ siteId, productId, assetId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.setProductThumbnail(productId, assetId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
}
