# Squarespace MMP Bot — Design Spec

**Date:** 2026-03-31
**Status:** Approved
**Bot handle:** `@squarespace` on MMP

## Problem

The Squarespace MCP server runs locally via stdio, requiring Claude Desktop or Claude Code. There's no way to manage Squarespace sites from a phone, another AI client, or a lightweight messaging interface. Site health issues (expired sessions, unexpected content changes) go unnoticed until something breaks.

## Solution

An MMP bot (`@squarespace`) that bridges Squarespace MCP tools to MMP messaging. Multi-user: anyone on MMP can DM the bot, link their Squarespace account via Browserbase cloud login, and manage their sites through natural language commands. Includes automated monitoring for session health and site content changes.

## Architecture

```
Express server (Railway)
├── POST /webhook/mmp     — MMP webhook handler (HMAC verified)
├── GET  /health           — health check
├── McpClient              — calls MMP tools (send, inbox)
├── SqspClient             — spawns Squarespace MCP as stdio subprocess
├── SQLite (db.ts)         — per-user sessions, site snapshots, alert prefs
└── Cron                   — session health checks + site change detection
```

### Squarespace MCP Integration

The bot spawns the Squarespace MCP server as a **stdio subprocess** per-user, the same way Claude Desktop connects to it. Each user gets isolated state via per-user environment variables:

```
SESSION_DIR=storage/users/{mmp_handle}/auth
SITES_CONFIG=storage/users/{mmp_handle}/sites.json
DB_PATH=storage/users/{mmp_handle}/sqhelper.db
```

The bot manages subprocess lifecycle: spawn on first command, reuse for subsequent commands from the same user, kill after idle timeout (5 minutes). This avoids holding hundreds of Node processes open.

**Why subprocess, not HTTP?** The Squarespace MCP is stdio-only. Rather than adding HTTP transport (separate project), we spawn `node {SQSP_MCP_PATH}` with per-user env. This matches how Claude Desktop uses it.

### MMP Integration

Same `McpClient` pattern as nyc-civic-bot and ticket-fighter-bot:
- HTTP MCP client calling MMP tools at `https://mmp.chat/mcp?token={bot_token}`
- Webhook endpoint with HMAC-SHA256 verification (`X-MMP-Signature` header)
- `mmp-send` tool for outbound messages, webhook for inbound

## Auth Flow (Browserbase Cloud Login)

1. New user DMs the bot
2. Bot replies: "Welcome! I'll help you manage your Squarespace sites. Let's connect your account."
3. Bot creates a Browserbase session via `@browserbasehq/sdk`, navigates to `https://login.squarespace.com`
4. Bot sends user the Browserbase live view URL: "Open this link and log in to Squarespace: {url}"
5. Bot polls for `member-session` cookie every 2s (same pattern as `sq_login_cloud`)
6. On detection: captures `storageState()`, saves to `storage/users/{handle}/auth/sqsp-session.json`
7. Runs `fetchAccountSites` equivalent to discover sites and capture per-site crumbs
8. DMs user: "Connected! Found 3 sites: Smyth Tavern, The Loyal, Café Altro Paradiso."
9. On timeout (5 min): "Login timed out. Send `login` to try again."

Per-user isolation: each user's session cookies, site config, and SQLite DB live in `storage/users/{mmp_handle}/`.

## Commands

### Info
| Command | Description | Squarespace MCP Tool |
|---|---|---|
| `list sites` | Show all linked sites | `sq_list_sites` |
| `list pages <site>` | Pages on a site | `sq_list_pages` |
| `read page <site> <page>` | Text content of a page | `sq_read_page` |
| `status` | Session health across all sites | `sq_login` |

### Content Management
| Command | Description | Squarespace MCP Tool |
|---|---|---|
| `update text <site> <page> <block> <text>` | Update a text block | `sq_update_text` |
| `update announcement <site> <text>` | Set announcement bar text | `sq_update_announcement_bar` |
| `add blog post <site> <title> <body>` | Create a blog post | `sq_create_blog_post` |
| `upload image <site> <url>` | Upload image from URL | `sq_upload_image` |
| `update menu <site> <page> <content>` | Update a menu block | `sq_update_menu` |
| `get css <site>` | Read custom CSS | `sq_get_design` |
| `update css <site> <css>` | Update custom CSS | `sq_update_css` |

### Navigation & Structure
| Command | Description | Squarespace MCP Tool |
|---|---|---|
| `add page <site> <title>` | Create a new page | `sq_create_page` |
| `delete page <site> <page>` | Delete a page (with confirmation) | `sq_delete_page` |

### Account Management
| Command | Description |
|---|---|
| `login` | Start Browserbase cloud login flow |
| `logout` | Remove stored session and data |
| `help` | List available commands |

