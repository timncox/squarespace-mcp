# User Memory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent user memory so Tim can tell the system things to remember across conversations (preferences, site rules, workflow shortcuts) via natural language or explicit commands.

**Architecture:** New `user_memories` SQLite table (Phase 18) with LLM-classified categories and auto-detected site scoping. Memories are injected into request interpreter, content strategist, and browser agent prompts. Dashboard gets a Memories tab for browsing/managing. Detection happens in the request interpreter (natural language) and via `/remember` command (explicit).

**Tech Stack:** SQLite (better-sqlite3), Claude Haiku (classification), Fastify (dashboard routes), existing Pino logger + error patterns.

---

### Task 1: Database Migration + CRUD Module

**Files:**
- Modify: `src/db/database.ts:263` (after Phase 17, before `logger.debug`)
- Create: `src/db/memories.ts`
- Create: `src/db/__tests__/memories.test.ts`

**Step 1: Write the failing tests**

Create `src/db/__tests__/memories.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { saveMemory, getRelevantMemories, forgetMemory, listMemories, getMemory } from '../memories.js';
import { getDb } from '../database.js';

// Reset memories table before each test
beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM user_memories');
});

describe('saveMemory', () => {
  it('creates a new memory with all fields', () => {
    const mem = saveMemory({
      content: 'Smyth Tavern uses dark themes',
      category: 'site_rule',
      siteId: 'grey-yellow-hbxc',
      tags: ['design', 'theme'],
      source: 'whatsapp',
    });
    expect(mem.id).toBeDefined();
    expect(mem.content).toBe('Smyth Tavern uses dark themes');
    expect(mem.category).toBe('site_rule');
    expect(mem.siteId).toBe('grey-yellow-hbxc');
    expect(mem.tags).toEqual(['design', 'theme']);
    expect(mem.source).toBe('whatsapp');
    expect(mem.active).toBe(true);
  });

  it('creates a global memory when siteId is null', () => {
    const mem = saveMemory({
      content: 'Always confirm before deleting pages',
      category: 'general',
      source: 'dashboard',
    });
    expect(mem.siteId).toBeUndefined();
    expect(mem.active).toBe(true);
  });

  it('deduplicates by content+siteId — updates and reactivates', () => {
    const mem1 = saveMemory({
      content: 'Use formal tone',
      category: 'client_preference',
      siteId: 'site-a',
      source: 'whatsapp',
    });
    forgetMemory(mem1.id);

    const mem2 = saveMemory({
      content: 'Use formal tone',
      category: 'client_preference',
      siteId: 'site-a',
      source: 'dashboard',
    });
    expect(mem2.id).toBe(mem1.id);
    expect(mem2.active).toBe(true);
  });

  it('treats same content with different siteId as separate memories', () => {
    const mem1 = saveMemory({ content: 'Use dark theme', category: 'site_rule', siteId: 'site-a', source: 'whatsapp' });
    const mem2 = saveMemory({ content: 'Use dark theme', category: 'site_rule', siteId: 'site-b', source: 'whatsapp' });
    expect(mem1.id).not.toBe(mem2.id);
  });
});

describe('getRelevantMemories', () => {
  it('returns global + site-specific memories', () => {
    saveMemory({ content: 'Global rule', category: 'general', source: 'whatsapp' });
    saveMemory({ content: 'Site rule', category: 'site_rule', siteId: 'site-a', source: 'whatsapp' });
    saveMemory({ content: 'Other site rule', category: 'site_rule', siteId: 'site-b', source: 'whatsapp' });

    const relevant = getRelevantMemories('site-a');
    expect(relevant).toHaveLength(2);
    expect(relevant.map(m => m.content)).toContain('Global rule');
    expect(relevant.map(m => m.content)).toContain('Site rule');
  });

  it('filters by category', () => {
    saveMemory({ content: 'A preference', category: 'client_preference', source: 'whatsapp' });
    saveMemory({ content: 'A rule', category: 'site_rule', source: 'whatsapp' });

    const rules = getRelevantMemories(undefined, ['site_rule']);
    expect(rules).toHaveLength(1);
    expect(rules[0].content).toBe('A rule');
  });

  it('excludes inactive memories', () => {
    const mem = saveMemory({ content: 'Forgotten', category: 'general', source: 'whatsapp' });
    forgetMemory(mem.id);

    const relevant = getRelevantMemories();
    expect(relevant).toHaveLength(0);
  });

  it('returns empty array when no memories exist', () => {
    expect(getRelevantMemories()).toEqual([]);
  });
});

describe('forgetMemory', () => {
  it('soft-deletes a memory', () => {
    const mem = saveMemory({ content: 'To forget', category: 'general', source: 'whatsapp' });
    forgetMemory(mem.id);

    const fetched = getMemory(mem.id);
    expect(fetched?.active).toBe(false);
  });
});

describe('listMemories', () => {
  it('returns all active memories sorted by most recent', () => {
    saveMemory({ content: 'First', category: 'general', source: 'whatsapp' });
    saveMemory({ content: 'Second', category: 'site_rule', siteId: 'site-a', source: 'dashboard' });

    const all = listMemories();
    expect(all).toHaveLength(2);
  });

  it('filters by siteId', () => {
    saveMemory({ content: 'Global', category: 'general', source: 'whatsapp' });
    saveMemory({ content: 'Site A', category: 'site_rule', siteId: 'site-a', source: 'whatsapp' });

    const siteOnly = listMemories('site-a');
    expect(siteOnly).toHaveLength(1);
    expect(siteOnly[0].content).toBe('Site A');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db/__tests__/memories.test.ts`
