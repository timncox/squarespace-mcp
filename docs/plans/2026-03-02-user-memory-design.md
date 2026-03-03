# User Memory Feature — Design Doc

**Date**: 2026-03-02
**Status**: Approved

## Problem

The system has no way to remember user-stated preferences, site rules, or workflow shortcuts between conversations. Tim has to re-state context every time (e.g., "use dark themes for Smyth Tavern", "when I say menu I mean the food menu").

## Solution

LLM-classified memory table. When Tim says "remember that..." (or uses `/remember`), the system extracts, classifies, and stores the memory. Memories are injected into the request interpreter, content strategist, and browser agent prompts to influence future behavior.

## Data Model

New `user_memories` table (Phase 18 migration):

| Column | Type | Purpose |
|--------|------|---------|
| `id` | TEXT PK | UUID |
| `content` | TEXT | The memory as stated |
| `category` | TEXT | `client_preference` \| `site_rule` \| `workflow_shortcut` \| `general` |
| `site_id` | TEXT NULL | Auto-detected site scope (null = global) |
| `tags` | TEXT NULL | JSON array of tags (e.g., `["design", "theme"]`) |
| `source` | TEXT | `whatsapp` \| `dashboard` |
| `active` | INTEGER | 1 = active, 0 = soft-deleted |
| `created_at` | TEXT | ISO 8601 |
| `updated_at` | TEXT | ISO 8601 |

Unique constraint on `(content, site_id)` to prevent duplicates. Re-stating a memory updates `updated_at` and re-activates if forgotten.

## Memory Detection & Storage

### Two input paths

1. **Natural language** (WhatsApp + dashboard chat): The request interpreter adds a `memories[]` array to `InterpretedRequest`. Trigger phrases: "remember that", "keep in mind", "don't forget", "always", "never" (in preference/rule context). A message can produce both tasks AND memories.

2. **Explicit command** (dashboard chat): `/remember <text>` bypasses the interpreter — direct LLM classification call.

### Classification

Single Haiku LLM call takes memory text + sites config, returns:

```json
{
  "content": "Smyth Tavern uses dark section themes",
  "category": "site_rule",
  "siteId": "smyth-tavern",
  "tags": ["design", "theme"]
}
```

### Forget

"Forget that..." / "stop remembering..." in natural language, or `/forget <text>` command. LLM matches forget request to existing memories. Sets `active = 0`.

### List

"What do you remember about Smyth Tavern?" / `/memories [site]`. Returns active memories filtered by site (or all).

## Context Injection

Memories injected into 3 places via `getRelevantMemories(siteId?, category?)`:

### 1. Request Interpreter (`whatsapp-request-interpreter.ts`)
- Workflow shortcuts + site rules before classification
- Filter: global + memories matching any mentioned site
- Format: bullet list under "## User Preferences" in prompt

### 2. Content Strategist (`content-strategist-agent.ts`)
- Client preferences + site rules alongside existing learnings
- Filter: task's `siteId` + global memories
- Format: "## User Memories" section in strategist prompt

### 3. Browser Agent Prompt (`browser-agent-prompt.ts`)
- Site rules affecting editing behavior only
- Filter: site-specific, `site_rule` category only, max 5
- Light touch to keep prompt lean

## Dashboard UI

New **Memories tab** (6th tab, after Learnings):

- **List view**: Table — Memory, Category (badge), Site (or "Global"), Created. Sorted by most recent.
- **Filters**: Category dropdown + site dropdown
- **Actions**: "Forget" button per row (soft-delete)
- **Add**: Text input + "Remember" button at top (goes through LLM classifier)
- **No inline edit**: Forget + re-add for changes

Routes: `GET /dashboard/memories` (list), `POST /dashboard/memories` (add), `DELETE /dashboard/memories/:id` (forget).

## Chat Commands

| Trigger | Action |
|---------|--------|
| "remember that..." / "keep in mind..." / "always..." / "never..." | Detect → classify → store → confirm |
| "what do you remember?" / "what do you know about [site]?" | List active memories |
| "forget that..." / "stop remembering..." | Match → soft-delete → confirm |

Pure memory messages (no tasks) get an immediate response — no conversation state machine involvement. Confirmation format:
- Store: "Remembered: *content* (category for site)"
- List: Numbered list with category badges
- Forget: "Forgotten: *content*"

## Files to Create/Modify

### New files
- `src/db/memories.ts` — CRUD: `saveMemory()`, `getRelevantMemories()`, `forgetMemory()`, `listMemories()`, `findMatchingMemory()`
- `src/services/memory-classifier.ts` — LLM classification: `classifyMemory()`, `matchMemoryForForget()`
- `src/db/__tests__/memories.test.ts` — CRUD tests
- `src/services/__tests__/memory-classifier.test.ts` — classifier tests

### Modified files
- `src/db/database.ts` — Phase 18 migration
- `src/services/whatsapp-request-interpreter.ts` — Add `memories[]` to output, memory trigger detection
- `src/services/conversation/message-handlers.ts` — Handle memory-only messages (store + respond)
- `src/agents/content-strategist-agent.ts` — Inject memories into prompt
- `src/automation/browser-agent-prompt.ts` — Inject site rules
- `src/routes/dashboard.ts` — Memories tab + API routes
- `src/models/conversation.ts` — Add `memories` to `InterpretedRequest` type
