# Squarespace Helper

AI agent that edits Squarespace websites based on forwarded client emails and WhatsApp messages. Clients email change requests, Tim confirms via WhatsApp or the web dashboard, and a multi-agent pipeline executes edits — via API when possible, browser automation when needed.

## How It Works

```
Client emails request → Gmail poll → Claude extracts tasks
  → Tim confirms via WhatsApp/Dashboard
  → Execution pipeline selects fastest path:
      Simple edit (~1s) → API executor (~5-30s) → Browser agent (~60-180s)
  → Supervisor verifies → Tim gets result
```

### Execution Priority

The system tries the fastest execution method first, falling back to slower ones:

1. **Simple edit** (~1s) — Direct API call for single operations (text replace, button edit, CSS change, menu update, footer edit, SEO update, etc.). 14 edit types classified by Haiku LLM.
2. **API executor** (~5-30s) — Multi-operation content plans executed entirely via Content Save API. No browser needed.
3. **Two-pass** — Structural changes (pages + sections) first, then content fill via API. Used for plans with 3+ section additions.
4. **Blank API** (~10s) — Add blank section via browser, populate with text/button/image blocks via API. Default strategy for all new section content.
5. **Batched browser** (~120s) — 3 operations per batch with browser agent, API fast paths between batches.
6. **Browser agent** (~60-180s) — Full Playwright automation for complex/custom layouts.

### Agent Pipeline

For complex content tasks, a multi-agent pipeline runs before editing:

1. **Research Agent** — Web search (Brave API) + URL visits for context
2. **Site Analyst** — Screenshots the target page, analyzes layout/style/brand
3. **Content Strategist** — Drafts a ContentPlan with exact copy, placement, and API blocks (`blank_api` for sections, `manual` for custom layouts)
4. **Browser Agent / API Executor** — Executes the plan
5. **Supervisor** — Verifies via API snapshot comparison + screenshots, retries on failure
6. **Learning Agent** — Extracts reusable patterns from execution

## Setup

### Prerequisites

- Node.js 18+
- Anthropic API key (Claude)
- Gmail API OAuth credentials
- WhatsApp Business API credentials (optional — dashboard works without it)
- Brave Search API key (for research agent)

### Install

```bash
npm install
npx playwright install chromium
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
SQUARESPACE_EMAIL=...
SQUARESPACE_PASSWORD=...
PORT=3000
```

### Gmail Setup

```bash
npm run setup-gmail
```

## Usage

```bash
npm run dev          # Dev server (tsx watch, port 3000)
npm run build        # TypeScript compile
npm run start        # Run compiled JS
npm run start:all    # Server + ngrok tunnel (WhatsApp webhooks)
npm run cli          # CLI tool for manual task submission
npm run test         # Run test suite (~1561 tests)
```

### Dashboard

`http://localhost:3000/dashboard` — 5 tabs:

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
| Browser | Playwright (Chromium) |
| Database | SQLite via better-sqlite3 |
| Logging | Pino (structured JSON) |

### Directory Structure

```
src/
  index.ts                       # Entry point: Fastify server + Gmail polling
  agents/                        # Multi-agent content pipeline
    coordinator.ts               # Pipeline orchestrator
    research-agent.ts            # Web search + synthesis
    content-strategist-agent.ts  # Content plan generation
    supervisor-agent.ts          # Result verification + retry
    types.ts                     # ContentPlan, ContentOperation, etc.
  automation/                    # Browser agent (Playwright)
    browser-agent.ts             # Core loop: screenshot → Claude → action → repeat
    actions/                     # 6 specialized handler modules (48 action types, incl. blog post creation)
  config/                        # Model IDs, layout presets, section templates
  db/                            # SQLite schema + migrations + CRUD
  routes/                        # Fastify routes (dashboard, webhooks, health)
  services/
    content-save.ts              # Squarespace Content Save API (~4500 lines)
    content-save-types.ts        # Type definitions (~500 lines)
    api-executor.ts              # Multi-operation API executor
    plan-classifier.ts           # Routes plans to API vs browser
    simple-edit-classifier.ts    # Fast path classifier (14 edit types)
    simple-edit-executor.ts      # Fast path dispatch
    page-id-resolver.ts          # Slug → page IDs with SQLite cache
    content-validator.ts         # Post-operation validation
    menu-parser.ts               # Menu text ↔ structured JSON
    media-upload.ts              # Image upload to Squarespace
    conversation/                # Conversation sub-modules
scripts/                         # Dev/debug scripts
data/                            # SQLite database (sqhelper.db)
storage/                         # Runtime data (uploads/, screenshots/, auth/)
```

## Content Save API

The API client (`ContentSaveClient` in `src/services/content-save.ts`) provides 40+ methods for editing Squarespace pages without a browser. Uses a read-modify-write pattern: GET page sections → modify JSON in memory → PUT back.

### Authentication

- Session cookies exported from a Playwright browser session (`storage/auth/sqsp-session.json`)
- Crumb token extracted from site-specific cookies
- Sessions work 90+ hours, warn after 24h
- Pre-flight check: `ContentSaveClient.checkSessionHealth()`

### Block Types

| Type | ID | Add | Update | Find By |
|------|----|-----|--------|---------|
| Text | 2 | `addTextBlock()` | `updateTextBlock()` / `patchTextBlock()` | Stripped HTML text |
| Menu | 18 | — | `updateMenuBlock()` | Raw text, tab/section/item titles |
| Code | 23 | `addCodeBlock()` | `updateCodeBlock()` | Code content |
| Quote | 44 | `addQuoteBlock()` | `updateQuoteBlock()` | Quote text / attribution |
| Button | 46 | `addButtonBlock()` | `updateButtonBlock()` | Label text |
| Video | 50 | `addVideoBlock()` | `updateVideoBlock()` | Title / URL |
| Divider | 52 | `addDividerBlock()` | `updateDividerBlock()` | — |
| Image | 1337 | `addImageBlock()` / batch | `updateImageBlock()` | Title / description / alt text |

### Other Operations

- **Section**: add blank, copy template, move, duplicate, edit style (theme/height/width/alignment/divider), reorder
- **Page**: create (blank or blog collection), delete, update metadata/SEO
- **Blog**: create blog post with title, body, publish status
- **Footer/CSS**: patch footer text, save custom CSS
- **Block management**: move, resize, swap, remove, duplicate

### Grid System

- 24-column desktop grid (X: 1–24, start inclusive / end exclusive)
- 8 named layout presets: `full-width`, `two-column`, `three-column`, `hero-wide`, `sidebar-content`, `content-sidebar`, `card-grid-2x2`, `centered-narrow`
- Mobile auto-reflows — only desktop coordinates are modified

## Testing

```bash
npm run test              # Full suite (~1561 tests, 49 files)
npm run test:unit         # Parse action tests only
npm run test:integration  # Compound action tests (requires live browser)
```

Integration tests require a live browser session and show as "failed" without one — this is expected.

## License

Private — not for distribution.
