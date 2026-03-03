# MCP-First Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the dual execution architecture with a single MCP orchestrator path, remove browser agent and old pipeline code.

**Architecture:** All tasks flow through the MCP orchestrator's 7-stage pipeline (classify → research → analyze → strategize → [approve] → execute → supervise). Old pipeline code moves to `src/archive/`. New MCP tools (`sq_web_search`, `sq_fetch_url`) close the web search gap. Strategist outputs structured `ContentPlan` JSON.

**Tech Stack:** TypeScript, MCP server (Zod schemas), Claude CLI (`claude -p --mcp-config`), Brave Search API, SQLite (better-sqlite3), Fastify

**Design doc:** `docs/plans/2026-03-03-mcp-first-unification-design.md`

---

## Task 1: Add Web Search MCP Tools

**Files:**
- Create: `src/mcp-server/tools/web-search.ts`
- Modify: `src/mcp-server/index.ts:26-32` (add registration)
- Test: `src/mcp-server/__tests__/web-search-tools.test.ts`

**Step 1: Write the failing test**

```typescript
// src/mcp-server/__tests__/web-search-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock brave-search module
vi.mock('../../services/brave-search.js', () => ({
  webSearch: vi.fn(),
}));

// Mock node fetch for sq_fetch_url
vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

import { createMockServer } from './test-helpers.js';

describe('web-search-tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sq_web_search calls webSearch and returns results', async () => {
    const { webSearch } = await import('../../services/brave-search.js');
    (webSearch as any).mockResolvedValue([
      { title: 'Test', url: 'https://example.com', description: 'A result' },
    ]);

    server = createMockServer();
    const { registerWebSearchTools } = await import('../tools/web-search.js');
    registerWebSearchTools(server as any);

    const tool = server.getToolHandler('sq_web_search');
    const result = await tool({ query: 'vegan restaurants NYC', count: 3 });

    expect(webSearch).toHaveBeenCalledWith('vegan restaurants NYC', 3);
    expect(result.content[0].text).toContain('example.com');
  });

  it('sq_fetch_url fetches and strips HTML', async () => {
    const fetch = (await import('node-fetch')).default as any;
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body><h1>Hello</h1><p>World</p></body></html>'),
    });

    server = createMockServer();
    const { registerWebSearchTools } = await import('../tools/web-search.js');
    registerWebSearchTools(server as any);

    const tool = server.getToolHandler('sq_fetch_url');
    const result = await tool({ url: 'https://example.com' });

    expect(result.content[0].text).toContain('Hello');
    expect(result.content[0].text).toContain('World');
  });

  it('sq_web_search handles errors gracefully', async () => {
    const { webSearch } = await import('../../services/brave-search.js');
    (webSearch as any).mockRejectedValue(new Error('API key invalid'));

    server = createMockServer();
    const { registerWebSearchTools } = await import('../tools/web-search.js');
    registerWebSearchTools(server as any);

    const tool = server.getToolHandler('sq_web_search');
    const result = await tool({ query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('API key invalid');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/web-search-tools.test.ts`
Expected: FAIL — module `../tools/web-search.js` not found

**Step 3: Implement the web search tools**

```typescript
// src/mcp-server/tools/web-search.ts
import { z } from 'zod';
import type { McpServer } from '@anthropic-ai/mcp';

export function registerWebSearchTools(server: McpServer): void {
  server.tool(
    'sq_web_search',
    'Search the web using Brave Search API. Returns titles, URLs, and descriptions.',
    { query: z.string().describe('Search query'), count: z.number().optional().describe('Number of results (default 5)') },
    async ({ query, count }) => {
      try {
        const { webSearch } = await import('../../services/brave-search.js');
        const results = await webSearch(query, count ?? 5);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Web search failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'sq_fetch_url',
    'Fetch a URL and return its text content (HTML stripped). Useful for extracting content from web pages.',
    { url: z.string().url().describe('URL to fetch') },
    async ({ url }) => {
      try {
        const fetch = (await import('node-fetch')).default;
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'SquarespaceHelper/1.0' },
          timeout: 15_000,
        });
        if (!resp.ok) {
          return {
            content: [{ type: 'text' as const, text: `Fetch failed: HTTP ${resp.status}` }],
            isError: true,
          };
        }
        const html = await resp.text();
        // Strip HTML tags, decode entities, collapse whitespace
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, '\n')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        return {
          content: [{ type: 'text' as const, text: text.substring(0, 10_000) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
```

