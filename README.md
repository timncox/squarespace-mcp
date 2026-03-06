# Squarespace MCP

MCP server that edits Squarespace websites via the Content Save API. Exposes ~84 tools for text, images, sections, blocks, pages, menus, forms, commerce, navigation, design, code injection, blog posts, gallery management, and more. Used from Claude Desktop.

## Setup

### Prerequisites

- Node.js 18+
- Squarespace session cookies (captured via `sq_login_browser` or browser export)
- Optional: Brave Search API key, Anthropic API key

### Install

```bash
npm install
```

### Environment

Create a `.env` file:

```env
BRAVE_API_KEY=...          # Optional: for sq_web_search
ANTHROPIC_API_KEY=sk-ant-... # Optional: for menu merge LLM
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
npm test        # Run test suite (1343 tests, 55 files)
```

## MCP Tool Categories

| Category | Count | Examples |
|----------|-------|---------|
| Text | 3 | update, patch, add text blocks |
| Sections | 7 | add blank/template, move, duplicate, edit style, dividers |
| Blocks | 7 | add button/image/video/embed/code, move, resize, swap, remove, duplicate |
| Pages | 4 | create, delete, update metadata, read page |
| Blog | 4 | create/update/list/find blog posts |
| Gallery | 3 | list/remove/reorder gallery images |
| Site-wide | 6 | navigation, settings, CSS, code injection, design, fonts/colors |
| Forms | 5 | list/create/get/update forms, add form block |
| Menu | 2 | get/update menu blocks (structured JSON) |
| Announcement Bar | 2 | get/update announcement bar |
| Map | 2 | add/update map blocks (auto-geocodes addresses) |
| Screenshot | 1 | take page screenshot |
| Web Search | 2 | search (Brave API), fetch URL |
| PDF Menu | 1 | parse PDF file into structured menu JSON |
| Images | 2 | upload single (path or URL), upload batch |
| Commerce | 8 | products CRUD, variants, images, store pages |
| Auth | 4 | login check, browser login, save session, restore session |
| Links | 1 | validate links on a page |
| Social | 3 | list/add/remove social links |

## Architecture

Pure MCP server — no web server, no orchestrator, no dashboard. Claude Desktop connects directly via stdio.

```
src/
  mcp-server/           # MCP server — ~84 tools across 15 modules
    tools/              # Tool modules (registerXxxTools pattern)
    session.ts          # Client cache + resolvePageIds
    index.ts            # Tool registration entry point
  services/             # API clients and business logic
    content-save.ts     # Content Save API client (86+ methods)
    media-upload.ts     # Image upload client
    page-id-resolver.ts # Page slug → API IDs
    menu-parser.ts      # Menu text ↔ structured JSON
    menu-merger.ts      # Menu merge (LLM + deterministic)
    brave-search.ts     # Web search via Brave API
    link-validator.ts   # HTTP link validation
    geocoding.ts        # Address → lat/long (Nominatim)
    section-catalog.ts  # Template section lookup + cache
    pdf-extractor.ts    # PDF text extraction
    design-property-extractor.ts # CSS/design value parsing + shared types
  config/               # Model IDs, section template catalog
  db/database.ts        # SQLite (page ID cache, template cache)
  utils/                # Logger (pino), errors, anthropic-client
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
npm test    # 1343 tests across 55 files
```

Tests use vitest with mocked API responses. No live Squarespace session required.

## License

Private — not for distribution.
