# Squarespace MCP

MCP server that edits Squarespace websites via the Content Save API. Exposes ~110 tools for text, images, sections, blocks, pages, menus, forms, commerce, navigation, design, code injection, blog posts, gallery management, PDF menu parsing, section snapshots, Wayback Machine recovery, and more. Used from Claude Desktop or Claude Code.

## Setup

### Prerequisites

- Node.js 18+
- Squarespace session cookies (captured via `sq_login_browser` or browser export)

### Install

```bash
npm install
```

### Environment

Create a `.env` file:

```env
# No API keys required — uses Squarespace session cookies only
```

Sites are auto-discovered after `sq_login_browser` or `sq_save_session` — no manual config needed. Discovered sites are stored in SQLite and persist across sessions.

Optionally, create `config/sites.json` for custom aliases/names:

```json
{
  "clients": [
    {
      "id": "my-site",
      "name": "My Site",
      "aliases": ["mysite"],
      "site": {
        "adminUrl": "https://my-subdomain.squarespace.com",
        "customDomain": "www.mysite.com"
      }
    }
  ]
}
```

### Claude Desktop Setup

Add to `claude_desktop_config.json`:

```json
{
  "squarespace": {
    "command": "/usr/local/bin/npx",
    "args": ["tsx", "/path/to/squarespace-mcp/src/mcp-server/index.ts"],
    "env": {
      "SESSION_DIR": "/path/to/squarespace-mcp/storage/auth",
      "DB_PATH": "/path/to/squarespace-mcp/data/sqhelper.db"
    }
  }
}
```

Uses `tsx` to run TypeScript source directly — no compile step needed.

### Claude Code Setup

Add to `.mcp.json` in your project root (or `~/.claude/mcp.json` for global access):

```json
{
  "mcpServers": {
    "squarespace": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/squarespace-mcp/dist/src/mcp-server/index.js"],
      "env": {
        "SESSION_DIR": "/path/to/squarespace-mcp/storage/auth",
        "DB_PATH": "/path/to/squarespace-mcp/data/sqhelper.db"
      }
    }
  }
}
```

Requires a compiled build (`npm run build` first). Alternatively, use `npx tsx` as the command to run from source.

## Authentication

Session cookies stored in `storage/auth/sqsp-session.json` (Playwright storageState format).

**`sq_login_browser`** (recommended) — Launches a visible Chromium browser via Playwright. User logs in manually; the tool captures all cookies (including HTTP-only `member-session`) via `context.cookies()` and saves the session automatically.

**`sq_login`** — Checks session health (file age + active API probe). Returns status and login instructions if the session is missing or stale.

**`sq_save_session`** — Accepts raw cookie JSON from manual browser export. Validates, backs up existing session, saves, and reloads clients.

**`sq_restore_session`** — Recovers previous session from `.bak` backup after a bad cookie save.

## Usage

```bash
npm run mcp     # Start MCP server (tsx src/mcp-server/index.ts)
npm run build   # TypeScript compile
npm test        # Run test suite (~1367 tests, 57 files)
```

## MCP Tool Categories

| Category | Count | Examples |
|----------|-------|---------|
| Text | 8 | read page, update/patch/format text, add text, update header/footer text |
| Sections | 6 | add blank/template, move, duplicate, edit style |
| Section Dividers | 2 | update/remove section dividers |
| Blocks | 30 | button, image, video, embed, accordion, quote, marquee, newsletter, divider, code, social links, map — add/update + move/resize/swap/remove/duplicate |
| Pages | 6 | create, delete, list, update metadata, get/update navigation |
| Blog | 4 | create/update/list/find blog posts |
| Gallery | 5 | list/add/remove/reorder gallery images, update gallery settings |
| Site-wide | 15 | list sites, settings, CSS, code injection, design, fonts/colors, social links, site identity, advanced settings |
| Forms | 6 | list/create/get/update forms, add/update form block |
| Menu | 3 | get/update/add menu blocks (structured JSON) |
| Announcement Bar | 2 | get/update announcement bar |
| Screenshot | 1 | take page screenshot |
| PDF Menu | 1 | parse PDF file into structured menu JSON |
| Images | 2 | upload single (path, URL, or base64), upload batch |
| Commerce | 8 | products CRUD, variants, images, store pages |
| Auth | 4 | login check, discover sites, save session, restore session |
| Links | 1 | validate links on a page |
| Snapshots | 4 | save/list/restore/delete section snapshots |
| Wayback | 2 | list Wayback Machine snapshots, fetch archived content |
| Gmail | 2 | setup Gmail, download attachments |

## Architecture

Pure MCP server — no web server, no orchestrator, no dashboard. Claude Desktop connects directly via stdio.

```
src/
  mcp-server/           # MCP server — ~110 tools across 17 modules
    tools/              # Tool modules (registerXxxTools pattern)
    session.ts          # Client cache + resolvePageIds + dynamic site discovery
    index.ts            # Tool registration entry point
  services/             # API clients and business logic
    content-save/       # Content Save API client (86+ methods, split into domain modules)
      client.ts         # Base class, infrastructure, static helpers
      types.ts          # All type definitions
      blocks.ts         # Block add/update (image, button, video, quote, code, etc.)
      block-layout.ts   # Move, resize, remove, duplicate, swap blocks
      text.ts           # Text block operations
      sections.ts       # Section add/move/duplicate/style/dividers
      pages.ts          # Page/blog CRUD
      header-footer.ts  # Header and footer editing
      site.ts           # CSS, settings, navigation, social accounts
      design.ts         # Fonts, colors, template tweaks
      gallery.ts        # Gallery settings, images, section catalog
      mobile.ts         # Mobile layout and visibility
      commerce.ts       # Products, store pages, product images
      index.ts          # Barrel exports + module imports
    media-upload.ts     # Image upload client
    page-id-resolver.ts # Page slug → API IDs
    menu-parser.ts      # Menu text → structured JSON
    link-validator.ts   # HTTP link validation
    geocoding.ts        # Address → lat/long (Nominatim)
    section-catalog.ts  # Template section lookup + cache
    pdf-extractor.ts    # PDF text extraction
    snapshot.ts         # Section snapshot CRUD (save/list/get/delete/dedup/cleanup)
    wayback.ts          # Wayback Machine CDX API + archived HTML extraction
    design-property-extractor.ts # CSS/design value parsing + shared types
    gmail.ts            # Gmail attachment download
  config/               # Model IDs, section template catalog
  db/database.ts        # SQLite (page ID cache, template cache, snapshots)
  utils/                # Logger (pino), errors
data/                   # Runtime SQLite database
storage/                # Session cookies, uploads, screenshots
```

### Content Save API

The API client (`ContentSaveClient`) uses a read-modify-write pattern: GET page sections → modify JSON → PUT back. Desktop grid is 24 columns (X: 1-24, start inclusive / end exclusive). Mobile auto-reflows.

### Key Conventions

- TypeScript with ES modules (`.js` extensions in imports)
- Pino structured logging (`logger.info({ key: value }, 'message')`)
- SQLite via better-sqlite3 (synchronous queries)
- Tool pattern: Zod schema → try/catch → resolvePageIds → getClient → call method → JSON result
- Tool naming: `sq_` prefix, snake_case

## Testing

```bash
npm test    # ~1367 tests across 57 files
```

Tests use vitest with mocked API responses. No live Squarespace session required.

## License

Private — not for distribution.