**Step 4: Register in index.ts**

Add to `src/mcp-server/index.ts` after existing registrations:
```typescript
import { registerWebSearchTools } from './tools/web-search.js';
// ... in the registration block:
registerWebSearchTools(server);
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/web-search-tools.test.ts`
Expected: PASS (3 tests)

**Step 6: Rebuild MCP server**

Run: `npx tsc --noCheck`

**Step 7: Commit**

```bash
git add src/mcp-server/tools/web-search.ts src/mcp-server/index.ts src/mcp-server/__tests__/web-search-tools.test.ts
git commit -m "feat(mcp): add sq_web_search and sq_fetch_url tools"
```

---

## Task 2: Update Strategist Prompt for Structured JSON Output

**Files:**
- Modify: `src/orchestrator/prompts/strategist.md`

**Step 1: Read the current strategist prompt**

Read `src/orchestrator/prompts/strategist.md` (310 lines) to understand current output format.

**Step 2: Update the prompt**

Replace the output format section to require ContentPlan JSON. The prompt must include:
- The full `ContentPlan` schema: `{ summary, operations[], estimatedMinutes }`
- The `ContentOperation` schema: `{ operationType, description, placement, content: ContentSpec }`
- All 23 `operationType` values with descriptions
- `ContentSpec` fields: `contentStrategy`, `heading`, `bodyText`, `templateCategory`, `templateIndex`, `replacements`, `apiBlocks`, etc.
- Example outputs for common scenarios (blog post, new page, text edit, section addition)
- Instruction: "Output ONLY valid JSON. No markdown, no explanation, just the ContentPlan object."

Key sections to add to the strategist prompt:
- "## Output Format" — the JSON schema
- "## Operation Types Reference" — all 23 types with when to use each
- "## Example Plans" — 3-4 realistic examples
- Remove any instruction about free-text output

**Step 3: Commit**

```bash
git add src/orchestrator/prompts/strategist.md
git commit -m "feat(mcp): update strategist prompt for structured ContentPlan JSON output"
```

---

## Task 3: Update Researcher Prompt with Web Search Tools

**Files:**
- Modify: `src/orchestrator/prompts/researcher.md`
- Modify: `src/orchestrator/orchestrator.ts:29-34` (add allowedTools for researcher)

**Step 1: Update researcher prompt**

Add tool documentation to `src/orchestrator/prompts/researcher.md`:
- `sq_web_search(query, count?)` — search the web
- `sq_fetch_url(url)` — fetch and extract page content
- Example workflow: generate queries → search → fetch top URLs → synthesize

**Step 2: Add allowedTools to researcher config**

In `src/orchestrator/orchestrator.ts`, update the researcher agent config:
```typescript
researcher: {
  name: 'researcher',
  model: 'haiku',
  maxTurns: 5,
  systemPromptFile: join(PROMPTS_DIR, 'researcher.md'),
  allowedTools: [
    'mcp__squarespace__sq_web_search',
    'mcp__squarespace__sq_fetch_url',
  ],
},
```

**Step 3: Commit**

```bash
git add src/orchestrator/prompts/researcher.md src/orchestrator/orchestrator.ts
git commit -m "feat(mcp): give researcher agent web search tools"
```

---

## Task 4: Enhance Orchestrator with Structured Planning + Tracking

**Files:**
- Modify: `src/orchestrator/orchestrator.ts` (major rewrite, 273 lines → ~350 lines)

**Step 1: Read current orchestrator**

Read `src/orchestrator/orchestrator.ts` fully.

**Step 2: Add ContentPlan parsing after strategist**

