# Section Divider MCP Tools — Design

## Overview

Add MCP tools for managing section dividers on Squarespace pages. Dividers are section-level properties (not blocks) that render decorative shape separators between sections.

## API Discovery

Dividers are stored at `section.divider` on each section object within the page sections JSON. They are saved via the standard `PUT /api/page-sections/{psId}/collection/{colId}` endpoint using the existing read-modify-write pattern.

### Divider Schema

```typescript
interface SectionDivider {
  enabled: boolean;
  type: 'none' | 'rounded' | 'soft-corners' | 'slanted' | 'scalloped' | 'wavy' | 'jagged' | 'pointed';
  width: { value: number; unit: 'vw' };
  height: { value: number; unit: 'vw' };
  isFlipX: boolean;
  isFlipY: boolean;
  offset: { value: number; unit: 'px' };
  stroke: {
    style: 'none' | 'solid' | 'dashed';
    color: { type: 'THEME_COLOR' | 'SITE_PALETTE_COLOR' | 'CUSTOM_COLOR' };
    thickness: { value: number; unit: 'px' };
    dashLength: { value: number; unit: 'px' };
    gapLength: { value: number; unit: 'px' };
    linecap: 'square';
  };
}
```

### Shape Types (all 8)

| Type | Description |
|------|-------------|
| `none` | Straight/flat |
| `rounded` | Rounded curve |
| `soft-corners` | Soft corner dip |
| `slanted` | Diagonal slant |
| `scalloped` | Scalloped waves |
| `wavy` | Wavy line |
| `jagged` | Zigzag/sawtooth |
| `pointed` | Sharp point/triangle |

### Default Values (from editor)

When a divider is first enabled, the editor sets:
- `type`: varies (user-selected)
- `width`: S=5vw, M=50vw(?), L=100vw
- `height`: S=2vw, M=4vw(?), L=6vw
- `isFlipX`: false, `isFlipY`: false
- `offset`: 0px
- `stroke.style`: `solid`
- `stroke.thickness`: 15px (L)
- `stroke.color`: `{ type: 'THEME_COLOR' }`

## Implementation

### 1. ContentSaveClient Methods

**`updateSectionDivider(pageSectionsId, collectionId, sectionIndex, dividerConfig)`**
- GET page sections
- Validate sectionIndex bounds
- Merge `dividerConfig` onto `section.divider` (preserving unspecified fields)
- PUT back all sections
- Returns `{ success, sectionId }`

**`removeSectionDivider(pageSectionsId, collectionId, sectionIndex)`**
- GET page sections
- Set `section.divider = { enabled: false }`
- PUT back
- Returns `{ success, sectionId }`

### 2. MCP Tools

**`sq_update_section_divider`** — Enable/configure a divider on a section
- Params: `siteId`, `pageSlug`, `sectionIndex`, `type` (optional), `width` (optional), `height` (optional), `flipX` (optional), `flipY` (optional), `offset` (optional), `strokeStyle` (optional), `strokeThickness` (optional)
- Resolves page IDs, calls `updateSectionDivider()`

**`sq_remove_section_divider`** — Disable divider on a section
- Params: `siteId`, `pageSlug`, `sectionIndex`
- Resolves page IDs, calls `removeSectionDivider()`

### 3. operationType

Add `'update_divider'` to the union in `src/agents/types.ts`.

### 4. Tests

- `src/services/__tests__/content-save-divider.test.ts` — ContentSaveClient divider methods
- `src/mcp-server/__tests__/divider-tools.test.ts` — MCP tool registration + handlers

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/services/content-save.ts` | Add `updateSectionDivider()`, `removeSectionDivider()` |
| `src/mcp-server/tools/divider.ts` | New file: `registerDividerTools()` |
| `src/mcp-server/index.ts` | Import + register divider tools |
| `src/agents/types.ts` | Add `'update_divider'` to operationType union |
| `src/services/__tests__/content-save-divider.test.ts` | New: ContentSaveClient tests |
| `src/mcp-server/__tests__/divider-tools.test.ts` | New: MCP tool tests |
