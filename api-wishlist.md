# Squarespace Block API Wishlist

Status of every Squarespace block type against our `ContentSaveClient` + `api-executor` pipeline.

Legend:
- ✅ Full — add + update/patch + findBlock
- 🔶 Partial — one or two operations missing
- ❌ None — no API support yet
- ❓ Unknown — type number not yet discovered

---

## Blocks We Have

| Block | Type # | Status | Methods | Notes |
|-------|---------|--------|---------|-------|
| **Text / HTML** | 2 | ✅ Full | `addTextBlock` `updateTextBlock` `patchTextBlock` `fillLastTextBlock` `updateTextBlockHtml` | Rich HTML builder; formatting (tag, alignment, bold, italic); surgical patch |
| **Image** | 1337 | ✅ Full | `addImageBlock` `addImageBlockBatch` `updateImageBlock` | Requires media upload via `MediaUploadClient`; default 12×8 grid |
| **Gallery (grid)** | 1337 (multi) | 🔶 Add only | `addImageBlockBatch` | Multiple image blocks in grid; no gallery-block update method; columns configurable (2/3/4) |
| **Button** | 46 | ✅ Full | `addButtonBlock` `updateButtonBlock` | Default 7 cols × 2 rows |
| **Menu** | 18 | 🔶 No add | `updateMenuBlock` `getMenuBlock` `findMenuBlock` | Structured JSON merge + plain-text serializer; no `addMenuBlock` |
| **Quote** | 31 | ✅ Full | `addQuoteBlock` `updateQuoteBlock` | Attribution optional; confirmed live Feb 28 2026 |
| **Code / HTML embed** | 1337 (engine=`code`) | ✅ Full | `addCodeBlock` `updateCodeBlock` | Shares type 1337 with Image; distinguished by `value.wysiwyg.engine === 'code'` |
| **Line / Divider** | 47 | 🔶 Add only | `addDividerBlock` | Structural only — no content to update; default 24×1. BLOCK_TYPE_DIVIDER = 47 (confirmed Feb 28 2026) |
| **Video (native)** | 32 | ✅ Full | `addVideoBlock` `updateVideoBlock` | Squarespace-hosted video. BLOCK_TYPE_VIDEO = 32 (confirmed Feb 28 2026) |

**Corrections (Feb 28 2026 live discovery):**
- ~~Type 52 = Divider~~ → **Type 52 = Donation block**
- ~~Type 50 = Video~~ → **Type 32 = Video (native)**; type 50 unconfirmed
- ~~Type 44 = "Quote (alt)"~~ → **Type 44 = Markdown** (value has `wysiwyg.engine: "markdown"`)

---

## Blocks We Don't Have Yet

### High Priority — Common, likely feasible via API

| Block | Type # | Priority | Notes |
|-------|---------|----------|-------|
| **Form** | 1337 variant | 🔴 High | Type 1337 with `buttonVariant`, `submissionTextAlignment`, `firstFieldHighlightType`. Full field config unknown — needs deeper value capture. |
| **Newsletter** | 51 | 🔴 High | `{ alignment, captchaEnabled, captchaTheme, captchaAlignment, description }`. Has captcha + description text. |
| **Social Links** | 54 | 🔴 High | `{ iconAlignment, iconSize, iconStyle, iconColor }`. Icon array structure still unknown — need to configure icons and re-capture. |
| **Embed (HTML)** | 22 | 🔴 High | Value is `{}` when empty. Need to add HTML content and re-capture to see structure. |
| **Map** | 1337 variant | 🟡 Medium | Type 1337 with `location: { mapLat, mapLng, mapZoom }`, `style`, `labels`, `terrain`. Changing address = update `mapLat`/`mapLng`. |
| **Audio** | 41 | 🟡 Medium | `{ designStyle, colorTheme, audioAssetId }`. Needs `MediaUploadClient` for audio files. |
| **Markdown** | 44 | 🟡 Medium | Type 44 with `wysiwyg.engine: "markdown"`. Same outer type as the old "Quote alt". |
| **Scrolling / Marquee** | 70 | 🟡 Medium | `{ marqueeItems: [{ text }], linkTo, waveFrequency, waveIntensity, animationSpeed }`. Easy to add/update marquee text. |
| **Shape** | 1337 variant | 🟡 Medium | Type 1337 with `shape`, `horizontalAlignment`, `showDropShadow`, `backgroundColor`. Decorative only. |

### Medium Priority — Feasible but less common

