# MCP-First Unification Design

**Date**: 2026-03-03
**Status**: Approved
**Approach**: A — MCP-First with full old pipeline removal

## Goal

Replace the dual execution architecture (old planning pipeline + MCP agents) with a single MCP-first path. Every task flows through the MCP orchestrator. Old pipeline code moves to `src/archive/`.

## Current Problem

Two parallel systems that never talk to each other:
- **Old pipeline**: `taskNeedsContentPlanning()` → research agent → site analyst → content strategist → ContentPlan → template/blank_api/two-pass fast paths → browser agent fallback
- **MCP pipeline**: `USE_MCP_AGENTS` gate → classifier → researcher → analyst → strategist → executor → supervisor

The old pipeline intercepts most tasks before the MCP gate is reached. The MCP agents are effectively dead code.

## New Execution Flow

```
Tim sends request (WhatsApp/email/dashboard)
  → Request interpreter extracts tasks
  → Tim confirms
  → executeTasks(conversation)
      → orchestrateTask() for each task
          1. Classify (Haiku, 1 turn)
          2. Research (Haiku, 5 turns) — if needed, uses sq_web_search + sq_fetch_url
          3. Analyze (Sonnet, 3 turns) — reads page via MCP tools
          4. Strategize (Sonnet, 3 turns) — outputs ContentPlan JSON
          5. [Optional] Plan approval — REQUIRE_PLAN_APPROVAL=true pauses for Tim
          6. Execute (Sonnet, 30 turns) — calls MCP tools
          7. Supervise (Sonnet, 5 turns) — verifies via read-only MCP tools
      → Track per-operation status in SQLite
      → Emit SSE events to dashboard
      → Report result to Tim
```

## Gap Closures

### 1. Structured Planning

Strategist prompt updated to output `ContentPlan` JSON (same schema as old system). Orchestrator parses it, creates `PlanOperation` rows, passes structured plan to executor.

### 2. Web Search (New MCP Tools)

Two new tools added to MCP server:
- `sq_web_search(query, count?)` — wraps existing `webSearch()` from `brave-search.ts`
- `sq_fetch_url(url)` — fetches URL, strips HTML to structured text

Researcher agent gets these in `allowedTools`. Same `BRAVE_SEARCH_API_KEY` from `.env`.

### 3. Page Deletion

Three-step best-effort in `sq_delete_page`:
1. Try `DELETE /api/collections/{id}`
2. Try `updateNavigation()` to remove from nav
3. Return result: "deleted", "hidden from nav", or "failed"

No browser fallback. If API can't delete, report to Tim.

### 4. Per-Operation Tracking

Orchestrator:
1. Parses strategist's ContentPlan JSON
2. Creates PlanOperation rows via `createPlanOperations()`
3. Emits `operation_update` SSE events
4. Updates operation status as executor progresses

### 5. Configurable Plan Approval

`REQUIRE_PLAN_APPROVAL` env var (default: `false`).

When `true`:
- After strategist, orchestrator sends formatted plan to Tim via WhatsApp
- Conversation → `awaiting_plan_approval`
- Tim confirms → executor runs
- Tim rejects/gives feedback → strategist revises

When `false`: fully autonomous (strategist → executor, no pause).

### 6. Content Validation

Supervisor agent reads page after execution via MCP tools, compares against plan's expected outcomes, returns structured verdict. No separate content-validator needed.

## Files Moved to src/archive/

```
src/agents/coordinator.ts
src/agents/research-agent.ts
src/agents/site-analyst-agent.ts
src/agents/content-strategist-agent.ts
src/agents/supervisor-agent.ts
src/agents/learning-agent.ts
src/automation/browser-agent.ts
src/automation/browser-agent-actions.ts
src/automation/browser-agent-prompt.ts
src/automation/browser-agent-rescue.ts
src/automation/browser-manager.ts
src/automation/squarespace-auth.ts
src/automation/site-navigator.ts
src/automation/actions/              (entire directory)
src/services/template-discovery.ts
src/services/template-registry.ts
src/services/content-validator.ts
src/services/conversation/planning.ts
```

## Files Modified

### execution.ts (major simplification)
- Remove all fast paths (template, blank_api, two-pass, batched)
- Remove browser agent execution
- Remove `USE_MCP_AGENTS` gate (MCP is the only path)
- Simplify to: for each task → `orchestrateTask()` → update status

### message-handlers.ts (simplification)
- Remove `trySimpleEditFastPath()`
- Remove `taskNeedsContentPlanning()` checks
- Remove `runPlanningPipeline()` calls
- Confirmation handler: confirm → enqueue → `executeTasks()`

### orchestrator.ts (enhanced)
- Strategist outputs ContentPlan JSON (parsed + validated)
- Per-operation tracking via PlanOperation rows
- SSE event emission for dashboard
- Optional plan approval gate
- Executor receives structured plan

### Conversation state machine (simplified)
- `idle → awaiting_confirm → executing → completed/failed`
- Plus `awaiting_plan_approval → executing` (if REQUIRE_PLAN_APPROVAL=true)
- Remove: `planning`, `revising` states

### mcp-server/ (new tools)
- New `tools/web-search.ts` module with `sq_web_search` + `sq_fetch_url`
- Register in `index.ts`

### Strategist prompt (updated)
- Output ContentPlan JSON schema instead of free text
- Include full operationType reference
- Include tool mapping per operation type

### Supervisor prompt (enhanced)
- Read page after execution
- Compare against plan expectations
- Return structured verdict with per-operation pass/fail

## Files That Stay Unchanged

- `src/services/content-save.ts` — API client foundation
- `src/services/menu-parser.ts`, `menu-merger.ts` — menu utilities
- `src/services/brave-search.ts` — web search (called by new MCP tool)
- `src/mcp-server/tools/` — all existing tool modules
- `src/db/` — all database code
- `src/routes/` — dashboard + webhooks
- `src/services/whatsapp.ts`, `gmail.ts`, `email-processor.ts`
- `src/services/conversation-handler.ts`
- `src/services/dashboard-events.ts`
- `src/services/execution-queue.ts`
- `src/config/` — models, section templates, sites
- `src/utils/` — logger, errors, retry
- `src/agents/types.ts` — type definitions

## Environment Variables

| Var | Default | Purpose |
|-----|---------|---------|
| `REQUIRE_PLAN_APPROVAL` | `false` | Pause after strategist for Tim's plan approval |
| `USE_MCP_AGENTS` | removed | No longer needed — MCP is the only path |
| `USE_LEGACY_ACTIONS` | removed | No legacy path |

## Risks

1. **Executor reliability** — the hardcoded fast paths were deterministic; the executor agent makes runtime decisions. Mitigation: comprehensive executor prompt with example workflows.
2. **Cost** — 6 Claude agents per task vs 1-3 in old pipeline. Mitigation: Haiku for classifier/researcher, skip research when not needed.
3. **Latency** — agent startup + MCP server init per stage. Mitigation: classifier short-circuits simple tasks.
4. **Page deletion** — API may still 404. Mitigation: nav hiding as partial solution, report to Tim.
