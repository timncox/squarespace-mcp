# Gallery Image Management — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add gallery image remove, reorder, and list MCP tools backed by new ContentSaveClient methods.

**Architecture:** Two new methods on ContentSaveClient (`removeGalleryImage`, `reorderGalleryImages`) wrapping discovered Squarespace endpoints. Three new MCP tools (`sq_list_gallery_images`, `sq_remove_gallery_image`, `sq_reorder_gallery_images`) in the existing `content.ts` tool module. Gallery tools resolve the gallery collection ID via `findGalleryBlock()`.

**Tech Stack:** TypeScript, vitest, Zod 3, MCP SDK

---

### Task 1: Add ContentSaveClient types

**Files:**
- Modify: `src/services/content-save-types.ts:302-316`

**Step 1: Add result types after existing gallery types**

After the `GalleryItem` interface (line ~316), add:

```typescript
/** Result of removing a gallery image */
export interface RemoveGalleryImageResult {
  success: boolean;
  itemId?: string;
  error?: string;
}

/** Result of reordering gallery images */
export interface ReorderGalleryImagesResult {
  success: boolean;
  items?: GalleryItem[];
  error?: string;
}
```

**Step 2: Commit**

```bash
git add src/services/content-save-types.ts
git commit -m "feat: add RemoveGalleryImageResult and ReorderGalleryImagesResult types"
```

---

### Task 2: Write failing tests for removeGalleryImage

**Files:**
- Modify: `src/services/__tests__/content-save-gallery.test.ts`

**Step 1: Add tests at end of the describe block**

Add a new `describe('removeGalleryImage()')` block after the existing gallery tests:

```typescript
  describe('removeGalleryImage()', () => {
    it('deletes an image and returns success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
      });

      const result = await client.removeGalleryImage(GALLERY_COLL_ID, 'item-abc');
      expect(result.success).toBe(true);
      expect(result.itemId).toBe('item-abc');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/content-items/item-abc');
      expect(opts.method).toBe('DELETE');
    });

    it('returns error on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

      const result = await client.removeGalleryImage(GALLERY_COLL_ID, 'nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('404');
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-gallery.test.ts`
Expected: FAIL — `removeGalleryImage is not a function`

**Step 3: Commit**

```bash
git add src/services/__tests__/content-save-gallery.test.ts
git commit -m "test: add failing tests for removeGalleryImage"
```

---

### Task 3: Implement removeGalleryImage

**Files:**
- Modify: `src/services/content-save.ts` (after `addGalleryImage`, around line ~8566)

**Step 1: Add the method**

After `addGalleryImage()`, add:

```typescript
  /**
   * Remove an image from a gallery collection.
   *
   * Endpoint: DELETE /api/content-items/{itemId}
   * Discovered via Playwright traffic capture on gallery editor.
   */
  async removeGalleryImage(
    galleryCollectionId: string,
    itemId: string,
  ): Promise<RemoveGalleryImageResult> {
    try {
      this.ensureCookies();

      const path = `/api/content-items/${encodeURIComponent(itemId)}`;
      const url = this.buildApiUrl(path, true);

      logger.info({ galleryCollectionId, itemId }, 'Removing gallery image');

      const response = await fetch(url, {
        method: 'DELETE',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { success: false, error: `Failed to remove gallery image: ${response.status}. ${body}` };
      }

      logger.info({ galleryCollectionId, itemId }, 'Gallery image removed');
      return { success: true, itemId };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }
```