### Command Parsing

The bot does **keyword pattern matching** on natural language DMs, not strict syntax parsing. Examples:

- "What pages does smyth tavern have?" → `list pages smyth-tavern`
- "Update the announcement on The Loyal to say 'Closed for private event'" → `update announcement the-loyal "Closed for private event"`
- "Is my session still working?" → `status`
- "Help" or "What can you do?" → `help`

Ambiguous messages get a clarifying reply: "I'm not sure what you mean. Send `help` to see what I can do."

## Data Model (SQLite)

```sql
CREATE TABLE users (
  mmp_handle TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  mmp_handle TEXT PRIMARY KEY REFERENCES users(mmp_handle),
  session_path TEXT NOT NULL,
  last_health_check TEXT,
  is_healthy INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE site_snapshots (
  mmp_handle TEXT NOT NULL,
  site_id TEXT NOT NULL,
  page_slug TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mmp_handle, site_id, page_slug)
);

CREATE TABLE alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mmp_handle TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Monitoring (Cron)

### Session Health — every 4 hours

For each user in `sessions`:
1. Check session file age (`stat.mtimeMs`)
2. If > 20h old: DM "Your Squarespace session expires in ~4h. Send `login` to refresh."
3. If > 24h old: DM "Session expired for {site_count} sites. Send `login` to reconnect."
4. Log alert to `alert_log` (deduplicate: don't re-alert within 4h)

### Site Change Detection — every 6 hours

For each user with a healthy session:
1. Spawn their Squarespace MCP subprocess
2. For each site, call `sq_list_pages`, then `sq_read_page` for each page
3. SHA-256 hash the page content
4. Compare against `site_snapshots`
5. If changed: DM "Page '{page}' on {site} changed since last check."
6. Update `site_snapshots` with new hash

Rate limiting: max 50 pages per user per check cycle to avoid hammering Squarespace.

## Error Handling

| Scenario | Behavior |
|---|---|
| User not logged in | Reply with login instructions |
| Session expired mid-command | "Session expired. Send `login` to reconnect." |
| Squarespace API error (500) | "Squarespace returned an error. Try again in a few minutes." |
| Invalid site/page name | "Site '{name}' not found. Send `list sites` to see your sites." |
| Browserbase session creation fails | "Cloud login unavailable right now. Try again later." |
| MCP subprocess crash | Log error, reply "Something went wrong. Try again." |
| Delete page without confirmation | "Are you sure you want to delete '{page}' on {site}? Reply `yes` to confirm." |

## Deployment

- **Project location:** `/Users/timcox/tim-os/squarespace-mmp-bot/`
- **Railway project:** new project, same pattern as other bots
- **Bot handle:** `@squarespace` on MMP
- **Docker:** Bundle compiled Squarespace MCP (`dist/`) into the image
- **Persistent volume:** `/data` for SQLite + per-user session storage

### Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Express port (default 3004) |
| `MMP_URL` | MMP server URL (default: `https://mmp.chat/mcp`) |
| `MMP_BOT_TOKEN` | Bot auth token for @squarespace |
| `WEBHOOK_SECRET` | HMAC secret for webhook verification |
| `BROWSERBASE_API_KEY` | Browserbase API key for cloud login |
| `BROWSERBASE_PROJECT_ID` | Browserbase project ID (optional) |
| `SQSP_MCP_PATH` | Path to compiled Squarespace MCP index.js |

### Dependencies

- `express` — HTTP server
- `better-sqlite3` — user/session/snapshot storage
- `node-cron` — scheduled health checks and change detection
- `@browserbasehq/sdk` — cloud browser for login flow
- `playwright-core` — CDP connection to Browserbase
- Squarespace MCP — bundled as compiled JS, spawned as subprocess

## Files

```
squarespace-mmp-bot/
├── src/
│   ├── server.ts          — Express app, webhook handler, command router
│   ├── mmp-client.ts      — HTTP MCP client for MMP (reused pattern)
│   ├── sqsp-client.ts     — Stdio subprocess manager for Squarespace MCP
│   ├── auth.ts            — Browserbase login flow for new users
│   ├── commands.ts        — Command parser + handlers
│   ├── monitor.ts         — Cron jobs: session health + site change detection
│   └── db.ts              — SQLite schema, queries, migrations
├── package.json
├── tsconfig.json
├── Dockerfile
└── README.md
```

## Out of Scope

- Web dashboard for managing sites (bot-only interface)
- Group chat support (DM-only for v1)
- Real-time Squarespace webhooks (Squarespace doesn't offer them for content changes)
- HTTP transport for the Squarespace MCP server itself
- AI-powered natural language understanding (keyword matching is sufficient for v1)
