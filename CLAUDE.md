# Squarespace Helper — CLAUDE.md

## What This Project Is

AI agent that edits Squarespace websites based on forwarded client emails and WhatsApp messages. Tim forwards emails from clients, the system extracts tasks, Tim confirms via WhatsApp (or the dashboard), and autonomous MCP agents execute edits via the Content Save API.

## Commands

```bash
npm run dev          # Start dev server (tsx watch)
npm run build        # TypeScript compile
npm run start        # Run compiled JS (node dist/src/index.js)
npm run test         # vitest run (~1527 tests, 58 files)
npm run test:unit    # Parse agent action tests only
npm run cli          # CLI tool (tsx src/cli.ts)
npm run setup-gmail  # Gmail OAuth setup
npm run start:all    # Server + ngrok tunnel
```

## Architecture

Entry point: `src/index.ts` — starts Fastify server + Gmail polling loop (60s interval).

All task execution routes through the **MCP orchestrator** — autonomous Claude CLI agents backed by ~40 MCP tools wrapping the Content Save API. No browser agent or legacy pipeline.

- **MCP server** (`src/mcp-server/`) wraps ContentSaveClient as ~63 tools
- **Autonomous Claude CLI agents** spawned via `claude -p --mcp-config --output-format stream-json`
- **Orchestrator** (`src/orchestrator/`) runs the full pipeline: classify → research → analyze → strategize → [approve] → execute → supervise
- **Self-improving loop**: browser fallbacks logged → dashboard → new API tools created

**MCP setup**: `mcp-config.json` points to `dist/src/mcp-server/index.js` (compiled JS). Must run `npx tsc --noCheck` before starting (type errors in other files block normal `npm run build`).

### Core Flow

1. **Email arrives** → Gmail API poll → `email-processor.ts` parses + extracts tasks via Claude
2. **Tasks created** → `conversation-handler.ts` sends summary to Tim via WhatsApp
3. **Tim confirms** → conversation state machine routes to `executeTasks()`
4. **MCP Orchestrator pipeline**: classify → research (web search) → analyze (site snapshot) → strategize (structured ContentPlan) → [plan approval if configured] → execute (MCP tools) → supervise (verify result)
5. All edits via Content Save API through MCP tools (~68 tools)

### Directory Structure

```
src/
  agents/           # Shared agent types (ContentPlan, ContentOperation, SupervisorVerdict, etc.)
  config/           # Model IDs (models.ts), section templates
  db/               # SQLite via better-sqlite3 (database.ts has migrations)
  models/           # TypeScript interfaces (task.ts, conversation.ts, site-config.ts)
  routes/           # Fastify routes (dashboard, webhooks, screenshots, health)
  services/         # Business logic (whatsapp, gmail, email-processor, conversation-handler, content-save)
    conversation/   # Conversation sub-modules (message-handlers, execution, helpers)
  mcp-server/       # MCP server — ~68 tools across 13 modules (text, section, blocks, pages, site, content, screenshot, web-search, forms, divider, links, gmail, commerce)
    tools/          # Tool modules (registerXxxTools pattern)
    session.ts      # Client cache + resolvePageIds (shared by all tools)
    index.ts        # Tool registration entry point
  orchestrator/     # MCP agent pipeline (the only execution path)
    orchestrator.ts # 6-stage: classify → research → analyze → strategize → execute → supervise
    cli-runner.ts   # Claude CLI spawner (stream-json NDJSON)
    fallback-tracker.ts # Browser fallback logging to SQLite
    prompts/        # 6 agent prompts (executor, supervisor, classifier, researcher, analyst, strategist)
  utils/            # Logger (pino), screenshot, errors, retry, anthropic-client
  archive/          # Old browser agent, pipeline agents, fast paths — kept for reference
scripts/            # Dev/debug scripts
data/               # Runtime SQLite database (data/sqhelper.db)
storage/            # Runtime data (uploads/, screenshots/) — not committed
```

### Key Files

