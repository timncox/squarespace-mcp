# Squarespace MCP — CLAUDE.md

## What This Project Is

MCP server that edits Squarespace websites via the Content Save API. Exposes ~112 tools for text, images, sections, blocks, pages, menus, forms, commerce, navigation, design, code injection, blog posts, gallery management, PDF menu parsing, section snapshots, Wayback Machine recovery, and more. Used from Claude Desktop.

## Commands

```bash
npm run mcp     # Start MCP server (tsx src/mcp-server/index.ts)
npm run build   # TypeScript compile
npm test        # vitest run (~1368 tests, 58 files)
```

## Architecture

Pure MCP server — no web server, no orchestrator, no dashboard. Claude Desktop connects directly.

Entry point: `src/mcp-server/index.ts` — registers all tools, starts stdio transport.

### Directory Structure

```
src/
  mcp-server/       # MCP server — ~90 tools across 17 modules
    tools/          # Tool modules (registerXxxTools pattern)
    session.ts      # Client cache + resolvePageIds + dynamic site discovery
    index.ts        # Tool registration entry point
  services/         # API clients and business logic
    content-save/   # Content Save API client (86+ methods, 14 domain modules)
      client.ts     # Base class, infrastructure, static helpers
      types.ts      # All type definitions
      blocks.ts     # Block add/update (image, button, video, quote, code, etc.)
      block-layout.ts # Move, resize, remove, duplicate, swap blocks
      text.ts       # Text block operations
      sections.ts   # Section add/move/duplicate/style/dividers
      pages.ts      # Page/blog CRUD
      header-footer.ts # Header and footer editing
      site.ts       # CSS, settings, navigation, social accounts
      design.ts     # Fonts, colors, template tweaks
      gallery.ts    # Gallery settings, images, section catalog
      mobile.ts     # Mobile layout and visibility
      commerce.ts   # Products, store pages, product images
      index.ts      # Barrel exports + module imports
    media-upload.ts # Image upload client
    page-id-resolver.ts # Page slug → API IDs
    menu-parser.ts  # Menu text ↔ structured JSON
    link-validator.ts # HTTP link validation
    geocoding.ts    # Address → lat/long (Nominatim)
    section-catalog.ts # Template section lookup + cache
    pdf-extractor.ts # PDF text extraction
    snapshot.ts     # Section snapshot CRUD (save/list/get/delete/dedup/cleanup)
    wayback.ts      # Wayback Machine CDX API + archived HTML extraction
    design-property-extractor.ts # CSS/design value parsing + shared types
  config/           # Model IDs, section template catalog (sites.json optional)
  db/database.ts    # SQLite (page ID cache, template cache)
  utils/            # Logger (pino), errors
data/               # Runtime SQLite database
storage/            # Session cookies, uploads, screenshots
```

### Key Files

| File | Purpose |
|------|---------|
| `src/mcp-server/index.ts` | MCP server entry — ~90 tools across 17 modules |
| `src/mcp-server/session.ts` | Client cache + `resolvePageIds` + dynamic site discovery |
| `src/services/content-save/` | Content Save API client (86+ methods across 14 modules) |
| `src/services/content-save/client.ts` | Base class, infrastructure, static helpers |
| `src/services/content-save/blocks.ts` | Block add/update (34 methods) |
| `src/services/media-upload.ts` | Image upload to Squarespace asset service |
| `src/services/page-id-resolver.ts` | Resolve page slugs to API IDs (HTML parse + DB cache) |
| `src/services/menu-parser.ts` | Menu text ↔ structured JSON |
| `src/config/section-templates.json` | Template catalog (27 templates, 8 categories) |
| `src/services/snapshot.ts` | Section snapshot service (SQLite CRUD + dedup + cleanup) |
| `src/services/wayback.ts` | Wayback Machine CDX API + HTML content extraction |
| `src/db/database.ts` | SQLite schema + migrations (21 phases) |

### Content Save API

