# Squarespace Content Save API — Agent Reference

Reference for agents working with the Squarespace API layer. All methods are on `ContentSaveClient` in `src/services/content-save.ts`. Types in `src/services/content-save-types.ts`.

## Authentication

- **Session file**: `storage/auth/sqsp-session.json` (Playwright session export)
- **Crumb token**: Extracted from site-specific cookies (NOT account.squarespace.com)
- **Pre-flight**: `ContentSaveClient.checkSessionHealth()` — checks existence, age, crumb
- **Factory**: `createContentSaveClient(subdomain)` — loads cookies automatically
- Sessions work 90+ hours but warn after 24h

## Read-Modify-Write Pattern

All block/section modifications follow this pattern:

```
1. GET  /api/page-sections/{pageSectionsId}          → read current sections
2. Modify sections JSON in memory
3. PUT  /api/page-sections/{pageSectionsId}/collection/{collectionId}  → save
```

**CRITICAL**: PUT validates ALL blocks. Missing `verticalAlignment` or `zIndex` on ANY block causes 400 errors. Always backfill before PUT:
```typescript
for (const gc of section.gridContents) {
  if (gc.layout?.desktop && !gc.layout.desktop.verticalAlignment) {
    gc.layout.desktop.verticalAlignment = 'top';
  }
  if (gc.layout?.desktop && gc.layout.desktop.zIndex == null) {
    gc.layout.desktop.zIndex = 0;
  }
}
```

## Block Type Reference

| Type ID | Name | Add Method | Update Method | Find-By Strategy |
|---------|------|------------|---------------|-----------------|
| 2 | Text | `addTextBlock()` | `updateTextBlock()` / `patchTextBlock()` | Stripped HTML text match |
| 18 | Menu | — | `updateMenuBlock()` | Raw text, tab/section/item titles |
| 23 | Code | `addCodeBlock()` | `updateCodeBlock()` | Code content match |
| 44 | Quote | `addQuoteBlock()` | `updateQuoteBlock()` | Quote text / attribution |
| 46 | Button | `addButtonBlock()` | `updateButtonBlock()` | Label text match |
| 1337 | Image | `addImageBlock()` / `addImageBlockBatch()` | `updateImageBlock()` | title/description/altText |
| 8 | Gallery | — | — | — |
| 52 | Divider | `addDividerBlock()` | — | — |
| 50 | Video | `addVideoBlock()` | `updateVideoBlock()` | title/url match |

### Block JSON Structure

**Text (type 2)**: `content.value.value.html` = `"<p>text</p>"`
**Button (type 46)**: `content.value.value = { label, url }`
**Image (type 1337)**: `content.value.value.assetUrl` = image URL
**Menu (type 18)**: `content.value.value = { menus: MenuTab[], raw: string, menuStyle, currencySymbol }`
**Block IDs**: Generated via `randomBytes(10).toString('hex')`

## Grid System

- **Desktop**: 24 columns (X: 1-24), start inclusive / end exclusive
- **Mobile**: Auto-reflows, only desktop coordinates modified
- Max columns: `gridSettings.breakpointSettings.desktop.columns`

### Default Block Sizes

| Block Type | Width (cols) | Height (rows) |
|-----------|-------------|--------------|
| Text | 24 | 3 |
| Button | 7 | 2 |
| Image | 12 | 8 |
| Divider | 24 | 1 |
| Video | 24 | 8 |

### Layout Presets (`src/config/layout-presets.ts`)

full-width, two-column, three-column, hero-wide, sidebar-content, content-sidebar, card-grid-2x2, centered-narrow

## Method Reference

### Text Operations
- `updateTextBlock(psId, colId, search, newHtml)` — full replacement (destructive)
- `patchTextBlock(psId, colId, search, newText)` — surgical substring replace (safe)
- `addTextBlock(psId, colId, sectionIdx, html, layout?, formatting?)` — add new text block
- `updateTextBlockHtml(psId, colId, search, rawHtml)` — raw HTML replacement
- `fillLastTextBlockInSection(psId, colId, sectionIdx, html)` — fill placeholder block

### Button Operations
- `addButtonBlock(psId, colId, sectionIdx, label, url, layout?)` — add button (type 46)
- `updateButtonBlock(psId, colId, searchLabel, { newLabel?, url? })` — update button

### Image Operations
- `addImageBlock(psId, colId, sectionIdx, assetUrl, options?)` — add image (type 1337)
- `addImageBlockBatch(psId, colId, sectionIdx, images[])` — batch add (single PUT)
- `updateImageBlock(psId, colId, search, { title?, description?, altText?, ... })` — metadata only

### Menu Operations
- `updateMenuBlock(psId, colId, search, newMenus, options?)` — structured JSON update
- `getMenuBlock(psId, search)` — read-only menu data
- `findMenuBlock(sections, search)` — find type 18 block in sections

