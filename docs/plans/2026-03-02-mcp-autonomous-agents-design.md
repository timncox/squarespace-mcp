# MCP Server + Autonomous Agents — Design Document

**Date:** 2026-03-02
**Status:** Draft
**Replaces:** Direct Anthropic SDK orchestration + claude-code-proxy

## Problem

The current architecture manually orchestrates ~19 LLM API calls across 18 files, using a local proxy (`claude-code-proxy`) to convert Claude Max OAuth into API access. Each pipeline stage (classifier, research, strategist, executor, supervisor) is hand-coded: build prompt, call `messages.create()`, parse response, route to next step. This results in ~9,500 lines of orchestration/parsing code on top of the actual Squarespace API logic.

## Solution

Replace the hand-coded orchestration with **autonomous Claude CLI agents** that access Squarespace functionality via an **MCP server**. Each pipeline stage becomes a Claude agent spawned with `claude -p` that reasons and calls tools on its own. The Claude CLI handles auth (Claude Max subscription), tool loops, context management, and error recovery.

## Architecture Overview

```
Email/WhatsApp/Dashboard
        │
        ▼
  ┌─────────────┐
  │ Orchestrator │  (TypeScript, not an LLM)
  │  index.ts    │
  └──────┬───────┘
         │
    ┌────┴────┐
    │ Simple? │──yes──▶ Direct API call (~2-3s)
    └────┬────┘
         │ no
         ▼
  ┌──────────────┐     ┌──────────────┐
  │  Researcher  │────▶│   Analyst     │
  │  (Haiku)     │     │  (Sonnet)     │
  └──────────────┘     └──────┬───────┘
                              │
                       ┌──────▼───────┐
                       │  Strategist   │
                       │  (Sonnet)     │
                       └──────┬───────┘
                              │
                       ┌──────▼───────┐
                       │   Executor    │  ◄── ALL MCP tools
                       │  (Sonnet)     │
                       └──────┬───────┘
                              │
                       ┌──────▼───────┐
                       │  Supervisor   │
                       │  (Sonnet)     │
                       └──────────────┘
                              │
                     ┌────────┴─────────┐
                     │ Browser fallback? │
                     └────────┬─────────┘
                              │ yes
                       ┌──────▼───────┐
                       │ Fallback Log  │──▶ Dashboard + future API tools
                       └──────────────┘
```

## 1. MCP Server

A stdio-transport MCP server that wraps the existing `ContentSaveClient` (91+ methods) and `MediaUploadClient` as ~40 high-level tools.

### Directory Structure

```
src/mcp-server/
  index.ts              # Entry point, McpServer + StdioServerTransport
  session.ts            # Cookie/auth management, shared client instances
  tools/
    text.ts             # sq_read_page, sq_update_text, sq_patch_text, sq_add_text
    image.ts            # sq_upload_image, sq_replace_image, sq_add_image, sq_add_image_batch
    button.ts           # sq_add_button, sq_update_button
    menu.ts             # sq_get_menu, sq_update_menu
    section.ts          # sq_add_blank_section, sq_add_template_section, sq_move_section, sq_style_section, sq_duplicate_section
    block-layout.ts     # sq_move_block, sq_resize_block, sq_remove_block, sq_swap_blocks, sq_duplicate_block
    page.ts             # sq_create_page, sq_delete_page, sq_update_page_seo, sq_list_pages
    blog.ts             # sq_create_blog_post, sq_update_blog_post
    navigation.ts       # sq_get_navigation, sq_reorder_navigation
    design.ts           # sq_update_font, sq_update_color, sq_update_tweaks
    settings.ts         # sq_get_settings, sq_update_settings, sq_edit_css, sq_edit_code_injection
    header-footer.ts    # sq_update_header_text, sq_update_footer_text
    screenshot.ts       # sq_take_screenshot (Playwright)
    browser.ts          # sq_browser_click, sq_browser_type, sq_browser_navigate, sq_browser_upload (fallback)
```

### Design Principles

**Tools are higher-level than raw ContentSaveClient methods.** Each tool takes human-readable inputs (`siteId` + `pageSlug`) and handles page ID resolution internally. The agent doesn't need to know about `pageSectionsId` or `collectionId`.

**Session cookies loaded once at server startup.** A shared `session.ts` module creates `ContentSaveClient` and `MediaUploadClient` instances per site, caching them for the server's lifetime. The `reloadSessionCookies()` method refreshes if stale.

**Browser fallback tools are explicitly separate.** The `browser.ts` tools are named with `sq_browser_*` prefix so agents can be instructed to prefer `sq_*` API tools and only fall back to `sq_browser_*` when API tools fail.

### Tool Catalog (~40 tools)

#### Read Tools (8)
| Tool | Description |
|------|-------------|
| `sq_read_page` | Read page sections/blocks as JSON (resolves slug → page IDs internally) |
| `sq_get_navigation` | Get site navigation structure (main nav + not-linked pages) |
| `sq_get_settings` | Get site settings (63 fields) |
| `sq_list_pages` | List all pages with slugs and types |
| `sq_get_menu` | Read menu block structure (tabs/sections/items) |
| `sq_get_header_footer` | Read header/footer sections |
| `sq_get_design` | Read fonts, colors, and template tweaks |
| `sq_take_screenshot` | Screenshot a page via Playwright, returns base64 image |

