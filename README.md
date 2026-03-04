# Squarespace Helper

AI agent that edits Squarespace websites based on forwarded client emails and WhatsApp messages. Clients email change requests, Tim confirms via WhatsApp or the web dashboard, and autonomous MCP agents execute edits via the Content Save API.

## How It Works

```
Client emails request → Gmail poll → Claude extracts tasks
  → Tim confirms via WhatsApp/Dashboard
  → MCP Orchestrator pipeline:
      classify → research → analyze → strategize → [approve] → execute → supervise
  → Tim gets result
```

### MCP Orchestrator Pipeline

All task execution routes through a 6-stage autonomous agent pipeline:

1. **Classifier** — Categorizes the request type and complexity
2. **Research Agent** — Web search (Brave API) + URL visits for context
3. **Site Analyst** — Screenshots the target page, analyzes layout/style/brand
4. **Content Strategist** — Drafts a structured ContentPlan with exact copy, placement, and operations
5. **Executor** — Autonomous Claude CLI agent with ~62 MCP tools wrapping the Content Save API
6. **Supervisor** — Per-operation verification with structured verdict, retries on failure

## Setup

### Prerequisites

- Node.js 18+
- Anthropic API key (Claude) — for email/task extraction
- Claude CLI (Claude Max auth) — for MCP agent execution
- Gmail API OAuth credentials
- WhatsApp Business API credentials (optional — dashboard works without it)
- Brave Search API key (for research agent)

### Install

```bash
npm install
```

### Environment

Create a `.env` file:

```env
ANTHROPIC_API_KEY=sk-ant-...
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=...
TIM_PHONE_NUMBER=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
BRAVE_API_KEY=...
PORT=3001
```

Site configuration via `sites.json` — each site needs Squarespace session cookies and optionally a Commerce API key.

### Gmail Setup

```bash
npm run setup-gmail
```

## Usage

```bash
npm run dev          # Dev server (tsx watch, port 3001)
npm run build        # TypeScript compile
npm run start        # Run compiled JS
npm run start:all    # Server + ngrok tunnel (WhatsApp webhooks)
npm run cli          # CLI tool for manual task submission
npm run test         # Run test suite (~1527 tests)
```

### MCP Server

The MCP server exposes ~62 tools for editing Squarespace sites. It can be used standalone with Claude Desktop or any MCP-compatible client:

```bash
npx tsc --noCheck    # Must compile before use
```

Configure in Claude Desktop's `claude_desktop_config.json` pointing to `dist/src/mcp-server/index.js`.

### Dashboard

`http://localhost:3001/dashboard` — 5 tabs:

- **Tasks** — Task list with status filter, retry failed tasks
- **Clients** — Client/site management
- **Agents** — Live agent activity monitor with SSE event history
- **Learnings** — Patterns extracted from past executions
- **Chat** — Chat interface for submitting requests directly

### Conversation Flow

```
idle → awaiting_confirm → executing → completed
                        → rejected
                        → clarifying → awaiting_confirm
                        → planning → awaiting_plan_approval → executing
```

## Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js + TypeScript (ES modules) |
| Server | Fastify |
| AI | Claude (Sonnet for reasoning, Haiku for classification) |
| Agent Execution | Claude CLI with MCP tools |
| Database | SQLite via better-sqlite3 |
| Logging | Pino (structured JSON) |

### Directory Structure

```
src/
  index.ts                       # Entry point: Fastify server + Gmail polling
  agents/                        # Shared agent types (ContentPlan, ContentOperation, etc.)
  config/                        # Model IDs, section templates
  db/                            # SQLite schema + migrations + CRUD
  routes/                        # Fastify routes (dashboard, webhooks, health)
  mcp-server/                    # MCP server — ~62 tools across 13 modules
    tools/                       # Tool modules (text, section, blocks, pages, site,
                                 #   content, screenshot, web-search, forms,
                                 #   divider, links, gmail, commerce)
    session.ts                   # Client cache + resolvePageIds
    index.ts                     # Tool registration entry point
  orchestrator/                  # MCP agent pipeline (the only execution path)
    orchestrator.ts              # 6-stage pipeline with structured planning
    cli-runner.ts                # Claude CLI spawner (stream-json NDJSON)
    prompts/                     # 6 agent prompts
  services/
    content-save.ts              # Squarespace Content Save API (86+ methods)
    page-id-resolver.ts          # Slug → page IDs with SQLite cache
    menu-parser.ts               # Menu text ↔ structured JSON
    menu-merger.ts               # Menu merge (LLM + deterministic)
    media-upload.ts              # Image upload to Squarespace
    gmail.ts                     # Gmail API integration
    whatsapp.ts                  # WhatsApp Cloud API
    conversation/                # Conversation sub-modules
scripts/
data/                            # SQLite database (sqhelper.db)
storage/                         # Runtime data (uploads/, screenshots/)
```

## Content Save API

The API client (`ContentSaveClient` in `src/services/content-save.ts`) provides 86+ methods for editing Squarespace pages without a browser. Uses a read-modify-write pattern: GET page sections → modify JSON in memory → PUT back.

### Authentication

- Session cookies stored per-site in `sites.json`
- Crumb token extracted from site-specific cookies
- Sessions work 90+ hours, warn after 24h
- Pre-flight check: `ContentSaveClient.checkSessionHealth()`

### MCP Tool Categories

| Category | Tools | Examples |
|----------|-------|---------|
| Text | 3 | update, patch, add text blocks |
| Sections | 7 | add blank/template, move, duplicate, edit style, dividers |
| Blocks | 6 | add button/image/video/embed/code, move, resize, swap, remove, duplicate |
| Pages | 4 | create, delete, update metadata, read page |
| Blog | 4 | create/update/list/find blog posts |
| Gallery | 3 | list/remove/reorder gallery images |
| Site-wide | 6 | navigation, settings, CSS, code injection, design, fonts/colors |
| Forms | 1 | update form block settings |
| Menu | 1 | update menu block (structured JSON merge) |
| Screenshot | 1 | take page screenshot |
| Web Search | 2 | search (Brave API), fetch URL |
| Gmail | 6 | list/read emails, process, download attachments, parse PDF menus |
| Commerce | 8 | products CRUD, images, store pages |
| Auth | 2 | login check, save session |

### Grid System

- 24-column desktop grid (X: 1-24, start inclusive / end exclusive)
- Mobile auto-reflows — only desktop coordinates are modified

### Commerce API

Separate REST API from Content Save — uses Bearer token auth with manually generated API keys. Supports product CRUD, image management, and store page creation via internal API.

## Testing

```bash
npm run test    # Full suite (~1527 tests, 58 files)
```

Tests use vitest with mocked API responses. No live Squarespace session required.

## License

Private — not for distribution.
