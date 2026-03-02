---
name: squarespace-create
description: >
  Use when adding new pages, sections, or blocks to a Squarespace site via API.
  Covers page creation, blank sections, and all 15 block types.
---

## When to Use

- User wants to add a new page to a Squarespace site
- User wants to add sections to an existing page
- User wants to add blocks (text, images, buttons, etc.) to existing sections
- User wants to create a gallery (multiple images in a grid)
- User wants to upload an image to a site's asset library

## Quick Reference — Creation Methods

All methods live on `ContentSaveClient` in `src/services/content-save.ts`.

### Pages

| Method | What it creates | Key params |
|--------|----------------|------------|
| `createPageViaApi(title, slug?, options?)` | New page | `options.type` (1=page) |
| `deletePageViaApi(collectionId)` | Deletes a page | collectionId from `getPageIds()` |

### Sections

| Method | What it creates | Key params |
|--------|----------------|------------|
| `addBlankSection(psId, colId)` | Empty Fluid Engine section | Appended to end |
| `copyTemplateSection(srcWebsiteId, srcColId, srcSectionId)` | Template section from catalog | IDs from `getSectionCatalog()` |
| `getSectionCatalog()` | Lists template sections | Returns `{ catalog, sections, categories }` |
| `verifySectionAdded(psId, expectedCount)` | Confirms section persisted | Returns `{ verified, actualCount, sections }` |

### Template Sections via Catalog (High-Level Helper)

`copyTemplateSectionFromCatalog()` in `src/services/section-catalog.ts` is the preferred way to add template sections. It handles the full flow: catalog lookup + client creation + copy API call.

```typescript
import { copyTemplateSectionFromCatalog } from '../services/section-catalog.js';

// ~300ms vs 5-25s UI automation
const result = await copyTemplateSectionFromCatalog(subdomain, 'Contact', 1);
// result: { success: true, sectionId: 'abc123...' } | null
```

**Flow**: `getOrFetchCatalog(subdomain)` (SQLite-cached, 7-day TTL) → `lookupCatalogEntry(catalog, categoryName, templateIndex)` → `client.copyTemplateSection(websiteId, collectionId, sectionId)`.

**Category names** (from catalog): Intro, About, Team, Contact, Services/Offerings, Products, FAQs, Images. Category lookup is case-insensitive and supports partial matches (e.g., "Services" matches "SERVICES/OFFERINGS").

**Used in all 3 execution paths:**
1. Browser agent fast path (`tryCopyTemplateSectionApi` in `handler-utils.ts`)
2. Conversation execution (`tryCopyTemplateViaApi` in `execution.ts`)
3. API-only pipeline (`executeAddSectionTemplate` in `api-executor.ts`)

**Template Section Registry** (`src/services/template-registry.ts`): Maps `{category, templateName}` → `sectionId` per site with SQLite cache (Phase 17 migration, 7-day TTL). Used by `validatePlanTemplateIndexes()` to cross-check plan template indexes against cached discovery data before execution.

### Blocks (all 15 types)

Every `add*Block` method follows the same pattern: `(pageSectionsId, collectionId, sectionIndex, ...blockSpecificParams, layout?)`.