| File | Purpose |
|------|---------|
| `src/orchestrator/orchestrator.ts` | MCP orchestrator — 6-stage pipeline with structured planning, per-operation tracking, and SSE events |
| `src/orchestrator/cli-runner.ts` | Claude CLI spawner (stream-json NDJSON parsing) |
| `src/orchestrator/prompts/` | 6 agent prompts (executor, supervisor, classifier, researcher, analyst, strategist) |
| `src/mcp-server/index.ts` | MCP server — ~68 tools registration entry point |
| `src/mcp-server/tools/web-search.ts` | Web search MCP tools (`sq_web_search`, `sq_fetch_url`) |
| `src/mcp-server/tools/gmail.ts` | Gmail MCP tools (`sq_list_emails`, `sq_read_email`, `sq_process_email`, `sq_download_attachment`, `sq_list_processed_emails`, `sq_parse_pdf_menu`) |
| `src/mcp-server/tools/commerce.ts` | Internal commerce MCP tools (8 tools: products, images, store pages) |
| `src/mcp-server/session.ts` | Client cache + resolvePageIds (shared by all tools) |
| `src/services/internal-commerce-types.ts` | TypeScript interfaces for internal commerce API (products, variants, images) |
| `src/services/conversation-handler.ts` | Message router — delegates to conversation sub-modules |
| `src/services/conversation/execution.ts` | Task execution — routes all tasks through MCP orchestrator + multi-site expansion |
| `src/services/conversation/message-handlers.ts` | Conversation message routing (direct requests, confirmations, clarifications, plan approval) |
| `src/services/conversation/helpers.ts` | Shared utilities (buildTaskDescription, describeTask, diagnoseFailure) |
| `src/services/dashboard-events.ts` | SSE event bus (EventEmitter singleton) |
| `src/agents/types.ts` | Shared agent types (ContentPlan, ContentOperation, ContentSpec, SupervisorVerdict) |
| `src/db/plan-operations.ts` | CRUD for granular per-operation tracking (plan_operations table) |
| `src/config/section-templates.json` | Template catalog (27 templates, 8 categories) with placeholder patterns |
| `src/services/content-save.ts` | Content Save API client (86+ methods — text/image/block/section/menu/navigation/settings/code-injection/design) |
| `src/services/menu-parser.ts` | Menu block text ↔ structured JSON (`parseMenuText`, `serializeMenu`) |
| `src/services/menu-merger.ts` | Menu merge: LLM (`mergeMenuContent`) + deterministic (`mergeMenuStructured`, `mergeMenuFromText`) |
| `src/services/whatsapp.ts` | WhatsApp Cloud API + dashboard SSE bridge |
| `src/routes/dashboard.ts` | Dashboard UI + SSE + chat endpoints |
| `src/db/database.ts` | SQLite schema + migrations (DB path: `data/sqhelper.db`) |
| `src/config/models.ts` | Claude model IDs (Sonnet for reasoning, Haiku for fast tasks) |

### Content Save API

The Content Save API is the primary execution mechanism, exposed as MCP tools. Uses `PUT /api/page-sections/{pageId}/collection/{collectionId}` with a read-modify-write pattern: GET sections JSON → modify in memory → PUT back.

**Key methods on ContentSaveClient:**
- `updateTextBlock()` — update text block HTML content
- `moveBlock()` — shift desktop grid coordinates
- `resizeBlock()` — adjust grid end coordinates
- `removeBlock()` — splice block from gridContents array
- `moveSection()` — reorder sections array (boundary-safe)
- `updateImageBlock()` — update image metadata (title, description, altText, assetUrl)
- `addTextBlock()` — add new text block with grid position calculation
- `swapBlocks()` — exchange two blocks' full layout objects
- `updateMenuBlock()` — structured JSON read-modify-write on type 18 blocks
- `findBlock()` — generalized finder (text, image, menu, button blocks + ID prefix fallback)
- `addSectionWithBlocks()` — atomic section creation with pre-populated blocks (text, embed, button, image, video). Preferred over `addBlankSection()` + separate block adds.
- `addBlankSection()` — add empty section (supports position param). WARNING: subsequent block insertions may fail.

**Grid system**: Desktop = 24 columns (X: 1–24), `start` inclusive / `end` exclusive. Mobile auto-reflows — only desktop coordinates are modified.

