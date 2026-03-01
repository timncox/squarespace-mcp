# Squarespace Helper — CLAUDE.md

## What This Project Is

AI agent that edits Squarespace websites based on forwarded client emails and WhatsApp messages. Tim forwards emails from clients, the system extracts tasks, Tim confirms via WhatsApp (or the dashboard), and a browser agent executes edits on Squarespace using Playwright.

## Commands

```bash
npm run dev          # Start dev server (tsx watch)
npm run build        # TypeScript compile
npm run start        # Run compiled JS (node dist/src/index.js)
npm run test         # vitest run (2487 tests)
npm run test:unit    # Parse agent action tests only
npm run cli          # CLI tool (tsx src/cli.ts)
npm run setup-gmail  # Gmail OAuth setup
npm run start:all    # Server + ngrok tunnel
```

## Architecture

Entry point: `src/index.ts` — starts Fastify server + Gmail polling loop (60s interval).

### Core Flow

1. **Email arrives** → Gmail API poll → `email-processor.ts` parses + extracts tasks via Claude
2. **Tasks created** → `conversation-handler.ts` sends summary to Tim via WhatsApp
3. **Tim confirms** → conversation state machine routes to handler
4. **Content pipeline** (for complex tasks): Research Agent → Site Analyst → Page Structure (API) → Template Discovery → Content Strategist → ContentPlan
5. **Browser agent** executes edits on Squarespace via Playwright
6. **Supervisor agent** verifies result, retries on failure
7. **Learning agent** extracts patterns from execution for future runs

### Directory Structure

```
src/
  agents/           # Multi-agent pipeline (coordinator, research, site-analyst, content-strategist, supervisor, learning)
  automation/       # Browser agent core (browser-agent.ts is the main loop)
    actions/        # Modular action handlers (6 specialized modules + types + utils)
    __tests__/      # Parse action + compound action tests
  config/           # Model IDs (models.ts)
  db/               # SQLite via better-sqlite3 (database.ts has migrations)
  models/           # TypeScript interfaces (task.ts, conversation.ts, site-config.ts)
  routes/           # Fastify routes (dashboard, webhooks, screenshots, health)
  services/         # Business logic (whatsapp, gmail, email-processor, conversation-handler, file-manager)
    conversation/   # Conversation sub-modules (message-handlers, execution, planning, helpers)
  utils/            # Logger (pino), screenshot, errors, retry, anthropic-client
scripts/            # Dev/debug scripts
data/               # Runtime SQLite database (data/sqhelper.db)
storage/            # Runtime data (uploads/, screenshots/) — not committed
```

### Key Files

| File | Purpose |
|------|---------|
| `src/automation/browser-agent.ts` | Core agent loop: screenshot → Claude → action → repeat |
| `src/automation/browser-agent-actions.ts` | Thin dispatcher (~230 lines) routing actions to handler modules |
| `src/automation/actions/` | 6 specialized handler modules (see below) |
| `src/automation/actions/types.ts` | `AgentAction` discriminated union (48 action types) + `ActionResult` |
| `src/automation/browser-agent-prompt.ts` | System prompt + step messages for the browser agent |
| `src/automation/browser-agent-rescue.ts` | Stuck detection + rescue hints + dynamic doc lookup |
| `src/services/conversation-handler.ts` | Message router — delegates to conversation sub-modules |
| `src/services/conversation/execution.ts` | Task execution (single, batched, multi-site, blank_api, template fast path, two-pass) |
| `src/services/conversation/message-handlers.ts` | Conversation message routing |
| `src/services/conversation/planning.ts` | Content planning logic |
| `src/services/conversation/helpers.ts` | Shared utilities (buildTaskDescription, describeTask, diagnoseFailure) |
| `src/services/dashboard-events.ts` | SSE event bus (EventEmitter singleton) |
| `src/agents/coordinator.ts` | Content pipeline orchestrator |
| `src/agents/supervisor-agent.ts` | Verification + retry logic |
| `src/agents/learning-agent.ts` | Pattern extraction from executions |
| `src/agents/content-strategist-agent.ts` | Generates ContentPlan with template indexes + blank_api routing + page structure context + discovered templates |
| `src/agents/types.ts` | Shared agent types (ContentPlan, ContentOperation, ContentSpec, SupervisorVerdict, PageStructure, ResearchSynthesis) |
| `src/services/template-discovery.ts` | Template probing + 7-day SQLite cache |
| `src/services/content-validator.ts` | Post-operation validation via API snapshot comparison |
| `src/db/plan-operations.ts` | CRUD for granular per-operation tracking (plan_operations table) |
| `src/config/section-templates.json` | Template catalog (27 templates, 8 categories) with placeholder patterns |
| `src/services/content-save.ts` | Content Save API client (text/image/block/section/menu manipulation) |
| `src/services/menu-parser.ts` | Menu block text ↔ structured JSON (`parseMenuText`, `serializeMenu`) |
| `src/services/menu-merger.ts` | Menu merge: LLM (`mergeMenuContent`) + deterministic (`mergeMenuStructured`, `mergeMenuFromText`) |
| `src/services/whatsapp.ts` | WhatsApp Cloud API + dashboard SSE bridge |
| `src/routes/dashboard.ts` | Dashboard UI + SSE + chat endpoints |
| `src/db/database.ts` | SQLite schema + migrations (DB path: `data/sqhelper.db`) |
| `src/config/models.ts` | Claude model IDs (Sonnet for reasoning, Haiku for fast tasks) |

