# MCP Phase 2 — Tools, Prompts & Orchestrator

**Date:** 2026-03-02
**Status:** Approved
**Depends on:** Phase 1 (MCP server + CLI runner + fallback tracker)

## Goal

Complete the MCP autonomous agents system: add all ~35 remaining MCP tools, write 6 agent prompts, and wire the orchestrator into the existing conversation handler behind a `USE_MCP_AGENTS` flag.

## Component 1: MCP Tools (~35 tools)

Each tool wraps ContentSaveClient methods. Tools take `siteId` + `pageSlug`, resolve IDs internally via `session.ts`. Error handling follows the existing pattern: try/catch → `{ isError: true }`.

### Tool Registry

#### Group A: Text & Formatting (extend `tools/text.ts`)

| Tool | ContentSaveClient Method | Params |
|------|-------------------------|--------|
| `sq_update_html` | `updateTextBlockHtml()` | siteId, pageSlug, searchText, html |
| `sq_patch_text` | `patchTextBlock()` | siteId, pageSlug, searchText, newText |
| `sq_format_text` | `applyFormattingToHtml()` + `updateTextBlockHtml()` | siteId, pageSlug, searchText, format (bold/italic/h1-h4/alignment) |
| `sq_add_text` | `addTextBlock()` | siteId, pageSlug, sectionIndex, html, layout? |
| `sq_update_footer_text` | `patchFooterTextBlock()` | siteId, searchText, newText |
| `sq_update_header_text` | `patchHeaderTextBlock()` | siteId, searchText, newText |

**Note:** `sq_update_text` (patch/replace) and `sq_read_page` already exist from Phase 1.

#### Group B: Block Management (new `tools/blocks.ts`)

| Tool | Method | Params |
|------|--------|--------|
| `sq_add_button` | `addButtonBlock()` | siteId, pageSlug, sectionIndex, label, url, design? |
| `sq_update_button` | `updateButtonBlock()` | siteId, pageSlug, searchText, label?, url?, design? |
| `sq_add_image` | `addImageBlock()` | siteId, pageSlug, sectionIndex, assetUrl, altText?, layout? |
| `sq_update_image` | `updateImageBlock()` | siteId, pageSlug, searchText, assetUrl?, altText?, title? |
| `sq_upload_image` | `MediaUploadClient.uploadImage()` | siteId, imageUrl (URL to fetch + upload) |
| `sq_remove_block` | `removeBlock()` | siteId, pageSlug, searchText |
| `sq_move_block` | `moveBlock()` | siteId, pageSlug, searchText, direction, gridSteps? |
| `sq_resize_block` | `resizeBlock()` | siteId, pageSlug, searchText, width?, height? |
| `sq_swap_blocks` | `swapBlocks()` | siteId, pageSlug, searchText1, searchText2 |
| `sq_duplicate_block` | `duplicateBlock()` | siteId, pageSlug, searchText |

#### Group C: Sections (extend `tools/section.ts`)

| Tool | Method | Params |
|------|--------|--------|
| `sq_edit_section_style` | `editSectionStyle()` | siteId, pageSlug, sectionSearch, theme?, height?, width?, alignment? |
| `sq_move_section` | `moveSection()` | siteId, pageSlug, sectionSearch, direction |
| `sq_duplicate_section` | `duplicateSection()` | siteId, pageSlug, sectionSearch |

**Note:** `sq_add_blank_section` and `sq_add_template_section` already exist from Phase 1.

#### Group D: Pages & Navigation (new `tools/pages.ts`)

| Tool | Method | Params |
|------|--------|--------|
| `sq_create_page` | `createPageViaApi()` | siteId, title, slug?, pageType? |
| `sq_delete_page` | `deletePageViaApi()` | siteId, collectionId |
| `sq_list_pages` | `listCollections()` | siteId |
| `sq_get_navigation` | `getNavigation()` | siteId |
| `sq_update_navigation` | `updateNavigation()` | siteId, items |
| `sq_update_page_metadata` | `updatePageMetadata()` | siteId, pageSlug, seoTitle?, seoDescription?, keywords? |

#### Group E: Site-wide (new `tools/site.ts`)

| Tool | Method | Params |
|------|--------|--------|
| `sq_get_settings` | `getSettings()` | siteId |
| `sq_update_settings` | `updateSettings()` | siteId, updates (partial settings object) |
| `sq_get_design` | `getWebsiteFonts()` + `getWebsiteColors()` + `getTemplateTweakSettings()` | siteId |
| `sq_update_design` | `updateFont()` / `updatePaletteColor()` / `setTemplateTweakSettings()` | siteId, fonts?, colors?, tweaks? |
| `sq_get_code_injection` | `getCodeInjection()` | siteId |
| `sq_update_code_injection` | `saveCodeInjection()` | siteId, header?, footer? |
| `sq_update_css` | `saveCustomCSS()` | siteId, css |

#### Group F: Blog, Menu & Gallery (new `tools/content.ts`)