### Block Management
- `findBlock(sections, search)` — generic finder (all block types)
- `removeBlock(psId, colId, search)` — remove block from section
- `moveBlock(psId, colId, search, direction, gridSteps?)` — move in grid
- `resizeBlock(psId, colId, search, direction, gridSteps?)` — resize in grid
- `swapBlocks(psId, colId, search1, search2)` — exchange positions
- `duplicateBlock(psId, colId, search)` — clone block

### Section Operations
- `addBlankSection(psId)` — add empty section (speculative API)
- `copyTemplateSection(wsId, colId, sectionId)` — copy from catalog
- `getSectionCatalog()` — list all template sections
- `editSectionStyle(psId, colId, sectionIdx, styles)` — update section theme/padding/etc
- `moveSection(psId, colId, sectionIdx, direction)` — reorder sections
- `duplicateSection(psId, colId, sectionIdx)` — clone section
- `verifySectionAdded(psId, expectedCount)` — verify section persisted

### Page Operations
- `getPageSections(psId)` — read page sections
- `savePageSections(psId, colId, sections)` — write page sections
- `listCollections()` — list all pages/collections
- `getPageIds(subdomain, slug)` — resolve pageSectionsId + collectionId
- `getPageMetadata(subdomain, slug)` — get page metadata
- `createPageViaApi(title, slug?, options?)` — create page (tries 3 endpoints)
- `deletePageViaApi(colId)` — delete page
- `updatePageMetadata(colId, updates)` — update page SEO/title/slug

### Footer & CSS
- `getHeaderFooter()` — read site header/footer config
- `getFooterSections()` — read footer sections
- `patchFooterTextBlock(subdomain, search, newText)` — patch footer text
- `updateFooterTextBlock(subdomain, search, newHtml)` — replace footer text
- `saveHeaderFooter(subdomain, config)` — save header/footer (NOT savePageSections!)
- `saveCustomCSS(css)` — save custom CSS via `POST /api/template/SaveTemplateCustomCss`
- `getCustomCSS()` — read current CSS

### Navigation & Settings
- `getNavigation()` — read page structure (mainNavigation + notLinked)
- `updateNavigation(fieldName, items)` — reorder pages via `POST /api/widget/UpdateNavigation`
- `getSettings()` — read full settings (~63 fields)
- `updateSettings(fields)` — write settings via `PUT /api/settings` (read-modify-write)
- `getSiteIdentity()` / `updateSiteIdentity(updates)` — business name/address/phone/email
- `getCodeInjection()` — read header/footer scripts from settings
- `saveCodeInjection(header?, footer?)` — save via `POST /api/config/SaveInjectionSettings`
- `getAdvancedSettings()` — read URL redirects/mappings
- `saveAdvancedSettings(data)` — save via `POST /api/config/SaveAdvancedSettings` (form-encoded)

### Design Write (Fonts, Colors, Tweaks)
- `getWebsiteFonts()` / `updateWebsiteFonts(data)` — `GET`/`PUT /api/website-fonts` (PUT → 204)
- `updateFont(fontName, updates)` — convenience: read-modify-write single font by name
- `getWebsiteColors()` / `updateWebsiteColors(data)` — `GET`/`PUT /api/website-colors` (PUT → 200)
- `updatePaletteColor(colorId, hsl)` — convenience: read-modify-write single palette color
- `getTemplateTweakSettings()` / `setTemplateTweakSettings(updates)` — ~200+ template tweaks
  - GET: `/api/template/GetTemplateTweakSettings?version=3`
  - POST: `/api/template/SetTemplateTweakSettings` (URL-encoded form: `tweakJson=<json>`)

### Blog Operations
- `createBlogPost(colId, title, options?)` — `POST /api/content/blogs/{colId}/text-posts`
- `updateBlogPost(colId, itemId, updates)` — `PUT /api/content/blogs/{colId}/text-posts/{itemId}`
- `findBlogPostByTitle(colId, search)` — case-insensitive partial title search
- `getCollectionItems(colId, options?)` — list posts with pagination and status filter

### Template Catalog
- `copyTemplateSectionFromCatalog(subdomain, category, index)` — shared helper in `section-catalog.ts`
  - Flow: `getOrFetchCatalog()` → `lookupCatalogEntry()` → `copyTemplateSection()`
  - ~300ms vs 5-25s UI automation
  - Categories: Intro, About, Team, Contact, Services/Offerings, Products, FAQs, Images

### Static Methods
- `ContentSaveClient.checkSessionHealth()` — pre-flight session check
- `ContentSaveClient.buildRichHtml(elements)` — build Squarespace HTML from structured data

## Page ID Resolution

`src/services/page-id-resolver.ts` resolves slug → (pageSectionsId, collectionId):

1. SQLite cache (30-day TTL)
2. `getPageIds()` API call
3. Public HTML fetch (parse data-page-sections attribute)
4. Headless browser fallback

Cache with `cachePageIds(subdomain, slug, psId, colId)`.

## Endpoint Catalog