#### Text Tools (4)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_update_text` | siteId, pageSlug, searchText, newText, mode(replace\|patch) | Update existing text block |
| `sq_add_text` | siteId, pageSlug, sectionIndex, text, blockType? | Add new text block to section |
| `sq_format_text` | siteId, pageSlug, searchText, heading?, bold?, italic?, alignment? | Apply formatting to text block |
| `sq_update_text_html` | siteId, pageSlug, searchText, rawHtml | Set raw HTML on text block |

#### Image Tools (4)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_upload_image` | filePath | Upload image, returns assetUrl |
| `sq_replace_image` | siteId, pageSlug, searchText, filePath, altText? | Replace existing image |
| `sq_add_image` | siteId, pageSlug, sectionIndex, filePath, altText?, columns? | Add image block |
| `sq_add_image_batch` | siteId, pageSlug, sectionIndex, images[], columns? | Add multiple images (gallery grid) |

#### Button Tools (2)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_add_button` | siteId, pageSlug, sectionIndex, label, url, size?, style?, alignment?, variant? | Add button block |
| `sq_update_button` | siteId, pageSlug, searchText, newLabel?, url?, size?, style?, alignment?, variant? | Update existing button |

#### Menu Tools (1)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_update_menu` | siteId, pageSlug, searchText, menus, mode(replace\|merge) | Update menu block (structured JSON) |

#### Section Tools (5)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_add_blank_section` | siteId, pageSlug, position? | Add empty section |
| `sq_add_template_section` | siteId, pageSlug, category, templateIndex, replacements?, position? | Add section from template catalog with optional text/image/button replacements |
| `sq_move_section` | siteId, pageSlug, searchText, direction(up\|down) | Reorder section |
| `sq_style_section` | siteId, pageSlug, sectionIndex, theme?, height?, contentWidth?, divider? | Style section |
| `sq_duplicate_section` | siteId, pageSlug, sectionIndex | Duplicate section |

#### Block Layout Tools (4)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_move_block` | siteId, pageSlug, searchText, direction(up\|down\|left\|right) | Move block in grid |
| `sq_resize_block` | siteId, pageSlug, searchText, width?, height? | Resize block |
| `sq_remove_block` | siteId, pageSlug, searchText | Remove block from section |
| `sq_swap_blocks` | siteId, pageSlug, searchText1, searchText2 | Swap two blocks' positions |

#### Page Management Tools (3)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_create_page` | siteId, title, slug?, pageType?(page\|blog) | Create new page |
| `sq_delete_page` | siteId, pageSlug | Delete page |
| `sq_update_page_seo` | siteId, pageSlug, seoTitle?, seoDescription?, keywords? | Update page metadata |

#### Blog Tools (2)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_create_blog_post` | siteId, blogSlug, title, content?, draft? | Create blog post |
| `sq_update_blog_post` | siteId, postId, title?, content?, draft? | Update blog post |

#### Site-Wide Tools (6)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_reorder_navigation` | siteId, pageOrder[] | Reorder pages in navigation |
| `sq_update_font` | siteId, fontName, fontFamily, weight?, style? | Change a site font |
| `sq_update_color` | siteId, colorId, hsl | Change a palette color |
| `sq_update_settings` | siteId, fields | Update site settings (partial) |
| `sq_edit_css` | siteId, css, mode(append\|replace) | Edit custom CSS |
| `sq_edit_code_injection` | siteId, header?, footer? | Edit code injection |

#### Header/Footer Tools (2)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_update_header_text` | siteId, searchText, newText | Patch header text block |
| `sq_update_footer_text` | siteId, searchText, newText | Patch footer text block |

#### Browser Fallback Tools (5)
| Tool | Params | Description |
|------|--------|-------------|
| `sq_browser_navigate` | url | Navigate browser to URL |
| `sq_browser_click` | selector | Click element by CSS selector |
| `sq_browser_type` | selector, text | Type into element |
| `sq_browser_upload` | selector, filePath | Upload file via input element |
| `sq_browser_screenshot` | (none) | Screenshot current browser state |

### Example Tool Implementation

```typescript
// src/mcp-server/tools/text.ts
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient } from '../session.js';

export function registerTextTools(server: McpServer) {
  server.registerTool('sq_update_text', {
    description: 'Update text on a Squarespace page. Finds the block containing searchText and replaces it. Use mode="patch" for surgical substring replacement (safer) or mode="replace" for full block replacement.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (e.g. "smyth-tavern")'),
      pageSlug: z.string().describe('Page slug (e.g. "home", "about", "menu")'),
      searchText: z.string().describe('Existing text to find (partial match, case-sensitive)'),
      newText: z.string().describe('New text content (HTML supported for replace mode)'),
      mode: z.enum(['replace', 'patch']).default('patch')
        .describe('"patch" = surgical substring swap (recommended), "replace" = full block replacement'),
    },
  }, async ({ siteId, pageSlug, searchText, newText, mode }) => {
    try {
      const client = await getClient(siteId);
      const { pageSectionsId, collectionId } = await client.resolvePageIds(pageSlug);

      const result = mode === 'patch'
        ? await client.patchTextBlock(pageSectionsId, collectionId, searchText, newText)
        : await client.updateTextBlock(pageSectionsId, collectionId, searchText, newText);

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, matched: result.matched }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  server.registerTool('sq_add_text', {
    description: 'Add a new text block to a section on a Squarespace page.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page slug'),
      sectionIndex: z.number().describe('Section index (0-based) to add the block to'),
      text: z.string().describe('Text content (HTML supported, e.g. "<h2>Title</h2><p>Body</p>")'),
      blockType: z.enum(['text', 'heading']).default('text').describe('Block type'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, text, blockType }) => {
    try {
      const client = await getClient(siteId);
      const { pageSectionsId, collectionId } = await client.resolvePageIds(pageSlug);
      const result = await client.addTextBlock(pageSectionsId, collectionId, sectionIndex, text);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: result.success, blockId: result.blockId }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ... sq_patch_text, sq_format_text, sq_update_text_html
}
```