**Blog post methods**:
- `createBlogPost(collectionId, title, options?)` — `POST /api/content/blogs/{id}/text-posts`. Options: `body`, `tags`, `excerpt`, `categories`, `slug`, `publishDate` (ISO 8601), `draft`. Uses create-then-update pattern: creates post, then calls `updateBlogPost()` to set body/tags/excerpt/categories.
- `updateBlogPost(collectionId, itemId, updates)` — `PUT /api/content/blogs/{id}/text-posts/{itemId}`. Supports: `title`, `body`, `excerpt`, `tags`, `categories`, `urlId`, `publishDate`, `draft`.
- `getCollectionItems(collectionId, options?)` — list blog posts with optional filter (published/draft/all) and limit
- `findBlogPostByTitle(collectionId, searchTitle)` — case-insensitive substring match, returns first match

**MCP blog tools**: `sq_create_blog_post`, `sq_update_blog_post`, `sq_list_blog_posts`, `sq_find_blog_post`. All accept `siteId` + `collectionId`. Create/update also accept `excerpt`, `categories`, `slug`, `publishDate` (ISO 8601).

**Gallery image management methods**:
- `removeGalleryImage(galleryCollectionId, itemId)` — `DELETE /api/content-items/{itemId}`
- `reorderGalleryImages(galleryCollectionId, itemIds)` — `POST /api/commondata/ReorderItems` (form-encoded)

**MCP gallery tools**: `sq_list_gallery_images` (discover image IDs/filenames/order), `sq_remove_gallery_image` (delete by itemId), `sq_reorder_gallery_images` (reorder by passing itemIds array). List/reorder accept `pageSlug` + optional `searchText`; remove just needs `itemId`.

**Gmail MCP tools**: `sq_list_emails` (list inbox with limit/unreadOnly), `sq_read_email` (full message + attachment metadata by messageId), `sq_process_email` (trigger task extraction pipeline), `sq_download_attachment` (save to storage/uploads/), `sq_list_processed_emails` (query email history DB with status filter), `sq_parse_pdf_menu` (download PDF → extractPdfText → parseMenuText → structured MenuTab[] or raw text fallback). Site-independent — no siteId or resolvePageIds needed.

**Site-wide methods**: `getNavigation()`, `getSettings()`, `getCodeInjection()`, `saveCodeInjection()`.

### Internal Commerce API

Commerce uses the same internal REST API as the Content Save client — session cookie auth, no separate API key. Methods live on `ContentSaveClient`.

**Product CRUD** (on ContentSaveClient):
- `createProductShell(collectionId, productType?)` — `POST /api/commerce/products/{collectionId}`. Creates hidden product with default variant.
- `getProduct(productId)` — `GET /api/commerce/products/{productId}`.
- `updateProduct(productId, updates)` — `PUT /api/commerce/products/{productId}`. Supports name, description, visibility, variants (create/update/delete), tags, categories, image ordering.
- `deleteProduct(productId)` — `DELETE /api/commerce/products/{productId}`.
- `listProducts(params?)` — `GET /api/3/commerce/products`. Optional pageSize/cursor.

**Product images** (on ContentSaveClient):
- `attachProductImage(productId, systemDataId)` — `POST /api/commerce/products/{productId}/images/asset-reference`. The `systemDataId` is the `assetId` from `MediaUploadClient`.
- `setProductThumbnail(productId, systemDataId)` — `POST /api/commerce/products/{productId}/thumbnail-image/asset-reference`.
- `updateProductImage(productId, imageId, updates)` — `PUT /api/2/commerce/products/{productId}/images/{imageId}`. Updates title, focalPoint.

**Store page creation** (on ContentSaveClient):
- `createStorePage(navPlacement?)` — copies `empty-store` template, adds to navigation. Two API calls: `POST /api/content/copy/collection/empty-store` → `POST /api/widget/UpdateNavigation`.

**MCP Commerce tools** (8 tools):
- `sq_create_store_page` — create store page on site
- `sq_create_product` — orchestrates: shell → images → update with name/price/variants
- `sq_update_product` — update product details and variants
- `sq_get_product` — get product by ID
- `sq_delete_product` — delete product
- `sq_list_products` — list products
- `sq_attach_product_image` — attach uploaded image + optionally set as thumbnail
- `sq_set_product_thumbnail` — set product thumbnail

**Key details**: All commerce endpoints use `X-CSRF-Token` header (not crumb query string). `createProductShell` creates a HIDDEN product — must `updateProduct` with `visibility: { state: 'VISIBLE' }` to publish. `memberAccountIdCache` on ContentSaveClient provides the `authorId` for image attachment.

