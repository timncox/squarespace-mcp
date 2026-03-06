# Squarespace MCP — CLAUDE.md

## What This Project Is

MCP server that edits Squarespace websites via the Content Save API. Exposes ~84 tools for text, images, sections, blocks, pages, menus, forms, commerce, navigation, design, code injection, blog posts, gallery management, PDF menu parsing, and more. Used from Claude Desktop.

## Commands

```bash
npm run mcp     # Start MCP server (tsx src/mcp-server/index.ts)
npm run build   # TypeScript compile
npm test        # vitest run (~1343 tests, 55 files)
```

## Architecture

Pure MCP server — no web server, no orchestrator, no dashboard. Claude Desktop connects directly.

Entry point: `src/mcp-server/index.ts` — registers all tools, starts stdio transport.

### Directory Structure

```
src/
  mcp-server/       # MCP server — ~84 tools across 15 modules
    tools/          # Tool modules (registerXxxTools pattern)
    session.ts      # Client cache + resolvePageIds + dynamic site discovery
    index.ts        # Tool registration entry point
  services/         # API clients and business logic
    content-save.ts # Content Save API client (86+ methods)
    media-upload.ts # Image upload client
    page-id-resolver.ts # Page slug → API IDs
    menu-parser.ts  # Menu text ↔ structured JSON
    link-validator.ts # HTTP link validation
    geocoding.ts    # Address → lat/long (Nominatim)
    section-catalog.ts # Template section lookup + cache
    pdf-extractor.ts # PDF text extraction
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
| `src/mcp-server/index.ts` | MCP server entry — ~84 tools across 15 modules |
| `src/mcp-server/session.ts` | Client cache + `resolvePageIds` + dynamic site discovery |
| `src/services/content-save.ts` | Content Save API client (86+ methods) |
| `src/services/media-upload.ts` | Image upload to Squarespace asset service |
| `src/services/page-id-resolver.ts` | Resolve page slugs to API IDs (HTML parse + DB cache) |
| `src/services/menu-parser.ts` | Menu text ↔ structured JSON |
| `src/config/section-templates.json` | Template catalog (27 templates, 8 categories) |
| `src/db/database.ts` | SQLite schema + migrations |

### Content Save API

Primary execution mechanism. Uses `PUT /api/page-sections/{pageId}/collection/{collectionId}` with read-modify-write pattern.

**Grid system**: Desktop = 24 columns (X: 1–24), `start` inclusive / `end` exclusive. Mobile auto-reflows.

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

## Testing

- `npm test` runs vitest with dist excluded
- 55 test files, 1343 tests
- Service tests in `src/services/__tests__/`
- MCP tool tests in `src/mcp-server/__tests__/`

## Critical Gotchas

- **Squarespace PUT validates ALL blocks**: Missing `verticalAlignment`/`zIndex` causes 400. Always backfill.
- **Adding blocks must expand gridSettings.rows**: All `addBlock` methods call `updateSectionRows()`.
- **Section IDs must be 24-char hex**: `generateSectionId()` for sections, `generateBlockId()` (20-char) for blocks.
- **Blog post create-then-update**: Create endpoint ignores body/tags. Follow-up PUT sets them.
- **Stale sessions return 500, not 401**: `isLikelyAuthError()` detects this pattern.
- **MCP server stdio**: NEVER `console.log()` — corrupts JSON-RPC. Use `console.error()`.
- **Zod version**: Must use Zod 3. Zod 4 breaks `zod-to-json-schema`.
- **`member-session` cookie is HTTP-only**: `document.cookie` can't capture it. Need Playwright `context.cookies()`.
