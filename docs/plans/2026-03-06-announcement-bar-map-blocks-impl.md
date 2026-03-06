# Announcement Bar + Map Block — Implementation Plan

**Design doc**: `docs/plans/2026-03-06-announcement-bar-map-blocks-design.md`

## Phase 1: Announcement Bar Tools (no new client methods needed)

### Step 1: Create announcement bar MCP tools
- Create `src/mcp-server/tools/announcement-bar.ts`
- `sq_get_announcement_bar`: siteId → getSettings() → extract + normalize announcementBarSettings
  - Return `{ enabled: style === 2, text: strip <p> tags from html, url, newWindow }`
  - Handle empty `{}` case (never configured)
- `sq_update_announcement_bar`: siteId + optional enabled/text/url/newWindow
  - Read current via getSettings()
  - Merge updates: enabled→style (1/2), text→wrap in `<p>`, url+newWindow→clickthroughUrl
  - Write via updateSettings({ announcementBarSettings: merged })
- Register in `src/mcp-server/index.ts`

### Step 2: Announcement bar tests
- Create `src/mcp-server/__tests__/announcement-bar-tools.test.ts`
- Test: get when empty ({}), get when configured, update text, toggle enabled/disabled, partial update (only text, only url), clear URL

**CHECKPOINT: Run tests, verify passing**

## Phase 2: Geocoding Utility

### Step 3: Create geocoding service
- Create `src/services/geocoding.ts`
- `geocodeAddress(address: string): Promise<{ lat: number, lng: number }>`
- Fetch `https://nominatim.openstreetmap.org/search?q={encoded}&format=json&limit=1`
- Set `User-Agent: SquarespaceHelper/1.0` header
- Parse first result: `{ lat: parseFloat(result.lat), lng: parseFloat(result.lon) }`
- Throw descriptive error if no results

### Step 4: Geocoding tests
- Create `src/services/__tests__/geocoding.test.ts`
- Mock global fetch
- Test: valid address returns lat/lng, no results throws, network error handled

**CHECKPOINT: Run tests, verify passing**

## Phase 3: Map Block ContentSaveClient Methods

### Step 5: Add map block methods to ContentSaveClient
- `static buildMapBlockContent(blockId, lat, lng, options?)` — returns GridContent['content'] for type 1337 map variant
  - Value shape: `{ location: { mapLat, mapLng, mapZoom }, vSize, style, labels, terrain, controls }`
  - Defaults: zoom 14, vSize 12, style 2, labels true, terrain false, controls false
- `addMapBlock(psId, colId, sectionIndex, lat, lng, options?)` — same GET→modify→PUT pattern as addCodeBlock
  - Default size: 24 cols × 12 rows
  - Accept layout overrides (columns, rowHeight, startX, etc.)
- `updateMapBlock(psId, colId, searchText, updates)` — find type 1337 block with `location.mapLat`, update fields
  - Updates: lat/lng (location), zoom (mapZoom), style, labels, terrain
- Add `'map'` case to `buildMapBlockContent` in addSectionWithBlocks if desired (optional — can skip for now)

### Step 6: Map block ContentSaveClient tests
- Create `src/services/__tests__/content-save-map.test.ts`
- Test: buildMapBlockContent structure, addMapBlock layout calc, updateMapBlock field merge, updateMapBlock block-not-found error

**CHECKPOINT: Run tests, verify passing**

## Phase 4: Map Block MCP Tools

### Step 7: Add map MCP tools to blocks.ts
- `sq_add_map`: siteId, pageSlug, sectionIndex, address, optional zoom/style/labels/terrain/layout
  - Geocode address → lat/lng
  - resolvePageIds → addMapBlock
- `sq_update_map`: siteId, pageSlug, searchText, optional address/zoom/style/labels/terrain
  - If address provided, geocode → new lat/lng
  - resolvePageIds → updateMapBlock

### Step 8: Map MCP tool tests
- Create `src/mcp-server/__tests__/map-tools.test.ts`
- Mock session.js + geocoding.ts
- Test: add map with address, update map address, update map zoom only, geocoding failure error

**CHECKPOINT: Run full test suite**

## Phase 5: Wiring + Documentation

### Step 9: Update MCP server instructions
- Add announcement bar section to INSTRUCTIONS in index.ts
- Add map block to the "Building a New Page" section
- Update squarespace-guide prompt with new tools

### Step 10: Final verification
- Run full test suite: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
- Verify all new + existing tests pass

### Step 11: Update memory
- Update api-capabilities.md with announcement bar API shape
- Update MEMORY.md with new tool count and changes
- Update block type table in api-capabilities.md with map block
