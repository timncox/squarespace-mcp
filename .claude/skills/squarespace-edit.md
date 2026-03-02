---
name: squarespace-edit
description: >
  Use when modifying existing content on a Squarespace site — text, images, buttons,
  menus, quotes, code, video, and more. Also covers removing and duplicating blocks.
---

## When to Use

- User wants to change existing text, headings, paragraphs
- User wants to update buttons (label, URL), images (alt text, title), or menus
- User wants to edit quote, code, video, newsletter, accordion, marquee, embed, form, or social link blocks
- User wants to update footer content
- User wants to remove or duplicate blocks
- User wants to resize, move, or swap blocks within a section

Do NOT use this skill for adding new sections/blocks (use `squarespace-create`) or for page-level operations like creating/deleting pages.

## Quick Reference

| Block Type | Update Method | Patch Method | CLI Command |
|-----------|--------------|-------------|-------------|
| Text | `updateTextBlock` (destructive) | `patchTextBlock` (surgical) | `update-text` / `patch-text` |
| Button | `updateButtonBlock` | — | `update-button` |
| Image | `updateImageBlock` (metadata only) | — | `update-image` |
| Menu | `updateMenuBlock` | — | `update-menu` |
| Video | `updateVideoBlock` | — | — |
| Quote | `updateQuoteBlock` | — | — |
| Code | `updateCodeBlock` | — | — |
| Newsletter | `updateNewsletterBlock` | — | — |
| Accordion | `updateAccordionBlock` | — | — |
| Marquee | `updateMarqueeBlock` | — | — |
| Form | `updateFormBlock` | — | — |
| Social Links | `updateSocialLinksBlock` | — | — |
| Embed | `updateEmbedBlock` | — | — |
| Footer text | `updateFooterTextBlock` | `patchFooterTextBlock` | `footer` |

---

## CRITICAL: Patch vs Update

This is the #1 source of bugs. Understand the difference before editing any text.

### `updateTextBlock(psId, colId, searchText, newHtml)` — DESTRUCTIVE

Replaces the **entire block's HTML** with `newHtml`. If a block has a heading + 3 paragraphs and you call `updateTextBlock`, all of it is replaced.

- Use when: you want to completely rewrite a block
- `searchText`: finds which block to target (case-insensitive match against stripped text)
- `newHtml`: the full replacement HTML (e.g., `<h2>New Title</h2><p>New body.</p>`)

### `patchTextBlock(psId, colId, searchText, newText)` — SURGICAL

Replaces only the **matched substring** within the block, preserving everything else.

- Use when: changing a phone number, fixing a typo, updating a name — any small change
- `searchText`: the exact text to find AND replace (case-insensitive)
- `newText`: what to replace it with
- The rest of the block content is preserved untouched

### `updateTextBlockHtml(psId, colId, searchText, rawHtml)` — RAW HTML

Like `updateTextBlock` but writes `rawHtml` directly without any wrapping. Use when you need precise HTML control (e.g., preserving existing `<p>` tags with specific attributes).

### `patchHtmlSegment(html, searchText, newText)` — INTERNAL

Low-level helper used by `patchTextBlock`. Splits HTML into block-level segments (`<p>`, `<h1>`–`<h6>`, `<div>`, `<li>`) and replaces within the matching segment only. Not called directly — use `patchTextBlock` instead.

### Rule of thumb

> **Always prefer `patchTextBlock` for small changes.** Only use `updateTextBlock` when replacing the entire block content.

---

## Finding Blocks

All update methods use `searchText` to locate the target block. The underlying `findBlock()` method searches across block types:

| Block Type | What it searches |
|-----------|-----------------|
| Text (type 2) | Stripped HTML content (tags removed) |
| Image (type 1337) | `title`, `description`, `subtitle` fields |
| Code (type 1337) | Raw HTML content |
| Button (type 46) | `label` field |
| Button (type 1337) | `buttonText`, `buttonLink` fields (definitionName: `'website.components.button'`) |
| Menu (type 18) | `raw` text + tab/section/item titles |
| Quote (type 31) | HTML content + source |
| Video (type 50) | Title, description |
| Form (type 1337) | `formId` field |
| All types | Block ID prefix fallback |

Search is **case-insensitive** and uses **substring matching** — you don't need the full text, just enough to uniquely identify the block.

### Specialized finders

