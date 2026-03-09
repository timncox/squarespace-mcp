# Squarespace Block API Coverage

Status of every Squarespace block type against our `ContentSaveClient` + MCP tools.

Legend:
- ✅ Full — add + update + MCP tools
- 🔶 Partial — one or two operations missing
- ❌ None — no API support yet
- ❓ Unknown — type number not yet discovered

---

## Blocks We Have

| Block | Type # | Status | MCP Tools | Notes |
|-------|---------|--------|-----------|-------|
| **Text / HTML** | 2 | ✅ Full | `sq_add_text` `sq_update_text` `sq_patch_text` `sq_format_text` | Rich HTML builder; formatting; surgical patch |
| **Image** | 1337 | ✅ Full | `sq_add_image` `sq_update_image` `sq_upload_image` | Requires media upload; default 12×8 grid |
| **Gallery** | 1337 (multi) | ✅ Full | `sq_add_gallery_image` `sq_update_gallery` `sq_list_gallery_images` `sq_reorder_gallery_images` `sq_remove_gallery_image` | Full gallery image management |
| **Button** | 46 | ✅ Full | `sq_add_button` `sq_update_button` | Default 7 cols × 2 rows |
| **Menu** | 18 | ✅ Full | `sq_add_menu` `sq_add_menu_tab` `sq_update_menu` `sq_get_menu` | Structured JSON merge + plain-text serializer |
| **Quote** | 31 | ✅ Full | `sq_add_quote` `sq_update_quote` | Attribution optional |
| **Code / HTML embed** | 1337 (engine=`code`) | ✅ Full | `sq_add_code` `sq_update_code` | Distinguished by `value.wysiwyg.engine === 'code'` |
| **Divider** | 47 | ✅ Add | `sq_add_divider` | Structural only — no content to update |
| **Video (native)** | 32 | ✅ Full | `sq_add_video` `sq_update_video` | Squarespace-hosted video |
| **Form** | 1337 variant | ✅ Full | `sq_add_form_block` `sq_update_form_block` `sq_create_form` `sq_update_form` `sq_list_forms` `sq_get_form` | Native Squarespace forms |
| **Newsletter** | 51 | ✅ Full | `sq_add_newsletter` `sq_update_newsletter` | Email signup with captcha support |
| **Social Links** | 54 | ✅ Full | `sq_add_social_links_block` `sq_update_social_links_block` `sq_add_social_link` `sq_list_social_links` `sq_remove_social_link` | Full social account management |
| **Embed** | 22 | ✅ Full | `sq_add_embed` `sq_update_embed` | Raw HTML/iframe embed |
| **Map** | 1337 variant | ✅ Full | `sq_add_map` `sq_update_map` | Address geocoding via Nominatim |
| **Marquee** | 70 | ✅ Full | `sq_add_marquee` `sq_update_marquee` | Scrolling text banner |
| **Accordion** | 69 | ✅ Full | `sq_add_accordion` `sq_update_accordion` | Expandable FAQ/content sections |

## Block Layout Operations

All block layout operations are implemented as MCP tools:

| Operation | MCP Tool |
|-----------|----------|
| Move block | `sq_move_block` |
| Resize block | `sq_resize_block` |
| Duplicate block | `sq_duplicate_block` |
| Swap blocks | `sq_swap_blocks` |
| Remove block | `sq_remove_block` |
| Move section | `sq_move_section` |
| Duplicate section | `sq_duplicate_section` |

## Site-Wide Operations

| Operation | MCP Tool |
|-----------|----------|
| Custom CSS | `sq_update_css` |
| Header text | `sq_update_header_text` |
| Footer text | `sq_update_footer_text` |
| Code injection | `sq_update_code_injection` `sq_get_code_injection` |
| Site settings | `sq_update_settings` `sq_get_settings` |
| Navigation | `sq_update_navigation` `sq_get_navigation` |
| Design (fonts/colors) | `sq_update_design` `sq_get_design` |
| Site identity | `sq_update_site_identity` `sq_get_site_identity` |
| Announcement bar | `sq_update_announcement_bar` `sq_get_announcement_bar` |

---

## Blocks We Don't Have Yet

### Feasible — Known type numbers

| Block | Type # | Priority | Notes |
|-------|---------|----------|-------|
| **Audio** | 41 | 🟡 Medium | `{ designStyle, colorTheme, audioAssetId }`. Needs `MediaUploadClient` for audio files. |
| **Markdown** | 44 | 🟢 Low | Type 44 with `wysiwyg.engine: "markdown"`. Could reuse code block infrastructure. |
| **Shape** | 1337 variant | 🟢 Low | `{ shape, horizontalAlignment, showDropShadow, backgroundColor }`. Decorative only. |
| **Chart** | 62 | 🟡 Medium | `{ dataTableId, title, legend, caption, palette, flip, dataTable: { data: [[...]] } }`. |
| **Page Link** | 12 | 🟡 Medium | `{ linkTitle, linkTarget, newWindow }`. Simple internal page link. |
| **Summary** | 55 | 🟢 Low | `{ collectionId, design, headerText, textSize, pageSize, imageAspectRatio }`. Display config only. |
| **Archive** | 61 | 🟢 Low | `{ collectionId, layout, groupBy, dropdownTitle }`. Blog/gallery archive listing. |
| **Donation** | 52 | 🟢 Low | External config (Squarespace Donations product). Likely no JSON to change. |

### Unknown type numbers — need discovery

| Block | Priority | Notes |
|-------|----------|-------|
| **Video (external/YouTube)** | 🟡 Medium | Type 50 suspected but unconfirmed |
| **Product** | 🟡 Medium | Commerce block that embeds a product |
| **Calendar** | 🟢 Low | Calendar widget |
| **Pricing Plan** | 🟢 Low | Commerce pricing display |

### External dependencies — unlikely to implement

| Block | Type # | Notes |
|-------|---------|-------|
| Instagram | 25 | Requires Instagram OAuth |
| Search Field | 33 | No configurable content |
| Tag Cloud | 14 | Read-only aggregation |
| RSS | 49 | Stores `feedUrl` once configured |
| SoundCloud | 56 | Stores track/playlist URL |
| Scheduling (Acuity) | 65 | External config |
| OpenTable | 66 | Just needs `restaurantId` |
| Tock | 68 | Just needs `tockBusinessSlug` |

---

## Discovery

Run discovery any time:
```bash
npx tsx scripts/discover-block-types.ts --site grey-yellow-hbxc --page test-page --pageSectionsId 699f3d5bd9db5d1500d60c01
```

## Type Number Corrections (Feb 28 2026)

- ~~Type 52 = Divider~~ → **Type 52 = Donation block**
- ~~Type 50 = Video~~ → **Type 32 = Video (native)**; type 50 unconfirmed
- ~~Type 44 = "Quote (alt)"~~ → **Type 44 = Markdown** (value has `wysiwyg.engine: "markdown"`)