After the strategist returns, parse its output as `ContentPlan` JSON:
```typescript
import type { ContentPlan } from '../agents/types.js';
import { createPlanOperations, updateOperationStatus } from '../db/plan-operations.js';
import { sendToTim, sendButtonsToTim } from '../services/whatsapp.js';
import { updateConversationStatus } from '../db/conversations.js';

// In orchestrateTask(), after strategist:
let contentPlan: ContentPlan;
try {
  contentPlan = JSON.parse(plan);
} catch {
  logger.error({ raw: plan.substring(0, 500) }, 'Strategist returned invalid JSON');
  return { success: false, fallbacks: [], agentCosts, totalCost: sumCosts(agentCosts) };
}
```

**Step 3: Add per-operation tracking**

After parsing the plan:
```typescript
let trackedOps: PlanOperation[] = [];
try {
  trackedOps = createPlanOperations(conversation.id, contentPlan);
  for (const op of trackedOps) {
    dashboardEvents.emit('operation_update', {
      conversationId: conversation.id,
      operationId: op.id,
      status: 'pending',
      description: op.description,
    });
  }
} catch (err) {
  logger.warn({ error: errMsg(err) }, 'Failed to track operations (non-blocking)');
}
```

**Step 4: Add optional plan approval gate**

```typescript
if (process.env.REQUIRE_PLAN_APPROVAL === 'true') {
  const planSummary = contentPlan.operations
    .map((op, i) => `${i + 1}. ${op.description}`)
    .join('\n');
  await sendButtonsToTim(
    `Here's my plan:\n\n${planSummary}\n\nShall I proceed?`,
    [
      { id: 'confirm_yes', title: 'Yes, proceed' },
      { id: 'confirm_no', title: 'No, cancel' },
    ],
    conversation.id,
  );
  updateConversationStatus(conversation.id, 'awaiting_plan_approval');
  // Return early — execution resumes when Tim confirms via handlePlanApproval
  return { success: true, verdict: undefined, fallbacks: [], agentCosts, totalCost: sumCosts(agentCosts) };
}
```

**Step 5: Pass structured plan to executor**

Update executor input to include the JSON plan:
```typescript
const executorInput = [
  `Site: ${task.siteId}`,
  `Target page: ${task.targetPage ?? 'home'}`,
  `\n## Plan (ContentPlan JSON)\n\`\`\`json\n${JSON.stringify(contentPlan, null, 2)}\n\`\`\``,
].join('\n');
```

**Step 6: Update operation status from executor steps**

In the `onStep` callback for the executor, parse tool results and update operation statuses based on tool calls completed.

**Step 7: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat(mcp): add structured planning, tracking, and approval to orchestrator"
```

---

## Task 5: Enhance Supervisor Prompt

**Files:**
- Modify: `src/orchestrator/prompts/supervisor.md`

**Step 1: Update supervisor prompt**

Add to supervisor prompt:
- Receives the ContentPlan JSON as part of input
- Must read the page after execution via `sq_read_page`
- Must compare actual content against each operation's expected outcome
- Must check: text blocks contain expected text, sections exist, blog posts created, etc.
- Return structured verdict per operation:
```json
{
  "verdict": "pass" | "partial" | "fail",
  "operations": [
    { "description": "...", "status": "pass" | "fail", "evidence": "..." }
  ],
  "issues": [],
  "suggestions": []
}
```

**Step 2: Add `sq_get_code_injection` and `sq_get_menu` to supervisor tools**

In `orchestrator.ts`, expand supervisor `allowedTools`:
```typescript
supervisor: {
  // ... existing ...
  allowedTools: [
    'mcp__squarespace__sq_read_page',
    'mcp__squarespace__sq_list_pages',
    'mcp__squarespace__sq_get_navigation',
    'mcp__squarespace__sq_get_settings',
    'mcp__squarespace__sq_get_design',
    'mcp__squarespace__sq_take_screenshot',
    'mcp__squarespace__sq_get_code_injection',
    'mcp__squarespace__sq_get_menu',
  ],
},
```

**Step 3: Commit**

```bash
git add src/orchestrator/prompts/supervisor.md src/orchestrator/orchestrator.ts
git commit -m "feat(mcp): enhance supervisor with per-operation verification"
```

---

