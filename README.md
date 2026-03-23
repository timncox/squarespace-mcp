# Squarespace MCP

MCP server that edits Squarespace websites via the Content Save API. Exposes 141+ tools for text, images, sections, blocks, pages, menus, forms, commerce, navigation, design, code injection, blog posts, gallery management, PDF/image menu parsing, menu diffing, bulk operations, one-command menu import, section snapshots, Wayback Machine recovery, and more. Used from Claude Desktop or Claude Code.

## Setup

### Prerequisites

- Node.js 18+
- Squarespace session cookies (captured via `sq_login_browser` or browser export)

### Install

```bash
npm install
npm run build
```

Configure `.mcp.json` (or `claude_desktop_config.json`) with the correct paths for your system — see the Claude Desktop / Claude Code sections below.

### Environment

Create a `.env` file:

```env
# Gmail OAuth2 (optional — only needed for attachment downloads)
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret
# GMAIL_REFRESH_TOKEN=1//your-refresh-token  # optional bootstrap
```

Sites are auto-discovered from your Squarespace account after `sq_login_browser` or `sq_save_session`. Discovered sites are stored in SQLite and auto-registered in `config/sites.json` with friendly names — no manual config needed.

Session cookies are automatically captured for each discovered site. The server checks file modification times and reloads cookies/config without restart when files change on disk.

Optionally, create `config/sites.json` for custom aliases:

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
    "command": "node",
    "args": ["/path/to/squarespace-mcp/dist/src/mcp-server/index.js"],
    "env": {
      "SESSION_DIR": "/path/to/squarespace-mcp/storage/auth",
      "SITES_CONFIG": "/path/to/squarespace-mcp/config/sites.json",
      "DB_PATH": "/path/to/squarespace-mcp/data/sqhelper.db"
    }
  }
}
```

Requires a compiled build (`npm run build` first). Alternatively, use `npx tsx /path/to/squarespace-mcp/src/mcp-server/index.ts` to run from source.

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
        "SITES_CONFIG": "/path/to/squarespace-mcp/config/sites.json",
        "DB_PATH": "/path/to/squarespace-mcp/data/sqhelper.db"
      }
    }
  }
}
```

Requires a compiled build (`npm run build` first). Alternatively, use `npx tsx` as the command to run from source.

## Authentication

Session cookies stored in `storage/auth/sqsp-session.json` (Playwright storageState format). The server auto-reloads cookies when the file changes — no restart needed.

**`sq_login_browser`** (recommended) — Launches a visible Chromium browser via Playwright. User logs in manually; the tool captures all cookies (including HTTP-only `member-session`) via `context.cookies()` and saves the session automatically.

**`sq_login`** — Checks session health (file age + active API probe). Now includes **per-site cookie status** showing which sites have valid `member-session` and `crumb` cookies and which need re-auth.

**`sq_save_session`** — Accepts raw cookie JSON from manual browser export. Validates, backs up existing session, saves, and reloads clients. Detects missing site-specific cookies and returns `missingSites` with admin URLs so you know which sites to visit before re-capturing.

**`sq_restore_session`** — Recovers previous session from `.bak` backup after a bad cookie save.

### Auto-Discovery & Cookie Capture

When the server discovers sites from your Squarespace account, it automatically:
1. Fetches site-specific cookies (`member-session` + `crumb`) for each new site
2. Registers the site in `config/sites.json` with the site title and custom domain
3. Saves to SQLite for persistence across sessions

This means adding a new site to your Squarespace account "just works" — the next `sq_list_sites` call discovers it, captures cookies, and registers it.

### Gmail (Attachment Downloads)

Uses Google OAuth2 + Gmail API for downloading email attachments. Email search/read is handled by the Claude.ai Gmail MCP — this server only fills the attachment download gap.

**Setup:**
1. Create a Google Cloud project with the Gmail API enabled
2. Create an OAuth2 client (application type: **Desktop app**)
3. Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in `.env`
4. Run `sq_login_gmail` to authorize — opens your default browser for Google consent
5. Tokens auto-refresh and are stored in `storage/auth/gmail-oauth.json`

## Usage

```bash
npm run mcp     # Start MCP server (tsx src/mcp-server/index.ts)
npm run build   # TypeScript compile
npm test        # Run test suite (~1475 tests, 67 files)
```

## MCP Tool Categories

| Category | Count | Examples |
|----------|-------|---------|
| Text | 8 | read page, update/patch/format text, add text, update header/footer text |
| Sections | 6 | add blank/template, move, duplicate, edit style |
| Section Dividers | 2 | update/remove section dividers |
| Blocks | 43 | button, image, video, embed, accordion, quote, marquee, newsletter, divider, code, social links, map, audio, page link, horizontal rule, search, markdown, summary, product — add/update + move/resize/swap/remove/duplicate |
| Pages | 7 | create, delete, list, update metadata, get/update navigation, **add page to nav** |
| Blog | 7 | create/update/delete/list/find blog posts, set featured image (single + batch) |
| Gallery | 5 | list/add/remove/reorder gallery images, update gallery settings |
| Site-wide | 20 | list sites, settings, CSS, CSS patching, code injection, design, fonts/colors, color themes, social links, site identity, advanced settings, header/footer config |
| Forms | 6 | list/create/get/update forms, add/update form block |
| Menu | 6 | get/update/add menu blocks, **parse PDF menus, parse menu images, diff menus** |
| Announcement Bar | 2 | get/update announcement bar (with style passthrough) |
| Images | 2 | upload single (path, URL, or base64), upload batch |
| Commerce | 9 | products CRUD, variants, images (attach/remove/replace), store pages |
| Auth | 5 | login browser, login check (with per-site health), discover sites, save session, restore session |
| Links | 1 | validate links on a page |
| Snapshots | 4 | save/list/restore/delete section snapshots |
| Wayback | 2 | list Wayback Machine snapshots, fetch archived content |
| Gmail | 2 | browser login, download attachments |
| Orchestration | 3 | **import menu from URL, bulk operations, auto-chunk wine list** |