### MCP Config File

```json
{
  "mcpServers": {
    "squarespace": {
      "command": "node",
      "args": ["dist/mcp-server/index.js"],
      "env": {
        "SESSION_DIR": "./data/sessions",
        "SITES_CONFIG": "./config/sites.json",
        "DB_PATH": "./data/sqhelper.db"
      }
    }
  }
}
```

---

## 2. Agent Definitions

Six specialized agents. Each is defined by a system prompt file and a spawn configuration.

### Agent Roster

| Agent | Model | Max Turns | Tools | Purpose |
|-------|-------|-----------|-------|---------|
| **classifier** | Haiku | 1 | none | Route: simple → fast path, complex → agent pipeline |
| **researcher** | Haiku | 5 | WebSearch (built-in) | Gather content/info from the web |
| **analyst** | Sonnet | 3 | `sq_read_page`, `sq_take_screenshot`, `sq_get_navigation`, `sq_list_pages` | Understand current page state |
| **strategist** | Sonnet | 3 | `sq_read_page`, `sq_get_navigation`, `sq_list_pages`, `sq_get_design` | Plan the operations |
| **executor** | Sonnet | 30 | ALL tools (API + browser fallback) | Perform the edits |
| **supervisor** | Sonnet | 5 | `sq_read_page`, `sq_take_screenshot` | Verify the result |

### Prompt Files

```
src/orchestrator/prompts/
  classifier.md
  researcher.md
  analyst.md
  strategist.md
  executor.md
  supervisor.md
```

### Prompt Sources — Reusing Existing Skill Files

The project already has 7 task-oriented skill files and 2 comprehensive reference files that contain most of the prompt engineering needed:

| Agent Prompt | Built From | Adaptation Needed |
|-------------|-----------|-------------------|
| `analyst.md` | `squarespace-snapshot.md` | Replace CLI commands with MCP tool names |
| `strategist.md` | `squarespace.md` (agent ref) + `squarespace-create.md` + `squarespace-edit.md` | Replace CLI commands, add JSON plan output format |
| `executor.md` | All 7 skill files + `squarespace.md` | Replace CLI commands, add API-first/browser-fallback rules, add BROWSER_FALLBACK reporting |
| `supervisor.md` | `squarespace-snapshot.md` + `squarespace-edit.md` | Replace CLI commands, add verdict output format |
| `researcher.md` | (new, short) | ~20 lines, web search focused |
| `classifier.md` | `squarespace-commands.md` "Simple Edit Fast Path Types" | Extract routing logic, add output schema |

**What transfers directly (no changes needed):**
- Block type reference (15 types with JSON structure)
- Desktop grid system (24 columns, start/end coordinates)
- Read-modify-write pattern documentation
- All gotchas (backfill verticalAlignment, 24-char section IDs, etc.)
- Template catalog reference (27 templates, 8 categories)
- Menu block structure (type 18, menus/raw/menuStyle)
- Dual button type documentation (type 46 + type 1337)

**What changes:** CLI command examples (`sq.ts update-text ...`) become MCP tool references (`use the sq_update_text tool`).

### Executor Prompt (Core Structure)

```markdown
# Squarespace Executor Agent

You edit Squarespace websites using the tools available to you.

## Rules

1. **API first.** Always try sq_* API tools before sq_browser_* tools.
2. **Browser is last resort.** Only use sq_browser_* tools when an API tool fails or doesn't exist for the operation.
3. **Report fallbacks.** When you use any sq_browser_* tool, include this in your final summary:
   `BROWSER_FALLBACK: {"intent": "what you were trying to do", "actions": ["browser steps taken"], "reason": "why API couldn't handle it"}`
4. **Verify visually.** After completing work, call sq_take_screenshot to confirm the result looks correct.
5. **One operation at a time.** Complete each operation fully before starting the next.

## Tool Preference Order

For any edit, try tools in this order:
1. Specific API tool (e.g., sq_update_text for text changes)
2. Generic API tool (e.g., sq_read_page to inspect, then specific tool)
3. Browser tools (sq_browser_navigate → sq_browser_click → etc.)

## API Gotchas
{contents from squarespace.md — all 11 gotchas}

## Block Types
{contents from squarespace-snapshot.md — block type reference}

## Grid System
{contents from squarespace-design.md — 24-column desktop grid}

## Template Catalog
{contents from squarespace-create.md — 27 templates, 8 categories}
```

### Strategist Prompt (Core Structure)