| Method | Path | Status |
|--------|------|--------|
| GET | `/api/page-sections/{pageSectionsId}` | Validated |
| PUT | `/api/page-sections/{pageSectionsId}/collection/{collectionId}` | Validated |
| GET | `/api/commondata/GetCollections/` | Validated |
| GET | `/api/site-header-footer` | Validated |
| PUT | `/api/site-header-footer` | Validated |
| GET | `/api/website/GetCustomCSS/` | Validated |
| POST | `/api/template/SaveTemplateCustomCss` | Validated |
| GET | `/api/navigation` | Validated |
| POST | `/api/widget/UpdateNavigation` | Validated |
| GET | `/api/settings` | Validated |
| PUT | `/api/settings` | Validated |
| POST | `/api/config/SaveInjectionSettings` | Validated |
| GET | `/api/config/GetAdvancedSettings` | Validated |
| POST | `/api/config/SaveAdvancedSettings` | Validated (form-encoded) |
| GET | `/api/website-fonts` | Validated |
| PUT | `/api/website-fonts` | Validated (→ 204) |
| GET | `/api/website-colors` | Validated |
| PUT | `/api/website-colors` | Validated (→ 200) |
| GET | `/api/template/GetTemplateTweakSettings?version=3` | Validated |
| POST | `/api/template/SetTemplateTweakSettings` | Validated (form-encoded) |
| POST | `/api/content/add/fluidEngineSection` | Speculative |
| POST | `/api/content/copy/section` | Speculative |
| GET | `/api/section-catalog/sections?engine=FLUID` | Speculative |
| POST | `/api/content/add/page` | Speculative |
| POST | `/api/pages` | Speculative |
| POST | `/api/collections` | Validated |
| DELETE | `/api/collections/{collectionId}` | Speculative |
| PUT | `/api/collections/{collectionId}` | Speculative |
| POST | `/api/media/upload` | Validated |
| POST | `/api/content/blogs/{colId}/text-posts` | Validated |
| PUT | `/api/content/blogs/{colId}/text-posts/{itemId}` | Validated |

## Execution Priority Chain

```
simple edit → API executor → two-pass → template → blank_api → batch → browser agent
```

1. **Simple edit** (`simple-edit-classifier.ts`): 13 edit types, Haiku classifier, direct API
2. **API executor** (`api-executor.ts`): Full plan execution via API, no browser
3. **Two-pass** (`execution.ts`): Structural (sections) → content (API fills)
4. **Template fast path**: addSectionFromTemplate + API replacements
5. **Blank API**: addBlankSection + addTextBlock via API
6. **Batched**: 3 ops per batch with browser agent
7. **Browser agent**: Full Playwright automation (slowest)

## Key Gotchas

1. **API sections wiped by editor save**: Browser editor doesn't know about API-added sections. If editor saves, it overwrites with stale state. Only safe in API-only pipeline (no browser editor open).
2. **PUT validates ALL blocks**: Missing `verticalAlignment`/`zIndex` on ANY block → 400 error.
3. **addTextBlock may return 500**: Client-generated block IDs sometimes rejected. Use UI+API fallback.
4. **Saved editor state required**: Content Save API can't see sections added via UI until `saveChanges()` persists them.
5. **editTextBlock is destructive**: Select All + retype destroys multi-line blocks. Use `patchTextBlock()`.
6. **Footer is embedded**: Footer sections live in `/api/site-header-footer`, not page-sections. Use `saveHeaderFooter()`.
7. **Block IDs**: `randomBytes(10).toString('hex')` — 20 hex chars.
8. **Crumb validation**: POST/PUT require crumb token. Check response for `crumbFail: true`.
9. **Menu raw field**: Must regenerate via `serializeMenu()` when modifying `menus` array.
10. **Image assetUrl path**: `content.value.value.assetUrl` (nested value).
11. **Session cookies**: Include both `squarespace.com` and `{site}.squarespace.com` cookies.

## Key File Map

| File | Purpose |
|------|---------|
| `src/services/content-save.ts` | Core API client (88+ methods) |
| `src/services/content-save-types.ts` | Type definitions (~1100 lines) |
| `src/services/api-executor.ts` | Multi-operation API executor |
| `src/services/plan-classifier.ts` | Plan → API/browser routing |
| `src/services/simple-edit-classifier.ts` | Simple edit fast path classifier |
| `src/services/simple-edit-executor.ts` | Simple edit dispatch |
| `src/services/page-id-resolver.ts` | Page ID resolution + cache |
| `src/services/section-catalog.ts` | Section template catalog cache |
| `src/services/content-validator.ts` | Post-operation validation |
| `src/services/menu-parser.ts` | Menu text ↔ JSON |
| `src/services/menu-merger.ts` | Menu merge (structured + LLM) |
| `src/services/media-upload.ts` | Image upload to Squarespace |
| `src/agents/types.ts` | ContentPlan, ContentOperation, API block types |
| `src/config/layout-presets.ts` | 8 named layout presets |
| `src/config/section-templates.json` | 27 template catalog entries |