| Tool | Method | Params |
|------|--------|--------|
| `sq_create_blog_post` | `createBlogPost()` | siteId, collectionId, title, body?, tags? |
| `sq_update_blog_post` | `updateBlogPost()` | siteId, collectionId, postId, updates |
| `sq_get_menu` | `getMenuBlock()` | siteId, pageSlug, searchText |
| `sq_update_menu` | `updateMenuBlock()` | siteId, pageSlug, searchText, menus |
| `sq_update_gallery` | `updateGallerySettings()` | siteId, pageSlug, searchText, settings |

### Tool File Organization

```
src/mcp-server/tools/
├── text.ts        # Phase 1 (2 tools) + Phase 2 (6 tools) = 8 tools
├── blocks.ts      # NEW: 10 tools
├── section.ts     # Phase 1 (2 tools) + Phase 2 (3 tools) = 5 tools
├── pages.ts       # NEW: 6 tools
├── site.ts        # NEW: 7 tools
├── content.ts     # NEW: 5 tools
└── screenshot.ts  # Phase 1 placeholder (1 tool)
```

### Registration in `index.ts`

Each file exports a `register*Tools(server)` function. `index.ts` imports and calls all of them:

```typescript
registerTextTools(server);
registerBlockTools(server);
registerSectionTools(server);
registerPageTools(server);
registerSiteTools(server);
registerContentTools(server);
registerScreenshotTools(server);
```

## Component 2: Agent Prompts

6 markdown files in `src/orchestrator/prompts/`. Each is a self-contained system prompt loaded via `--system-prompt-file`.

### classifier.md (~100 lines)

**Purpose:** Route tasks to simple-edit fast path or full agent pipeline.

**Input:** Task description + site info.
**Output:** JSON `{ route: "simple" | "pipeline", simpleEditType?: string, confidence: "high" | "medium" | "low" }`.

**Content:** Adapted from existing simple-edit classifier patterns (18 edit types). Lists what qualifies as simple (text replace, button update, menu edit, blog post, etc.) vs pipeline (multi-section, page creation, design changes, content generation).

### researcher.md (~50 lines)

**Purpose:** Gather external information via web search.

**Input:** Research query derived from task.
**Output:** Structured research findings as text.

**Content:** Short prompt focused on web search + synthesis. No MCP tools — uses Claude's built-in WebSearch.

### analyst.md (~200 lines)

**Purpose:** Understand current page state before planning.

**Input:** Site ID + target page(s).
**Output:** JSON `{ pages: [{ slug, sections, blocks, themes }], navigation, siteSettings }`.

**Allowed tools:** `sq_read_page`, `sq_take_screenshot`, `sq_get_navigation`, `sq_list_pages`, `sq_get_settings`, `sq_get_design`.

**Content:** Adapted from squarespace-snapshot.md. Block type reference table. Instructions to read page structure and report findings.

### strategist.md (~400 lines)

**Purpose:** Generate a ContentPlan (operation list) from task + analysis.

**Input:** Task description + analyst output + research findings.
**Output:** JSON ContentPlan matching existing `ContentPlan` type.

**Allowed tools:** `sq_read_page`, `sq_get_navigation`, `sq_list_pages`, `sq_get_design` (read-only).

**Content:** Adapted from squarespace-create.md + squarespace-edit.md + agent reference. Includes:
- All 23 operation types with required fields
- Template catalog (27 templates, 8 categories)
- Content strategy routing (template vs blank_api vs manual)
- Grid system reference (24 cols)
- "ONLY do what was explicitly requested" constraint

### executor.md (~500 lines)

**Purpose:** Execute operations using MCP tools. Report browser fallbacks.

**Input:** ContentPlan JSON from strategist.
**Output:** Execution results + any `BROWSER_FALLBACK:` markers.

**Allowed tools:** ALL `sq_*` tools.

**Content:** The biggest prompt. Adapted from all 7 skill files + squarespace.md agent reference:
- Full tool reference (all ~40 tools with params)
- Block type reference (15 types)
- 24-column grid system
- Read-modify-write pattern
- All 11 gotchas from skill files
- Dual button types (46 + 1337)
- Menu block structure (type 18)
- BROWSER_FALLBACK protocol: when a tool fails or can't handle a task, emit `BROWSER_FALLBACK: { intent, actions, reason }`
- Execution order: structural ops first (create page, add sections), then content ops (text, images, buttons)

### supervisor.md (~150 lines)

**Purpose:** Verify execution results by reading page state.

**Input:** Original task + executor results.
**Output:** JSON `{ verdict: "pass" | "fail" | "partial", issues: string[], suggestions: string[] }`.

**Allowed tools:** `sq_read_page`, `sq_take_screenshot`.

**Content:** Adapted from supervisor-agent.ts patterns. Read page after execution, compare against task requirements, produce structured verdict.

## Component 3: Orchestrator

### File: `src/orchestrator/orchestrator.ts`

```typescript
export interface OrchestratorResult {
  success: boolean;
  verdict?: SupervisorVerdict;
  fallbacks: BrowserFallback[];
  agentCosts: Record<string, number>;
  totalCost: number;
}

export async function orchestrateTask(
  task: Task,
  conversation: Conversation,
): Promise<OrchestratorResult>
```