```markdown
# Squarespace Strategist Agent

You plan content operations for Squarespace websites. You receive a task description,
research findings, and page analysis. You output a structured JSON plan.

## Available Operation Types
{from squarespace.md — all 23 operation types with required fields}

## Output Format

Return a JSON plan:
```json
{
  "operations": [
    {
      "description": "Add an About section with team photo",
      "tool": "sq_add_template_section",
      "params": {
        "siteId": "smyth-tavern",
        "pageSlug": "about",
        "category": "About",
        "templateIndex": 2,
        "replacements": {
          "texts": [{"searchText": "About Us", "newText": "About Smyth Tavern"}],
          "images": [{"searchText": "placeholder", "filePath": "/storage/uploads/team.jpg"}]
        }
      }
    }
  ]
}
```

## Rules
1. ONLY plan operations that were explicitly requested. Do not invent extra sections.
2. Use the page analysis to avoid duplicating existing content.
3. Prefer template sections when a catalog match exists. Use blank sections for custom layouts.
4. Include all required params for each tool call.
```

### Supervisor Prompt (Core Structure)

```markdown
# Squarespace Supervisor Agent

You verify that edits were completed correctly on Squarespace websites.

## Process
1. Call sq_take_screenshot to see the current page visually.
2. Call sq_read_page to get the page JSON (blocks, sections, text content).
3. Compare what you see/read against the original task requirements.
4. Return a verdict.

## Output Format

Return JSON:
```json
{
  "pass": true/false,
  "summary": "What was checked and the result",
  "issues": ["Any problems found"],
  "browserFallbacksDetected": ["Any BROWSER_FALLBACK notes from the executor"]
}
```

## Rules
1. A task passes if the requested changes are visible and correct.
2. Minor visual differences (spacing, exact font rendering) are acceptable.
3. Missing content, wrong text, broken images, or unchanged pages are failures.
```

---

## 3. CLI Runner

The core function that spawns Claude CLI agents and parses their output.

```typescript
// src/orchestrator/cli-runner.ts
import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';

interface AgentConfig {
  name: string;
  model: 'sonnet' | 'haiku' | 'opus';
  maxTurns: number;
  systemPromptFile: string;
  allowedTools?: string[];
  mcpConfig: string;
}

interface AgentResult {
  success: boolean;
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  cost: number;
  numTurns: number;
  sessionId: string;
}

interface RunOptions {
  onStep?: (step: AgentStepEvent) => void;
  timeout?: number;  // ms, default 5 minutes
}

export async function runAgent(
  config: AgentConfig,
  input: string,
  options: RunOptions = {},
): Promise<AgentResult> {
  const args = [
    '-p', input,
    '--output-format', 'stream-json',
    '--model', config.model,
    '--max-turns', String(config.maxTurns),
    '--system-prompt-file', config.systemPromptFile,
    '--mcp-config', config.mcpConfig,
    '--permission-mode', 'bypassPermissions',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
  ];

  if (config.allowedTools) {
    args.push('--allowedTools', ...config.allowedTools);
  }

  // Strip env vars that cause nested Claude detection issues
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  const proc = spawn('claude', args, {
    cwd: process.cwd(),
    env: cleanEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stepCount = 0;

  return new Promise((resolve, reject) => {
    const timeout = options.timeout ?? 300_000;
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Agent ${config.name} timed out after ${timeout}ms`));
    }, timeout);

    const rl = createInterface({ input: proc.stdout });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);

        if (msg.type === 'assistant' && options.onStep) {
          const textBlocks = msg.message?.content
            ?.filter((b: any) => b.type === 'text')
            ?.map((b: any) => b.text) ?? [];
          const toolCalls = msg.message?.content
            ?.filter((b: any) => b.type === 'tool_use')
            ?.map((b: any) => ({ tool: b.name, input: b.input })) ?? [];

          options.onStep({
            agent: config.name,
            step: ++stepCount,
            text: textBlocks.join('\n'),
            tools: toolCalls,
          });
        }

        if (msg.type === 'result') {
          clearTimeout(timer);
          resolve({
            success: msg.subtype === 'success',
            text: msg.result ?? msg.errors?.join('\n') ?? 'Unknown error',
            usage: msg.usage ?? { input_tokens: 0, output_tokens: 0 },
            cost: msg.total_cost_usd ?? 0,
            numTurns: msg.num_turns ?? 0,
            sessionId: msg.session_id,
          });
        }
      } catch {
        // Non-JSON line from stderr leak, ignore
      }
    });

    // Swallow stderr (Claude CLI writes progress/warnings there)
    proc.stderr?.resume();

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Agent ${config.name} exited with code ${code}`));
      }
    });
  });
}
```

---

## 4. Orchestrator

The pipeline coordinator. TypeScript code (not an LLM) that spawns agents in sequence and routes between fast path and agent pipeline.

