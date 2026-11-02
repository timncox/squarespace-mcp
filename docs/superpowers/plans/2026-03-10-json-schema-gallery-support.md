# JSON_SCHEMA Gallery Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all gallery tools work with JSON_SCHEMA GalleryMasonry sections (not just FLUID_ENGINE type 8 blocks).

**Architecture:** Extend `findGalleryBlock()` to also scan JSON_SCHEMA sections for `galleryOptions.transientGalleryId`. Add `addGalleryImageViaSaveMedia()` for galleries where the `/api/galleries/{id}/images` endpoint returns 500. Have `addGalleryImage()` auto-fallback to SaveMedia on failure. The tool layer stays unchanged — all fixes are in the service layer.

**Tech Stack:** TypeScript, vitest, Squarespace Content Save API

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/services/content-save/gallery.ts` | Modify | Extend `findGalleryBlock()`, add `addGalleryImageViaSaveMedia()`, auto-fallback in `addGalleryImage()` |
| `src/services/content-save/types.ts` | Modify | Add `galleryType` to `findGalleryBlock` return type |
| `src/services/__tests__/content-save-gallery.test.ts` | Modify | Add tests for JSON_SCHEMA gallery detection and SaveMedia fallback |

No tool layer changes needed — `sq_list_gallery_images`, `sq_add_gallery_image`, `sq_remove_gallery_image`, `sq_reorder_gallery_images` all use `findGalleryBlock()` → `getGalleryItems()`/`addGalleryImage()` which will transparently gain JSON_SCHEMA support.

---

## Chunk 1: findGalleryBlock JSON_SCHEMA support

### Task 1: Add JSON_SCHEMA gallery detection tests

**Files:**
- Modify: `src/services/__tests__/content-save-gallery.test.ts`

- [ ] **Step 1: Add helper to create JSON_SCHEMA gallery sections**

Add a `makeJsonSchemaGallerySection` helper after the existing `makeSectionsWithGallery` helper (line ~86):

```typescript
function makeJsonSchemaGallerySection(sectionId: string, galleryCollectionId: string): PageSection {
  return {
    id: sectionId,
    sectionName: 'JSON_SCHEMA',
    typeName: 'GalleryMasonry',
    jsonData: {
      galleryOptions: {
        transientGalleryId: galleryCollectionId,
      },
    },
  };
}
```

- [ ] **Step 2: Write failing tests for JSON_SCHEMA gallery detection**

Add these tests inside the existing `describe('findGalleryBlock()')` block (after line 162):

```typescript
it('finds a JSON_SCHEMA GalleryMasonry section by transientGalleryId', () => {
  const section = makeJsonSchemaGallerySection('sec-json-1', GALLERY_COLL_ID);
  const result = client.findGalleryBlock([section], GALLERY_COLL_ID);
  expect(result).not.toBeNull();
  expect(result!.galleryCollectionId).toBe(GALLERY_COLL_ID);
  expect(result!.sectionIndex).toBe(0);
  expect(result!.blockIndex).toBe(-1);
});

it('finds first JSON_SCHEMA gallery when no searchText', () => {
  const textSection: PageSection = {
    id: 'sec-text',
    sectionName: 'FLUID_ENGINE',
    fluidEngineContext: {
      id: 'ctx-1',
      gridContents: [makeTextBlock('blk-1', '<p>Hi</p>')],
      gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
    },
  };
  const gallerySection = makeJsonSchemaGallerySection('sec-json-1', GALLERY_COLL_ID);
  const result = client.findGalleryBlock([textSection, gallerySection]);
  expect(result).not.toBeNull();
  expect(result!.galleryCollectionId).toBe(GALLERY_COLL_ID);
  expect(result!.sectionIndex).toBe(1);
});

it('finds JSON_SCHEMA gallery by section ID prefix', () => {
  const section = makeJsonSchemaGallerySection('abc123def456789012345678', GALLERY_COLL_ID);
  const result = client.findGalleryBlock([section], 'abc123');
  expect(result).not.toBeNull();
  expect(result!.galleryCollectionId).toBe(GALLERY_COLL_ID);
});

