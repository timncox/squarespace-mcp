# Atomic Section Creation + Template Orphan Fix

**Date**: 2026-03-04
**Status**: Design

## Problem

Two bugs in section creation:

1. **`sq_add_blank_section` + block insertion → 500**: Creating a blank section via API works, but subsequent `sq_add_text`/`sq_add_embed` calls to the new section return 500 errors. The Squarespace backend likely doesn't fully initialize the `fluidEngineContext` server-side when a section is added via PUT with empty `gridContents`.

2. **`sq_add_template_section` → orphan section**: `copyTemplateSection()` calls `POST /api/content/copy/section` which creates the section site-wide but never attaches it to the target page. Returns "success: true" but the section doesn't appear on the page.

## Approach

**Atomic section+content creation**: Sidestep the 500 by never creating empty sections. New method creates sections with initial blocks already in `gridContents` in a single PUT. Also fix the template section orphan bug.

## Design

### 1. New ContentSaveClient Method: `addSectionWithBlocks()`

```typescript
interface InitialBlock =
  | { type: 'text'; html: string; layout?: LayoutHints; formatting?: TextFormatting }
  | { type: 'embed'; html: string; layout?: LayoutHints }
  | { type: 'button'; text: string; url: string; layout?: LayoutHints }
  | { type: 'image'; assetUrl: string; altText?: string; layout?: LayoutHints }
  | { type: 'video'; videoUrl: string; layout?: LayoutHints }

interface LayoutHints {
  columns?: number;
  rowHeight?: number;
  gapRows?: number;
  startX?: number;
  endX?: number;
  startY?: number;
  endY?: number;
}

interface AddSectionWithBlocksResult {
  success: boolean;
  sectionId?: string;
  sectionIndex?: number;
  blockIds?: string[];
  error?: string;
}

async addSectionWithBlocks(
  pageSectionsId: string,
  collectionId: string,
  blocks: InitialBlock[],
  options?: {
    position?: number;  // Insert at index (default: append)
    styles?: Partial<SectionStyles>;
  }
): Promise<AddSectionWithBlocksResult>
```

**Logic**:
1. GET current sections
2. Build blank section skeleton (same as `addBlankSection`)
3. For each `InitialBlock`, create `GridContent` using existing block-building logic from `addTextBlock`/`addEmbedBlock`/etc.
4. Pre-populate `fluidEngineContext.gridContents` with all blocks
5. Insert section at `position` (or append)
6. Single PUT with all sections

Block positioning within the section follows the same auto-stacking logic as `addTextBlock` — each block placed below the previous with gap rows.

### 2. Fix `sq_add_template_section` Orphan Bug

After `copyTemplateSection()` returns the new section data:
1. GET page sections for target page
2. Build a `PageSection` from the copy response
3. Append to sections array (or insert at position)
4. PUT updated sections

The `copyTemplateSection` response includes `id` and `sectionData` — we need to verify the section data structure and extract/construct the full `PageSection` from it.

### 3. New MCP Tool: `sq_add_section`

```
sq_add_section:
  siteId: string           — Site identifier
  pageSlug: string         — Page URL slug
  blocks: InitialBlock[]   — At least one block (text, embed, button, image, video)
  position?: number        — Section index to insert at (default: append)
  styles?: object          — Section style overrides (theme, height, width, alignment)
```

Returns: `{ success, sectionId, sectionIndex, blockIds[] }`

### 4. Position Support for Both Tools

Both `sq_add_section` and `sq_add_blank_section` get proper position support using array splice:
```typescript
if (position !== undefined && position >= 0 && position < sections.length) {
  sections.splice(position, 0, newSection);
} else {
  sections.push(newSection);
}
```

### 5. Block Type Constants and Builders

Extract block-building logic into reusable functions:
- `buildTextBlockContent(blockId, html, formatting?)` → GridContent.content
- `buildEmbedBlockContent(blockId, embedHtml)` → GridContent.content
- `buildButtonBlockContent(blockId, text, url)` → GridContent.content
- `buildImageBlockContent(blockId, assetUrl, altText?)` → GridContent.content
- `buildVideoBlockContent(blockId, videoUrl)` → GridContent.content

These extract the content-building from existing `addXxxBlock` methods without duplicating layout logic.

### 6. Tool Description Updates

- `sq_add_blank_section` description updated to warn: "Creates an empty section. Note: some sites may reject subsequent block insertions to API-created blank sections. Use sq_add_section instead to create sections with initial content."
- `sq_add_template_section` description unchanged (just fix the implementation)

## Testing

### Unit Tests (ContentSaveClient)
- `addSectionWithBlocks` with single text block
- `addSectionWithBlocks` with multiple mixed blocks (text + embed + button)
- `addSectionWithBlocks` with position insertion (beginning, middle, end)
- `addSectionWithBlocks` with custom section styles
- `addSectionWithBlocks` with empty blocks array → error
- Block layout auto-calculation (stacking, gap rows)
- Each block type builder (text, embed, button, image, video)

### Unit Tests (Template Orphan Fix)
- `sq_add_template_section` appends copied section to target page
- `sq_add_template_section` with position parameter
- `sq_add_template_section` handles copy failure gracefully

### MCP Tool Tests
- `sq_add_section` success with text block
- `sq_add_section` success with multiple blocks
- `sq_add_section` error on empty blocks array
- `sq_add_section` error on page resolution failure

## Files Changed

| File | Change |
|------|--------|
| `src/services/content-save.ts` | Add `addSectionWithBlocks()`, extract block builder functions |
| `src/services/content-save-types.ts` | Add `InitialBlock`, `AddSectionWithBlocksResult` types |
| `src/mcp-server/tools/section.ts` | Add `sq_add_section`, fix `sq_add_template_section` orphan bug, add position support |
| `src/mcp-server/tools/blocks.ts` | Possibly extract shared block-building logic |
| `src/services/__tests__/content-save-sections.test.ts` | Tests for `addSectionWithBlocks` |
| `src/mcp-server/__tests__/section-tools.test.ts` | Tests for new/fixed MCP tools |