```typescript
// src/orchestrator/orchestrator.ts
import { runAgent } from './cli-runner.js';
import { classifyTask } from '../services/simple-edit-classifier.js';
import { executeSimpleEdit } from '../services/simple-edit-executor.js';
import { dashboardEvents } from '../services/dashboard-events.js';
import { logBrowserFallback } from './fallback-tracker.js';
import { logger } from '../utils/logger.js';

const MCP_CONFIG = './mcp-config.json';
const PROMPTS_DIR = './src/orchestrator/prompts';

const AGENT_CONFIGS = {
  researcher: {
    name: 'researcher',
    model: 'haiku' as const,
    maxTurns: 5,
    systemPromptFile: `${PROMPTS_DIR}/researcher.md`,
    mcpConfig: MCP_CONFIG,
    // Researcher uses Claude's built-in web search, no Squarespace tools
    allowedTools: ['WebSearch', 'WebFetch'],
  },
  analyst: {
    name: 'analyst',
    model: 'sonnet' as const,
    maxTurns: 3,
    systemPromptFile: `${PROMPTS_DIR}/analyst.md`,
    mcpConfig: MCP_CONFIG,
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_take_screenshot',
      'mcp__squarespace__sq_get_navigation',
      'mcp__squarespace__sq_list_pages',
    ],
  },
  strategist: {
    name: 'strategist',
    model: 'sonnet' as const,
    maxTurns: 3,
    systemPromptFile: `${PROMPTS_DIR}/strategist.md`,
    mcpConfig: MCP_CONFIG,
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_get_navigation',
      'mcp__squarespace__sq_list_pages',
      'mcp__squarespace__sq_get_design',
    ],
  },
  executor: {
    name: 'executor',
    model: 'sonnet' as const,
    maxTurns: 30,
    systemPromptFile: `${PROMPTS_DIR}/executor.md`,
    mcpConfig: MCP_CONFIG,
    // ALL tools — executor gets everything
  },
  supervisor: {
    name: 'supervisor',
    model: 'sonnet' as const,
    maxTurns: 5,
    systemPromptFile: `${PROMPTS_DIR}/supervisor.md`,
    mcpConfig: MCP_CONFIG,
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_take_screenshot',
    ],
  },
};

export async function executeTask(task: Task): Promise<TaskResult> {
  const emit = (event: string, data: any) =>
    dashboardEvents.emit(event, { taskId: task.id, ...data });

  // Step 1: Classify — stays as direct Haiku call (fast path)
  emit('agent_activity', { agent: 'classifier', status: 'running' });
  const classification = await classifyTask(task);

  if (classification.isSimple && classification.confidence === 'high') {
    emit('agent_activity', { agent: 'classifier', status: 'done', result: 'fast_path' });
    const result = await executeSimpleEdit(classification);
    return { success: result.success, summary: result.summary };
  }

  emit('agent_activity', { agent: 'classifier', status: 'done', result: 'agent_pipeline' });

  // Step 2: Research (if task involves content creation)
  let research = '';
  if (taskNeedsResearch(task)) {
    emit('agent_activity', { agent: 'researcher', status: 'running' });
    const researchResult = await runAgent(
      AGENT_CONFIGS.researcher,
      `Research content for this website edit task:\n\n${task.description}\n\nSite: ${task.siteId}\nPage: ${task.targetPage}`,
    );
    research = researchResult.text;
    emit('agent_activity', { agent: 'researcher', status: 'done' });
  }

  // Step 3: Analyze current page
  emit('agent_activity', { agent: 'analyst', status: 'running' });
  const analysis = await runAgent(
    AGENT_CONFIGS.analyst,
    `Analyze the current state of the "${task.targetPage}" page on site "${task.siteId}". Describe the layout, sections, and content.`,
  );
  emit('agent_activity', { agent: 'analyst', status: 'done' });

  // Step 4: Plan operations
  emit('agent_activity', { agent: 'strategist', status: 'running' });
  const plan = await runAgent(
    AGENT_CONFIGS.strategist,
    buildStrategistPrompt(task, research, analysis.text),
  );
  emit('agent_activity', { agent: 'strategist', status: 'done' });

  // Step 5: Execute
  emit('agent_activity', { agent: 'executor', status: 'running' });
  const result = await runAgent(
    AGENT_CONFIGS.executor,
    `Execute this plan on site "${task.siteId}":\n\n${plan.text}`,
    {
      timeout: 600_000,  // 10 min for complex tasks
      onStep: (step) => emit('agent_step', step),
    },
  );
  emit('agent_activity', { agent: 'executor', status: 'done' });

  // Step 6: Parse and log browser fallbacks
  const fallbacks = parseBrowserFallbacks(result.text);
  for (const fb of fallbacks) {
    await logBrowserFallback(task.siteId, task.targetPage, fb);
  }

  // Step 7: Verify
  emit('agent_activity', { agent: 'supervisor', status: 'running' });
  const verdict = await runAgent(
    AGENT_CONFIGS.supervisor,
    `Verify that this task was completed correctly on site "${task.siteId}", page "${task.targetPage}":\n\nTask: ${task.description}\n\nExecutor summary: ${result.text}`,
  );
  emit('agent_activity', { agent: 'supervisor', status: 'done' });

  const supervisorResult = parseVerdict(verdict.text);

  if (!supervisorResult.pass) {
    // Retry with supervisor feedback
    emit('agent_activity', { agent: 'executor', status: 'retrying' });
    const retry = await runAgent(
      AGENT_CONFIGS.executor,
      `Your previous attempt had issues: ${supervisorResult.summary}\n\nOriginal plan:\n${plan.text}\n\nPlease fix the issues.`,
      {
        timeout: 600_000,
        onStep: (step) => emit('agent_step', step),
      },
    );
    emit('agent_activity', { agent: 'executor', status: 'done' });

    // Parse fallbacks from retry too
    const retryFallbacks = parseBrowserFallbacks(retry.text);
    for (const fb of retryFallbacks) {
      await logBrowserFallback(task.siteId, task.targetPage, fb);
    }

    // Re-verify
    const retryVerdict = await runAgent(
      AGENT_CONFIGS.supervisor,
      `Verify retry of: ${task.description}\n\nExecutor summary: ${retry.text}`,
    );
    const retryResult = parseVerdict(retryVerdict.text);

    return {
      success: retryResult.pass,
      summary: retryResult.summary,
      fallbacks: [...fallbacks, ...retryFallbacks],
      cost: result.cost + retry.cost + verdict.cost + retryVerdict.cost,
    };
  }

  return {
    success: true,
    summary: supervisorResult.summary,
    fallbacks,
    cost: result.cost + verdict.cost,
  };
}
```