it('prefers FLUID_ENGINE gallery over JSON_SCHEMA when both exist', () => {
  const fluidGallery = makeGalleryBlock('blk-fluid', 'fluid-gallery-coll');
  const fluidSection: PageSection = {
    id: 'sec-fluid',
    sectionName: 'FLUID_ENGINE',
    fluidEngineContext: {
      id: 'ctx-1',
      gridContents: [fluidGallery],
      gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
    },
  };
  const jsonSection = makeJsonSchemaGallerySection('sec-json', GALLERY_COLL_ID);
  const result = client.findGalleryBlock([fluidSection, jsonSection]);
  expect(result).not.toBeNull();
  expect(result!.galleryCollectionId).toBe('fluid-gallery-coll');
});

it('falls back to JSON_SCHEMA gallery when no FLUID_ENGINE gallery matches searchText', () => {
  const textBlock = makeTextBlock('blk-1', '<p>Hi</p>');
  const fluidSection: PageSection = {
    id: 'sec-fluid',
    sectionName: 'FLUID_ENGINE',
    fluidEngineContext: {
      id: 'ctx-1',
      gridContents: [textBlock],
      gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
    },
  };
  const jsonSection = makeJsonSchemaGallerySection('sec-json', GALLERY_COLL_ID);
  const result = client.findGalleryBlock([fluidSection, jsonSection], GALLERY_COLL_ID);
  expect(result).not.toBeNull();
  expect(result!.galleryCollectionId).toBe(GALLERY_COLL_ID);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose src/services/__tests__/content-save-gallery.test.ts`

Expected: 5 new tests FAIL (findGalleryBlock returns null for JSON_SCHEMA sections).

### Task 2: Implement JSON_SCHEMA gallery detection

**Files:**
- Modify: `src/services/content-save/gallery.ts:192-224`

- [ ] **Step 4: Update findGalleryBlock to scan JSON_SCHEMA sections**

Replace the `findGalleryBlock` method (lines 192-224) with:

```typescript
ContentSaveClient.prototype.findGalleryBlock = function (
  this: ContentSaveClient,
  sections: PageSection[],
  searchText?: string,
): { gridContent: GridContent; sectionIndex: number; blockIndex: number; galleryCollectionId: string } | null {
  // Pass 1: Search FLUID_ENGINE sections for type 8 gallery blocks (existing behavior)
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const gridContents = section.fluidEngineContext?.gridContents;
    if (!gridContents) continue;

    for (let bi = 0; bi < gridContents.length; bi++) {
      const gc = gridContents[bi];
      const bv = gc.content?.value;
      if (!bv || bv.type !== BLOCK_TYPE_GALLERY) continue;

      const val = bv.value ?? {};
      const galleryCollectionId = (val.collectionId ?? val.transientGalleryId ?? '') as string;

      if (!searchText) {
        return { gridContent: gc, sectionIndex: si, blockIndex: bi, galleryCollectionId };
      }

      const needle = searchText.toLowerCase();
      if (
        galleryCollectionId === searchText ||
        bv.id.toLowerCase().startsWith(needle)
      ) {
        return { gridContent: gc, sectionIndex: si, blockIndex: bi, galleryCollectionId };
      }
    }
  }

  // Pass 2: Search JSON_SCHEMA sections (e.g. GalleryMasonry, GalleryGrid)
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si] as Record<string, unknown>;
    if (section.sectionName !== 'JSON_SCHEMA') continue;

    const jsonData = section.jsonData as Record<string, unknown> | undefined;
    const galleryOptions = jsonData?.galleryOptions as Record<string, unknown> | undefined;
    const galleryCollectionId = (galleryOptions?.transientGalleryId ?? '') as string;
    if (!galleryCollectionId) continue;

    if (!searchText) {
      return { gridContent: {} as GridContent, sectionIndex: si, blockIndex: -1, galleryCollectionId };
    }

    const needle = searchText.toLowerCase();
    if (
      galleryCollectionId === searchText ||
      (section.id as string).toLowerCase().startsWith(needle)
    ) {
      return { gridContent: {} as GridContent, sectionIndex: si, blockIndex: -1, galleryCollectionId };
    }
  }

  return null;
};
```

Key changes:
- First pass scans FLUID_ENGINE (existing behavior, unchanged)
- Second pass scans JSON_SCHEMA sections for `jsonData.galleryOptions.transientGalleryId`
- JSON_SCHEMA results use `blockIndex: -1` and empty `gridContent` (no block to reference)
- FLUID_ENGINE galleries are preferred over JSON_SCHEMA when no searchText is given

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --reporter=verbose src/services/__tests__/content-save-gallery.test.ts`

