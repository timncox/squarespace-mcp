# Squarespace Block Type Discovery

Live discovery run: Feb 28 2026, grey-yellow-hbxc test-page.

Method: Added every available block type to the test page via the Fluid Engine block picker, saved, then ran `scripts/discover-block-types.ts --pageSectionsId 699f3d5bd9db5d1500d60c01`. Cross-referenced block index with editor DOM labels (via `[role=gridcell]` sibling scan).

---

## Complete Block Type Map

| Block Name | Type # | Value Signature | Notes |
|------------|--------|----------------|-------|
| **Text** | 2 | `{ engine: "wysiwyg", source, html, textAttributes }` | ✅ Implemented |
| **Page Link** | 12 | `{ linkTitle, linkTarget, newWindow }` | ❌ Not implemented |
| **Tag Cloud** | 14 | `{}` | ❌ Not implemented |
| **Embed** | 22 | `{}` / `{ html }` | ✅ Implemented — `addEmbedBlock(html?)`, `updateEmbedBlock(html)` |
| **Instagram** | 25 | `{ collectionId, design: "grid", auto-crop, show-meta, thumbnails-per-row }` | ❌ Gallery-like structure |
| **Quote** | 31 | `{ quote, source, blockAnimation, vSize, hSize, schemaName, aspectRatio, floatDir }` | ✅ Implemented |
| **Video (native)** | 32 | `{ blockAnimation, layout, overlay, nativeVideo, nativeVideoAssetId }` or `{ isOldBlock: true }` | ✅ Implemented (BLOCK_TYPE_VIDEO = 32) |
| **Search Field** | 33 | `{}` | ❌ No config — just a search widget |
| **Audio** | 41 | `{ designStyle, colorTheme, audioAssetId }` | ❌ Not implemented |
| **Markdown** | 44 | `{ wysiwyg: { engine: "markdown", source, html } }` | ⚠️ Was misidentified as "Quote alt"; same outer type 44 but engine=markdown |
| **RSS** | 49 | `{}` | ❌ Likely stores feedUrl once configured |
| **Newsletter** | 51 | `{ alignment, captchaEnabled, captchaTheme, captchaAlignment, description }` | ❌ Email signup form |
| **Donation** | 52 | `{}` | ❌ Squarespace donation/payments block |
| **Social Links** | 54 | `{ iconAlignment, iconSize, iconStyle, iconColor }` | ✅ Implemented — `addSocialLinksBlock(options?)`, `updateSocialLinksBlock(updates)` |
| **Summary** | 55 | `{ collectionId, design, headerText, textSize, pageSize, imageAspectRatio }` | ❌ Content aggregation |
| **SoundCloud** | 56 | `{ aspectRatio: 67 }` | ❌ Audio player embed |
| **Archive** | 61 | `{ collectionId, layout, blockId, groupBy, dropdownTitle, authorField, categoryField }` | ❌ Blog/gallery archive listing |
| **Chart** | 62 | `{ dataTableId, title, legend, caption, palette, flip, dataTable }` | ❌ Data visualization |
| **Scheduling** | 65 | `{}` | ❌ Acuity scheduling embed |
| **OpenTable** | 66 | `{ restaurantId, domain, lang, hideIcons, hideTitle }` | ❌ Restaurant reservations |
| **Line/Divider** | 47 | `{}` | ✅ Implemented (BLOCK_TYPE_DIVIDER = 47) |
| **Accordion** | 69 | `{ accordionItems: [{ title, description }] }` | ❌ Expandable FAQ/content |
| **Scrolling/Marquee** | 70 | `{ marqueeItems: [{ text }], linkTo, waveFrequency, waveIntensity, animationSpeed }` | ❌ Scrolling text ticker |
| **Tock** | 68 | `{ tockBusinessSlug, tockDisplayMode, tockAlignment, tockColorMode, hideTockLogo }` | ❌ Restaurant booking (Tock) |
| **Gallery** | 8 | `{ collectionId, design, thumbnails-per-row, aspect-ratio, lightbox, ... }` | ✅ Known (from previous discovery) |
| **Menu** | 18 | `{ menus, raw, menuStyle, currencySymbol }` | ✅ Implemented |
| **Button (old)** | 46 | `{ label, url }` | ✅ Implemented (addButtonBlock) |
| **Code** | 23 | (legacy type, may be 7.0 only) | ❌ Uncertain — see notes below |

### Type 1337 Variants

Type 1337 is Squarespace's Fluid Engine "widget" type — discriminated by inner value structure:

