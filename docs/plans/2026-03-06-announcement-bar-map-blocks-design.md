# Announcement Bar + Map Block MCP Tools — Design

**Date**: 2026-03-06

## Overview

Add 4 new MCP tools: 2 for announcement bars (site-level setting) and 2 for map blocks (page-level block).

## Announcement Bar

### API Discovery

Announcement bar settings live inside `PUT /api/settings` under the `announcementBarSettings` field. Confirmed via Playwright network capture on Smyth Tavern (grey-yellow-hbxc).

**JSON shape:**
```json
{
  "announcementBarSettings": {
    "style": 2,
    "text": {
      "html": "<p>This is an announcement</p>",
      "raw": false
    },
    "clickthroughUrl": {
      "url": "https://google.com",
      "newWindow": false
    }
  }
}
```

- `style: 1` = disabled, `style: 2` = enabled
- `text.html` wraps content in `<p>` tags, `text.raw` always `false`
- `clickthroughUrl` is optional — `{}` means no link
- `announcementBarSettings: {}` = never configured (no announcement bar)
- Persists text/URL even when disabled (style: 1)

**Note:** Announcement bar is a paid feature (Business/Commerce plans). Free/Personal plans show an "Upgrade" button.

### MCP Tools

**`sq_get_announcement_bar`** — Read current state
- Input: `siteId`
- Reads `announcementBarSettings` from `getSettings()`
- Returns normalized: `{ enabled, text, url, newWindow }`

**`sq_update_announcement_bar`** — Update or toggle
- Input: `siteId`, optional `enabled` (bool), optional `text` (string), optional `url` (string), optional `newWindow` (bool)
- Read-modify-write via `updateSettings({ announcementBarSettings: {...} })`
- `enabled: true` → `style: 2`, `enabled: false` → `style: 1`
- `text` is plain text, tool wraps in `<p>` tags
- All params optional — only provided fields change

### Implementation

- New file: `src/mcp-server/tools/announcement-bar.ts`
- Registration: `registerAnnouncementBarTools(server)` added to `index.ts`
- No new ContentSaveClient methods — uses existing `getSettings()` + `updateSettings()`
- The tool layer handles `style ↔ enabled` translation and `<p>` wrapping

## Map Block

### API Discovery

Map blocks are type 1337 variants, discriminated by `location.mapLat` presence. Captured from live block-type-discovery run (Feb 28 2026, grey-yellow-hbxc test-page):

```json
{
  "type": 1337,
  "value": {
    "location": {
      "mapLat": 40.7207559,
      "mapLng": -74.0007613,
      "mapZoom": 12
    },
    "vSize": 12,
    "style": 2,
    "labels": true,
    "terrain": false,
    "controls": false
  }
}
```

### MCP Tools

**`sq_add_map`** — Add a map block to a section
- Input: `siteId`, `pageSlug`, `sectionIndex`, `address` (string), optional `zoom` (1-20, default 14), optional `style` (number), optional `labels` (bool, default true), optional `terrain` (bool, default false), optional layout params
- Geocodes address via Nominatim (OpenStreetMap) free API
- Creates type 1337 block via new `addMapBlock()` method

**`sq_update_map`** — Update an existing map block
- Input: `siteId`, `pageSlug`, `searchText`, optional `address`, optional `zoom`, optional `style`, optional `labels`, optional `terrain`
- If `address` provided, re-geocodes to new lat/lng
- Uses new `updateMapBlock()` method

### ContentSaveClient Methods

- `addMapBlock(psId, colId, sectionIndex, lat, lng, options?)` — same pattern as `addCodeBlock()`. Default size: 24 cols × 12 rows.
- `updateMapBlock(psId, colId, searchText, updates)` — find map block by searching for type 1337 with `location.mapLat`, update fields.
- `static buildMapBlockContent(blockId, lat, lng, options?)` — static builder for atomic section creation.

### Geocoding

- New file: `src/services/geocoding.ts`
- `geocodeAddress(address: string): Promise<{ lat: number, lng: number }>`
- Uses Nominatim (OpenStreetMap) free API: `https://nominatim.openstreetmap.org/search`
- Requires `User-Agent` header per Nominatim usage policy
- Max 1 request/second (Nominatim rate limit) — not a concern for our usage
- Returns first result; throws if no results found

### Implementation

- Map tools added to `src/mcp-server/tools/blocks.ts` (alongside other block tools)
- ContentSaveClient methods in `src/services/content-save.ts`
- Geocoding utility in `src/services/geocoding.ts`

## Testing

- Announcement bar: mock `getSettings`/`updateSettings`, test style↔enabled translation, HTML wrapping, partial updates
- Map block: mock geocoding + ContentSaveClient, test addMapBlock layout, updateMapBlock field merge, findMapBlock discrimination
- Geocoding: mock fetch, test address resolution, error handling for no results

## Files Changed

| File | Change |
|------|--------|
| `src/mcp-server/tools/announcement-bar.ts` | New — 2 tools |
| `src/mcp-server/tools/blocks.ts` | Add `sq_add_map`, `sq_update_map` |
| `src/mcp-server/index.ts` | Register announcement bar tools |
| `src/services/content-save.ts` | `addMapBlock()`, `updateMapBlock()`, `buildMapBlockContent()` |
| `src/services/geocoding.ts` | New — `geocodeAddress()` |
| `src/services/__tests__/content-save-map.test.ts` | New — map block method tests |
| `src/mcp-server/__tests__/announcement-bar-tools.test.ts` | New — announcement bar tool tests |
| `src/mcp-server/__tests__/map-tools.test.ts` | New — map tool tests |
| `src/services/__tests__/geocoding.test.ts` | New — geocoding tests |