### Action Handler Modules

The browser agent actions were refactored from a single 7,490-line file into a dispatcher + 6 specialized modules:

| Module | Actions |
|--------|---------|
| `basic-handlers.ts` | click, hover, type, fill, press, scroll, wait, navigate, uploadFile, findText, exitFooter |
| `text-editing-handlers.ts` | editTextBlock, formatTextBlock, editButtonBlock, editMenuBlock, editQuoteBlock, editCodeBlock |
| `block-management-handlers.ts` | addBlockToSection, removeBlock, moveBlockInSection, resizeBlock |
| `section-management-handlers.ts` | addSection, addSectionFromTemplate, enterSectionEditMode, moveSection, editSectionStyle |
| `image-handlers.ts` | replaceImage, addImageBlock |
| `page-management-handlers.ts` | createPage (pageType?: 'page'\|'blog'), deletePage, switchPage, editPageSEO, editCustomCSS, createBlogPost |

Support files: `handler-utils.ts` (shared utils), `parse-action.ts` (JSON parser), `types.ts` (type definitions).

### Template Selection

`addSection` and `addSectionFromTemplate` support `templateIndex` (0-based) for positional selection in the template grid, which is more reliable than text-based matching. Text-based matching (`:has-text()`) is the fallback.

Post-add verification detects wrong templates (e.g., product/store blocks on non-product sections) and fails fast.

### Page Structure for Content Strategist

During the content pipeline (Step 2b), after the site analyst screenshots the page but before closing the browser, `fetchPageStructure()` in `coordinator.ts` extracts the `data-page-sections` attribute from the editor DOM and calls `ContentSaveClient.getPageSections()` to get the actual section/block JSON. `summarizePageSections()` (a pure, testable function) transforms this into a clean `PageStructure` summary with section names, block types, text snippets (first 100 chars), and image alt texts. This is passed to the content strategist as `pageStructures` (keyed by `siteId:targetPage`).

The strategist prompt renders this under "## Current Page Structure (from API -- precise data)" and instructs the LLM to: reference existing sections by position/content for placement, avoid duplicating existing content, and make precise "add after section N" decisions. Falls back gracefully to screenshot-only analysis if the API call fails (session expired, no iframe, etc.).

Types: `PageStructure`, `SectionSummary`, `BlockSummary` in `src/agents/types.ts`. Tests: `src/agents/__tests__/page-structure.test.ts` (13 tests).

### Enhanced Research Agent

`src/agents/research-agent.ts` uses a 4-phase pipeline: LLM-generated queries → parallel web search → URL extraction → structured synthesis. Produces `ResearchSynthesis` (in `types.ts`) with structured findings, key themes, and source attributions. The coordinator passes this to the content strategist for richer content generation.