**Design settings methods**:
- `getWebsiteFonts()` / `updateWebsiteFonts(data)` — `GET`/`PUT /api/website-fonts`
- `getWebsiteColors()` / `updateWebsiteColors(data)` — `GET`/`PUT /api/website-colors`
- `getTemplateTweakSettings()` / `setTemplateTweakSettings(updates)` — read-modify-write pattern, POST is URL-encoded
- `updateFont(fontName, updates)` — convenience: read-modify-write for a single font by name
- `updatePaletteColor(colorId, hsl)` — convenience: read-modify-write for a single palette color by ID

### Menu Block API

Menu blocks are **type 18** in Squarespace's Fluid Engine. Their JSON structure: `{ menus: MenuTab[], raw: string, menuStyle: number, currencySymbol: string }` stored in `fluidEngineContext.gridContents[].content.value.value`.

**Parser** (`src/services/menu-parser.ts`): `parseMenuText(text)` converts plain-text menu format (tabs with `========`, sections with `-------`, items with `$price`) into structured `MenuTab[]`. `serializeMenu(menus)` is the inverse. Types: `MenuTab`, `MenuSection`, `MenuItem`.

**API methods** on `ContentSaveClient`:
- `findMenuBlock(sections, searchText)` — wraps `findBlock()` with type 18 filter, returns `menuValue`
- `getMenuBlock(pageSectionsId, searchText)` — read-only, returns current menus/menuStyle/currencySymbol
- `updateMenuBlock(pageSectionsId, collectionId, searchText, newMenus, options?)` — read-modify-write, regenerates `raw` via `serializeMenu()`, preserves unknown fields via spread. Supports `{ preserveRaw: true }` option.

**Structured merge** (`src/services/menu-merger.ts`): `mergeMenuStructured(current, updates)` matches tabs/sections/items by title (case-insensitive exact match), appends unmatched entries, overrides non-null update values. `mergeMenuFromText(currentMenus, updateText)` convenience wrapper. Existing LLM-based `mergeMenuContent()` unchanged (fallback for fuzzy cases).

**Wiring**: MCP tool `sq_update_menu` reads current menu, merges or replaces via parser/merger, writes back through `ContentSaveClient.updateMenuBlock()`.

Tests: `menu-parser.test.ts` (45), `content-save-menu.test.ts` (24), `menu-merger.test.ts` (36).

### Granular Operation Tracking

`src/db/plan-operations.ts` provides per-operation status tracking persisted to SQLite (`plan_operations` table, Phase 14 migration). `createPlanOperations()` creates a `PlanOperation` row for each `ContentOperation` in the plan. `updateOperationStatus()` transitions individual operations through `pending → executing → succeeded/failed`. The orchestrator creates tracked operations and emits `operation_update` SSE events to the dashboard.

### Session Cookie Health

`ContentSaveClient.checkSessionHealth()` — static method that checks session file existence, age, staleness (>24h), and crumb token presence without creating a full client instance. Used for pre-flight checks before API operations. `getSessionAge()` instance method returns `{ ageHours, isStale, lastRefreshed }` after cookies are loaded. Both `ContentSaveClient` and `MediaUploadClient` warn if session cookies are >24h old.

### Dashboard

Server-rendered HTML with inline `<script>` tags. No frontend framework. 5 tabs: Tasks, Clients, Agents, Learnings, Chat.

**Key endpoints:**
- `GET /dashboard` — task list with status filter
- `GET /dashboard/tasks/:id` — task detail with live progress
- `POST /dashboard/tasks/:id/retry` — retry failed task
- `GET /dashboard/agents` — agent activity monitor
- `GET /dashboard/chat` — chat interface
- `GET /dashboard/events` — SSE stream for live updates
- `POST /dashboard/chat` — send chat message

**SSE Event Types** (via `dashboardEvents` EventEmitter):
- `task_update` — status changes (pending → executing → done/failed)
- `agent_activity` — MCP pipeline agent status (research started, strategist completed, etc.)
- `message` / `buttons` / `image` — WhatsApp message forwarding
- `conversation_update` — conversation state changes
- `operation_update` — per-operation status changes (pending → executing → succeeded/failed)

**Note**: SSE events are now persisted to `agent_events` SQLite table with 7-day retention. Page load hydrates from `/dashboard/agents/history`.

**Task detail page** shows:
- Real-time status badge updates
- Agent Activity card (MCP pipeline agents: research, analyst, strategist, executor, supervisor)
- Per-operation status tracking