## Task 6: Enhance Page Deletion (Best-Effort API)

**Files:**
- Modify: `src/services/content-save.ts` (around `deletePageViaApi` at line 6996)
- Modify: `src/mcp-server/tools/page-tools.ts` (wherever `sq_delete_page` is registered)

**Step 1: Read current deletePageViaApi implementation**

Read `src/services/content-save.ts:6996-7055` to understand current approach.

**Step 2: Add navigation-hiding fallback to deletePageViaApi**

If `DELETE /api/collections/{id}` fails, try removing the page from navigation:
```typescript
async deletePageViaApi(collectionId: string): Promise<PageDeleteResult> {
  // Try 1: DELETE endpoint
  try {
    const result = await this.tryDeleteCollection(collectionId);
    if (result.success) return result;
  } catch { /* fall through */ }

  // Try 2: Hide from navigation
  try {
    const navResult = await this.getNavigation();
    if (navResult.success && navResult.data) {
      // Find and remove from mainNavigation
      const mainNav = navResult.data.mainNavigation ?? [];
      const filtered = mainNav.filter((item: any) => item.id !== collectionId);
      if (filtered.length < mainNav.length) {
        await this.updateNavigation('mainNav', filtered);
        return { success: true, method: 'hidden_from_nav', note: 'Page hidden from navigation but not deleted. Manual cleanup may be needed.' };
      }
    }
  } catch { /* fall through */ }

  return { success: false, error: 'Could not delete page via API or hide from navigation' };
}
```

**Step 3: Update MCP tool to return informative result**

Update `sq_delete_page` tool handler to include the `method` and `note` fields in its response.

**Step 4: Commit**

```bash
git add src/services/content-save.ts src/mcp-server/tools/page-tools.ts
git commit -m "feat: add navigation-hiding fallback for page deletion"
```

---

## Task 7: Move Old Code to src/archive/

**Files:**
- Move ~20+ files to `src/archive/`

**Step 1: Create archive directory**

```bash
mkdir -p src/archive/agents src/archive/automation src/archive/automation/actions src/archive/services src/archive/services/conversation
```

**Step 2: Move agent files**

```bash
git mv src/agents/coordinator.ts src/archive/agents/
git mv src/agents/research-agent.ts src/archive/agents/
git mv src/agents/site-analyst-agent.ts src/archive/agents/
git mv src/agents/content-strategist-agent.ts src/archive/agents/
git mv src/agents/supervisor-agent.ts src/archive/agents/
git mv src/agents/learning-agent.ts src/archive/agents/
git mv src/agents/url-researcher.ts src/archive/agents/
```

Keep: `src/agents/types.ts` (ContentPlan types used by orchestrator)

**Step 3: Move automation files**

```bash
git mv src/automation/browser-agent.ts src/archive/automation/
git mv src/automation/browser-agent-actions.ts src/archive/automation/
git mv src/automation/browser-agent-prompt.ts src/archive/automation/
git mv src/automation/browser-agent-rescue.ts src/archive/automation/
git mv src/automation/browser-agent-state.ts src/archive/automation/
git mv src/automation/browser-manager.ts src/archive/automation/
git mv src/automation/squarespace-auth.ts src/archive/automation/
git mv src/automation/site-navigator.ts src/archive/automation/
git mv src/automation/editor-actions.ts src/archive/automation/
git mv src/automation/network-capture.ts src/archive/automation/
git mv src/automation/selectors.ts src/archive/automation/
git mv src/automation/site-discovery.ts src/archive/automation/
git mv src/automation/squarespace-docs.ts src/archive/automation/
git mv src/automation/actions/ src/archive/automation/
```

**Step 4: Move service files**

