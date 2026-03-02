---
name: squarespace-design
description: >
  Use when changing layout, styling, or visual design of a Squarespace site.
  Covers section styling (theme, height, dividers), section ordering,
  block layout (desktop + mobile), custom CSS, and gallery settings.
---

# Squarespace Design & Layout

## Overview

All methods are on `ContentSaveClient` from `src/services/content-save.ts`.
Types are in `src/services/content-save-types.ts`.

Most methods require `pageSectionsId` and `collectionId` — resolve these via
`getPageIds(slug)` or the page cache in `sq.ts`.

---

## Grid System

- **Desktop**: 24 columns (X: 1–24, `start` inclusive / `end` exclusive)
- **Mobile**: 8 columns (auto-reflows from desktop)
- `GridCoord = { x: number; y: number }` — column and row position
- Grid origin is top-left: `{ x: 1, y: 1 }`

---

## Section Styling

### editSectionStyle()

```typescript
async editSectionStyle(
  pageSectionsId: string,
  collectionId: string,
  sectionSearch: number | string,  // section index or text content
  styles: SectionStyleOptions,
): Promise<SectionStyleResult>
```

```typescript
interface SectionStyleOptions {
  sectionTheme?: string;       // "white" | "light" | "dark" | "black" | ""
  sectionHeight?: string;      // "small" | "medium" | "large" | "full"
  contentWidth?: string;       // "inset" | "wide" | "full"
  verticalAlignment?: string;  // "top" | "middle" | "bottom"
  divider?: SectionDividerOptions | null;  // null to disable
}

interface SectionDividerOptions {
  enabled: boolean;
  type?: string;    // "pointed" | "wave" | "slant" | "brush" | "paint"
  width?: { unit: string; value: number };   // default: { unit: "vw", value: 100 }
  height?: { unit: string; value: number };  // default: { unit: "vw", value: 12 }
  isFlipX?: boolean;
  isFlipY?: boolean;
}
```

Returns: `{ success, sectionId?, sectionIndex?, updatedFields?, error? }`

**IMPORTANT**: Writes to `section.styles.*` (NOT `section.sectionTheme`). Accepts
simplified values ("dark") or full CSS classes ("section-height--large") — both work.

### Section Search Parameter

Several methods accept `sectionSearch: number | string`:
- **number**: Section index (0-based)
- **string**: Text content to find within the section's blocks

---

## Section Ordering

### moveSection()

```typescript
async moveSection(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,          // text content within the section to move
  direction: 'up' | 'down',
): Promise<SectionMoveResult>
```

Boundary-safe: returns success with `oldIndex === newIndex` at edges.

### duplicateSection()

```typescript
async duplicateSection(
  pageSectionsId: string,
  collectionId: string,
  sectionSearch: number | string,
): Promise<SectionDuplicateResult>
```

Deep clones the section with new section ID (24-char hex) and regenerated block IDs.

Returns: `{ success, originalSectionId?, newSectionId?, newSectionIndex?, error? }`

### reorderSections()

```typescript
async reorderSections(
  pageSectionsId: string,
  collectionId: string,
  newOrder: number[],   // current indices in desired order, e.g. [2, 0, 1]
): Promise<SectionReorderResult>
```

Returns: `{ success, newOrder?, sectionsCount?, error? }`

---

## Block Layout — Desktop

### moveBlock()

```typescript
async moveBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  direction: 'up' | 'down' | 'left' | 'right',
  gridSteps?: number,   // defaults to block's own dimension in movement direction
): Promise<BlockMoveResult>
```

Returns: `{ success, blockId?, direction?, oldPosition?, newPosition?, clamped?, error? }`

### swapBlocks()

```typescript
async swapBlocks(
  pageSectionsId: string,
  collectionId: string,
  searchText1: string,
  searchText2: string,
): Promise<BlockMoveResult>
```

Exchanges two blocks' full layout objects (desktop + mobile + zIndex).

### resizeBlock()

```typescript
async resizeBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  width?: 'smaller' | 'larger' | 'full',
  height?: 'shorter' | 'taller',
): Promise<BlockResizeResult>
```

At least one of `width` or `height` required.

Returns: `{ success, blockId?, oldSize?, newSize?, clamped?, error? }`

### setBlockPosition()

```typescript
async setBlockPosition(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  position: { start: GridCoord; end: GridCoord },
): Promise<BlockMoveResult>
```

Sets exact desktop coordinates. Clamping shifts the entire block if it goes out of bounds.

### setBlockSize()

```typescript
async setBlockSize(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  size: { width?: number; height?: number },
): Promise<BlockResizeResult>
```

Sets exact desktop size in columns/rows. At least one of `width` or `height` required.

---

## Block Layout — Mobile

Mobile grid is **8 columns**. Same search-by-text pattern as desktop methods.

### hideOnMobile() / showOnMobile()

```typescript
async hideOnMobile(psId: string, colId: string, searchText: string): Promise<MobileVisibilityResult>
async showOnMobile(psId: string, colId: string, searchText: string): Promise<MobileVisibilityResult>
```

Returns: `{ success, blockId?, visible?, error? }`

### setMobileLayout()

```typescript
async setMobileLayout(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  layout: { start?: GridCoord; end?: GridCoord; visible?: boolean },
): Promise<MobileLayoutSetResult>
```

Partial update — only provided fields are changed.

Returns: `{ success, blockId?, oldLayout?, newLayout?, clamped?, error? }`