## Conventions

- **TypeScript** with ES modules (`"type": "module"`, `.js` extensions in imports)
- **No frontend framework** — dashboard is server-rendered HTML with inline `<script>` tags
- **Dynamic imports** (`await import(...)`) to avoid circular dependencies (established pattern in whatsapp.ts, tasks.ts, conversations.ts)
- **Pino logger** — structured logging everywhere (`logger.info({ key: value }, 'message')`)
- **SQLite** via better-sqlite3 — synchronous queries, migrations in `database.ts`
- **Error handling**: `errMsg()` utility wraps unknown errors into strings
- **Models**: Sonnet (`claude-sonnet-4-20250514`) for reasoning, Haiku (`claude-haiku-4-5-20251001`) for fast/cheap tasks — defined in `src/config/models.ts`
- **Database path**: `data/sqhelper.db` (NOT `storage/`)

## Conversation State Machine

```
idle → awaiting_confirm → executing → completed
                        → rejected
                        → clarifying → awaiting_confirm
                        → planning → awaiting_plan_approval → executing
                                                             → revising → awaiting_plan_approval
                                                             → rejected
```

Sources: `email` | `whatsapp` | `dashboard`

Concurrent conversations are supported via `ExecutionQueue` and multi-conversation routing. Multiple conversations can be in flight simultaneously; execution is serialized per-site by the queue.

## Request Interpreter

`whatsapp-request-interpreter.ts` uses an LLM prompt to classify WhatsApp messages. Key edge cases:
- **Informational questions** ("what sites do you manage?") must return zero tasks, not create editing tasks
- **Generic requests** without a site name ("update the homepage") must trigger clarification, not default to any site
- **Conversational messages** ("thanks", "hi") return zero tasks

## Image Upload

Image uploads use `MediaUploadClient` to upload files to Squarespace's asset service, then `ContentSaveClient.updateImageBlock()` to set the `assetUrl` on image blocks. Source files stored in `storage/uploads/`.

## Environment

- `.env` file for secrets (ANTHROPIC_API_KEY, WhatsApp tokens, Gmail OAuth, Commerce API keys)
- Claude CLI agents use Claude Max auth directly (no API key or proxy needed)
- `data/` directory for SQLite database
- `storage/` directory for uploads, screenshots
- Port 3001 by default, ngrok for WhatsApp webhook tunnel

## Testing

- `vitest` for unit tests — **~1527 tests** across 58 test files
- `src/services/__tests__/content-save-add-block.test.ts` — addTextBlock tests (block ID generation, layout calculation, backfill, gapRows/rowHeight spacing)
- `src/db/__tests__/plan-operations.test.ts` — operation tracking CRUD tests
- `src/services/__tests__/menu-parser.test.ts` — menu text parser + serializer tests (45 tests)
- `src/services/__tests__/content-save-menu.test.ts` — menu block API methods tests (24 tests)
- `src/services/__tests__/menu-merger.test.ts` — menu merger (LLM + structured) tests (36 tests)
- `src/services/__tests__/content-save-design-nav.test.ts` — design write + navigation tests (30 tests)
- `src/orchestrator/__tests__/orchestrator.test.ts` — MCP orchestrator pipeline tests
- `src/mcp-server/__tests__/` — MCP tool registration + handler tests
- `src/services/__tests__/content-save-commerce.test.ts` — Internal commerce methods tests (10 tests)
- `src/mcp-server/__tests__/commerce-tools.test.ts` — Commerce MCP tool tests (12 tests)
- `src/mcp-server/__tests__/gmail-tools.test.ts` — Gmail MCP tools tests
- Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
- Old browser agent and pipeline tests are in `src/archive/` — excluded from test runs
- **operationType union** includes 23 types: `create_page`, `delete_page`, `update_page_metadata`, `add_section`, `add_block`, `add_gallery`, `modify_text`, `replace_image`, `remove_block`, `modify_block`, `modify_style`, `edit_footer`, `edit_css`, `reorder_sections`, `move_block`, `resize_block`, `create_blog_post`, `update_blog_post`, `edit_code_injection`, `modify_gallery_settings`, `duplicate_block`, `duplicate_section`, `swap_blocks`. Site-wide ops (footer/CSS/code-injection/blog) skip `resolvePageContext()` in the api-executor.