```bash
git mv src/services/template-discovery.ts src/archive/services/
git mv src/services/template-registry.ts src/archive/services/
git mv src/services/content-validator.ts src/archive/services/
git mv src/services/conversation/planning.ts src/archive/services/conversation/
```

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move old pipeline and browser agent to src/archive/"
```

---

## Task 8: Simplify execution.ts

**Files:**
- Modify: `src/services/conversation/execution.ts` (4063 lines → ~100 lines)

**Step 1: Read current execution.ts**

Read the file, identify all imports and functions that reference archived code.

**Step 2: Rewrite execution.ts**

Strip down to the core: import orchestrator, loop over tasks, call `orchestrateTask()`.

```typescript
// src/services/conversation/execution.ts
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';
import { getTask, updateTaskStatus } from '../../db/tasks.js';
import { updateConversationStatus } from '../../db/conversations.js';
import { sendToTim } from '../whatsapp.js';
import { orchestrateTask } from '../../orchestrator/orchestrator.js';
import { dashboardEvents } from '../dashboard-events.js';
import type { Conversation } from '../../models/conversation.js';
import { decayOldLearnings } from '../../db/learnings.js';

// Multi-site expansion helper (keep existing)
function expandMultiSiteTasks(taskIds: string[]): string[] {
  // ... keep existing implementation
}

export async function executeTasks(conversation: Conversation): Promise<void> {
  try { decayOldLearnings(); } catch { /* non-blocking */ }

  const expandedTaskIds = expandMultiSiteTasks(conversation.taskIds);
  const total = expandedTaskIds.length;
  let completed = 0;
  let failed = 0;

  for (const taskId of expandedTaskIds) {
    const task = getTask(taskId);
    if (!task) { failed++; continue; }

    updateTaskStatus(taskId, 'executing');
    dashboardEvents.emit('task_update', { taskId, status: 'executing' });

    try {
      const result = await orchestrateTask(task, conversation);
      const status = result.success ? 'done' : 'failed';
      updateTaskStatus(taskId, status, result.success ? undefined : result.verdict?.issues?.join(', '));

      if (result.success) completed++;
      else failed++;

      if (conversation.source !== 'dashboard') {
        await sendToTim(
          result.success
            ? `Done: ${task.description}`
            : `Failed: ${result.verdict?.issues?.join(', ') ?? 'Unknown error'}`,
          conversation.id,
        );
      }
    } catch (err) {
      failed++;
      updateTaskStatus(taskId, 'failed', errMsg(err));
      logger.error({ taskId, error: errMsg(err) }, 'Task orchestration error');
    }
  }

  updateConversationStatus(conversation.id, 'completed');
  logger.info({ total, completed, failed, conversationId: conversation.id }, 'All tasks finished');
}
```

**Step 3: Remove `executeTasksWithPlan` export**

It's no longer called from anywhere. Remove it and all fast path functions.

**Step 4: Fix any imports in other files**

Search for imports of removed functions from execution.ts:
- `executeTasksWithPlan` — referenced in `message-handlers.ts:24` and `:794`
- `trySimpleEditFastPath` — referenced in `message-handlers.ts:362`
- Any other references to removed fast path functions

**Step 5: Run tests**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
Expected: Many test failures from archived code references. Fix imports or exclude archived test files.

**Step 6: Commit**

```bash
git add src/services/conversation/execution.ts
git commit -m "refactor: simplify execution.ts to MCP-only path"
```

---

## Task 9: Simplify message-handlers.ts

**Files:**
- Modify: `src/services/conversation/message-handlers.ts`

**Step 1: Remove planning-related imports and logic**

Remove:
- Import of `taskNeedsContentPlanning`, `runPlanningPipeline` from `./planning.js`
- Import of `executeTasksWithPlan` from `./execution.js`
- The entire `trySimpleEditFastPath()` function (~80 lines)
- The `needsPlanning` check and `runPlanningPipeline()` call in `handleConfirmation()`
- The `handlePlanApproval()` function (unless kept for `REQUIRE_PLAN_APPROVAL`)

**Step 2: Simplify handleConfirmation**

After confirmation, just enqueue the task:
```typescript
await sendToTim(`Got it. Starting ${conversation.taskIds.length} task(s)...`, conversation.id);
updateConversationStatus(conversation.id, 'executing');
const siteId = getSiteIdForQueue(conversation);
executionQueue.enqueue(conversation.id, siteId, () => executeTasks(conversation));
```

No simple edit fast path. No planning detection. No branching.

**Step 3: Keep handlePlanApproval for REQUIRE_PLAN_APPROVAL**

If `REQUIRE_PLAN_APPROVAL=true`, the orchestrator pauses after strategist and needs a way to resume. Keep or adapt `handlePlanApproval()` to call back into the orchestrator's executor stage.

**Step 4: Commit**

```bash
git add src/services/conversation/message-handlers.ts
git commit -m "refactor: simplify message-handlers to remove planning pipeline"
```

---

## Task 10: Remove USE_MCP_AGENTS and USE_LEGACY_ACTIONS env vars

**Files:**
- Modify: `src/services/conversation/execution.ts` (remove gate)
- Modify: `.env` (remove vars)
- Modify: any other files referencing these vars

**Step 1: Search for all references**

```bash
grep -r "USE_MCP_AGENTS\|USE_LEGACY_ACTIONS" src/ --include="*.ts" -l
```

Remove the env var checks. MCP is the only path now.

**Step 2: Remove from .env**

Remove `USE_MCP_AGENTS=true` line.

**Step 3: Commit**

```bash
git add -A
git commit -m "refactor: remove USE_MCP_AGENTS and USE_LEGACY_ACTIONS gates"
```

---

## Task 11: Move Archived Tests

**Files:**
- Move test files that test archived code

**Step 1: Identify tests for archived modules**

```bash
# Tests for browser agent, old agents, planning, etc.
git mv src/automation/__tests__/ src/archive/automation/
git mv src/agents/__tests__/ src/archive/agents/
git mv src/services/__tests__/content-validator.test.ts src/archive/services/
git mv src/services/__tests__/template-*.test.ts src/archive/services/
```

Keep: tests for `content-save.ts`, `menu-parser.ts`, `menu-merger.ts`, MCP tools, orchestrator.

**Step 2: Run remaining tests**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
Expected: All remaining tests pass.

**Step 3: Commit**

```bash
git add -A
git commit -m "refactor: move archived module tests to src/archive/"
```

---

## Task 12: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update architecture section**

- Remove browser agent, old pipeline, and fast path documentation
- Update execution flow to describe MCP-only path
- Remove references to archived files
- Update directory structure
- Update action handler modules section (removed)
- Update commands if any changed
- Update test counts

**Step 2: Update key files table**

Remove archived file entries, add new ones:
- `src/mcp-server/tools/web-search.ts` — Web search MCP tools
- Updated orchestrator description

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for MCP-first architecture"
```