| Method | Content param(s) | Default size (cols x rows) |
|--------|-----------------|---------------------------|
| `addTextBlock(psId, colId, sIdx, html, layout?, formatting?)` | `html` string + optional `formatting` | 24 x 3 |
| `addButtonBlock(psId, colId, sIdx, label, url, layout?)` | `label`, `url` | 7 x 2 |
| `addImageBlock(psId, colId, sIdx, assetUrl, options?)` | `assetUrl` + `options.altText/title/description/subtitle/linkTo` | 12 x 8 |
| `addImageBlockBatch(psId, colId, sIdx, images[])` | Array of `{ assetUrl, altText?, title?, layout? }` | Per-image customizable |
| `addDividerBlock(psId, colId, sIdx, layout?)` | None (horizontal rule) | 24 x 1 |
| `addVideoBlock(psId, colId, sIdx, videoUrl, options?)` | `videoUrl` + `options.title/description` | 24 x 8 |
| `addQuoteBlock(psId, colId, sIdx, quoteText, attribution?, layout?)` | `quoteText`, optional `attribution` | 24 x 3 |
| `addCodeBlock(psId, colId, sIdx, code, language?, layout?)` | `code` string, optional `language` | 24 x 3 |
| `addNewsletterBlock(psId, colId, sIdx, options?, layout?)` | `options.title/description/submitButtonText/alignment` | 24 x 3 |
| `addAccordionBlock(psId, colId, sIdx, items, options?, layout?)` | `items: { title, description }[]` + `options.isExpandedFirstItem/shouldAllowMultipleOpenItems` | 24 x 3 |
| `addMarqueeBlock(psId, colId, sIdx, items, options?, layout?)` | `items: { text, linkTo? }[]` + `options.animationDirection/animationSpeed/textStyle/pausedOnHover/fadeEdges` | 24 x 3 |
| `addFormBlock(psId, colId, sIdx, formId, options?, layout?)` | `formId` from `listForms()` + `options.buttonVariant/buttonAlignment/useLightbox` | 24 x 3 |
| `addSocialLinksBlock(psId, colId, sIdx, options?, layout?)` | `options.iconAlignment/iconSize/iconStyle/iconColor` | 24 x 3 |
| `addEmbedBlock(psId, colId, sIdx, html?, layout?)` | Optional `html` (embed/iframe code) | 24 x 3 |
| `fillLastTextBlockInSection(psId, colId, sIdx, newHtml)` | `newHtml` — fills an existing placeholder block | N/A (modifies existing) |

### Media

| Method | What it does | Key params |
|--------|-------------|------------|
| `uploadImageToSite(imageUrl)` | Upload image by URL to site assets | Returns `{ assetId, contentItemId }` |

### Gallery Collections (native gallery blocks)

These methods manage **native Squarespace gallery collections** — distinct from the image-block-grid approach used by `addImageBlockBatch`. Gallery collections are backed by `/api/content-collections/` and `/api/galleries/` endpoints.

| Method | What it does | Key params |
|--------|-------------|------------|
| `getGalleryItems(galleryCollectionId)` | Fetch up to 250 items from a gallery | Returns `{ items: GalleryItem[], hasMore }` |
| `getGalleryItemCount(galleryCollectionId)` | Get item count for a gallery | Returns `{ count }` |
| `addGalleryImage(galleryCollectionId, assetId, metadata?)` | Add an uploaded image to a gallery | `metadata.title`, `metadata.description`; returns `{ itemId }` |

**Workflow**: Upload image via `uploadImageToSite(url)` → get `assetId` → `addGalleryImage(collectionId, assetId, { title, description })`.

**Gallery collections vs image-block grids**: Gallery collections are Squarespace-native collections with their own `collectionId`, supporting pagination, ordering, and metadata per item. Image-block grids (`addImageBlockBatch`) place multiple type-1337 image blocks in a CSS grid layout within a section — simpler but no native gallery features (lightbox, slideshow, etc.).

### Helpers

| Method | What it does |
|--------|-------------|
| `ContentSaveClient.buildRichHtml(elements[])` | Converts `{ text, tag, bold, italic, link }[]` → HTML string |
| `formatHtml(input, formatting?)` | Wraps plain text in tags with `formatting.tag/alignment/bold/italic` |
| `getPageIds(slug)` | Resolves page slug → `{ collectionId, pageSectionsId? }` |
| `getPageSections(psId)` | GET full sections JSON for a page |

## Prerequisites

1. Session cookies loaded (see `squarespace-setup` skill)
2. Site configured in `config/sites.json` with subdomain
3. Page IDs resolved — use `snapshot` command or `getPageIds(slug)` to get `pageSectionsId` and `collectionId`

## Workflow

### 1. Snapshot the page

```bash
tsx scripts/sq.ts snapshot --site <id> --page <slug>
```

Note the section count and indexes. New sections are always appended at the end.