### Dynamic Template Discovery

`src/services/template-discovery.ts` probes the live Squarespace editor to discover actual template names/positions in each category. Results are cached in SQLite (`template_cache` table, Phase 13 migration) with 7-day TTL. The coordinator runs discovery as Step 2c (after page structure), and passes `discoveredTemplates` to the content strategist. `validatePlanTemplateIndexes()` in `execution.ts` cross-checks plan template indexes against cached data before execution.

### Template Catalog & Smart Routing

`src/config/section-templates.json` contains 27 templates across 8 categories (Intro, About, Team, Contact, Services, Products, FAQs, Images) with placeholder text patterns and layout descriptions. Types in `src/config/section-templates-types.ts`. The content strategist prompt dynamically renders the catalog via `formatCatalogForPrompt()`.

The content strategist chooses a `contentStrategy` per operation:
- **`template`**: Standard layouts (About, Contact, Team) — adds template, replaces placeholders
- **`blank_api`**: Text-heavy content (CV, testimonials, long-form) — adds blank section, populates via API
- **`manual`**: Custom layouts, interactive elements — full browser agent control

`ContentSpec` includes `contentStrategy`, `apiBlocks` (HTML blocks for blank_api), `templateIndex` (for template selection), and `replacements` (structured text/button/image replacements for templates).

### Content Save API Fast Paths

Several browser agent actions try the Content Save API first (~100-500ms) before falling back to UI automation. The API uses `PUT /api/page-sections/{pageId}/collection/{collectionId}` with a read-modify-write pattern: GET sections JSON → modify in memory → PUT back. API fast paths require saved editor state — `handleAddSection` saves automatically (Step 5), and `executeBatchedPlan` saves between batches.

| Action | API Method | Fallback |
|--------|-----------|----------|
| `editTextBlock` | `ContentSaveClient.updateTextBlock()` | 10-step UI automation |
| `moveBlockInSection` | `ContentSaveClient.moveBlock()` — shifts desktop grid coordinates | Arrow keys / drag handle |
| `resizeBlock` | `ContentSaveClient.resizeBlock()` — adjusts grid end coordinates | Drag edge handles |
| `removeBlock` | `ContentSaveClient.removeBlock()` — splices block from gridContents | 6-step UI compound action |
| `moveSectionUp/Down` | `ContentSaveClient.moveSection()` — reorders sections array | Section toolbar arrows |
| `replaceImage` / `addImageBlock` | `ContentSaveClient.updateImageBlock()` — updates title/description/subtitle/altText | UI automation (7-step compound) |
| `editMenuBlock` | `ContentSaveClient.updateMenuBlock()` — structured JSON read-modify-write on type 18 blocks | 8-step UI automation (select-all/replace) |

Block finding uses `ContentSaveClient.findBlock()` — a generalized finder that searches text blocks (stripped HTML), image blocks (title/description), menu blocks (type 18: raw text, tab/section/item titles), blocks with `value.text`/`value.label`, and block ID prefix fallback.

Grid system: Desktop = 24 columns (X: 1–24), `start` inclusive / `end` exclusive. `gridSettings.breakpointSettings.desktop.columns` provides the max. Mobile auto-reflows — only desktop coordinates are modified.

Additional methods: `swapBlocks()` exchanges two blocks' full layout objects (desktop + mobile + zIndex) in a single GET + PUT. `removeBlock()` splices a block from its section's gridContents array. `moveSection()` reorders sections by splicing/inserting in the sections array (boundary-safe: returns success with oldIndex === newIndex at edges). `updateImageBlock()` updates image block metadata (title, description, subtitle, altText, linkTo) via read-modify-write. `addTextBlock()` adds a new text block to a section via API (generates block ID, calculates grid position with configurable `gapRows`/`rowHeight` spacing, includes `verticalAlignment` and `zIndex` fields, backfills missing fields on existing blocks before PUT).