Expected: FAIL — module `../memories.js` not found

**Step 3: Add Phase 18 migration to database.ts**

In `src/db/database.ts`, after the Phase 17 block (line ~263, before `logger.debug('Database migrations applied')`), add:

```typescript
  // Phase 18 migrations — User memory (cross-conversation preferences)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      site_id TEXT,
      tags TEXT,
      source TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_user_memories_site ON user_memories(site_id);
    CREATE INDEX IF NOT EXISTS idx_user_memories_category ON user_memories(category);
    CREATE INDEX IF NOT EXISTS idx_user_memories_active ON user_memories(active);
  `);

  // Unique index for deduplication (content + site_id)
  try {
    db.exec('CREATE UNIQUE INDEX idx_user_memories_content_site ON user_memories(content, site_id)');
  } catch {
    // Index already exists
  }
```

**Step 4: Create `src/db/memories.ts`**

```typescript
/**
 * Database helpers for the user_memories table — cross-conversation user preferences.
 *
 * Follows the same patterns as learnings.ts:
 * - UUID text primary keys
 * - ISO timestamp strings
 * - JSON.stringify/parse for tags
 * - Deduplication by (content, site_id)
 */

import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MemoryCategory =
  | 'client_preference'
  | 'site_rule'
  | 'workflow_shortcut'
  | 'general';

export interface UserMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  siteId?: string;
  tags?: string[];
  source: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveMemoryInput {
  content: string;
  category: MemoryCategory;
  siteId?: string;
  tags?: string[];
  source: string;
}

// ─── CRUD Operations ────────────────────────────────────────────────────────

/**
 * Save a memory or reactivate an existing one with the same content+siteId.
 */
export function saveMemory(input: SaveMemoryInput): UserMemory {
  const db = getDb();
  const now = new Date().toISOString();

  // Check for existing memory with same content + site_id
  const existing = db
    .prepare(
      `SELECT * FROM user_memories
       WHERE content = ? AND (site_id IS ? OR (site_id IS NULL AND ? IS NULL))`,
    )
    .get(input.content, input.siteId ?? null, input.siteId ?? null) as
    | Record<string, unknown>
    | undefined;

  if (existing) {
    // Reactivate and update
    db.prepare(
      `UPDATE user_memories
       SET active = 1, category = ?, tags = ?, source = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.category, input.tags ? JSON.stringify(input.tags) : null, input.source, now, existing.id as string);

    logger.info({ id: existing.id, content: input.content }, 'Memory reactivated');
    return getMemory(existing.id as string)!;
  }

  // Create new
  const id = randomUUID();
  db.prepare(
    `INSERT INTO user_memories (id, content, category, site_id, tags, source, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.content,
    input.category,
    input.siteId ?? null,
    input.tags ? JSON.stringify(input.tags) : null,
    input.source,
    now,
    now,
  );

  logger.info({ id, category: input.category, siteId: input.siteId }, 'New memory created');
  return getMemory(id)!;
}

/**
 * Get a single memory by ID.
 */
export function getMemory(id: string): UserMemory | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM user_memories WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return rowToMemory(row);
}

/**
 * Get active memories relevant to a site context.
 * Returns global memories + site-specific ones.
 */
export function getRelevantMemories(
  siteId?: string,
  categories?: MemoryCategory[],
): UserMemory[] {
  const db = getDb();

  let sql = `SELECT * FROM user_memories
     WHERE active = 1
       AND (site_id IS NULL OR site_id = ?)`;

  const params: unknown[] = [siteId ?? null];

  if (categories && categories.length > 0) {
    const placeholders = categories.map(() => '?').join(',');
    sql += ` AND category IN (${placeholders})`;
    params.push(...categories);
  }

  sql += ` ORDER BY updated_at DESC LIMIT 20`;

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToMemory);
}