### 2. Add a section (if needed)

```bash
tsx scripts/sq.ts add-section --site <id> --page <slug>
```

The new section index = previous section count (0-based). A page with 3 sections gets a new section at index 3.

### 3. Add blocks to the section

```bash
tsx scripts/sq.ts add-text --site <id> --page <slug> --section <idx> --html "<h2>Title</h2><p>Body text.</p>"
tsx scripts/sq.ts add-button --site <id> --page <slug> --section <idx> --label "Book Now" --url "https://example.com"
tsx scripts/sq.ts add-image --site <id> --page <slug> --section <idx> --asset-url "https://images.unsplash.com/..." --alt "Description"
```

`add-section` must succeed before any block commands targeting that section.

### 4. Verify

```bash
tsx scripts/sq.ts snapshot --site <id> --page <slug>
```

Confirm section count increased and block content matches.

## Block Types — apiBlock JSON Format

These are the JSON formats used by the content strategist's `apiBlocks` array (dispatched by `api-executor.ts`).

### Text

```json
{ "html": "<h2>Section Heading</h2><p>Body paragraph.</p>" }
```

With formatting shorthand (auto-wraps plain text):

```json
{ "html": "Section Heading", "formatting": { "tag": "h2", "alignment": "center" } }
```

Formatting options: `tag` ("h1"–"h4", "p"), `alignment` ("left", "center", "right"), `bold` (true), `italic` (true).

For multi-element structured content, use `richContent`:

```json
{
  "richContent": [
    { "text": "About Us", "tag": "h2", "bold": true },
    { "text": "We build great things.", "tag": "p" },
    { "text": "Learn more", "tag": "p", "link": { "href": "https://example.com" } }
  ]
}
```

### Button

```json
{ "type": "button", "label": "Book a Call", "url": "https://calendly.com/example" }
```

### Image

```json
{ "type": "image", "imagePath": "/abs/path/to/image.jpg", "altText": "Description" }
```

`imagePath` must be an absolute path to a file in `storage/uploads/`. The executor uploads it and gets the `assetUrl` before calling `addImageBlock`.

### Gallery (multiple images in a grid)

```json
{
  "type": "gallery",
  "images": [
    { "imagePath": "/path/to/img1.jpg", "altText": "Caption one" },
    { "imagePath": "/path/to/img2.jpg", "altText": "Caption two" }
  ],
  "galleryStyle": "grid",
  "columns": 3
}
```

Uses `addImageBlockBatch` (single GET+PUT). Grid math: 24 / columns = column width (2 cols = 12 wide, 3 = 8, 4 = 6). NOT a native gallery block — it's multiple image blocks arranged in a grid.

### Divider

```json
{ "type": "divider" }
```

### Video

```json
{ "type": "video", "videoUrl": "https://www.youtube.com/watch?v=...", "title": "Optional caption" }
```

Supports YouTube, Vimeo, and oEmbed-compatible URLs.

### Quote

```json
{ "type": "quote", "quoteText": "Innovation distinguishes leaders from followers.", "attribution": "Steve Jobs" }
```

### Code

```json
{ "type": "code", "code": "const x = 1;", "language": "javascript" }
```

### Newsletter

```json
{ "type": "newsletter", "title": "Subscribe", "description": "Get updates.", "submitButtonText": "Sign Up" }
```

### Accordion

```json
{
  "type": "accordion",
  "items": [
    { "title": "Question 1?", "description": "Answer 1." },
    { "title": "Question 2?", "description": "Answer 2." }
  ],
  "isExpandedFirstItem": true
}
```

### Marquee (scrolling text)

```json
{
  "type": "marquee",
  "items": [
    { "text": "Welcome" },
    { "text": "to our site", "linkTo": "/about" }
  ],
  "animationDirection": "left",
  "animationSpeed": 50
}
```

### Form

```json
{ "type": "form", "formId": "abc123", "buttonVariant": "primary", "buttonAlignment": "center" }
```

Requires a pre-existing form — get the `formId` from `listForms()`.