**Block spacing**: `addTextBlock()` accepts `layout.gapRows` (default 2 for non-first blocks, 0 for first) and `layout.rowHeight` (default 3). Content strategist outputs layout hints per `apiBlock`. Section styling (`sectionPadding`, `blockSpacing`, `sectionTheme`) applied after both blank_api and template operations.

### Menu Block API

Menu blocks are **type 18** in Squarespace's Fluid Engine. Their JSON structure: `{ menus: MenuTab[], raw: string, menuStyle: number, currencySymbol: string }` stored in `fluidEngineContext.gridContents[].content.value.value`.

**Parser** (`src/services/menu-parser.ts`): `parseMenuText(text)` converts plain-text menu format (tabs with `========`, sections with `-------`, items with `$price`) into structured `MenuTab[]`. `serializeMenu(menus)` is the inverse. Types: `MenuTab`, `MenuSection`, `MenuItem`.

**API methods** on `ContentSaveClient`:
- `findMenuBlock(sections, searchText)` — wraps `findBlock()` with type 18 filter, returns `menuValue`
- `getMenuBlock(pageSectionsId, searchText)` — read-only, returns current menus/menuStyle/currencySymbol
- `updateMenuBlock(pageSectionsId, collectionId, searchText, newMenus, options?)` — read-modify-write, regenerates `raw` via `serializeMenu()`, preserves unknown fields via spread. Supports `{ preserveRaw: true }` option.

**Structured merge** (`src/services/menu-merger.ts`): `mergeMenuStructured(current, updates)` matches tabs/sections/items by title (case-insensitive exact match), appends unmatched entries, overrides non-null update values. `mergeMenuFromText(currentMenus, updateText)` convenience wrapper. Existing LLM-based `mergeMenuContent()` unchanged (fallback for fuzzy cases).

**Wiring**: `tryMenuBlockApi()` in `handler-utils.ts` extracts IDs from DOM, reads current menu, merge or replace via parser/merger, writes back. `handleEditMenuBlock()` calls it as a fast path before the 8-step UI automation.

Tests: `menu-parser.test.ts` (45), `content-save-menu.test.ts` (24), `menu-merger.test.ts` (36).

### Blank+API Execution Path

For text-heavy content (CV pages, long-form sections, 3+ text blocks), the content strategist can choose `contentStrategy: 'blank_api'` instead of template-based editing. Execution in `executeBlankApiOperation()`:

1. **Add blank section** via `handleAddSection()` (direct UI handler call, ~5s)
2. **Save editor state** via `saveChanges(page)` to persist section to server
3. **Try addTextBlock API** for each `apiBlock` in the operation
4. **Fallback** (if API returns 500): `enterSectionEditMode` → `addBlockToSection("Text")` via UI → `fillLastTextBlockInSection()` via API to replace placeholder content

Smart routing in `executeTasksWithPlan()` separates `blank_api` ops from `template`/`manual` ops. If the plan includes `create_page`, blank_api ops are deferred until after page creation completes.

**Known issue**: `addTextBlock` API may return 500 when adding blocks to newly-created sections. The UI+API fallback handles this by letting Squarespace create blocks through its normal UI flow (server-assigned IDs), then filling content via `updateTextBlock`.

### Template Fast Path

For operations with `contentStrategy: 'template'` + structured `replacements` + `templateCategory`, `executeTasksWithPlan()` routes directly to `executeTemplateOperation()` in `execution.ts`, bypassing the browser agent entirely (~30s vs ~60-180s).

**`ContentSpec.replacements`** maps 1:1 to the `addSectionFromTemplate` action's replacements param:
```typescript
replacements?: {
  texts?: Array<{ searchText: string; newText: string }>;
  buttons?: Array<{ searchText: string; newLabel?: string; url?: string }>;
  images?: Array<{ searchText: string; imagePath: string; altText?: string }>;
  removeBlocks?: string[];  // button/block text to remove
};
```