/**
 * Soft-delete a memory (set active = 0).
 */
export function forgetMemory(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE user_memories SET active = 0, updated_at = ? WHERE id = ?').run(now, id);
  logger.info({ id }, 'Memory forgotten');
}

/**
 * List active memories, optionally filtered by site.
 */
export function listMemories(siteId?: string): UserMemory[] {
  const db = getDb();

  if (siteId) {
    const rows = db
      .prepare('SELECT * FROM user_memories WHERE active = 1 AND site_id = ? ORDER BY updated_at DESC')
      .all(siteId) as Record<string, unknown>[];
    return rows.map(rowToMemory);
  }

  const rows = db
    .prepare('SELECT * FROM user_memories WHERE active = 1 ORDER BY updated_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToMemory);
}

// ─── Row Mapper ─────────────────────────────────────────────────────────────

function rowToMemory(row: Record<string, unknown>): UserMemory {
  return {
    id: row.id as string,
    content: row.content as string,
    category: row.category as MemoryCategory,
    siteId: (row.site_id as string) || undefined,
    tags: row.tags ? (JSON.parse(row.tags as string) as string[]) : undefined,
    source: row.source as string,
    active: (row.active as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/db/__tests__/memories.test.ts`
Expected: All 10 tests PASS

**Step 6: Commit**

```bash
git add src/db/database.ts src/db/memories.ts src/db/__tests__/memories.test.ts
git commit -m "feat: add user_memories table + CRUD module (Phase 18)"
```

---

### Task 2: Memory Classifier Service

**Files:**
- Create: `src/services/memory-classifier.ts`
- Create: `src/services/__tests__/memory-classifier.test.ts`

**Step 1: Write the failing tests**

Create `src/services/__tests__/memory-classifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyMemory, isMemoryTrigger, isForgetTrigger, isListMemoriesTrigger } from '../memory-classifier.js';

// Mock the Anthropic client
vi.mock('../../utils/anthropic-client.js', () => ({
  getAnthropicClient: () => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            content: 'Smyth Tavern uses dark themes',
            category: 'site_rule',
            siteId: 'grey-yellow-hbxc',
            tags: ['design', 'theme'],
          }),
        }],
      }),
    },
  }),
}));

vi.mock('../../config/models.js', () => ({
  MODEL_HAIKU: 'claude-haiku-4-5-20251001',
}));

describe('isMemoryTrigger', () => {
  it('detects "remember that" phrases', () => {
    expect(isMemoryTrigger('remember that Smyth uses dark themes')).toBe(true);
    expect(isMemoryTrigger('Remember: always use GBP')).toBe(true);
  });

  it('detects "keep in mind" phrases', () => {
    expect(isMemoryTrigger('keep in mind that site X uses blue')).toBe(true);
  });

  it('detects "don\'t forget" phrases', () => {
    expect(isMemoryTrigger("don't forget that menus should be in pounds")).toBe(true);
  });

  it('detects "always" and "never" as preference indicators', () => {
    expect(isMemoryTrigger('always use formal tone for law firms')).toBe(true);
    expect(isMemoryTrigger('never touch the footer on site X')).toBe(true);
  });

  it('does not trigger on normal task messages', () => {
    expect(isMemoryTrigger('update the menu on Smyth Tavern')).toBe(false);
    expect(isMemoryTrigger('add a new section to the homepage')).toBe(false);
  });

  it('does not trigger on short messages', () => {
    expect(isMemoryTrigger('yes')).toBe(false);
    expect(isMemoryTrigger('no')).toBe(false);
    expect(isMemoryTrigger('ok')).toBe(false);
  });
});

describe('isForgetTrigger', () => {
  it('detects forget requests', () => {
    expect(isForgetTrigger('forget that Smyth uses dark themes')).toBe(true);
    expect(isForgetTrigger('stop remembering that rule about footers')).toBe(true);
  });

  it('does not false-positive on other messages', () => {
    expect(isForgetTrigger('remember that Smyth uses dark themes')).toBe(false);
    expect(isForgetTrigger('update the menu')).toBe(false);
  });
});

describe('isListMemoriesTrigger', () => {
  it('detects list requests', () => {
    expect(isListMemoriesTrigger('what do you remember?')).toBe(true);
    expect(isListMemoriesTrigger('what do you remember about Smyth Tavern?')).toBe(true);
    expect(isListMemoriesTrigger('what do you know about site X?')).toBe(true);
    expect(isListMemoriesTrigger('list memories')).toBe(true);
  });

  it('does not false-positive', () => {
    expect(isListMemoriesTrigger('update the homepage')).toBe(false);
  });
});