### moveBlockMobile()

```typescript
async moveBlockMobile(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  direction: 'up' | 'down' | 'left' | 'right',
  gridSteps?: number,
): Promise<MobileMoveResult>
```

### resizeBlockMobile()

```typescript
async resizeBlockMobile(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  width?: 'smaller' | 'larger' | 'full',   // 'full' = all 8 mobile columns
  height?: 'shorter' | 'taller',
): Promise<MobileResizeResult>
```

---

## Custom CSS

### getCustomCSS()

```typescript
async getCustomCSS(): Promise<{ success: boolean; css: string; error?: string }>
```

Site-wide CSS. No `pageSectionsId`/`collectionId` needed.

### saveCustomCSS()

```typescript
async saveCustomCSS(css: string): Promise<{ success: boolean; error?: string }>
```

Replaces the entire site-wide custom CSS. No per-page CSS API exists.

---

## Gallery Settings

### updateGallerySettings()

```typescript
async updateGallerySettings(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  settings: GallerySettings,
): Promise<GallerySettingsUpdateResult>
```

```typescript
interface GallerySettings {
  'thumbnails-per-row'?: number;
  'aspect-ratio'?: string;
  design?: string;
  padding?: number;
  lightbox?: boolean;
  'auto-crop'?: boolean;
  'square-thumbs'?: boolean;
  'show-meta'?: boolean;
  'show-meta-basic'?: boolean;
  'show-meta-only-title'?: boolean;
  'show-meta-only-description'?: boolean;
}
```

Returns: `{ success, blockId?, updatedFields?, error? }`

---

## CLI Commands

All via `tsx scripts/sq.ts <command>`:

| Command | Flags |
|---------|-------|
| `move-section` | `--site <id> --page <slug> --search <str> --direction up\|down` |
| `section-style` | `--site <id> --page <slug> --search <str> [--theme <str>] [--height <str>]` |
| `move-block` | `--site <id> --page <slug> --search <str> --direction up\|down\|left\|right [--steps <n>]` |
| `resize-block` | `--site <id> --page <slug> --search <str> [--width smaller\|larger\|full] [--height shorter\|taller]` |
| `custom-css` | `--site <id> [--css <str> \| --file <path>]` (read if no flags, write if --css or --file) |
| `duplicate-section` | `--site <id> --page <slug> --search <str\|idx>` |
| `swap-blocks` | `--site <id> --page <slug> --block1 <str> --block2 <str>` |
| `duplicate-block` | `--site <id> --page <slug> --search <str>` |
| `gallery` | `--site <id> --page <slug> --section <idx> --images <csv-urls> [--cols <n>]` |

**API-only** (no CLI command): `reorderSections()` — use the TypeScript API directly.

---

## Examples

### Example 1: Make a section dark themed with large height

```typescript
const client = createContentSaveClient('my-site', cookiePath);

await client.editSectionStyle(psId, colId, 0, {
  sectionTheme: 'dark',
  sectionHeight: 'large',
  contentWidth: 'wide',
});
```

Or search by text content:

```typescript
await client.editSectionStyle(psId, colId, 'About Our Team', {
  sectionTheme: 'dark',
  sectionHeight: 'large',
});
```

### Example 2: Reorder sections

```typescript
// Move section with "Contact" text to the top
await client.moveSection(psId, colId, 'Contact', 'up');

// Or reorder all sections at once: put section 2 first, then 0, then 1
await client.reorderSections(psId, colId, [2, 0, 1]);
```

### Example 3: Resize and move a block

```typescript
// Make the heading full-width
await client.resizeBlock(psId, colId, 'Welcome to', 'full');

// Move an image block down
await client.moveBlock(psId, colId, 'team photo', 'down', 4);

// Set exact position (columns 5-19, rows 1-9)
await client.setBlockPosition(psId, colId, 'Our Services', {
  start: { x: 5, y: 1 },
  end: { x: 19, y: 9 },
});
```

### Example 4: Hide a block on mobile

```typescript
await client.hideOnMobile(psId, colId, 'decorative divider');
```

### Example 5: Add custom CSS

```typescript
const { css } = await client.getCustomCSS();
const newCss = css + '\n\n/* Custom heading style */\n.sqs-block h2 { color: #333; }';
await client.saveCustomCSS(newCss);
```

### Example 6: Add a section divider

```typescript
await client.editSectionStyle(psId, colId, 'About Us', {
  divider: {
    enabled: true,
    type: 'wave',
    height: { unit: 'vw', value: 8 },
  },
});
```

---

## Important Notes

- **Grid coordinates**: Desktop is 24 columns, mobile is 8 columns. `start` is inclusive, `end` is exclusive.
- **Clamping**: Move/resize operations clamp to grid boundaries rather than failing.
- **editSectionStyle bug (fixed Mar 2026)**: Writes to `section.styles.*` — NOT `section.sectionTheme` at the top level. If you see old code writing to `section.sectionTheme`, it's incorrect.
- **Divider lives at `section.divider`** (top-level, separate from `section.styles`).
- **Mobile auto-reflows**: Only desktop coordinates need explicit management. Mobile reflows automatically but can be overridden with `setMobileLayout()` and related methods.
- **Custom CSS is site-wide only** — no per-page CSS API exists.
- **Backfill required**: When modifying blocks via API PUT, always backfill `verticalAlignment` and `zIndex` on existing blocks (Squarespace validates ALL blocks, not just modified ones).