Expected: All tests PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/services/content-save/gallery.ts src/services/__tests__/content-save-gallery.test.ts
git commit -m "feat: findGalleryBlock scans JSON_SCHEMA GalleryMasonry sections

Extends gallery detection to also search JSON_SCHEMA sections for
galleryOptions.transientGalleryId, fixing sq_list_gallery_images,
sq_remove_gallery_image, and sq_reorder_gallery_images for sites
using GalleryMasonry sections (not just FLUID_ENGINE type 8 blocks).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 2: addGalleryImage SaveMedia fallback

### Task 3: Add SaveMedia fallback tests

**Files:**
- Modify: `src/services/__tests__/content-save-gallery.test.ts`

- [ ] **Step 7: Write tests for addGalleryImageViaSaveMedia**

Add a new `describe('addGalleryImageViaSaveMedia()')` block after the existing `addGalleryImage` tests (after line 563):

```typescript
describe('addGalleryImageViaSaveMedia()', () => {
  it('uploads image buffer to gallery collection via SaveMedia', async () => {
    const saveMediaResponse = {
      job: { id: 'job-123' },
      media: [{ id: 'new-item-id', systemDataSourceType: 'JPEG', mediaProcessingState: 2 }],
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => saveMediaResponse });

    const imageBuffer = Buffer.from('fake-jpeg-data');
    const result = await client.addGalleryImageViaSaveMedia(
      GALLERY_COLL_ID,
      imageBuffer,
      'photo.jpeg',
      'image/jpeg',
    );

    expect(result.success).toBe(true);
    expect(result.itemId).toBe('new-item-id');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/commondata/SaveMedia');
    expect(opts.method).toBe('POST');
    // FormData body — verify it was sent (can't easily inspect FormData internals)
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it('returns error when SaveMedia fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Server error' });

    const result = await client.addGalleryImageViaSaveMedia(
      GALLERY_COLL_ID,
      Buffer.from('data'),
      'photo.jpeg',
      'image/jpeg',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });
});
```

- [ ] **Step 8: Write tests for addGalleryImage auto-fallback**

Add these tests to the existing `describe('addGalleryImage()')` block (after line 563, before the new describe):

```typescript
it('falls back to SaveMedia when galleries API returns 500 and imageBuffer provided', async () => {
  // First call: /api/galleries/{id}/images → 500
  mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Something went wrong' });
  // Second call: SaveMedia → success
  const saveMediaResponse = {
    job: { id: 'job-456' },
    media: [{ id: 'fallback-item-id', systemDataSourceType: 'JPEG' }],
  };
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => saveMediaResponse });

  const imageBuffer = Buffer.from('fake-jpeg-data');
  const result = await client.addGalleryImage(GALLERY_COLL_ID, 'asset-123', { title: 'Test' }, {
    imageBuffer,
    filename: 'test.jpeg',
    contentType: 'image/jpeg',
  });

  expect(result.success).toBe(true);
  expect(result.itemId).toBe('fallback-item-id');
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it('does not fall back to SaveMedia when galleries API returns 500 but no imageBuffer', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Something went wrong' });

  const result = await client.addGalleryImage(GALLERY_COLL_ID, 'asset-123');

  expect(result.success).toBe(false);
  expect(result.error).toContain('500');
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 9: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose src/services/__tests__/content-save-gallery.test.ts`