| Block | Type # | Priority | Notes |
|-------|---------|----------|-------|
| **Chart** | 62 | 🟡 Medium | `{ dataTableId, title, legend, caption, palette, flip, dataTable: { data: [[...]] } }`. Full data structure needs deeper capture. |
| **Page Link** | 12 | 🟡 Medium | `{ linkTitle, linkTarget, newWindow }`. Internal page link. Simple to add/update. |
| **Summary** | 55 | 🟡 Medium | `{ collectionId, design, headerText, textSize, pageSize, imageAspectRatio }`. Display config only — source page, item count, layout. |
| **Accordion** | 69 | 🟡 Medium | `{ accordionItems: [{ title, description }] }`. Very feasible — add/update FAQ items. |
| **Archive** | 61 | 🟡 Medium | `{ collectionId, layout, groupBy, dropdownTitle }`. Blog/gallery archive listing. Mostly config. |
| **Donation** | 52 | 🟡 Medium | `{}` — config is external (Squarespace Donations product). Likely no JSON to change. |
| **Product** | ❓ | 🟡 Medium | Type number not yet discovered. Commerce block that embeds a product. Stores `productId`. |
| **Calendar** | ❓ | 🟡 Medium | Type number not yet discovered (separate from Scheduling). Shows a calendar widget from Google Calendar or similar. |

### Lower Priority — External dependencies or read-only

| Block | Type # | Priority | Notes |
|-------|---------|----------|-------|
| **Instagram** | 25 | 🟢 Low | Gallery-like JSON (`collectionId`, `design: "grid"`, `thumbnails-per-row`). Requires Instagram OAuth. |
| **Search Field** | 33 | 🟢 Low | `{}` — no configurable content. Just adds the search widget. |
| **Tag Cloud** | 14 | 🟢 Low | `{}` — read-only aggregation. No config. |
| **RSS** | 49 | 🟢 Low | `{}` when empty. Likely stores `feedUrl` once configured. |
| **SoundCloud** | 56 | 🟢 Low | `{ aspectRatio: 67 }`. Stores track/playlist URL once configured. |
| **Scheduling (Acuity)** | 65 | 🟢 Low | `{}` — config is external (Acuity). No JSON to change. |
| **OpenTable** | 66 | 🟢 Low | `{ restaurantId, domain, lang, hideIcons, hideTitle }`. Just needs restaurant ID. |
| **Tock** | 68 | 🟢 Low | `{ tockBusinessSlug, tockDisplayMode, tockAlignment, tockColorMode, hideTockLogo }`. Just needs business slug. |
| **Embed** | 22 | 🟢 Low | `{}` when empty. Need to configure and re-capture to see HTML field structure. |
| **Flickr** | ❓ | 🟢 Low | Type not yet discovered. Requires Flickr account link. |
| **Bandsintown** | ❓ | 🟢 Low | Type not yet discovered. Requires Bandsintown artist account. |
| **Zola** | ❓ | 🟢 Low | Type not yet discovered. Wedding registry integration. |

---

## Discovery TODO

Remaining unknowns after Feb 28 2026 mass discovery run:

| Block | Status | How to Confirm |
|-------|--------|----------------|
| **Video (external/YouTube/Vimeo)** | Type 50 suspected but unconfirmed | Add a Video block, paste a YouTube URL, save, run discovery |
| **Calendar** | Type unknown | Add Calendar block (Display section), save, run discovery |
| **Pricing Plan** | Type unknown | Add Pricing Plan block (Sell section), save, run discovery |
| **Product** | Type unknown | Add Product block (Sell section), save, run discovery |
| **Embed** | Type 22 confirmed, value structure unknown | Add Embed block, paste some HTML, save, re-run discovery to see value |
| **Social Links** | Type 54 confirmed, icon array structure unknown | Add Social Links, configure icons, save, re-run discovery |
| **RSS** | Type 49 confirmed, feedUrl field name unknown | Configure RSS URL, save, re-run discovery |
| **Flickr / Bandsintown / Zola** | Types unknown | Add each, save, run discovery |
| **Type 23 (Code legacy)** | Listed in KNOWN_TYPES but may be 7.0 only | Check if type 23 appears on any 7.0 site page |

Run discovery any time:
```bash
npx tsx scripts/discover-block-types.ts --site grey-yellow-hbxc --page test-page --pageSectionsId 699f3d5bd9db5d1500d60c01
```

---

---

## Section Style API — Confirmed Fields (Mar 2026)

Live discovery on grey-yellow-hbxc test-page. Captured via `scripts/discover-section-style.ts`.