**Execution flow** (save-first pattern):
1. **Add template section** via `handleAddSection()` (UI, ~5s)
2. **Save editor state** via `saveChanges(page)` — critical: API can't see sections until saved
3. **Re-enter edit mode** if save exited it
4. **Replace text blocks** via `ContentSaveClient.updateTextBlock()` for each `texts[]` entry
5. **Remove blocks** via `ContentSaveClient.removeBlock()` for each `removeBlocks[]` entry
6. **Apply section styling** via `handleEditSectionStyle()` if style props present

**Graceful degradation**: Operations missing `replacements` or that fail during template execution stay in the plan and fall through to the browser agent.

### Two-Pass Execution

For plans with page creation or 3+ section additions, `executeTasksWithPlan()` uses two-pass execution (`TWO_PASS_SECTION_THRESHOLD = 3`). This is checked FIRST, before template validation and batching gates.

**Pass 1 (Structural)**: Creates pages and adds all sections (blank + template) without content. Saves editor state after all structural work to persist sections to the server.

**Pass 2 (Content)**: Fills content into the now-persistent sections via Content Save API (`executeContentOnlyTemplate()` and `executeContentOnlyBlankApi()`).

Split logic: `splitOperationsIntoPasses()` separates structural (section/page creation) from content (text/image replacement) operations. `shouldUseTwoPass()` checks if the plan qualifies. **Adding a new structural op type** requires updating 4 places: `splitOperationsIntoPasses` (structural branch), the pass 1 loop in `executeTwoPassPlan`, `shouldUseTwoPass`, and both `hasPageCreation` gates in the blank_api and template fast paths.

### Granular Operation Tracking

`src/db/plan-operations.ts` provides per-operation status tracking persisted to SQLite (`plan_operations` table, Phase 14 migration). `createPlanOperations()` creates a `PlanOperation` row for each `ContentOperation` in the plan. `updateOperationStatus()` transitions individual operations through `pending → executing → succeeded/failed`.

Tracked operations are threaded through `executeTasks()`, `executeTasksWithPlan()`, and `executeBatchedPlan()` via the `trackedOps` parameter. `findTrackedOp()` helper maps `ContentOperation` objects back to their `PlanOperation` rows by index matching. Status changes emit `operation_update` SSE events to the dashboard.

### Post-Operation Content Validation

`src/services/content-validator.ts` provides API-based validation that content operations landed correctly. Uses `capturePreSnapshot()` before operations and `validateOperation()` after to compare section state.

**Integration points:**
- **blank_api path**: Captures pre-snapshot per operation, validates after each block addition, returns `validation` in result. Validation SSE events emitted per operation + summary logged.
- **Batched execution**: Captures pre-snapshot per batch, validates each operation post-batch, logs overall validation summary.
- **Inline (single task)**: Validates all plan operations after browser agent completes but before supervisor. `formatValidationForSupervisor()` formats evidence text passed to `superviseBrowserResult()`.

The supervisor agent accepts optional `validationEvidence` parameter and combines it with JSON evidence for enhanced verification confidence.

### Supervisor API Verification

The supervisor agent uses two JSON evidence sources to verify browser agent results:

1. **Content Save API** (`SupervisorApiOptions`) — uses authenticated `ContentSaveClient` to compare before/after sections via `getPageSections()`. Works on private/trial sites. Detects text changes, block additions/removals, section order changes, and image metadata changes. Tried first.
2. **SiteReader** (`SupervisorJsonOptions`) — uses public `?format=json-pretty` endpoint. Falls back to this if API evidence fails. May fail on private sites (returns 401).

Both produce `JsonVerificationEvidence` objects consumed by the same `formatJsonEvidenceForPrompt()` formatter. Before-snapshots are captured in `execution.ts` after entering edit mode but before the browser agent runs.

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
- `agent_step` — per-step browser agent progress (step number, action, screenshot)
- `agent_activity` — pipeline agent status (research started, site analyst completed, etc.)
- `message` / `buttons` / `image` — WhatsApp message forwarding
- `conversation_update` — conversation state changes
- `operation_update` — per-operation status changes (pending → executing → succeeded/failed)

**Note**: SSE events are now persisted to `agent_events` SQLite table with 7-day retention. Page load hydrates from `/dashboard/agents/history`.