### Social Links

```json
{ "type": "social-links", "iconAlignment": "center", "iconSize": "medium", "iconStyle": "icon-only" }
```

Pulls social links from the site's global social links configuration.

### Embed

```json
{ "type": "embed", "html": "<iframe src=\"https://maps.google.com/...\"></iframe>" }
```

## Grid System

- **24 columns** on desktop (X: 1–24, `start` inclusive / `end` exclusive)
- Mobile auto-reflows — only modify desktop coordinates
- Default block widths: Text/Divider/Video/Quote/Code = 24 (full), Button = 7, Image = 12
- Default block heights: Text/Quote/Code = 3, Button = 2, Image/Video = 8, Divider = 1

### Block Spacing

Controlled via `layout` param on every `add*Block` method:

```typescript
layout?: {
  columns?: number;    // Width in columns (default varies by type)
  rowHeight?: number;  // Height in rows (default varies by type)
  gapRows?: number;    // Rows of gap above this block (default: 2 for non-first, 0 for first)
  startX?: number;     // Explicit start column
  endX?: number;       // Explicit end column
  startY?: number;     // Explicit start row
  endY?: number;       // Explicit end row
}
```

### Backfill Warning

Squarespace validates ALL blocks in a section on PUT, not just the modified one. All `add*Block` methods auto-backfill `verticalAlignment` and `zIndex` on existing blocks before writing.

## CLI Commands

### Available now

| Command | Usage |
|---------|-------|
| `add-section` | `tsx scripts/sq.ts add-section --site <id> --page <slug>` |
| `add-text` | `tsx scripts/sq.ts add-text --site <id> --page <slug> --section <idx> --html "<p>Content</p>"` |
| `add-button` | `tsx scripts/sq.ts add-button --site <id> --page <slug> --section <idx> --label "Click" --url "https://..."` |
| `add-image` | `tsx scripts/sq.ts add-image --site <id> --page <slug> --section <idx> --asset-url "https://..." [--alt "text"]` |

### More block types

| Command | Usage |
|---------|-------|
| `add-quote` | `tsx scripts/sq.ts add-quote --site <id> --page <slug> --section <idx> --text <str> [--attribution <str>]` |
| `add-code` | `tsx scripts/sq.ts add-code --site <id> --page <slug> --section <idx> --code <str> [--language <str>]` |
| `add-video` | `tsx scripts/sq.ts add-video --site <id> --page <slug> --section <idx> --url <str> [--title <str>]` |
| `add-divider` | `tsx scripts/sq.ts add-divider --site <id> --page <slug> --section <idx>` |

### Page management

| Command | Usage |
|---------|-------|
| `create-page` | `tsx scripts/sq.ts create-page --site <id> --title <str> [--slug <str>]` |
| `delete-page` | `tsx scripts/sq.ts delete-page --site <id> --page <slug>` |

### Section/block operations

| Command | Usage |
|---------|-------|
| `duplicate-section` | `tsx scripts/sq.ts duplicate-section --site <id> --page <slug> --search <str\|idx>` |
| `gallery` | `tsx scripts/sq.ts gallery --site <id> --page <slug> --section <idx> --images <csv-urls> [--cols <n>]` |

### Media

| Command | Usage |
|---------|-------|
| `upload-image` | `tsx scripts/sq.ts upload-image --site <id> --url <image-url>` |

### Not yet in sq.ts (use API directly)

| Block type | API method |
|------------|-----------|
| Newsletter | `addNewsletterBlock()` |
| Accordion | `addAccordionBlock()` |
| Marquee | `addMarqueeBlock()` |
| Form | `addFormBlock()` |
| Social Links | `addSocialLinksBlock()` |
| Embed | `addEmbedBlock()` |

## Examples

### Example 1: Add a text section to an existing page