### Pipeline Steps

1. **Classify** — Call `classifyForMcp(task)` (non-LLM, reuses existing simple-edit classifier logic). If simple → execute via existing fast path, return.

2. **Research** (if task mentions external content/URLs) — `runAgent(researcher, query)`. Skip for pure editing tasks.

3. **Analyze** — `runAgent(analyst, siteId + pages)`. Returns page structure JSON.

4. **Strategize** — `runAgent(strategist, task + analysis + research)`. Returns ContentPlan JSON.

5. **Execute** — `runAgent(executor, plan)`. Returns execution log + BROWSER_FALLBACK markers.

6. **Supervise** — `runAgent(supervisor, task + results)`. Returns verdict JSON.

7. **Track fallbacks** — Parse executor output for `BROWSER_FALLBACK:` markers, log via `fallback-tracker.ts`.

### Agent Configs

```typescript
const AGENT_CONFIGS: Record<string, Omit<AgentConfig, 'mcpConfig'>> = {
  classifier: { name: 'classifier', model: 'haiku', maxTurns: 1, systemPromptFile: 'src/orchestrator/prompts/classifier.md' },
  researcher: { name: 'researcher', model: 'haiku', maxTurns: 5, systemPromptFile: 'src/orchestrator/prompts/researcher.md' },
  analyst:    { name: 'analyst',    model: 'sonnet', maxTurns: 3, systemPromptFile: 'src/orchestrator/prompts/analyst.md' },
  strategist: { name: 'strategist', model: 'sonnet', maxTurns: 3, systemPromptFile: 'src/orchestrator/prompts/strategist.md' },
  executor:   { name: 'executor',   model: 'sonnet', maxTurns: 30, systemPromptFile: 'src/orchestrator/prompts/executor.md' },
  supervisor: { name: 'supervisor', model: 'sonnet', maxTurns: 5, systemPromptFile: 'src/orchestrator/prompts/supervisor.md' },
};
```

### Integration: Flag-Gated Swap

In `src/services/conversation/execution.ts`, the `executeTasks()` function checks:

```typescript
if (process.env.USE_MCP_AGENTS === 'true') {
  return orchestrateTaskViaMcp(conversation, task);
}
// ... existing execution path unchanged
```

### SSE Events

Orchestrator emits to `dashboardEvents`:
- `agent_activity` — when each agent starts/completes
- `agent_step` — forwarded from `runAgent.onStep`
- `task_update` — status transitions

## Implementation Strategy

### Wave 1 (parallel, 4 worktree agents): MCP Tools

| Agent | Scope | Files |
|-------|-------|-------|
| Agent 1 | Groups A+C: text (6 new) + sections (3 new) | `tools/text.ts`, `tools/section.ts` |
| Agent 2 | Group B: blocks (10 new) | `tools/blocks.ts` (new) |
| Agent 3 | Groups D+E: pages (6) + site-wide (7) | `tools/pages.ts` (new), `tools/site.ts` (new) |
| Agent 4 | Group F: blog/menu/gallery (5) | `tools/content.ts` (new) |

Each agent gets:
- The existing tool files as examples (text.ts, section.ts pattern)
- The session.ts API (getClient, getMediaClient, resolvePageIds)
- The specific ContentSaveClient method signatures they need
- Instructions to follow the exact same pattern: Zod schemas, try/catch, JSON response

### Wave 2 (parallel, 3 worktree agents): Prompts + Orchestrator

| Agent | Scope | Files |
|-------|-------|-------|
| Agent 5 | executor.md + supervisor.md | `prompts/executor.md`, `prompts/supervisor.md` |
| Agent 6 | classifier.md + researcher.md + analyst.md + strategist.md | `prompts/classifier.md`, `prompts/researcher.md`, `prompts/analyst.md`, `prompts/strategist.md` |
| Agent 7 | orchestrator.ts + execution.ts integration | `orchestrator.ts`, modify `execution.ts` |

### Merge Order

1. Wave 1 agents (tools) — no conflicts between agents since each writes to different files
2. Merge `index.ts` registration calls (I do this manually — just adding import + register lines)
3. Wave 2 agents (prompts + orchestrator) — no conflicts since each writes to different files
4. Final: `npm run test` to verify

## Testing

- Each new tool file gets a corresponding test file in `src/mcp-server/__tests__/`
- Prompt files don't need tests (they're markdown)
- Orchestrator gets unit tests mocking `runAgent`
- Integration test: manual run via CLI with `USE_MCP_AGENTS=true`

## Risks

- **Tool count**: 40+ tools is a lot of MCP context. Claude CLI may need `--allowedTools` filtering per agent to keep context manageable.
- **Screenshot placeholder**: `sq_take_screenshot` stays as placeholder — browser integration is Phase 3.
- **Blog tools need collectionId**: `sq_create_blog_post` takes collectionId directly (not pageSlug) since blogs are collections, not pages. The strategist must resolve this from `sq_list_pages` output.
