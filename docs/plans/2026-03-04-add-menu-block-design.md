# Add Menu Block — Design

## Goal

Add `sq_add_menu` MCP tool + `addMenuBlock()` ContentSaveClient method to create new menu blocks (type 18) on Squarespace pages.

## Captured Block Structure (from Playwright traffic capture)

```json
{
  "content": {
    "value": {
      "type": 18,
      "id": "<blockId>",
      "value": {
        "raw": "<serialized menu text>",
        "menus": [{ "title": null, "description": null, "sections": [{ "title": null }] }],
        "menuStyle": "classic",
        "currencySymbol": "$"
      }
    }
  },
  "layout": {
    "desktop": { "start": { "x": 1, "y": <calculated> }, "end": { "x": 13, "y": <calculated> }, "visible": true, "verticalAlignment": "top", "zIndex": <next> },
    "mobile": { "start": { "x": 1, "y": <calculated> }, "end": { "x": 9, "y": <calculated> }, "visible": true, "verticalAlignment": "top", "zIndex": <next> }
  }
}
```

Key differences from other block types:
- No `containerStyles` (unlike type 1337 blocks)
- No `stickyScroll` needed (editor adds it but API works without)
- `value.raw` = Squarespace plain-text menu format (serialized from menus)
- `value.menus` = structured `MenuTab[]` (parsed from text)

## Implementation

### 1. ContentSaveClient.addMenuBlock()

File: `src/services/content-save.ts`

```ts
async addMenuBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  menuText?: string,
  options?: {
    menuStyle?: string;      // default "classic"
    currencySymbol?: string; // default "$"
    columns?: number;        // default 12
    rowHeight?: number;      // default 6
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<MenuBlockAddResult>
```

Pattern: identical to `addEmbedBlock()` — GET sections → validate → backfill → calculate position → build block → push → PUT.

Menu content handling:
- If `menuText` provided: `parseMenuText(menuText)` → `MenuTab[]`, use original text as `raw`
- If empty/omitted: 1 empty tab with 1 empty section (matches editor default)

### 2. MenuBlockAddResult type

File: `src/services/content-save-types.ts`

```ts
export interface MenuBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  sectionId?: string;
  error?: string;
}
```

### 3. MCP tool: sq_add_menu

File: `src/mcp-server/tools/blocks.ts`

```
sq_add_menu:
  siteId: string (required)
  pageSlug: string (required)
  sectionIndex: number (required)
  menuText: string (optional) — Squarespace menu format
  menuStyle: string (optional) — default "classic"
  currencySymbol: string (optional) — default "$"
  layout: { columns, offsetColumns, rowHeight, startX, endX, startY, endY } (optional)
```

Resolves `offsetColumns` at MCP layer (same as sq_add_embed).

### 4. Tests

- `content-save-menu.test.ts`: addMenuBlock() — empty, single tab, multi-tab, custom style/currency, layout options
- MCP tool tests: sq_add_menu success + error cases

## Reused Components

- `parseMenuText()` from `menu-parser.ts`
- `serializeMenu()` from `menu-parser.ts` (for raw field when structured data provided)
- `generateBlockId()` for block IDs
- `BLOCK_TYPE_MENU` constant (18)
- Grid calculation pattern from `addEmbedBlock()`
- `resolvePageIds` + `getClient` MCP wiring