---

## Task 13: Rebuild and Smoke Test

**Step 1: Rebuild**

Run: `npx tsc --noCheck`
Expected: Clean compile (no errors from archived code since it's excluded)

**Step 2: Run all tests**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
Expected: All pass (count will be lower than before — many tests moved to archive)

**Step 3: Start server and test via dashboard**

Run: `npm run dev`
Submit a test task via dashboard chat: "Add a blog post about summer cocktails to Smyth Tavern"
Verify: task flows through orchestrator stages (check dashboard agent activity)

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve issues found during smoke testing"
```

---

## Execution Order & Dependencies

```
Task 1 (web search tools) — independent
Task 2 (strategist prompt) — independent
Task 3 (researcher prompt) — depends on Task 1
Task 4 (orchestrator enhancement) — depends on Tasks 2, 3
Task 5 (supervisor prompt) — independent
Task 6 (page deletion) — independent
Task 7 (archive old code) — independent, but do AFTER Tasks 1-6
Task 8 (simplify execution.ts) — depends on Task 7
Task 9 (simplify message-handlers) — depends on Task 8
Task 10 (remove env vars) — depends on Tasks 8, 9
Task 11 (move tests) — depends on Task 7
Task 12 (update CLAUDE.md) — do last
Task 13 (rebuild + smoke test) — do last
```

**Parallelizable groups:**
- Group A: Tasks 1, 2, 5, 6 (all independent)
- Group B: Task 3 (after 1)
- Group C: Task 4 (after 2, 3)
- Group D: Task 7 (after all code changes)
- Group E: Tasks 8, 9, 10, 11 (sequential, after 7)
- Group F: Tasks 12, 13 (final)
