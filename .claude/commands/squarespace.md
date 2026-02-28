# Squarespace API Reference

When the user runs `/squarespace`, provide an interactive reference for the Squarespace Content Save API based on their context or question.

## Quick API Lookup

Common tasks and which `ContentSaveClient` method to use:

| Task | Method | Key Parameters |
|------|--------|---------------|
| Replace text (surgical) | `patchTextBlock()` | psId, colId, searchText, newText |
| Replace text (full block) | `updateTextBlock()` | psId, colId, searchText, newHtml |
| Add text block | `addTextBlock()` | psId, colId, sectionIndex, html, layout?, formatting? |
| Raw HTML replace | `updateTextBlockHtml()` | psId, colId, searchText, rawHtml |
| Update button | `updateButtonBlock()` | psId, colId, searchLabel, { newLabel?, url? } |
| Add button | `addButtonBlock()` | psId, colId, sectionIndex, label, url, layout? |
| Update image metadata | `updateImageBlock()` | psId, colId, searchText, { title?, altText?, ... } |
| Add image | `addImageBlock()` | psId, colId, sectionIndex, assetUrl, options? |
| Batch add images | `addImageBlockBatch()` | psId, colId, sectionIndex, images[] |
| Update menu | `updateMenuBlock()` | psId, colId, searchText, newMenus |
| Remove block | `removeBlock()` | psId, colId, searchText |
| Move block | `moveBlock()` | psId, colId, searchText, direction, gridSteps? |
| Swap blocks | `swapBlocks()` | psId, colId, search1, search2 |
| Move section | `moveSection()` | psId, colId, sectionIndex, direction |
| Edit section style | `editSectionStyle()` | psId, colId, sectionIndex, styles |
| Edit footer text | `patchFooterTextBlock()` | subdomain, searchText, newText |
| Save custom CSS | `saveCustomCSS()` | subdomain, css |
| Create page | `createPageViaApi()` | title, slug?, options? |
| Delete page | `deletePageViaApi()` | collectionId |
| Update page metadata | `updatePageMetadata()` | collectionId, { title?, seoTitle?, ... } |
| Verify section added | `verifySectionAdded()` | psId, expectedCount |
| Add quote block | `addQuoteBlock()` | psId, colId, sectionIndex, quoteText, attribution? |
| Add code block | `addCodeBlock()` | psId, colId, sectionIndex, code, language? |
| Add divider | `addDividerBlock()` | psId, colId, sectionIndex, layout? |
| Add video | `addVideoBlock()` | psId, colId, sectionIndex, videoUrl, options? |

## Session Health

```typescript
// Pre-flight check (static, no client needed)
const health = ContentSaveClient.checkSessionHealth();
// → { exists, hasCrumb, ageHours, isStale, sessionPath }

// Create client (loads cookies automatically)
const client = createContentSaveClient(subdomain);

// Get session age (after loading)
const age = client.getSessionAge();
// → { ageHours, isStale, lastRefreshed }
```

- Session file: `storage/auth/sqsp-session.json`
- Sessions work 90+ hours, warn after 24h
- If expired, re-authenticate via browser session

## Block Types

| Type | ID | Add Method | Key JSON Fields |
|------|-----|------------|----------------|
| Text | 2 | `addTextBlock` | `value.html`, `value.source` |
| Menu | 18 | — | `value.value.menus`, `value.value.raw` |
| Code | 23 | `addCodeBlock` | `value.html`, `value.codeLanguage` |
| Quote | 44 | `addQuoteBlock` | `value.html`, `value.source` |
| Button | 46 | `addButtonBlock` | `value.label`, `value.url` |
| Video | 50 | `addVideoBlock` | `value.url`, `value.title` |
| Divider | 52 | `addDividerBlock` | (no content) |
| Image | 1337 | `addImageBlock` | `value.value.assetUrl` |

## Grid System

- 24 columns desktop, X range 1-24, start inclusive / end exclusive
- Defaults: text=24x3, button=7x2, image=12x8, divider=24x1
- Layout presets: `full-width`, `two-column`, `three-column`, `hero-wide`, `sidebar-content`, `content-sidebar`, `card-grid-2x2`, `centered-narrow`

## Simple Edit Fast Path Types

13 types that bypass content planning entirely:

`text_replace` | `text_add` | `button_edit` | `image_metadata` | `block_remove` | `menu_update` | `footer_edit` | `css_change` | `section_style` | `image_replace` | `button_add` | `section_reorder` | `block_move` | `page_seo`

## Execution Priority

```
simple edit → API executor → two-pass → template → blank_api → batch → browser agent
```

## Key Files

| File | Purpose |
|------|---------|
| `src/services/content-save.ts` | Core API client (~4500 lines) |
| `src/services/content-save-types.ts` | Type definitions |
| `src/services/api-executor.ts` | Multi-operation API executor |
| `src/services/plan-classifier.ts` | Plan → API/browser routing |
| `src/services/simple-edit-classifier.ts` | Simple edit classifier (Haiku LLM) |
| `src/services/simple-edit-executor.ts` | Simple edit dispatch |
| `src/services/page-id-resolver.ts` | Page ID resolution + SQLite cache |
| `src/services/section-catalog.ts` | Template catalog cache |
| `src/services/content-validator.ts` | Post-operation validation |
| `src/services/menu-parser.ts` | Menu text ↔ structured JSON |
| `src/services/media-upload.ts` | Image upload service |
| `src/agents/types.ts` | ContentPlan, ContentOperation types |

## Key Gotchas

1. **`patchTextBlock` vs `updateTextBlock`**: Patch = safe surgical replace. Update = destructive full replace.
2. **PUT validates ALL blocks**: Missing `verticalAlignment`/`zIndex` on any block → 400.
3. **Footer uses `saveHeaderFooter()`**: NOT `savePageSections()`.
4. **Menu `raw` field**: Must regenerate via `serializeMenu()` after modifying `menus`.
5. **API sections wiped by editor**: Only use API section addition when no browser editor is open.