Expected: 4 new tests FAIL (methods don't exist yet).

### Task 4: Implement addGalleryImageViaSaveMedia and auto-fallback

**Files:**
- Modify: `src/services/content-save/gallery.ts`
- Modify: `src/services/content-save/types.ts` (update interface declaration)

- [ ] **Step 10: Add addGalleryImageViaSaveMedia declaration**

In `gallery.ts`, add to the `declare module` block (after line 46, before the closing `}`):

```typescript
    addGalleryImageViaSaveMedia(
      galleryCollectionId: string,
      imageBuffer: Buffer,
      filename: string,
      contentType?: string,
    ): Promise<AddGalleryImageResult>;
```

- [ ] **Step 11: Update addGalleryImage signature to accept fallback data**

In the `declare module` block, update the `addGalleryImage` declaration (replace lines 35-39):

```typescript
    addGalleryImage(
      galleryCollectionId: string,
      assetId: string,
      metadata?: { title?: string; description?: string },
      fallbackData?: { imageBuffer: Buffer; filename: string; contentType?: string },
    ): Promise<AddGalleryImageResult>;
```

- [ ] **Step 12: Implement addGalleryImageViaSaveMedia**

Add after the existing `addGalleryImage` method (after line 344):

```typescript
ContentSaveClient.prototype.addGalleryImageViaSaveMedia = async function (
  this: ContentSaveClient,
  galleryCollectionId: string,
  imageBuffer: Buffer,
  filename: string,
  contentType = 'image/jpeg',
): Promise<AddGalleryImageResult> {
  try {
    this.ensureCookies();

    const url = this.buildApiUrl('/api/commondata/SaveMedia');
    const fd = new FormData();
    fd.append('collectionId', galleryCollectionId);
    fd.append('recordType', '2');
    fd.append('process', 'true');
    fd.append('Filedata', new Blob([new Uint8Array(imageBuffer)], { type: contentType }), filename);

    logger.info(
      { galleryCollectionId, filename, size: imageBuffer.length },
      'Adding gallery image via SaveMedia',
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `SaveMedia failed: ${response.status}. ${body.slice(0, 200)}` };
    }

    const data = await response.json() as Record<string, unknown>;
    const media = Array.isArray(data.media) ? data.media : [];
    const itemId = media[0]?.id as string | undefined;

    logger.info({ galleryCollectionId, itemId }, 'Gallery image added via SaveMedia');
    return { success: true, itemId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
```

- [ ] **Step 13: Add auto-fallback to addGalleryImage**

Replace the existing `addGalleryImage` method (lines 300-344) with:

```typescript
ContentSaveClient.prototype.addGalleryImage = async function (
  this: ContentSaveClient,
  galleryCollectionId: string,
  assetId: string,
  metadata?: { title?: string; description?: string },
  fallbackData?: { imageBuffer: Buffer; filename: string; contentType?: string },
): Promise<AddGalleryImageResult> {
  try {
    this.ensureCookies();

    const path = `/api/galleries/${encodeURIComponent(galleryCollectionId)}/images`;
    const url = this.buildApiUrl(path, true);

    const body: Record<string, unknown> = { assetId };
    if (metadata?.title) body.title = metadata.title;
    if (metadata?.description) body.description = metadata.description;

    logger.info(
      { galleryCollectionId, assetId, hasTitle: !!metadata?.title },
      'Adding image to gallery',
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const respBody = await response.text().catch(() => '');

      // Auto-fallback: if galleries API returns 500 and we have image data, try SaveMedia
      if (response.status === 500 && fallbackData?.imageBuffer) {
        logger.info(
          { galleryCollectionId },
          'Galleries API returned 500, falling back to SaveMedia',
        );
        return this.addGalleryImageViaSaveMedia(
          galleryCollectionId,
          fallbackData.imageBuffer,
          fallbackData.filename,
          fallbackData.contentType,
        );
      }

      return { success: false, error: `Failed to add gallery image: ${response.status}. ${respBody}` };
    }

    const data = await response.json().catch(() => ({}));
    const itemId = (data as Record<string, unknown>).id as string | undefined;

    logger.info({ galleryCollectionId, itemId }, 'Gallery image added');
    return { success: true, itemId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
```

- [ ] **Step 14: Run tests to verify they pass**

Run: `npm test -- --reporter=verbose src/services/__tests__/content-save-gallery.test.ts`

Expected: All tests PASS.

- [ ] **Step 15: Commit**

```bash
git add src/services/content-save/gallery.ts src/services/content-save/types.ts src/services/__tests__/content-save-gallery.test.ts
git commit -m "feat: addGalleryImage auto-fallback to SaveMedia on 500

JSON_SCHEMA GalleryMasonry sections reject the /api/galleries/{id}/images
endpoint with 500. When this happens and image data is available,
automatically retry via POST /api/commondata/SaveMedia which works
for all gallery types.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 3: Wire up SaveMedia fallback in the tool layer

### Task 5: Update sq_add_gallery_image to provide fallback data

**Files:**
- Modify: `src/mcp-server/tools/content.ts:790-849`

- [ ] **Step 16: Update sq_add_gallery_image to pass image buffer as fallback**

The tool already uploads images via `mediaClient.uploadImage()` which returns `assetId` and `assetUrl`. To enable the SaveMedia fallback, we need to also read the image file so we can pass the buffer. Replace the tool handler (lines 803-848):

```typescript
  }, async ({ siteId, pageSlug, imagePath, imageUrl, title, description, searchText }) => {
    try {
      if (!imagePath && !imageUrl) {
        return { content: [{ type: 'text' as const, text: 'Error: Must provide imagePath or imageUrl' }], isError: true };
      }

      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const mediaClient = getMediaClient(siteId);

      // Find the gallery block to get the galleryCollectionId
      const data = await client.getPageSections(ids.pageSectionsId);
      const found = client.findGalleryBlock(data.sections, searchText);
      if (!found) {
        return { content: [{ type: 'text' as const, text: 'Error: No gallery block found on this page' }], isError: true };
      }

      // Upload the image to media library
      let uploadResult;
      if (imageUrl) {
        const isUrl = imageUrl.startsWith('http://') || imageUrl.startsWith('https://');
        uploadResult = isUrl
          ? await mediaClient.uploadImageFromUrl(imageUrl)
          : await mediaClient.uploadImage(imageUrl);
      } else if (imagePath) {
        uploadResult = await mediaClient.uploadImage(imagePath);
      }

      if (!uploadResult?.success || !uploadResult.assetId) {
        return { content: [{ type: 'text' as const, text: `Error: Image upload failed: ${uploadResult?.error ?? 'no assetId returned'}` }], isError: true };
      }

      // Prepare fallback data for SaveMedia (in case galleries API returns 500)
      let fallbackData: { imageBuffer: Buffer; filename: string; contentType?: string } | undefined;
      const resolvedPath = imagePath || imageUrl;
      if (resolvedPath && !resolvedPath.startsWith('http://') && !resolvedPath.startsWith('https://')) {
        try {
          const { readFile } = await import('node:fs/promises');
          const { basename } = await import('node:path');
          const buf = await readFile(resolvedPath);
          const fname = basename(resolvedPath);
          const ext = fname.split('.').pop()?.toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
          fallbackData = { imageBuffer: buf, filename: fname, contentType: mime };
        } catch {
          // If we can't read the file for fallback, proceed without it
        }
      } else if (resolvedPath && uploadResult.assetUrl) {
        // For URL uploads, download from CDN as fallback source
        try {
          const cdnResp = await fetch(uploadResult.assetUrl, {
            headers: { Accept: 'image/jpeg,image/png,image/*' },
            signal: AbortSignal.timeout(15_000),
          });
          if (cdnResp.ok) {
            const buf = Buffer.from(await cdnResp.arrayBuffer());
            const urlPath = new URL(uploadResult.assetUrl).pathname;
            const fname = urlPath.split('/').pop() || 'image.jpeg';
            const ct = cdnResp.headers.get('content-type') || 'image/jpeg';
            fallbackData = { imageBuffer: buf, filename: fname, contentType: ct };
          }
        } catch {
          // Proceed without fallback
        }
      }

      // Add to gallery (with auto-fallback to SaveMedia if galleries API returns 500)
      const result = await client.addGalleryImage(found.galleryCollectionId, uploadResult.assetId, { title, description }, fallbackData);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...result, assetUrl: uploadResult.assetUrl }, null, 2) }],
        ...(result.success ? {} : { isError: true }),
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });
```

- [ ] **Step 17: Run full test suite**

Run: `npm test`

Expected: All tests PASS. No regressions.

- [ ] **Step 18: Build**

Run: `npm run build`

Expected: No TypeScript errors.

- [ ] **Step 19: Commit**

```bash
git add src/mcp-server/tools/content.ts
git commit -m "feat: sq_add_gallery_image provides image data for SaveMedia fallback

When the galleries API rejects with 500 (JSON_SCHEMA galleries),
the tool now passes the original image buffer so addGalleryImage
can automatically retry via SaveMedia.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 4: Update CLAUDE.md and memory

### Task 6: Document JSON_SCHEMA gallery support

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 20: Add JSON_SCHEMA gallery gotcha to CLAUDE.md**

Add to the "Critical Gotchas" section:

```markdown
- **Gallery types**: FLUID_ENGINE pages use type 8 gallery blocks; JSON_SCHEMA pages use `GalleryMasonry`/`GalleryGrid` sections with `jsonData.galleryOptions.transientGalleryId`. `findGalleryBlock()` searches both. The `/api/galleries/{id}/images` endpoint returns 500 for JSON_SCHEMA galleries — `addGalleryImage()` auto-falls back to `SaveMedia`.
```

- [ ] **Step 21: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document JSON_SCHEMA gallery support in CLAUDE.md

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