---

## 5. Self-Improving Loop — Browser Fallback Tracking

When the executor agent uses browser tools instead of API tools, it reports this in its output. The system captures these, stores them, surfaces them, and progressively eliminates them.

### Phase 1: Structured Logging (Day One)

**Database schema** (new migration):

```sql
CREATE TABLE IF NOT EXISTS browser_fallbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  page_slug TEXT,
  intent TEXT NOT NULL,          -- "change form notification email"
  actions TEXT NOT NULL,          -- JSON: ["clicked form", "opened settings", "typed email"]
  reason TEXT NOT NULL,           -- "no API tool for form notification settings"
  selectors TEXT,                 -- JSON: [".form-settings", "input[name=email]"]
  task_id TEXT,
  occurrence_count INTEGER DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,    -- 1 when API tool created
  resolved_tool TEXT,             -- "sq_update_form_settings" when resolved
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_fallbacks_intent ON browser_fallbacks(intent);
CREATE INDEX idx_fallbacks_resolved ON browser_fallbacks(resolved);
```

**Fallback parser:**

```typescript
// src/orchestrator/fallback-tracker.ts

interface BrowserFallback {
  intent: string;
  actions: string[];
  reason: string;
  selectors?: string[];
}

export function parseBrowserFallbacks(executorOutput: string): BrowserFallback[] {
  const fallbacks: BrowserFallback[] = [];
  const regex = /BROWSER_FALLBACK:\s*(\{[^}]+\})/g;
  let match;
  while ((match = regex.exec(executorOutput)) !== null) {
    try {
      fallbacks.push(JSON.parse(match[1]));
    } catch {
      // Executor didn't format as JSON — extract what we can
      fallbacks.push({
        intent: match[1],
        actions: [],
        reason: 'unstructured fallback report',
      });
    }
  }
  return fallbacks;
}

export async function logBrowserFallback(
  siteId: string,
  pageSlug: string | undefined,
  fallback: BrowserFallback,
): Promise<void> {
  const db = getDatabase();

  // Check if this intent already exists (dedup by intent)
  const existing = db.prepare(
    'SELECT id, occurrence_count FROM browser_fallbacks WHERE intent = ? AND resolved = 0'
  ).get(fallback.intent);

  if (existing) {
    db.prepare(
      'UPDATE browser_fallbacks SET occurrence_count = occurrence_count + 1, last_seen = datetime("now") WHERE id = ?'
    ).run(existing.id);
  } else {
    db.prepare(`
      INSERT INTO browser_fallbacks (site_id, page_slug, intent, actions, reason, selectors, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(siteId, pageSlug, fallback.intent, JSON.stringify(fallback.actions), fallback.reason, JSON.stringify(fallback.selectors ?? []));
  }

  logger.info({ siteId, intent: fallback.intent, reason: fallback.reason }, 'Browser fallback logged');
}

export function getUnresolvedFallbacks(): BrowserFallbackRow[] {
  return getDatabase().prepare(
    'SELECT * FROM browser_fallbacks WHERE resolved = 0 ORDER BY occurrence_count DESC'
  ).all();
}