### Section `styles` Object (at `section.styles.*`)

| Field | API Format | Notes |
|-------|-----------|-------|
| `sectionTheme` | `"white"` \| `"light"` \| `"dark"` \| `"black"` \| `""` | Lowercase. Controls coordinated background + text + button colors. |
| `sectionHeight` | `"section-height--small"` \| `"--medium"` \| `"--large"` \| `"--full"` | CSS class format |
| `contentWidth` | `"content-width--wide"` \| `"--inset"` \| `"--full"` | CSS class format |
| `verticalAlignment` | `"vertical-alignment--top"` \| `"--middle"` \| `"--bottom"` | CSS class format |
| `horizontalAlignment` | `"horizontal-alignment--left"` \| `"--center"` \| `"--right"` | CSS class format (not yet in SectionStyleOptions) |
| `backgroundWidth` | `"background-width--full-bleed"` | CSS class format (not yet wired) |
| `imageOverlayOpacity` | `0.15` (number 0–1) | Background image overlay |
| `sectionAnimation` | `"none"` \| `"...?"` | Scroll animation |
| `backgroundMode` | `"image"` \| `"color"` \| `"video"` | What background to show |
| `customSectionHeight` | `1` – `100` (number) | Pixel/% custom height when `sectionHeight` has custom value |
| `customContentWidth` | `0` – `100` (number) | Percent when content width is custom |

### Section `divider` Object (at `section.divider` — top-level, NOT in `styles`)

Captured when section 0 divider was enabled with "pointed" shape:

```json
{
  "enabled": true,
  "type": "pointed",
  "width": { "unit": "vw", "value": 100 },
  "height": { "unit": "vw", "value": 12 },
  "isFlipX": true,
  "isFlipY": false,
  "offset": { "unit": "px", "value": 0 },
  "stroke": {
    "style": "solid",
    "color": { "type": "THEME_COLOR" },
    "thickness": { "unit": "px", "value": 15 },
    "dashLength": { "unit": "px", "value": 5 },
    "gapLength": { "unit": "px", "value": 15 },
    "linecap": "square"
  }
}
```

When disabled: `{ "enabled": false }` (no other fields).

**Known divider `type` values** (confirmed): `"pointed"`. Expected others: `"wave"`, `"slant"`, `"brush"`, `"paint"`.

### Bug Fixed (Mar 2026)

`editSectionStyle()` was writing to top-level section fields (`section.sectionTheme`) instead of
the nested `styles` object (`section.styles.sectionTheme`). This meant ALL section style API
calls were silently no-ops — the PUT succeeded but nothing visually changed.

**Fixed**: `sectionTheme`, `sectionHeight`, `contentWidth`, `verticalAlignment` now write to
`section.styles.*`. Divider writes to top-level `section.divider`. The implementation also
normalizes simplified values: `"dark"` stays `"dark"` (sectionTheme), `"small"` becomes
`"section-height--small"` (sectionHeight), etc.

### Unconfirmed / Not Yet Discovered

- `backgroundColor`, `paddingTop`, `paddingBottom`, `blockSpacing` — NOT found in API data.
  These are browser-agent-only features (UI automation). The API path is a known no-op for them.
- Section animation values (other than `"none"`)
- Other divider shape type values

---

## Missing Operations on Existing Blocks

Even for blocks we "have", some operations aren't wired yet:

| Operation | Block | Status | Notes |
|-----------|-------|--------|-------|
| `addMenuBlock` | Menu (18) | ❌ Missing | No way to add a brand new menu block via API — only update existing ones |
| Update gallery images | Gallery | ❌ Missing | `addImageBlockBatch` adds new blocks; no batch-update for existing gallery grid |
| `duplicateBlock` | All | ❌ Missing | `ContentSaveClient.duplicateBlock()` exists but not wired in `api-executor` |
| `moveBlock` | All | ❌ Missing | API fast path exists in browser-agent but not in `api-executor`'s `ContentOperation` union |
| `resizeBlock` | All | ❌ Missing | Same as above |
| `swapBlocks` | All | ❌ Missing | Same as above |
| Section reorder | — | ❌ Missing | `moveSection()` exists on client but no `operationType` in `ContentOperation` |
| Footer blocks | All | ❌ Missing | Footer uses different save endpoint; `ContentSaveClient` has the methods but `api-executor` doesn't handle footer pages |
| Custom CSS | — | ❌ Missing | `getCustomCSS` / `saveCustomCSS` exist but not exposed through planner/executor |