| Block | Discriminator | Key Value Fields |
|-------|--------------|-----------------|
| **Image** | `imageId` or `assetUrl` present | `imageId`, `altText`, `linkTo`, `imagePosition`, `imageMask` |
| **Button (Fluid Engine)** | `buttonText` + `buttonLink` | `buttonText`, `buttonLink`, `buttonSize`, `buttonAlignment`, `containerStyles`, `transforms`, `animations` |
| **Code / HTML block** | `wysiwyg.engine === "code"` | `wysiwyg.engine`, `wysiwyg.mode: "htmlmixed"`, `wysiwyg.source`, `html` |
| **Map** | `location.mapLat` present | `location: { mapLat, mapLng, mapZoom }`, `style`, `labels`, `terrain`, `vSize` |
| **Form (Fluid Engine)** | `buttonVariant` or `submissionTextAlignment` | `buttonAlignment`, `buttonVariant`, `firstFieldHighlightType`, `submissionTextAlignment` |
| **Shape** | `shape` field present | `shape`, `horizontalAlignment`, `showDropShadow`, `backgroundColor`, `dropShadow`, `transforms` |

---

## Block Picker Categories

From the live editor block picker (grey-yellow-hbxc, Feb 28 2026):

**Essentials**: Text · Image · Button · Video · Form · Accordion · Shape · Scrolling · Line

**Sell**: Product · Pricing Plan · Donation · Scheduling

**Display**: Summary · Newsletter · Quote · Audio · Calendar · Map · Menu · Chart

**Code**: Code · Markdown · Embed

**Links**: Social Links · Search Field · Page Link · Tag Cloud · RSS · Archive

**Integrations**: Instagram · Tock · SoundCloud · Flickr · OpenTable · Zola · Bandsintown

---

## Still Unknown / Not Yet Discovered

These were NOT added to the test page — type numbers still unknown:

| Block | Category | Priority | Notes |
|-------|----------|----------|-------|
| **Calendar** | Display | 🟡 Medium | Separate from Scheduling; shows a calendar widget |
| **Pricing Plan** | Sell | 🟡 Medium | Subscription/pricing tier blocks |
| **Product** | Sell | 🟡 Medium | Embed a single product |
| **Flickr** | Integrations | 🟢 Low | Requires Flickr account |
| **Zola** | Integrations | 🟢 Low | Wedding registry |
| **Bandsintown** | Integrations | 🟢 Low | Music event listings |
| **Video (external)** | Essentials | 🟡 Medium | YouTube/Vimeo embed — suspected type 50, **not yet live-confirmed** |

---

## Corrections to Previous Assumptions

| Previous Belief | Actual |
|----------------|--------|
| Type 52 = Divider | ❌ Type 52 = **Donation** block |
| Type 47 was unknown | ✅ Type 47 = **Line/Divider** (confirmed, already in code) |
| Type 44 = "Quote (alt)" | ❌ Type 44 = **Markdown** (value has `wysiwyg.engine: "markdown"`) |
| Type 50 = Video | ⚠️ **Unconfirmed** — native video is type 32; type 50 status unknown |
| Type 23 = Code | ⚠️ May be legacy 7.0 Code type; Fluid Engine Code = type 1337 with engine="code" |

---

## Implementation Priority

Based on discoveries, highest-value blocks to implement next:

### High — Common client requests, feasible JSON structure
1. **Newsletter (51)** — Email signup, has `captchaEnabled`, `description` text
2. **Form / type 1337 Form variant** — Contact form; type 1337 with `buttonVariant`, `submissionTextAlignment`
3. **Social Links (54)** — `iconAlignment`, `iconSize`, `iconStyle`, `iconColor`; need to discover icon array structure
4. **Accordion (69)** — `accordionItems: [{ title, description }]`; very feasible to add/update
5. **Audio (41)** — `audioAssetId`, `designStyle`, `colorTheme`; needs `MediaUploadClient` for audio files

### Medium — Feasible but less common
6. **Chart (62)** — `dataTable` array; can add/update chart data
7. **Scrolling/Marquee (70)** — `marqueeItems` array; easy to add/update text
8. **Archive (61)** — `collectionId`, `groupBy`; display config only
9. **Summary (55)** — `collectionId`, `pageSize`, `design`; display config

### Lower — Integration or external dependency
10. **Scheduling (65)** — empty JSON; config is external (Acuity)
11. **OpenTable (66)** — just needs `restaurantId`
12. **Instagram (25)** — gallery-like; needs Instagram OAuth connection
13. **Tock (68)** — just needs `tockBusinessSlug`

---

## Raw Discovery Data

Full JSON in `data/block-type-discovery.json` (last run: Feb 28 2026).

Run again any time with:
```bash
npx tsx scripts/discover-block-types.ts --site grey-yellow-hbxc --page test-page --pageSectionsId 699f3d5bd9db5d1500d60c01
```