### New Tools (v0.3)

**Menu Intelligence:**
- **`sq_parse_pdf_menu`** — Parse a PDF menu into structured JSON. Accepts a URL or file path. Uses rule-based parsing with Claude AI fallback for complex layouts.
- **`sq_parse_menu_image`** — Extract menu items from a JPG/PNG image using Claude's vision capabilities. Handles photographed menus, scanned documents, and design-heavy menu images.
- **`sq_diff_menu`** — Compare current menu block content against new menu text. Shows added items, removed items, and price changes before applying updates.

**Navigation:**
- **`sq_add_page_to_nav`** — Add an existing page to site navigation with position control. Handles the full `resolveTemplateId` → `UpdateNavigation` flow automatically.
- **`sq_create_page`** `navigation` param — Now works correctly. Creates the page and adds it to mainNav in one call.

**Orchestration:**
- **`sq_import_menu_from_url`** — Give it a restaurant website URL and a target site. Automatically finds PDF menus, parses them, creates a page, and builds a menu block with all menus as tabs. One tool call replaces a 10-minute manual workflow.
- **`sq_bulk_operation`** — Run the same operation across multiple sites. Supports `list_pages`, `read_page`, and `update_menu` with per-site error handling.
- **`sq_auto_chunk_wine_list`** — Parse a large wine list PDF, categorize wines by type/region, select highlights, and add as a summarized menu tab. Handles 200+ bottle lists that are too large for a single menu block.

**Session Management:**
- **Auto-cookie capture** — When new sites are discovered, cookies are automatically fetched and saved. No more manual Playwright → cookie merging workflows.
- **Auto-crumb repair** — Sites added to your Squarespace account after the original login automatically get their CSRF crumb tokens captured via HTTP on the next `sq_list_sites` call. No re-login needed.
- **HTTP-based cookie capture** — `sq_login_browser` now uses fast HTTP calls to capture site-specific cookies instead of navigating Playwright to each site's `/config` page. Faster, more reliable, works for any number of sites.
- **Auto-site registration** — Discovered sites are auto-added to `sites.json` with friendly names from the Squarespace API.
- **File-change detection** — Session cookies and site config reload automatically when files change on disk. No more MCP server restarts.
- **Per-site health** — `sq_login` now shows per-site cookie status so you know exactly which sites need re-auth.
- **CONFLICT auto-retry** — On write conflicts, the server refreshes the crumb token and retries once before failing. Eliminates false conflicts from stale crumb tokens.

**Fluid Engine Text Support:**
- **Type 1337 text blocks** — `sq_read_page`, `sq_update_text`, `sq_patch_text`, `sq_update_html`, and `fillLastTextBlockInSection` now recognize text content inside type 1337 (fluid engine) blocks. Previously, only classic type 2 text blocks were searchable — newer Squarespace pages that use type 1337 for all blocks would return "No text block found" even when text was visible on the page.

## Architecture

Pure MCP server — no web server, no orchestrator, no dashboard. Claude Desktop connects directly via stdio.

```
src/
  mcp-server/           # MCP server — 141+ tools across 18 modules
    tools/              # Tool modules (registerXxxTools pattern)
    session.ts          # Client cache + resolvePageIds + dynamic site discovery
    index.ts            # Tool registration entry point
  services/             # API clients and business logic
    content-save/       # Content Save API client (100+ methods, split into domain modules)
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
    gmail.ts            # Gmail OAuth2 attachment download
  config/               # Model IDs, section template catalog
  db/database.ts        # SQLite (page ID cache, template cache, snapshots)
  utils/                # Logger (pino), errors
data/                   # Runtime SQLite database
storage/                # Session cookies, uploads, screenshots
```

### Content Save API

The API client (`ContentSaveClient`) uses a read-modify-write pattern: GET page sections → modify JSON → PUT back. Desktop grid is 24 columns (X: 1-24, start inclusive / end exclusive). Mobile auto-reflows.

Optimistic locking with automatic retry: before saving, the server re-fetches page sections and compares hashes. On conflict, it refreshes the crumb token and retries once before reporting failure.

### Key Conventions

- TypeScript with ES modules (`.js` extensions in imports)
- Pino structured logging (`logger.info({ key: value }, 'message')`)
- SQLite via better-sqlite3 (synchronous queries)
- Tool pattern: Zod schema → try/catch → resolvePageIds → getClient → call method → JSON result
- Tool naming: `sq_` prefix, snake_case
- File-change detection: session cookies and site config auto-reload via mtime checks

## Testing

```bash
npm test    # ~1475 tests across 67 files
```

Tests use vitest with mocked API responses. No live Squarespace session required.

## License

Private — not for distribution.