- **`findMenuBlock(sections, searchText)`** — wraps `findBlock()` with type 18 filter, returns `menuValue` with `{ menus, raw, menuStyle, currencySymbol }`
- **`findGalleryBlock(sections, searchText?)`** — finds type 8 gallery blocks by `collectionId` or block ID prefix

---

## All Edit Methods by Block Type

### Text Blocks

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateTextBlock` | `(psId, colId, searchText, newHtml)` | Replace entire block HTML (destructive) |
| `patchTextBlock` | `(psId, colId, searchText, newText)` | Replace matched substring only (surgical) |
| `updateTextBlockHtml` | `(psId, colId, searchText, rawHtml)` | Replace with raw HTML (no wrapping) |

```bash
# Full replacement
tsx scripts/sq.ts update-text --site <id> --page <slug> --search "old heading" --html "<h2>New Heading</h2>"

# Surgical patch
tsx scripts/sq.ts patch-text --site <id> --page <slug> --search "555-1234" --new "555-5678"
```

### Button Blocks (type 46 + type 1337)

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateButtonBlock` | `(psId, colId, searchText, { newLabel?, url?, size?, style?, alignment?, variant? })` | Update label, URL, and/or design fields |

- **Type 46 (legacy)**: `searchText` matches the button's `label` field
- **Type 1337 (new)**: `searchText` matches `buttonText` or `buttonLink` field
- A normalization layer (`isButtonBlock`/`getButtonFields`/`setButtonFields`) abstracts over both types
- Must provide at least one update field (`newLabel`, `url`, or a design field)
- Design fields: `size` (`'small'`/`'medium'`/`'large'`), `style` (`'primary'`/`'secondary'`/`'tertiary'`), `alignment` (`'left'`/`'center'`/`'right'`), `variant` (`'solid'`/`'outline'`)

```bash
tsx scripts/sq.ts update-button --site <id> --page <slug> --search "Book Now" --label "Reserve" --url "https://new-url.com"
```

### Image Blocks (type 1337)

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateImageBlock` | `(psId, colId, searchText, { title?, description?, subtitle?, altText?, linkTo?, assetUrl? })` | Update image metadata or replace asset |

- With `assetUrl`: replaces the actual image (writes to `content.value.value.assetUrl`)
- Without `assetUrl`: updates metadata only (title, alt text, etc.)
- API fast paths: `replaceImage` and `addImageBlock` browser actions try API first (~200ms) before falling back to 7-step UI automation
- `searchText` matches `title`, `description`, or `subtitle`

```bash
tsx scripts/sq.ts update-image --site <id> --page <slug> --search "Team Photo" --alt "Our team at the 2026 retreat" --title "Team Retreat"
```

### Menu Blocks (type 18)

| Method | Signature | What it does |
|--------|-----------|-------------|
| `getMenuBlock` | `(psId, searchText)` | Read current menus/style/currency (read-only) |
| `updateMenuBlock` | `(psId, colId, searchText, newMenus, options?)` | Replace menu JSON, regenerate `raw` |

Menu JSON structure:
```
MenuTab[] → each tab has { title, sections: MenuSection[] }
MenuSection[] → each section has { title, items: MenuItem[] }
MenuItem[] → each item has { title, description, price }
```

Options: `{ preserveRaw: true }` skips raw text regeneration.

**Menu merge strategies** (in `src/services/menu-merger.ts`):
- `mergeMenuStructured(current, updates)` — deterministic title matching (case-insensitive exact match). Appends unmatched entries. Best for adding/updating items.
- `mergeMenuFromText(currentMenus, updateText)` — parses text format, then structured merge.
- `mergeMenuContent(current, updates)` — LLM-based merge. Fallback for fuzzy matching.

```bash
tsx scripts/sq.ts update-menu --site <id> --page <slug> --search "Lunch Menu" --menus '[{"title":"Lunch","sections":[...]}]'
```

### Video Blocks (type 50)

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateVideoBlock` | `(psId, colId, searchText, { url?, title?, description? })` | Update video URL or metadata |

### Quote Blocks (type 31)

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateQuoteBlock` | `(psId, colId, searchText, { quoteText?, attribution? })` | Update quote text and/or attribution |

### Code Blocks (type 1337, engine='code')

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateCodeBlock` | `(psId, colId, searchText, { code?, language? })` | Replace code content |

