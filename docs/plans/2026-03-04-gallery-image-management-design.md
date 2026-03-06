# Gallery Image Management — Design

## Problem

Gallery sections in Squarespace 7.1 are backed by **gallery collections** containing content items (images). We can already add images and update gallery display settings, but we cannot:
- List images in a gallery (for discovery)
- Remove images from a gallery
- Reorder images within a gallery

## API Discovery (via Playwright)

All endpoints discovered on `tim-cox.squarespace.com` gallery page:

| Operation | Endpoint | Method | Body Format |
|-----------|----------|--------|-------------|
| List | `GET /api/content-collections/{collectionId}/content-items` | GET | — |
| Add | `POST /api/galleries/{collectionId}/images` | POST | form-encoded |
| Delete | `DELETE /api/content-items/{itemId}` | DELETE | — |
| Reorder | `POST /api/commondata/ReorderItems` | POST | form-encoded |

### Key Details

- **Gallery collection ID** is NOT the page collection ID. It lives in the gallery section's block data (`collectionId` on the gallery block). Resolved via `findGalleryBlock().galleryCollectionId`.
- **Add image** body: `process=true&contentType=image&recordType=2&collectionId={id}&index={n}&fileUrl={url}` (or `assetId` for uploaded images)
- **Reorder** body: `collectionId={id}&itemIds=["id1","id2","id3"]` — full ordered list of all item IDs
- **Delete** returns empty body on success (200)
- **Content items** have: `id`, `displayIndex`, `filename`, `assetUrl`, `title`, `mediaFocalPoint`, `colorData`

## ContentSaveClient Methods

### New: `removeGalleryImage(collectionId, itemId)`

```typescript
async removeGalleryImage(collectionId: string, itemId: string): Promise<{ success: boolean; error?: string }>
```

- `DELETE /api/content-items/{itemId}`
- No request body needed
- Returns `{ success: true }` on 200

### New: `reorderGalleryImages(collectionId, itemIds)`

```typescript
async reorderGalleryImages(collectionId: string, itemIds: string[]): Promise<{ success: boolean; items?: GalleryItem[]; error?: string }>
```

- `POST /api/commondata/ReorderItems`
- Form-encoded body: `collectionId={id}&itemIds={JSON.stringify(itemIds)}`
- Returns updated items with new `displayIndex` values

### Existing (no changes needed)

- `getGalleryItems(collectionId)` — already fetches content items
- `addGalleryImage(collectionId, assetId, metadata?)` — already adds images
- `findGalleryBlock(sections, searchText)` — resolves `galleryCollectionId`

## MCP Tools

### `sq_list_gallery_images`

- Params: `siteId`, `pageSlug`, `searchText?` (gallery block identifier)
- Resolves page → finds gallery block → gets `galleryCollectionId` → calls `getGalleryItems()`
- Returns: array of `{ id, displayIndex, filename, title, assetUrl }`

### `sq_remove_gallery_image`

- Params: `siteId`, `pageSlug`, `itemId`
- Calls `removeGalleryImage(collectionId, itemId)`
- Returns: success/error

### `sq_reorder_gallery_images`

- Params: `siteId`, `pageSlug`, `itemIds` (ordered array of all image IDs)
- Calls `reorderGalleryImages(collectionId, itemIds)`
- Returns: updated item list with new ordering

## Testing

- ContentSaveClient: mock HTTP for remove (DELETE 200, 404), reorder (POST with body validation, error cases)
- MCP tools: mock session, test each tool success + error paths
- Reorder edge cases: empty array, single item, same order