export function resolveFallback(id: number, toolName: string): void {
  getDatabase().prepare(
    'UPDATE browser_fallbacks SET resolved = 1, resolved_tool = ? WHERE id = ?'
  ).run(toolName, id);
}
```

### Phase 2: Dashboard Visibility (Week One)

New "Fallbacks" tab in the dashboard showing:
- Unresolved fallbacks sorted by occurrence count
- Intent, reason, first/last seen, count
- "Resolve" button (marks as resolved + records the tool name)
- Chart showing fallback frequency over time

**Dashboard endpoint:**

```typescript
// GET /dashboard/fallbacks
app.get('/dashboard/fallbacks', async (req, reply) => {
  const fallbacks = getUnresolvedFallbacks();
  const resolved = getDatabase().prepare(
    'SELECT * FROM browser_fallbacks WHERE resolved = 1 ORDER BY last_seen DESC LIMIT 20'
  ).all();
  // Render HTML with fallback table
});
```

### Phase 3: Human-Triggered API Expansion (Ongoing)

When Tim sees a repeated fallback pattern (3+ occurrences), the workflow is:

1. **Tim asks Claude Code** to investigate:
   ```
   "I keep seeing browser fallbacks for 'change form notification email'.
    Investigate the Squarespace API — find the endpoint and add an MCP tool."
   ```

2. **Claude Code** runs the established discovery workflow:
   - Opens editor with network capture
   - Performs the action via UI
   - Captures the HTTP request/response
   - Writes the ContentSaveClient method
   - Writes the MCP tool wrapper
   - Writes tests
   - Marks the fallback as resolved: `resolveFallback(id, 'sq_update_form_settings')`

3. **Next occurrence** — executor agent uses the new API tool instead of browser fallback.

### Phase 4: Automated Discovery (Future)

A "tool-builder" agent that runs periodically (or on-demand):

```typescript
// Future: src/orchestrator/tool-builder.ts
async function proposeNewTools(): Promise<ToolProposal[]> {
  const fallbacks = getUnresolvedFallbacks()
    .filter(fb => fb.occurrence_count >= 3);

  if (fallbacks.length === 0) return [];

  const proposals: ToolProposal[] = [];
  for (const fb of fallbacks) {
    // Step 1: Ask Claude if this is likely an API operation
    const analysis = await runAgent(TOOL_ANALYZER,
      `A Squarespace editor action "${fb.intent}" required browser automation. ` +
      `Browser actions were: ${fb.actions.join(', ')}. ` +
      `Is this likely backed by a REST API endpoint? What endpoint pattern would you expect?`
    );

    // Step 2: If likely API, run network capture
    if (analysis.text.includes('LIKELY_API')) {
      // Launch discovery script
      // Capture network traffic
      // Analyze endpoint
      // Generate tool code
    }

    proposals.push({
      fallbackId: fb.id,
      intent: fb.intent,
      analysis: analysis.text,
      occurrences: fb.occurrence_count,
    });
  }
  return proposals;
}
```

Phase 4 is genuinely achievable — all the building blocks exist (discovery scripts, network capture, ContentSaveClient pattern, MCP tool pattern). But it's future work. Phases 1-3 deliver immediate value.

---

## 6. Dashboard Integration

The existing dashboard SSE system works with minimal changes. The orchestrator emits the same event types.

### SSE Events (from agents)

```typescript
// agent_activity — pipeline progress
{ type: 'agent_activity', agent: 'researcher', status: 'running' | 'done' | 'retrying' }

// agent_step — per-turn executor progress (from stream-json parsing)
{ type: 'agent_step', agent: 'executor', step: 3, text: 'Updating the heading...', tools: [{ tool: 'sq_update_text', input: {...} }] }

// fallback_logged — browser fallback detected
{ type: 'fallback_logged', intent: 'change form email', reason: 'no API tool', count: 2 }
```

### Cost Tracking

Each `AgentResult` includes `cost` (from Claude CLI's `total_cost_usd`). The orchestrator sums across all agents in the pipeline and stores per-task:

```typescript
const totalCost = [research, analysis, plan, result, verdict]
  .reduce((sum, r) => sum + (r?.cost ?? 0), 0);

// Store in task record
updateTask(task.id, { cost_usd: totalCost });
```

---

## 7. Preservation Strategy

### Principle: Build Alongside, Don't Replace

The new MCP architecture is built in new directories. Existing code stays untouched. A config flag switches between old and new paths.

### Step 1: Tag Current State

```bash
git tag v1-direct-api -m "Pre-MCP architecture: direct Anthropic SDK calls + proxy"
```

### Step 2: New Directories (No Existing Code Touched)

```
src/
  # EXISTING — untouched:
  automation/           # current browser agent
  agents/               # current pipeline agents (coordinator, strategist, etc.)
  services/             # ContentSaveClient, WhatsApp, email, etc.
  routes/               # dashboard, webhooks
  db/                   # database
  config/               # models, sites, templates
  utils/                # logger, anthropic-client, proxy-manager

  # NEW — added alongside:
  mcp-server/           # MCP tool definitions
    index.ts            # McpServer + StdioServerTransport
    session.ts          # shared client instances
    tools/              # 14 tool modules (~40 tools)
  orchestrator/         # new agent spawning
    cli-runner.ts       # spawn claude CLI + parse stream-json
    orchestrator.ts     # pipeline logic (replaces coordinator.ts)
    fallback-tracker.ts # browser fallback logging
    prompts/            # 6 agent system prompt files
```

### Step 3: Config Flag

```typescript
// src/index.ts
const USE_MCP_AGENTS = process.env.USE_MCP_AGENTS === 'true';