### Newsletter Blocks

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateNewsletterBlock` | `(psId, colId, searchText, { description?, alignment?, captchaEnabled?, submitButtonText?, title? })` | Update newsletter form settings |

### Accordion Blocks

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateAccordionBlock` | `(psId, colId, searchText, { items?, isExpandedFirstItem?, shouldAllowMultipleOpenItems? })` | Update FAQ items and behavior |

- `items`: `Array<{ title: string; description: string }>`

### Marquee Blocks

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateMarqueeBlock` | `(psId, colId, searchText, { items?, animationDirection?, animationSpeed?, textStyle?, pausedOnHover? })` | Update scrolling text content and animation |

- `items`: `Array<{ text: string; linkTo?: string }>`
- `animationDirection`: `'left'` or `'right'`

### Form Blocks

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateFormBlock` | `(psId, colId, searchText, { buttonVariant?, buttonAlignment?, useLightbox? })` | Update form display settings |

- `buttonVariant`: `'primary'`, `'secondary'`, `'tertiary'`
- `buttonAlignment`: `'left'`, `'center'`, `'right'`
- `searchText` matches by `formId`

### Social Links Blocks

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateSocialLinksBlock` | `(psId, colId, searchText, { iconAlignment?, iconSize?, iconStyle?, iconColor? })` | Update social link display |

- `iconSize`: `'small'`, `'medium'`, `'large'`
- `iconStyle`: `'icon-only'`, `'icon-text'`
- `iconColor`: `'black'`, `'white'`
- `searchText` matches by block ID prefix

### Embed Blocks (type 22)

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateEmbedBlock` | `(psId, colId, searchText, html)` | Replace embed HTML content |

- Falls back to first type 22 block if search doesn't match

---

## Footer Editing

Footer sections use a **separate API endpoint** (`site-header-footer`), not the standard page sections API. Two dedicated methods:

| Method | Signature | What it does |
|--------|-----------|-------------|
| `updateFooterTextBlock` | `(searchText, newText)` | Full replacement of footer text block (destructive) |
| `patchFooterTextBlock` | `(searchText, newText)` | Surgical substring replace in footer text block |

Note: these take only 2 params (no `psId`/`colId`) — the footer IDs are resolved internally.

The same patch-vs-update rule applies: prefer `patchFooterTextBlock` for small changes.

---

## Block Lifecycle

### Remove a block

```
removeBlock(psId, colId, searchText, options?)
```

Splices the block from its section's `gridContents` array. `searchText` uses `findBlock()` — matches across all block types.

```bash
tsx scripts/sq.ts remove-block --site <id> --page <slug> --search "text in block to remove"
```

### Duplicate a block

```
duplicateBlock(psId, colId, searchText)
```

Creates a copy of the block with a new ID, placed after the original in the same section.

### Duplicate a section

```
duplicateSection(psId, colId, sectionSearch)
```

`sectionSearch` can be a section index (number) or text within the section (string). Creates a full copy with new IDs for the section and all its blocks.

---

## Move / Resize / Swap Blocks

| Method | Signature | What it does |
|--------|-----------|-------------|
| `moveBlock` | `(psId, colId, searchText, direction, gridSteps?)` | Shift block on desktop grid |
| `resizeBlock` | `(psId, colId, searchText, width?, height?)` | Resize block |
| `swapBlocks` | `(psId, colId, searchText1, searchText2)` | Exchange two blocks' positions |
| `moveSection` | `(psId, colId, searchText, direction)` | Reorder sections (`'up'`/`'down'`) |

- `moveBlock` direction: `'up'`, `'down'`, `'left'`, `'right'`
- `resizeBlock` width: `'smaller'`, `'larger'`, `'full'`; height: `'shorter'`, `'taller'`

```bash
tsx scripts/sq.ts move-section --site <id> --page <slug> --search "About Us" --direction up
```

---

## Section Styling

```
editSectionStyle(psId, colId, sectionSearch, styles)
```

`SectionStyleOptions`:
- `sectionTheme`: `'white'`, `'light'`, `'dark'`, `'black'`, `''` (default)
- `sectionHeight`: `'small'`, `'medium'`, `'large'`, `'full'`
- `contentWidth`: `'inset'`, `'wide'`, `'full'`
- `verticalAlignment`: `'top'`, `'middle'`, `'bottom'`

`sectionSearch` can be a section index (number) or text within the section (string).