Primary execution mechanism. Uses `PUT /api/page-sections/{pageId}/collection/{collectionId}` with read-modify-write pattern.

**Grid system**: Desktop = 24 columns (X: 1–24), `start` inclusive / `end` exclusive. Mobile auto-reflows.

**Auto-snapshots**: Every `savePageSections()` call auto-snapshots the pre-edit state (cached from `getPageSections()` via `structuredClone`). 5-minute dedup window. 7-day retention for auto-snapshots; manual snapshots kept forever. Snapshot failures never block saves.

### Auth

Session cookies from `storage/auth/sqsp-session.json`. The `sq_login_browser` tool launches headful Chromium via Playwright — user logs in, tool captures all cookies (including HTTP-only `member-session`) via `context.cookies()` and saves the session.

## Conventions

- **TypeScript** with ES modules (`"type": "module"`, `.js` extensions in imports)
- **Pino logger** — structured logging (`logger.info({ key: value }, 'message')`)
- **SQLite** via better-sqlite3 — synchronous queries, migrations in `database.ts`
- **Error handling**: `errMsg()` utility wraps unknown errors into strings
- **Database path**: `data/sqhelper.db`

## MCP Tool Development Pattern

- Every tool: Zod schema → try/catch → resolvePageIds (if page-scoped) → getClient → call method → JSON result or isError
- Site-wide tools (footer, header, settings, design, code injection, CSS, blog, nav) skip resolvePageIds
- `siteId` accepts flexible input: id, name, alias, or subdomain
- Tool naming: `sq_` prefix, snake_case
- Registration: `export function registerXxxTools(server: McpServer)` + add to `index.ts`

## Content Save Module Pattern

The `content-save/` directory uses **TypeScript prototype augmentation** to split a large class across files:
- `client.ts` defines the `ContentSaveClient` class with infrastructure methods
- Domain files (e.g., `blocks.ts`, `text.ts`) use `declare module './index.js'` to extend the interface and assign methods to `ContentSaveClient.prototype`
- `index.ts` barrel-exports the class and imports all domain modules (order matters: client first, then domain files)
- `content-save.ts` (in parent dir) re-exports everything for backward compatibility

## Testing

- `npm test` runs vitest with dist excluded
- 57 test files, ~1367 tests
- Service tests in `src/services/__tests__/`
- MCP tool tests in `src/mcp-server/__tests__/`

## Critical Gotchas

- **Squarespace PUT validates ALL blocks**: Missing `verticalAlignment`/`zIndex` causes 400. Always backfill.
- **Adding blocks must expand gridSettings.rows**: All `addBlock` methods call `updateSectionRows()`.
- **Section IDs must be 24-char hex**: `generateSectionId()` for sections, `generateBlockId()` (20-char) for blocks.
- **Blog post create-then-update**: Create endpoint ignores body/tags. Follow-up PUT sets them.
- **Page deletion uses `RemoveCollection`**: `POST /api/commondata/RemoveCollection` with `collectionId` as form data and `X-CSRF-Token` header. Moves page to trash (30-day retention). `SaveCollectionSettings` is create-only — cannot update or delete. `DELETE /api/collections/{id}` returns 404.
- **Image blocks need `definitionName` + `imageId`**: Blocks require `definitionName: "website.components.imageFluid"` (or PUT returns 500) and `imageId` (24-char hex content image record, or block renders empty). Content images created via `POST /api/uploads/images/asset-reference` with form data `assetId={uuid}&libraryId={websiteId}&recordType=2`. See `createContentImage()` in `client.ts`.
- **Stale sessions return 500, not 401**: `isLikelyAuthError()` detects this pattern.
- **MCP server stdio**: NEVER `console.log()` — corrupts JSON-RPC. Use `console.error()`.
- **Zod version**: Must use Zod 3. Zod 4 breaks `zod-to-json-schema`.
- **`member-session` cookie is HTTP-only**: `document.cookie` can't capture it. Need Playwright `context.cookies()`.