Also add the import for `RemoveGalleryImageResult` and `ReorderGalleryImagesResult` from `content-save-types.js` at the top of the file (where other gallery types are imported).

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-gallery.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/content-save.ts
git commit -m "feat: add removeGalleryImage() to ContentSaveClient"
```

---

### Task 4: Write failing tests for reorderGalleryImages

**Files:**
- Modify: `src/services/__tests__/content-save-gallery.test.ts`

**Step 1: Add tests**

```typescript
  describe('reorderGalleryImages()', () => {
    it('reorders images and returns updated items', async () => {
      const updatedItems = [
        { id: 'item-b', displayIndex: 0, filename: 'b.png' },
        { id: 'item-a', displayIndex: 1, filename: 'a.png' },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: updatedItems }),
        text: async () => JSON.stringify({ items: updatedItems }),
      });

      const result = await client.reorderGalleryImages(GALLERY_COLL_ID, ['item-b', 'item-a']);
      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items![0].id).toBe('item-b');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/api/commondata/ReorderItems');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');

      // Verify form body
      const body = opts.body as string;
      expect(body).toContain(`collectionId=${GALLERY_COLL_ID}`);
      expect(body).toContain('itemIds=');
      const decodedIds = decodeURIComponent(body.split('itemIds=')[1]);
      expect(JSON.parse(decodedIds)).toEqual(['item-b', 'item-a']);
    });

    it('returns error on API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal error',
      });

      const result = await client.reorderGalleryImages(GALLERY_COLL_ID, ['item-a']);
      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-gallery.test.ts`
Expected: FAIL — `reorderGalleryImages is not a function`

**Step 3: Commit**

```bash
git add src/services/__tests__/content-save-gallery.test.ts
git commit -m "test: add failing tests for reorderGalleryImages"
```

---

### Task 5: Implement reorderGalleryImages

**Files:**
- Modify: `src/services/content-save.ts` (after `removeGalleryImage`)

**Step 1: Add the method**

```typescript
  /**
   * Reorder images in a gallery collection.
   *
   * Endpoint: POST /api/commondata/ReorderItems
   * Body: form-encoded collectionId + itemIds (JSON array of IDs in desired order)
   * Discovered via Playwright traffic capture on gallery editor.
   */
  async reorderGalleryImages(
    galleryCollectionId: string,
    itemIds: string[],
  ): Promise<ReorderGalleryImagesResult> {
    try {
      this.ensureCookies();

      const path = '/api/commondata/ReorderItems';
      const url = this.buildApiUrl(path, true);

      const formBody = `collectionId=${encodeURIComponent(galleryCollectionId)}&itemIds=${encodeURIComponent(JSON.stringify(itemIds))}`;

      logger.info(
        { galleryCollectionId, itemCount: itemIds.length },
        'Reordering gallery images',
      );

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { success: false, error: `Failed to reorder gallery images: ${response.status}. ${body}` };
      }

      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const items = Array.isArray(data.items) ? data.items as GalleryItem[] : undefined;

      logger.info(
        { galleryCollectionId, itemCount: items?.length },
        'Gallery images reordered',
      );
      return { success: true, items };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-gallery.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/services/content-save.ts
git commit -m "feat: add reorderGalleryImages() to ContentSaveClient"
```

---

### Task 6: Write failing tests for gallery MCP tools

**Files:**
- Modify: `src/mcp-server/__tests__/content-tools.test.ts`

**Step 1: Add mock methods to `mockClient`**

At the top where `mockClient` is defined, add:

```typescript
  getPageSections: vi.fn(),
  findGalleryBlock: vi.fn(),
  getGalleryItems: vi.fn(),
  removeGalleryImage: vi.fn(),
  reorderGalleryImages: vi.fn(),
```

**Step 2: Add tests**

```typescript
  // ── Gallery Image Management Tools ──────────────────────────────────────

  describe('sq_list_gallery_images', () => {
    it('lists gallery images on a page', async () => {
      mockClient.getPageSections.mockResolvedValue({
        sections: [{ id: 'sec-1' }],
        updatedOn: Date.now(),
      });
      mockClient.findGalleryBlock.mockReturnValue({
        galleryCollectionId: 'gal-col-1',
        sectionIndex: 0,
        blockIndex: 0,
        gridContent: {},
      });
      mockClient.getGalleryItems.mockResolvedValue({
        success: true,
        items: [
          { id: 'img-1', displayIndex: 0, filename: 'photo1.jpg', assetUrl: 'https://cdn/photo1.jpg' },
          { id: 'img-2', displayIndex: 1, filename: 'photo2.jpg', assetUrl: 'https://cdn/photo2.jpg' },
        ],
      });

      const result = await server.callTool('sq_list_gallery_images', {
        siteId: 'test-site',
        pageSlug: 'gallery',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.items).toHaveLength(2);
    });

    it('returns error when no gallery block found', async () => {
      mockClient.getPageSections.mockResolvedValue({
        sections: [{ id: 'sec-1' }],
        updatedOn: Date.now(),
      });
      mockClient.findGalleryBlock.mockReturnValue(null);

      const result = await server.callTool('sq_list_gallery_images', {
        siteId: 'test-site',
        pageSlug: 'no-gallery',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No gallery block found');
    });
  });

  describe('sq_remove_gallery_image', () => {
    it('removes a gallery image', async () => {
      mockClient.removeGalleryImage.mockResolvedValue({ success: true, itemId: 'img-1' });

      const result = await server.callTool('sq_remove_gallery_image', {
        siteId: 'test-site',
        itemId: 'img-1',
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('returns error on failure', async () => {
      mockClient.removeGalleryImage.mockResolvedValue({ success: false, error: 'Not found' });

      const result = await server.callTool('sq_remove_gallery_image', {
        siteId: 'test-site',
        itemId: 'bad-id',
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('sq_reorder_gallery_images', () => {
    it('reorders gallery images', async () => {
      mockClient.getPageSections.mockResolvedValue({
        sections: [{ id: 'sec-1' }],
        updatedOn: Date.now(),
      });
      mockClient.findGalleryBlock.mockReturnValue({
        galleryCollectionId: 'gal-col-1',
        sectionIndex: 0,
        blockIndex: 0,
        gridContent: {},
      });
      mockClient.reorderGalleryImages.mockResolvedValue({
        success: true,
        items: [
          { id: 'img-2', displayIndex: 0 },
          { id: 'img-1', displayIndex: 1 },
        ],
      });

      const result = await server.callTool('sq_reorder_gallery_images', {
        siteId: 'test-site',
        pageSlug: 'gallery',
        itemIds: ['img-2', 'img-1'],
      });

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(mockClient.reorderGalleryImages).toHaveBeenCalledWith('gal-col-1', ['img-2', 'img-1']);
    });
  });
```

**Step 3: Update the registration count test**

Change the `'should register all 8 content tools'` test to expect 11 tools and add:

```typescript
    expect(server.tools.has('sq_list_gallery_images')).toBe(true);
    expect(server.tools.has('sq_remove_gallery_image')).toBe(true);
    expect(server.tools.has('sq_reorder_gallery_images')).toBe(true);
```

**Step 4: Run tests to verify they fail**

Run: `npx vitest run src/mcp-server/__tests__/content-tools.test.ts`
Expected: FAIL — tools not registered

**Step 5: Commit**

```bash
git add src/mcp-server/__tests__/content-tools.test.ts
git commit -m "test: add failing tests for gallery image MCP tools"
```

---

### Task 7: Implement gallery MCP tools

**Files:**
- Modify: `src/mcp-server/tools/content.ts` (after `sq_update_gallery`, before closing `}`)

**Step 1: Add the three new tools**

```typescript
  // ── sq_list_gallery_images ─────────────────────────────────────────────────
  server.registerTool('sq_list_gallery_images', {
    description:
      'List all images in a gallery on a Squarespace page. Returns image IDs, filenames, titles, display order, and asset URLs. Use this to discover image IDs before removing or reordering.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the gallery'),
      searchText: z.string().optional().describe('Gallery collectionId or block ID prefix (optional — uses first gallery if omitted)'),
    },
  }, async ({ siteId, pageSlug, searchText }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const data = await client.getPageSections(ids.pageSectionsId);
      const found = client.findGalleryBlock(data.sections, searchText);
      if (!found) {
        return { content: [{ type: 'text' as const, text: 'Error: No gallery block found on this page' }], isError: true };
      }
      const result = await client.getGalleryItems(found.galleryCollectionId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to fetch gallery items'}` }], isError: true };
      }
      const summary = (result.items ?? []).map((item: any) => ({
        id: item.id,
        displayIndex: item.displayIndex,
        filename: item.filename,
        title: item.title,
        assetUrl: item.assetUrl,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, galleryCollectionId: found.galleryCollectionId, items: summary }, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── sq_remove_gallery_image ────────────────────────────────────────────────
  server.registerTool('sq_remove_gallery_image', {
    description:
      'Remove an image from a gallery. Use sq_list_gallery_images first to get the image item ID.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      itemId: z.string().describe('Gallery image item ID (from sq_list_gallery_images)'),
    },
  }, async ({ siteId, itemId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.removeGalleryImage('', itemId);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to remove image'}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // ── sq_reorder_gallery_images ──────────────────────────────────────────────
  server.registerTool('sq_reorder_gallery_images', {
    description:
      'Reorder images in a gallery. Pass the complete list of image item IDs in the desired order. Use sq_list_gallery_images first to get current IDs and order.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug containing the gallery'),
      itemIds: z.array(z.string()).describe('Complete ordered list of all gallery image item IDs in desired display order'),
      searchText: z.string().optional().describe('Gallery collectionId or block ID prefix (optional — uses first gallery if omitted)'),
    },
  }, async ({ siteId, pageSlug, itemIds, searchText }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const data = await client.getPageSections(ids.pageSectionsId);
      const found = client.findGalleryBlock(data.sections, searchText);
      if (!found) {
        return { content: [{ type: 'text' as const, text: 'Error: No gallery block found on this page' }], isError: true };
      }
      const result = await client.reorderGalleryImages(found.galleryCollectionId, itemIds);
      if (!result.success) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to reorder images'}` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/mcp-server/__tests__/content-tools.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/mcp-server/tools/content.ts
git commit -m "feat: add sq_list_gallery_images, sq_remove_gallery_image, sq_reorder_gallery_images MCP tools"
```

---

### Task 8: Register tools in MCP server index

**Files:**
- Check: `src/mcp-server/index.ts`

The gallery tools are in `content.ts` which is already registered via `registerContentTools(server)`. No changes needed to `index.ts`. Verify by running the full test suite.

**Step 1: Run full test suite**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
Expected: All tests pass, count increases by ~10

**Step 2: Commit (if any cleanup needed)**

---

### Task 9: Update CLAUDE.md and memory

**Files:**
- Modify: `CLAUDE.md` — update tool count (~47 → ~50), add gallery management methods to Key methods table
- Modify: memory `MEMORY.md` — add gallery image management entry

**Step 1: Update CLAUDE.md**

- Update "~47 tools" references to "~50 tools"
- Add to ContentSaveClient key methods: `removeGalleryImage()`, `reorderGalleryImages()`
- Add MCP tools: `sq_list_gallery_images`, `sq_remove_gallery_image`, `sq_reorder_gallery_images`

**Step 2: Update memory**

Add to Current State section in MEMORY.md:
- Gallery image management MCP tools: `sq_list_gallery_images`, `sq_remove_gallery_image`, `sq_reorder_gallery_images`
- API endpoints: `DELETE /api/content-items/{id}`, `POST /api/commondata/ReorderItems`

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with gallery image management tools"
```