```bash
# 1. Check current state
tsx scripts/sq.ts snapshot --site acme --page about
# Output: 2 sections (index 0, 1)

# 2. Add blank section (will be index 2)
tsx scripts/sq.ts add-section --site acme --page about

# 3. Add heading + paragraph
tsx scripts/sq.ts add-text --site acme --page about --section 2 --html "<h2>Our Story</h2><p>Founded in 2020, we set out to...</p>"

# 4. Add a CTA button
tsx scripts/sq.ts add-button --site acme --page about --section 2 --label "Contact Us" --url "/contact"

# 5. Verify
tsx scripts/sq.ts snapshot --site acme --page about
# Output: 3 sections, section 2 has 2 blocks
```

### Example 2: Create a page with content (programmatic)

```typescript
import { ContentSaveClient } from '../src/services/content-save.js';

const client = new ContentSaveClient('site-subdomain');

// 1. Create page
const page = await client.createPageViaApi('Services', 'services');

// 2. Get page IDs
const ids = await client.getPageIds('services');
const { collectionId } = ids!;
// Note: pageSectionsId may need to be fetched from DOM or snapshot

// 3. Add blank section
const section = await client.addBlankSection(psId, collectionId);

// 4. Add blocks
await client.addTextBlock(psId, collectionId, 0,
  '<h1>Our Services</h1><p>We offer the following:</p>');

await client.addTextBlock(psId, collectionId, 0,
  '<h2>Web Design</h2><p>Custom websites built for your brand.</p>');

await client.addButtonBlock(psId, collectionId, 0,
  'Get a Quote', '/contact');
```

### Example 3: Add an image gallery

```typescript
const client = new ContentSaveClient('site-subdomain');

// Upload images first
const img1 = await client.uploadImageToSite('https://example.com/photo1.jpg');
const img2 = await client.uploadImageToSite('https://example.com/photo2.jpg');
const img3 = await client.uploadImageToSite('https://example.com/photo3.jpg');

// Add blank section
await client.addBlankSection(psId, collectionId);

// Batch-add as 3-column grid (24/3 = 8 cols each)
await client.addImageBlockBatch(psId, collectionId, sectionIndex, [
  { assetUrl: img1.assetId!, altText: 'Photo 1', layout: { columns: 8 } },
  { assetUrl: img2.assetId!, altText: 'Photo 2', layout: { columns: 8 } },
  { assetUrl: img3.assetId!, altText: 'Photo 3', layout: { columns: 8 } },
]);
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `Section index N out of range` | Section doesn't exist yet, or count changed | Re-snapshot to get current count |
| `No fluidEngineContext` | Section is not Fluid Engine (legacy section) | Target a different section or add a new blank one |
| `Session expired — re-authenticate` | Cookies >24h old or invalidated | Run `squarespace-setup` skill |
| `API returned 400` on PUT | Malformed block data or missing backfill fields | All methods auto-backfill; check block-specific data |
| `API returned 500` on addTextBlock | Squarespace rejects client-generated block ID | Use fallback: add block via UI, fill via `fillLastTextBlockInSection()` |
| `Image upload failed` | Invalid URL or asset too large | Verify URL is publicly accessible |
| `Could not resolve pageSectionsId` | Page ID cache empty | Run `snapshot` first, or pass `--psid` manually |
| `createPageViaApi: endpointAvailable: false` | All 3 endpoint variants returned errors | Page creation may not be available on this plan; use browser agent |

## Known Limitations

- **Menu blocks**: Cannot be created via API. Use browser agent `addBlockToSection("Menu")`, then update with `updateMenuBlock()`.
- **Image asset replacement**: `uploadImageToSite()` uploads new images. To replace an existing image block's file, use browser agent `replaceImage` action.
- **Footer blocks**: Footer uses `saveHeaderFooter()`, not `savePageSections()`. Add blocks to footer via browser agent.
- **Form blocks need existing form**: `addFormBlock()` requires a `formId` from a pre-created form. Create forms in the Squarespace UI first.
- **Social links are site-global**: `addSocialLinksBlock()` displays links configured in site settings. Block options control display style only.
- **Video/divider type IDs**: Types 50 (video) and 52 (divider) are suspected values. If API returns errors, run `scripts/discover-block-types.ts` to confirm.
