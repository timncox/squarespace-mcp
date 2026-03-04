/**
 * MCP Tools — Commerce API (Products, Orders, Inventory, Profiles, Transactions)
 *
 * Tier 1 — Read operations:
 * sq_list_store_pages: List store pages on a site
 * sq_list_products: List products with optional type/date filters
 * sq_get_product: Get product details by ID
 * sq_list_orders: List orders with status/customer filters
 * sq_get_order: Get order details by ID
 * sq_list_inventory: List current inventory levels
 * sq_adjust_stock: Adjust stock quantities for variants
 *
 * Tier 2 — Product management:
 * sq_create_product: Create a new product
 * sq_update_product: Update product name, description, tags, visibility
 * sq_delete_product: Delete a product
 * sq_fulfill_order: Mark order as fulfilled with tracking info
 *
 * Tier 3 — Reporting:
 * sq_list_profiles: List customer profiles
 * sq_list_transactions: List transactions with date filters
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCommerceClient } from '../session.js';

export function registerCommerceTools(server: McpServer) {
  // ── sq_list_store_pages ──────────────────────────────────────────────────────
  server.registerTool('sq_list_store_pages', {
    description:
      'List all store pages on a Squarespace site. Returns page IDs, titles, and URLs. ' +
      'Requires Commerce API access — use sq_list_sites to check hasCommerceApi first.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.getStorePages();
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_list_products ─────────────────────────────────────────────────────────
  server.registerTool('sq_list_products', {
    description:
      'List products from a Squarespace store. Supports filtering by product type and modification date. ' +
      'Returns products array and pagination cursor for fetching more.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      type: z.enum(['PHYSICAL', 'DIGITAL', 'SERVICE', 'GIFT_CARD']).optional().describe('Filter by product type'),
      modifiedAfter: z.string().optional().describe('ISO 8601 date — only products modified after this date'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
  }, async ({ siteId, type, modifiedAfter, cursor }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.getProducts({ type, modifiedAfter, cursor });
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_get_product ───────────────────────────────────────────────────────────
  server.registerTool('sq_get_product', {
    description:
      'Get full details for a single product by its ID. Returns product name, description, variants, pricing, images, and stock info.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      productId: z.string().describe('Product ID'),
    },
  }, async ({ siteId, productId }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.getProduct(productId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_list_orders ───────────────────────────────────────────────────────────
  server.registerTool('sq_list_orders', {
    description:
      'List orders from a Squarespace store. Supports filtering by fulfillment status, customer, and modification date. ' +
      'Returns orders array and pagination cursor.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      fulfillmentStatus: z.enum(['PENDING', 'FULFILLED', 'CANCELED']).optional().describe('Filter by fulfillment status'),
      customerId: z.string().optional().describe('Filter by customer ID'),
      modifiedAfter: z.string().optional().describe('ISO 8601 date — only orders modified after this date'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
  }, async ({ siteId, fulfillmentStatus, customerId, modifiedAfter, cursor }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.getOrders({ fulfillmentStatus, customerId, modifiedAfter, cursor });
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_get_order ─────────────────────────────────────────────────────────────
  server.registerTool('sq_get_order', {
    description:
      'Get full details for a single order by its ID. Returns line items, shipping address, customer info, fulfillment status, and totals.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      orderId: z.string().describe('Order ID'),
    },
  }, async ({ siteId, orderId }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.getOrder(orderId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_list_inventory ────────────────────────────────────────────────────────
  server.registerTool('sq_list_inventory', {
    description:
      'List current inventory levels for all product variants. Returns variant IDs, SKUs, quantities, and whether stock is tracked.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
  }, async ({ siteId, cursor }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.getInventory(cursor);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_adjust_stock ──────────────────────────────────────────────────────────
  server.registerTool('sq_adjust_stock', {
    description:
      'Adjust stock quantities for one or more product variants. Use quantityDelta for relative changes (+/-) or quantity for absolute values. ' +
      'Each adjustment targets a specific variantId.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      adjustments: z.array(z.object({
        variantId: z.string().describe('Variant ID to adjust'),
        quantity: z.number().optional().describe('Absolute stock quantity (overrides current)'),
        quantityDelta: z.number().optional().describe('Relative stock change (e.g. -1, +5)'),
      })).describe('Array of stock adjustments'),
    },
  }, async ({ siteId, adjustments }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.adjustStock(adjustments);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, adjustedVariants: adjustments.length }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_create_product ────────────────────────────────────────────────────────
  server.registerTool('sq_create_product', {
    description:
      'Create a new product on a Squarespace store. Requires storePageId (from sq_list_store_pages) and product type. ' +
      'At least one variant with pricing is required.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      storePageId: z.string().describe('Store page ID (from sq_list_store_pages)'),
      type: z.enum(['PHYSICAL', 'DIGITAL', 'SERVICE', 'GIFT_CARD']).describe('Product type'),
      name: z.string().optional().describe('Product name'),
      description: z.string().optional().describe('Product description (HTML supported)'),
      tags: z.array(z.string()).optional().describe('Product tags'),
      isVisible: z.boolean().optional().describe('Whether product is visible in store (default true)'),
      variants: z.array(z.object({
        sku: z.string().describe('SKU identifier'),
        pricing: z.object({
          basePrice: z.object({
            value: z.string().describe('Price as string (e.g. "29.99")'),
            currency: z.string().describe('Currency code (e.g. "USD")'),
          }),
        }),
        stock: z.object({
          quantity: z.number().optional().describe('Initial stock quantity'),
        }).optional(),
        attributes: z.record(z.string()).optional().describe('Variant attributes (e.g. {"Color": "Red", "Size": "L"})'),
      })).describe('Product variants with pricing'),
    },
  }, async ({ siteId, storePageId, type, name, description, tags, isVisible, variants }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.createProduct({
        storePageId,
        type,
        name,
        description,
        tags,
        isVisible,
        variants,
      });
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_update_product ────────────────────────────────────────────────────────
  server.registerTool('sq_update_product', {
    description:
      'Update an existing product. Can change name, description, tags, and visibility. ' +
      'Only provided fields are updated — omitted fields are left unchanged.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      productId: z.string().describe('Product ID to update'),
      name: z.string().optional().describe('New product name'),
      description: z.string().optional().describe('New product description (HTML supported)'),
      tags: z.array(z.string()).optional().describe('New product tags (replaces existing)'),
      isVisible: z.boolean().optional().describe('Whether product is visible in store'),
    },
  }, async ({ siteId, productId, name, description, tags, isVisible }) => {
    try {
      const client = getCommerceClient(siteId);
      const updateData: Record<string, unknown> = {};
      if (name !== undefined) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (tags !== undefined) updateData.tags = tags;
      if (isVisible !== undefined) updateData.isVisible = isVisible;

      const result = await client.updateProduct(productId, updateData);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_delete_product ────────────────────────────────────────────────────────
  server.registerTool('sq_delete_product', {
    description:
      'Delete a product from the store. This action is permanent and cannot be undone.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      productId: z.string().describe('Product ID to delete'),
    },
  }, async ({ siteId, productId }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.deleteProduct(productId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deleted: productId }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_fulfill_order ─────────────────────────────────────────────────────────
  server.registerTool('sq_fulfill_order', {
    description:
      'Mark an order as fulfilled with shipping details. Optionally send a notification email to the customer.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      orderId: z.string().describe('Order ID to fulfill'),
      shipDate: z.string().describe('Ship date in ISO 8601 format (e.g. "2026-03-04T10:00:00Z")'),
      carrierName: z.string().optional().describe('Shipping carrier name (e.g. "USPS", "FedEx")'),
      trackingNumber: z.string().optional().describe('Tracking number'),
      trackingUrl: z.string().optional().describe('Tracking URL'),
      shouldSendNotification: z.boolean().optional().describe('Send shipment notification to customer (default false)'),
    },
  }, async ({ siteId, orderId, shipDate, carrierName, trackingNumber, trackingUrl, shouldSendNotification }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.fulfillOrder(orderId, {
        shipDate,
        carrierName,
        trackingNumber,
        trackingUrl,
        shouldSendNotification,
      });
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_list_profiles ─────────────────────────────────────────────────────────
  server.registerTool('sq_list_profiles', {
    description:
      'List customer/visitor profiles. Filter to customers only with isCustomer=true. ' +
      'Returns profile info including email, name, and order history.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      isCustomer: z.boolean().optional().describe('If true, only show customers (people who have ordered)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
  }, async ({ siteId, isCustomer, cursor }) => {
    try {
      const client = getCommerceClient(siteId);
      const options: { filter?: string; cursor?: string } = {};
      if (isCustomer === true) options.filter = 'isCustomer';
      if (cursor) options.cursor = cursor;

      const result = await client.getProfiles(options);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  // ── sq_list_transactions ─────────────────────────────────────────────────────
  server.registerTool('sq_list_transactions', {
    description:
      'List commerce transactions (sales, refunds). Supports filtering by date range. ' +
      'Returns transaction documents with amounts, dates, and related order IDs.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      modifiedAfter: z.string().optional().describe('ISO 8601 date — only transactions after this date'),
      modifiedBefore: z.string().optional().describe('ISO 8601 date — only transactions before this date'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
  }, async ({ siteId, modifiedAfter, modifiedBefore, cursor }) => {
    try {
      const client = getCommerceClient(siteId);
      const result = await client.getTransactions({ modifiedAfter, modifiedBefore, cursor });
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
}
