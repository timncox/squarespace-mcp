# Video & Embed MCP Tools Design

**Date**: 2026-03-03
**Status**: Approved

## Problem

The ContentSaveClient has `addVideoBlock()`, `updateVideoBlock()`, `addEmbedBlock()`, and `updateEmbedBlock()` methods, but no MCP tools expose them. Claude Desktop and the MCP orchestrator cannot add or update video/embed blocks — forcing browser automation (10+ Playwright steps) for what should be a single API call.

## Solution

Add 4 MCP tools to `src/mcp-server/tools/blocks.ts`, following the exact same pattern as existing `sq_add_button`/`sq_add_image` tools.

### Tool 1: `sq_add_video`

Add a video block (YouTube, Vimeo, etc.) to a section.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| siteId | string | yes | Site identifier (name/alias/subdomain) |
| pageSlug | string | yes | Page URL slug |
| sectionIndex | number | yes | 0-based section index |
| videoUrl | string | yes | YouTube, Vimeo, or other video URL |
| title | string | no | Video title |
| description | string | no | Video description |
| layout | object | no | Grid placement (see Layout Object) |

Default: full-width (24 cols), 8 rows tall. Calls `client.addVideoBlock()`.

### Tool 2: `sq_update_video`

Update an existing video block's URL, title, or description.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| siteId | string | yes | |
| pageSlug | string | yes | |
| searchText | string | yes | Matches video URL, title, or description |
| videoUrl | string | no | New video URL |
| title | string | no | New title |
| description | string | no | New description |

Calls `client.updateVideoBlock()`.

### Tool 3: `sq_add_embed`

Add a raw HTML embed block (iframes, scripts, Google Maps, Calendly, etc.).

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| siteId | string | yes | |
| pageSlug | string | yes | |
| sectionIndex | number | yes | |
| html | string | no | Raw HTML embed code — blank placeholder if omitted |
| layout | object | no | Grid placement (see Layout Object) |

Default: 12 cols wide, 6 rows tall. Calls `client.addEmbedBlock()`.

### Tool 4: `sq_update_embed`

Update the HTML content of an existing embed block.

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| siteId | string | yes | |
| pageSlug | string | yes | |
| searchText | string | yes | Block ID or content match |
| html | string | yes | New HTML embed code |

Calls `client.updateEmbedBlock()`.

### Layout Object

Shared by `sq_add_video` and `sq_add_embed`:

```typescript
{
  columns?: number;        // Grid columns to span (default: 24 for video, 12 for embed)
  offsetColumns?: number;  // Push block right by N columns (startX = offset + 1)
  rowHeight?: number;      // Rows tall (default: 8 for video, 6 for embed)
  startX?: number;         // Absolute grid start X (overrides columns/offset)
  endX?: number;           // Absolute grid end X
  startY?: number;         // Absolute grid start Y
  endY?: number;           // Absolute grid end Y
}
```

`offsetColumns` is a convenience: `{ columns: 12, offsetColumns: 12 }` places a half-width block on the right side (startX=13, endX=25).

If `startX`/`endX` are provided, they override `columns`/`offsetColumns`.

### Implementation Notes

- All tools registered in `blocks.ts` alongside existing 10 tools
- `offsetColumns` resolved to `startX` before passing to ContentSaveClient (the client already accepts startX/endX)
- Tests in `src/mcp-server/__tests__/blocks-video-embed.test.ts` — mock `../session.js`, success + error per tool
- Update `index.ts` instructions/prompt with new tool descriptions