if (USE_MCP_AGENTS) {
  // New path: orchestrator spawns Claude CLI agents
  const { executeTask } = await import('./orchestrator/orchestrator.js');
  registerMcpTaskHandler(executeTask);
} else {
  // Old path: direct Anthropic SDK calls + proxy
  await ensureProxy();
  const { handleTask } = await import('./services/conversation/execution.js');
  registerLegacyTaskHandler(handleTask);
}
```

### Step 4: Shared Foundation

Both paths share:
- `ContentSaveClient` — called directly (old) or via MCP tools (new)
- `MediaUploadClient` — same
- Database layer — same tables + new `browser_fallbacks` table
- WhatsApp/email services — same
- Dashboard — same SSE events, new Fallbacks tab
- Session management — same cookie files

### Step 5: Incremental Migration

Convert one agent at a time. Possible order:

1. **Executor first** (biggest win — replaces ~6,000 lines of browser agent + actions + rescue + prompt)
2. **Supervisor second** (replaces ~400 lines)
3. **Analyst + Strategist** (replaces ~650 lines)
4. **Researcher** (replaces ~200 lines)
5. **Classifier stays as-is** (it's already a single fast Haiku call, no benefit from CLI agent)

Each step can be tested independently. If an MCP agent performs worse than the direct API path for a specific stage, switch just that stage back.

### Rollback

At any point: `USE_MCP_AGENTS=false` restores the entire old pipeline. The proxy auto-starts, direct API calls resume, nothing is lost.

---

## 8. Migration Path — Implementation Order

### Phase 1: Foundation (MCP Server + CLI Runner)
1. Build MCP server with 5 core tools (sq_read_page, sq_update_text, sq_take_screenshot, sq_add_blank_section, sq_add_template_section)
2. Build CLI runner (spawn + parse stream-json)
3. Test manually: `claude -p "Read the home page of smyth-tavern" --mcp-config ./mcp-config.json`
4. Verify MCP tools work end-to-end

### Phase 2: Executor Agent
1. Write executor prompt (adapt from existing skill files)
2. Wire into orchestrator with config flag
3. Test: simple text edit via MCP agent vs. old path
4. Test: template section addition via MCP agent
5. Compare: speed, accuracy, cost

### Phase 3: Full Pipeline
1. Add remaining ~35 MCP tools
2. Write analyst, strategist, supervisor prompts
3. Wire full pipeline in orchestrator
4. Test: complex multi-section task end-to-end
5. Add fallback tracking (Phase 1-2 of self-improving loop)

### Phase 4: Dashboard + Polish
1. Add Fallbacks tab to dashboard
2. Add cost tracking per task
3. Add agent step streaming to dashboard
4. Performance optimization (tool response caching, parallel agent steps where possible)

### Phase 5: Self-Improving Loop
1. Review fallback patterns from real usage
2. Investigate and add API tools for top fallbacks
3. (Future) Automated discovery agent

---

## Appendix: What Gets Deleted (After Proven)

Once the MCP agent path is proven and `USE_MCP_AGENTS=true` is the default:

| File/Directory | Lines | Reason |
|---------------|-------|--------|
| `src/automation/browser-agent.ts` | ~800 | Replaced by executor agent + MCP tools |
| `src/automation/browser-agent-prompt.ts` | ~1000 | Replaced by `prompts/executor.md` |
| `src/automation/browser-agent-actions.ts` | ~230 | Replaced by MCP tool dispatcher |
| `src/automation/browser-agent-rescue.ts` | ~300 | Claude handles stuck detection natively |
| `src/automation/actions/*.ts` (6 modules) | ~4500 | Logic moved into MCP server tools |
| `src/agents/coordinator.ts` | ~300 | Replaced by `orchestrator.ts` |
| `src/agents/content-strategist-agent.ts` | ~500 | Replaced by `prompts/strategist.md` |
| `src/agents/supervisor-agent.ts` | ~400 | Replaced by `prompts/supervisor.md` |
| `src/agents/research-agent.ts` | ~200 | Replaced by `prompts/researcher.md` |
| `src/agents/site-analyst-agent.ts` | ~150 | Replaced by `prompts/analyst.md` |
| `src/services/conversation/execution.ts` | ~800 | Template/blank_api/batching logic moved to executor agent |
| `src/services/conversation/planning.ts` | ~200 | Replaced by strategist agent |
| `src/services/plan-classifier.ts` | ~200 | Executor agent decides tool selection |
| `src/utils/proxy-manager.ts` | ~100 | No proxy needed |
| `src/utils/anthropic-client.ts` | ~30 | No SDK calls (classifier might keep this) |
| **Total** | **~9,710** | |

**Added:**
| File/Directory | Est. Lines | Purpose |
|---------------|-----------|---------|
| `src/mcp-server/` | ~1,200 | MCP server + 14 tool modules |
| `src/orchestrator/` | ~400 | CLI runner + orchestrator + fallback tracker |
| `src/orchestrator/prompts/` | ~600 | 6 agent prompt files (adapted from skill files) |
| **Total** | **~2,200** | |

**Net reduction: ~7,500 lines** of orchestration code replaced by MCP tools + agent prompts.

---

## Appendix: Key Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| CLI agent slower than direct API calls for simple tasks | Classifier fast path stays as direct API call — no CLI spawn for simple edits |
| Agent makes wrong tool choices | Executor prompt has explicit preference order; supervisor catches errors |
| MCP server session goes stale | `session.ts` checks cookie age, reloads from disk if stale |
| Claude CLI not installed/broken | Pre-flight check in orchestrator; fall back to old path |
| Image input not supported via `-p` flag | Use SDK streaming input mode for analyst (screenshots), or save screenshots to disk and reference via file path in prompt |
| Token costs increase (autonomous loops are chatty) | `--max-turns` caps each agent; `--max-budget-usd` as safety net; cost tracking per task |
| Browser fallback quality is poor | Browser tools are same Playwright actions as current system; just called differently |
| Agent prompts need tuning | Prompts built from battle-tested skill files; iterate based on real results |