describe('classifyMemory', () => {
  it('returns classified memory from LLM response', async () => {
    const result = await classifyMemory('Smyth Tavern uses dark themes');
    expect(result.content).toBe('Smyth Tavern uses dark themes');
    expect(result.category).toBe('site_rule');
    expect(result.siteId).toBe('grey-yellow-hbxc');
    expect(result.tags).toEqual(['design', 'theme']);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/memory-classifier.test.ts`
Expected: FAIL — module not found

**Step 3: Write the memory classifier**

Create `src/services/memory-classifier.ts`:

```typescript
/**
 * Memory classifier — detects memory triggers in messages and classifies
 * them into categories using an LLM call.
 */

import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_HAIKU } from '../config/models.js';
import { loadSitesConfig } from './task-extractor.js';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import type { MemoryCategory } from '../db/memories.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ClassifiedMemory {
  content: string;
  category: MemoryCategory;
  siteId?: string;
  tags?: string[];
}

// ─── Trigger Detection ──────────────────────────────────────────────────────

const MEMORY_TRIGGERS = [
  /\bremember\s+(that|this|:)/i,
  /\bkeep\s+in\s+mind/i,
  /\bdon'?t\s+forget/i,
  /^always\b/i,
  /^never\b/i,
];

const FORGET_TRIGGERS = [
  /\bforget\s+(that|about|the)/i,
  /\bstop\s+remembering/i,
  /\bremove\s+(that\s+)?memory/i,
];

const LIST_TRIGGERS = [
  /\bwhat\s+do\s+you\s+remember/i,
  /\bwhat\s+do\s+you\s+know\s+about/i,
  /\blist\s+memories/i,
  /\bshow\s+memories/i,
];

export function isMemoryTrigger(text: string): boolean {
  if (text.length < 10) return false;
  // Don't trigger on forget requests
  if (isForgetTrigger(text)) return false;
  return MEMORY_TRIGGERS.some((re) => re.test(text));
}

export function isForgetTrigger(text: string): boolean {
  return FORGET_TRIGGERS.some((re) => re.test(text));
}

export function isListMemoriesTrigger(text: string): boolean {
  return LIST_TRIGGERS.some((re) => re.test(text));
}

// ─── LLM Classification ────────────────────────────────────────────────────

/**
 * Classify a memory statement using Claude Haiku.
 * Extracts the core preference/rule, categorizes it, and detects site scope.
 */
export async function classifyMemory(memoryText: string): Promise<ClassifiedMemory> {
  const sitesConfig = loadSitesConfig();
  const siteNames = sitesConfig.clients.map((c) => ({
    name: c.name,
    id: c.id,
    aliases: c.aliases,
  }));

  const response = await getAnthropicClient().messages.create({
    model: MODEL_HAIKU,
    max_tokens: 512,
    system: `You classify user preferences/rules for a Squarespace website management system.

Given a statement from the user, extract:
1. "content" — the core rule/preference (clean, concise, imperative)
2. "category" — one of: "client_preference" (tone, style, branding), "site_rule" (do/don't do on specific site), "workflow_shortcut" (shorthand definitions), "general" (applies everywhere)
3. "siteId" — the site subdomain if a specific site is mentioned, null if global
4. "tags" — 1-3 relevant tags (e.g., ["design", "theme"], ["menu", "pricing"])

Available sites: ${JSON.stringify(siteNames)}

Respond with JSON only, no markdown.`,
    messages: [{ role: 'user', content: memoryText }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : '{}';

  try {
    const parsed = JSON.parse(text.trim());
    return {
      content: parsed.content || memoryText,
      category: parsed.category || 'general',
      siteId: parsed.siteId || undefined,
      tags: Array.isArray(parsed.tags) ? parsed.tags : undefined,
    };
  } catch (err) {
    logger.warn({ error: errMsg(err), response: text }, 'Failed to parse memory classification — using defaults');
    return {
      content: memoryText,
      category: 'general',
    };
  }
}

/**
 * Match a "forget" request against existing memories using Claude Haiku.
 * Returns the ID of the best-matching memory, or undefined if no match.
 */
export async function matchMemoryForForget(
  forgetText: string,
  memories: Array<{ id: string; content: string; siteId?: string }>,
): Promise<string | undefined> {
  if (memories.length === 0) return undefined;

  const memoryList = memories.map((m, i) => `${i}. "${m.content}" (site: ${m.siteId || 'global'})`).join('\n');

  const response = await getAnthropicClient().messages.create({
    model: MODEL_HAIKU,
    max_tokens: 64,
    system: `The user wants to forget a previously saved memory. Match their request to one of the existing memories below. Respond with ONLY the index number (0-based) of the best match, or "none" if nothing matches.

Existing memories:
${memoryList}`,
    messages: [{ role: 'user', content: forgetText }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = (textBlock?.type === 'text' ? textBlock.text : '').trim();

  if (text === 'none') return undefined;

  const index = parseInt(text, 10);
  if (isNaN(index) || index < 0 || index >= memories.length) return undefined;

  return memories[index].id;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/memory-classifier.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/services/memory-classifier.ts src/services/__tests__/memory-classifier.test.ts
git commit -m "feat: add memory classifier with trigger detection + LLM classification"
```

---

### Task 3: Wire Memory Detection into Request Interpreter

**Files:**
- Modify: `src/models/conversation.ts:23-26` (add `memories` to `InterpretedRequest`)
- Modify: `src/services/whatsapp-request-interpreter.ts:23-26` (add `memories` field)
- Modify: `src/services/whatsapp-request-interpreter.ts:94` (inject memories into prompt)
- Modify: `src/services/whatsapp-request-interpreter.ts:139` (add memory instructions to system prompt)
- Modify: `src/services/whatsapp-request-interpreter.ts:243-283` (parse `memories` from response)

**Step 1: Add `memories` to InterpretedRequest type**

In `src/services/whatsapp-request-interpreter.ts`, update the `InterpretedRequest` interface (line ~23):

```typescript
export interface InterpretedRequest {
  tasks: InterpretedTask[];
  memories: InterpretedMemory[];
  reasoning: string;
}

export interface InterpretedMemory {
  content: string;
  /** Raw text that triggered memory detection — used for LLM classification */
  rawText: string;
}
```

**Step 2: Inject user memories into the interpreter prompt**

In `buildInterpreterPrompt()` (line ~94), add a parameter for existing memories and render them:

```typescript
function buildInterpreterPrompt(
  sitesConfig: SitesConfig,
  discoveredSites?: DiscoveredSite[],
  userMemories?: Array<{ content: string; category: string; siteId?: string }>,
): string {
```

At the end of the prompt string (before the closing backtick at line ~238), add:

```typescript
${userMemories && userMemories.length > 0 ? `
## User Preferences (remembered from previous conversations)
${userMemories.map((m) => `- ${m.siteId ? `[${m.siteId}] ` : ''}${m.content}`).join('\n')}

Use these preferences to resolve ambiguity. For example, if a preference says "when I say menu, I mean the food menu on the dining page", use that context when interpreting requests.` : ''}
```

**Step 3: Add memory detection instructions to the system prompt**

In the `## Instructions` section of `buildInterpreterPrompt` (around line 183), add as item 12:

```
12. **Memory detection**: If Tim's message contains a preference, rule, or shortcut he wants remembered (phrases like "remember that...", "keep in mind...", "always...", "never..." in the context of a preference), include it in the "memories" array. A message can have BOTH tasks AND memories. If the message is ONLY a memory statement with no editing tasks, return an empty tasks array and populate the memories array.
```

**Step 4: Update the response format in the prompt**

In the JSON response format examples (around line 203), add:

```json
{
  "reasoning": "...",
  "tasks": [...],
  "memories": [
    {
      "content": "Smyth Tavern uses dark section themes",
      "rawText": "remember that Smyth Tavern uses dark themes"
    }
  ]
}
```

**Step 5: Update the response parser**

In `parseInterpreterResponse()` (line ~243), add `memories` parsing:

```typescript
    const memories: InterpretedMemory[] = Array.isArray(parsed.memories)
      ? parsed.memories.map((m: Record<string, unknown>) => ({
          content: (m.content as string) || '',
          rawText: (m.rawText as string) || (m.content as string) || '',
        }))
      : [];

    return {
      tasks,
      memories,
      reasoning: (parsed.reasoning as string) || '',
    };
```

Also update the error fallback return to include `memories: []`.

**Step 6: Pass user memories into the interpreter call**

In `interpretWhatsAppRequest()` (line ~44), import and call `getRelevantMemories`:

```typescript
import { getRelevantMemories } from '../db/memories.js';
```

Before the `getAnthropicClient().messages.create()` call, fetch memories:

```typescript
  const userMemories = getRelevantMemories().map((m) => ({
    content: m.content,
    category: m.category,
    siteId: m.siteId,
  }));
  const systemPrompt = buildInterpreterPrompt(sitesConfig, discoveredSites, userMemories);
```

**Step 7: Run existing tests to verify no regressions**

Run: `npx vitest run src/services/__tests__/whatsapp-request-interpreter.test.ts` (if test file exists) AND `npx vitest run src/automation/__tests__/` (main test suite)
Expected: PASS (existing behavior unchanged — `memories` defaults to `[]`)

**Step 8: Commit**

```bash
git add src/services/whatsapp-request-interpreter.ts
git commit -m "feat: add memory detection to request interpreter"
```

---

### Task 4: Handle Memory Messages in Conversation Flow

**Files:**
- Modify: `src/services/conversation/message-handlers.ts:170-195` (after interpreter call, before task creation)
- Modify: `src/services/conversation-handler.ts:202-211` (intercept memory-only messages before handleDirectRequest)

**Step 1: Add memory handling to handleDirectRequest**

In `src/services/conversation/message-handlers.ts`, after the interpreter returns (line ~191), before the "No tasks extracted" check (line ~192), add memory processing:

```typescript
    // ─── Process memories ────────────────────────────────────────────────
    if (interpreted.memories && interpreted.memories.length > 0) {
      const { classifyMemory } = await import('../memory-classifier.js');
      const { saveMemory } = await import('../../db/memories.js');
      const source = msg.from === 'dashboard' ? 'dashboard' : 'whatsapp';

      const savedMemories: string[] = [];
      for (const mem of interpreted.memories) {
        try {
          const classified = await classifyMemory(mem.rawText);
          const saved = saveMemory({
            content: classified.content,
            category: classified.category,
            siteId: classified.siteId,
            tags: classified.tags,
            source,
          });
          const scope = saved.siteId ? ` for ${saved.siteId}` : '';
          savedMemories.push(`Remembered: *${saved.content}* (${saved.category}${scope})`);
        } catch (err) {
          logger.error({ error: errMsg(err) }, 'Failed to classify/save memory');
        }
      }

      // If there are memories but NO tasks, respond immediately and return
      if (interpreted.tasks.length === 0 && savedMemories.length > 0) {
        await sendToTim(savedMemories.join('\n'));
        return;
      }

      // If there are both memories AND tasks, send memory confirmation alongside task flow
      if (savedMemories.length > 0) {
        await sendToTim(savedMemories.join('\n'));
      }
    }
```

**Step 2: Add forget/list handling before routing**

In `src/services/conversation-handler.ts`, in `handleIncomingMessage()` before the `if (!conversation)` block (line ~202), add memory command interception:

```typescript
  // ─── Memory commands (work regardless of conversation state) ────────────
  const { isForgetTrigger, isListMemoriesTrigger, matchMemoryForForget } = await import('./memory-classifier.js');
  const { listMemories, forgetMemory: forgetMem } = await import('../db/memories.js');

  if (isListMemoriesTrigger(msg.body)) {
    // Extract site name hint from message (e.g., "what do you remember about Smyth?")
    const memories = listMemories(); // TODO: could parse site from message
    if (memories.length === 0) {
      await sendToTim("I don't have any saved memories yet. Tell me something to remember!");
    } else {
      const list = memories.map((m, i) =>
        `${i + 1}. *${m.content}* — ${m.category}${m.siteId ? ` (${m.siteId})` : ' (global)'}`
      ).join('\n');
      await sendToTim(`Here's what I remember:\n\n${list}`);
    }
    return;
  }

  if (isForgetTrigger(msg.body)) {
    const memories = listMemories();
    const matchId = await matchMemoryForForget(msg.body, memories);
    if (matchId) {
      const mem = memories.find((m) => m.id === matchId);
      forgetMem(matchId);
      await sendToTim(`Forgotten: *${mem?.content ?? 'memory'}*`);
    } else {
      await sendToTim("I couldn't find a matching memory to forget. Use 'what do you remember?' to see all memories.");
    }
    return;
  }
```

**Step 3: Run the full test suite**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**'`
Expected: All existing tests pass (new paths are additive)

**Step 4: Commit**

```bash
git add src/services/conversation/message-handlers.ts src/services/conversation-handler.ts
git commit -m "feat: wire memory save/forget/list into conversation flow"
```

---

### Task 5: Inject Memories into Content Strategist

**Files:**
- Modify: `src/agents/content-strategist-agent.ts:254` (fetch memories alongside learnings)
- Modify: `src/agents/content-strategist-agent.ts:302-312` (add memories param to buildStrategyPrompt)
- Modify: `src/agents/content-strategist-agent.ts:550-560` (render memories section after learnings)

**Step 1: Add memories parameter to buildStrategyPrompt**

In `src/agents/content-strategist-agent.ts`, update the `buildStrategyPrompt` signature (line ~302) to accept memories:

```typescript
function buildStrategyPrompt(
  tasks: Task[],
  research: ResearchResult | undefined,
  siteAnalysis: SiteAnalysis | undefined,
  revisionFeedback?: string,
  previousPlan?: ContentPlan,
  learnings?: Learning[],
  discoveredTemplates?: TemplateDiscoveryResult,
  pageStructures?: Record<string, PageStructure>,
  navigationData?: NavigationData,
  userMemories?: Array<{ content: string; category: string; siteId?: string }>,
): string {
```

**Step 2: Render memories in the prompt**

After the learnings section (line ~560), add:

```typescript
  // User memories (stated preferences from Tim)
  if (userMemories && userMemories.length > 0) {
    parts.push('## User Preferences (from Tim)\n');
    parts.push('Tim has specifically asked to remember these preferences. Follow them:\n');
    for (const m of userMemories) {
      const scope = m.siteId ? `[${m.siteId}]` : '[global]';
      parts.push(`- ${scope} ${m.content}`);
    }
    parts.push('');
  }
```

**Step 3: Fetch and pass memories in runContentStrategistAgent**

In `runContentStrategistAgent()` (line ~254), after `getRelevantLearnings`:

```typescript
  const { getRelevantMemories } = await import('../db/memories.js');
  const userMemories = getRelevantMemories(primaryTask?.siteId).map((m) => ({
    content: m.content,
    category: m.category,
    siteId: m.siteId,
  }));
```

Pass `userMemories` to `buildStrategyPrompt()` (line ~259).

**Step 4: Run tests**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**'`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/content-strategist-agent.ts
git commit -m "feat: inject user memories into content strategist prompt"
```

---

### Task 6: Inject Memories into Browser Agent Prompt

**Files:**
- Modify: `src/automation/browser-agent-prompt.ts:596-599` (add memories parameter)
- Modify: `src/automation/browser-agent-prompt.ts` (add memories rendering in prompt assembly)

**Step 1: Add memories parameter to buildSystemPrompt**

Update the function signature (line ~596):

```typescript
export function buildSystemPrompt(
  siteContext?: { pages: PageConfig[]; siteName: string },
  learnings?: Learning[],
  userMemories?: Array<{ content: string; siteId?: string }>,
): SystemPromptBlock[] {
```

**Step 2: Add memories to the prompt output**

In the prompt assembly logic (after the learnings section is built), add a memory block:

```typescript
  // Add user memories as a text block (site rules only, max 5, keep prompt lean)
  if (userMemories && userMemories.length > 0) {
    const memoryLines = userMemories
      .slice(0, 5)
      .map((m) => `- ${m.content}`)
      .join('\n');
    blocks.push({
      type: 'text' as const,
      text: `## User Preferences\nTim has asked to remember these rules. Follow them:\n${memoryLines}`,
    });
  }
```

**Step 3: Pass memories from the caller**

In `src/automation/browser-agent.ts`, where `buildSystemPrompt` is called, fetch and pass memories:

```typescript
import { getRelevantMemories } from '../db/memories.js';

// In the agent loop, when building the prompt:
const memories = getRelevantMemories(siteId, ['site_rule']).map((m) => ({
  content: m.content,
  siteId: m.siteId,
}));
const systemPrompt = buildSystemPrompt(siteContext, learnings, memories);
```

**Step 4: Run tests**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**'`
Expected: PASS

**Step 5: Commit**

```bash
git add src/automation/browser-agent-prompt.ts src/automation/browser-agent.ts
git commit -m "feat: inject user memories (site rules) into browser agent prompt"
```

---

### Task 7: Dashboard Memories Tab

**Files:**
- Modify: `src/routes/dashboard.ts:74-80` (add tab)
- Modify: `src/routes/dashboard.ts` (add render function + route handlers)

**Step 1: Add the Memories tab to navigation**

In `src/routes/dashboard.ts`, update the `tabs` array (line ~74):

```typescript
  const tabs = [
    { id: 'tasks', label: 'Tasks', href: '/dashboard' },
    { id: 'clients', label: 'Clients', href: '/dashboard/clients' },
    { id: 'agents', label: 'Agents', href: '/dashboard/agents' },
    { id: 'learnings', label: 'Learnings', href: '/dashboard/learnings' },
    { id: 'memories', label: 'Memories', href: '/dashboard/memories' },
    { id: 'chat', label: 'Chat', href: '/dashboard/chat' },
  ];
```

**Step 2: Add the renderMemoriesPage function**

Add near the other render functions (after `renderLearningsPage`):

```typescript
function renderMemoriesPage(memories: import('../db/memories.js').UserMemory[]): string {
  const categoryBadge = (cat: string) => {
    const colors: Record<string, string> = {
      client_preference: '#a78bfa',
      site_rule: '#f97316',
      workflow_shortcut: '#22d3ee',
      general: '#94a3b8',
    };
    const color = colors[cat] || '#94a3b8';
    return `<span style="background:${color}20;color:${color};padding:2px 8px;border-radius:4px;font-size:0.75rem">${escapeHtml(cat)}</span>`;
  };

  const addForm = `
    <div class="card" style="margin-bottom:1rem">
      <form method="POST" action="/dashboard/memories" style="display:flex;gap:0.5rem;align-items:center">
        <input name="content" placeholder="Tell me something to remember..."
               style="flex:1;padding:0.5rem;border-radius:0.5rem;border:1px solid #334155;background:#1e293b;color:#e2e8f0" required>
        <button type="submit" style="padding:0.5rem 1rem;border-radius:0.5rem;border:none;background:#3b82f6;color:white;cursor:pointer">Remember</button>
      </form>
    </div>`;

  if (memories.length === 0) {
    return `${addForm}<div class="empty-state"><div class="icon">🧠</div><p>No memories yet. Tell me something to remember!</p></div>`;
  }

  const rows = memories
    .map(
      (m) => `
      <tr>
        <td>${escapeHtml(m.content)}</td>
        <td>${categoryBadge(m.category)}</td>
        <td class="mono small">${escapeHtml(m.siteId || 'Global')}</td>
        <td class="small muted">${m.tags ? escapeHtml(m.tags.join(', ')) : ''}</td>
        <td class="small muted">${escapeHtml(m.source)}</td>
        <td class="small muted">${new Date(m.createdAt).toLocaleDateString()}</td>
        <td>
          <form method="POST" action="/dashboard/memories/${m.id}/forget" style="display:inline">
            <button type="submit" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.8rem">Forget</button>
          </form>
        </td>
      </tr>`,
    )
    .join('');

  const stats = `
    <div class="stats-row">
      <div class="stat"><div class="value">${memories.length}</div><div class="label">Active</div></div>
      <div class="stat"><div class="value">${memories.filter((m) => !m.siteId).length}</div><div class="label">Global</div></div>
      <div class="stat"><div class="value">${memories.filter((m) => m.siteId).length}</div><div class="label">Site-Specific</div></div>
    </div>`;

  return `${addForm}${stats}
    <div class="card">
      <h2>Saved Memories</h2>
      <table>
        <thead><tr><th>Memory</th><th>Category</th><th>Site</th><th>Tags</th><th>Source</th><th>Created</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
```

**Step 3: Add route handlers**

Add near the other dashboard routes:

```typescript
  // ─── Memories Tab ───────────────────────────────────────────────────────
  app.get('/dashboard/memories', async (_request: FastifyRequest, reply: FastifyReply) => {
    const { listMemories } = await import('../db/memories.js');
    const memories = listMemories();
    const html = layout('Memories', 'memories', renderMemoriesPage(memories));
    return reply.type('text/html').send(html);
  });

  app.post('/dashboard/memories', async (request: FastifyRequest, reply: FastifyReply) => {
    const { content } = request.body as { content: string };
    if (!content || content.trim().length < 3) {
      return reply.redirect('/dashboard/memories');
    }

    try {
      const { classifyMemory } = await import('../services/memory-classifier.js');
      const { saveMemory } = await import('../db/memories.js');

      const classified = await classifyMemory(content.trim());
      saveMemory({
        content: classified.content,
        category: classified.category,
        siteId: classified.siteId,
        tags: classified.tags,
        source: 'dashboard',
      });
    } catch (err) {
      logger.error({ error: errMsg(err) }, 'Failed to save memory from dashboard');
    }

    return reply.redirect('/dashboard/memories');
  });

  app.post('/dashboard/memories/:id/forget', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { forgetMemory } = await import('../db/memories.js');
    forgetMemory(id);
    return reply.redirect('/dashboard/memories');
  });
```

**Step 4: Run tests**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**'`
Expected: PASS

**Step 5: Commit**

```bash
git add src/routes/dashboard.ts
git commit -m "feat: add Memories tab to dashboard with add/forget UI"
```

---

### Task 8: Integration Test + Full Suite Verification

**Files:**
- Run full test suite
- Verify no regressions

**Step 1: Run full test suite**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**'`
Expected: All ~1771+ tests pass (plus new memory tests)

**Step 2: Run TypeScript compile check**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 3: Verify the feature end-to-end manually (optional)**

Start the dev server: `npm run dev`
1. Open `http://localhost:3000/dashboard/memories` — should show empty state + add form
2. Add a memory via the form — should classify and display
3. Click "Forget" — should soft-delete
4. Check the Chat tab — type "remember that Smyth uses dark themes" — should save and confirm

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: user memory system — store, classify, inject, and manage preferences"
```