**Task detail page** shows:
- Real-time status badge updates
- Agent Activity card (pipeline agents: research, site analyst, content strategist, etc.)
- Browser Agent progress card (step counter, progress bar, live screenshots, step log)

### Batched Execution

Large plans (≥6 operations) are split into batches:

```
BATCH_SIZE = 3        # operations per batch
STEPS_PER_BATCH = 40  # browser agent steps per batch
BATCH_THRESHOLD = 5   # batch when >5 operations
```

`executeBatchedPlan()` runs batches sequentially on the same page, emitting `agent_activity` and `agent_step` SSE events per batch. Each batch gets its own step budget. Editor state is saved between batches via `saveChanges(page)` so API fast paths work in subsequent batches. Post-batch validation checks that operations landed correctly.

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

Concurrent conversations are supported via `ExecutionQueue` (serial browser execution) and multi-conversation routing. Multiple conversations can be in flight simultaneously; browser execution is serialized by the queue.

## Page Navigation

`navigateToPage()` in `site-navigator.ts` normalizes homepage slug variants (`homepage`, `home-page`, `landing`, `index`, `main` → `home`) and includes fallback detection for Squarespace's home icon. Always ensure sites in `config/sites.json` have a `"home"` page entry.

## Request Interpreter

`whatsapp-request-interpreter.ts` uses an LLM prompt to classify WhatsApp messages. Key edge cases:
- **Informational questions** ("what sites do you manage?") must return zero tasks, not create editing tasks
- **Generic requests** without a site name ("update the homepage") must trigger clarification, not default to any site
- **Conversational messages** ("thanks", "hi") return zero tasks

## Image Upload

Three browser agent actions handle image uploads to Squarespace:

1. **`uploadFile`** — Generic: `setInputFiles()` on a `<input type="file">` selector
2. **`replaceImage`** — 7-step compound action: find image by alt/text → click section → edit mode → click image → upload via file input → set alt text → close
3. **`addImageBlock`** — 7-step compound action: verify edit mode → ADD BLOCK → search "Image" → open editor → upload via file input → set alt text → close

All use Playwright's `page.setInputFiles()` with absolute file paths from `storage/uploads/`.

Upload strategies (fallback chain):
- Strategy A: Find `input[type="file"]` directly
- Strategy B: Click Replace/Upload button, then find `input[type="file"]`

## Environment

- `.env` file for secrets (ANTHROPIC_API_KEY, WhatsApp tokens, Gmail OAuth)
- Anthropic API via `claude-code-proxy` on `localhost:42069` (OAuth → Claude Max subscription)
- `data/` directory for SQLite database
- `storage/` directory for uploads, screenshots
- Port 3000 by default, ngrok for WhatsApp webhook tunnel

## Testing

- `vitest` for unit tests — **2164 tests** across 38+ test files
- Main test suite: `src/automation/__tests__/parse-agent-action.test.ts` (parse tests including templateIndex)
- `src/services/__tests__/content-save-add-block.test.ts` — addTextBlock tests (block ID generation, layout calculation, backfill, gapRows/rowHeight spacing)
- `src/services/__tests__/content-validator.test.ts` — content validation tests
- `src/db/__tests__/plan-operations.test.ts` — operation tracking CRUD tests
- `src/agents/__tests__/page-structure.test.ts` — page structure summarization tests
- `src/services/__tests__/menu-parser.test.ts` — menu text parser + serializer tests (45 tests)
- `src/services/__tests__/content-save-menu.test.ts` — menu block API methods tests (24 tests)
- `src/services/__tests__/menu-merger.test.ts` — menu merger (LLM + structured) tests (36 tests)
- Integration test: `src/automation/__tests__/compound-actions.integration.test.ts` (requires live browser session)
- Run: `npm run test` (integration test files show as "failed" when no browser session — this is expected)
- **Pre-existing TS errors**: `operationType` union doesn't include `'create_page'` or `'create_blog_post'`, causing TS2367 in tests and execution.ts. Workaround: cast to `string` for comparison. Server runs via `tsx watch` which ignores type errors.