```bash
tsx scripts/sq.ts section-style --site <id> --page <slug> --search "Hero Section" --theme dark --height large
```

---

## CLI Commands

All commands use `tsx scripts/sq.ts <subcommand>`. Common flags: `--site <id>`, `--page <slug>`.

| Command | Required flags | Description |
|---------|---------------|-------------|
| `update-text` | `--search <text> --html <html>` | Full replace of text block |
| `patch-text` | `--search <text> --new <text>` | Surgical substring replace |
| `remove-block` | `--search <text>` | Remove a block |
| `move-section` | `--search <text> --direction up\|down` | Reorder sections |
| `section-style` | `--search <text> [--theme] [--height]` | Style a section |
| `update-button` | `--search <text> [--label] [--url]` | Update button |
| `update-image` | `--search <text> [--alt] [--title]` | Update image metadata |
| `update-menu` | `--search <text> --menus <json>` | Replace menu content |
| `footer` | `[--search <text> --text <text>]` | Get footer sections, or patch footer text |
| `swap-blocks` | `--block1 <text> --block2 <text>` | Swap two blocks' positions |
| `duplicate-block` | `--search <text>` | Duplicate a block |

Optional overrides: `--psid <id>`, `--colid <id>` (bypass page ID resolution for private sites).

---

## Workflow

### Step 1: Identify site and page

Look up the site in `config/sites.json`. The `--site` flag accepts a client ID, alias, or raw subdomain. If the user didn't specify which site or page, ask before proceeding.

### Step 2: Snapshot current state

```bash
tsx scripts/sq.ts snapshot --site <id> --page <slug>
```

Review the snapshot to understand current content. Note section indexes (0-based) and block text for `--search` targeting.

If snapshot fails with an auth error, tell the user to run the `squarespace-setup` skill first.

### Step 3: Execute edits

Run commands one at a time. After each, check output for `"success": true`.

**If a command fails:**
- Auth error → stop, tell user to run `squarespace-setup`
- Block not found → verify `--search` text matches actual content (check snapshot)
- Section index out of range → re-snapshot for current section count
- Other error → report the full error before proceeding

### Step 4: Verify

Run another snapshot and confirm changes landed correctly. Report before/after comparison to the user.

---

## Examples

### Change a heading

```bash
# Snapshot to see current content
tsx scripts/sq.ts snapshot --site acme --page about

# Patch just the heading text (surgical)
tsx scripts/sq.ts patch-text --site acme --page about --search "About Our Company" --new "About Acme Corp"

# Verify
tsx scripts/sq.ts snapshot --site acme --page about
```

### Update a menu price

```bash
# Read current menu
tsx scripts/sq.ts snapshot --site cafe --page menu

# Patch the price (surgical — preserves all other menu content)
tsx scripts/sq.ts patch-text --site cafe --page menu --search "$12.99" --new "$14.99"
```

### Fix a phone number in the footer

Footer blocks aren't on regular pages — use the `footer` CLI command:

```bash
# View current footer content
tsx scripts/sq.ts footer --site acme

# Patch a phone number (surgical)
tsx scripts/sq.ts footer --site acme --search "555-1234" --text "555-5678"
```

---

## Error Handling

- All methods return `{ success: boolean, error?: string }`
- `"No text block found containing..."` → `--search` text doesn't match any block. Re-snapshot and check exact content.
- `"Block is type X, not..."` → wrong block type matched. Use more specific search text.
- Auth/crumb errors → session expired. Run `squarespace-setup` to refresh.
- 400 from API → usually a malformed PUT. Check that HTML is valid and complete.

## Key Rules

- API calls take ~200ms. Always prefer API over browser agent.
- `--search` is case-insensitive and matches against stripped text (no HTML tags).
- HTML for `--html` must be valid: `<h2>Heading</h2><p>Paragraph.</p>`, `<ul><li>Item</li></ul>`.
- Special characters: use `$'...'` bash quoting for unicode (e.g., `$'Let\u2019s'` for curly apostrophe).
- Footer editing requires dedicated footer methods — standard page methods won't find footer blocks.
- `updateImageBlock` supports both metadata updates and full image replacement via `assetUrl`. The browser agent's `replaceImage` and `addImageBlock` actions have API fast paths that try `MediaUploadClient.uploadImage()` + `updateImageBlock(assetUrl)` before falling back to UI automation.
