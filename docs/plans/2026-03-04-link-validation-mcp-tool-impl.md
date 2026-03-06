# Link Validation MCP Tool — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `sq_validate_links` MCP tool so the supervisor agent can validate links on a page after execution.

**Architecture:** New MCP tool wraps existing `extractAndValidateLinks()` from `link-validator.ts`. Derives `siteBaseUrl` from site config (customDomain or adminUrl). Supervisor agent gets the tool in its allowed list + prompt instructions.

**Tech Stack:** TypeScript, Zod schemas, vitest, existing MCP server patterns

---

### Task 1: Add `getSiteBaseUrl()` to session.ts

The tool needs to derive `siteBaseUrl` from site config. `findSite()` is private, so we add a small public helper.

**Files:**
- Modify: `src/mcp-server/session.ts`

**Step 1: Write the failing test**

Add to a new file `src/mcp-server/__tests__/session-helpers.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify({
    clients: [
      {
        id: 'smyth-tavern',
        name: 'Smyth Tavern',
        aliases: ['smyth'],
        site: {
          adminUrl: 'https://grey-yellow-hbxc.squarespace.com/config',
          customDomain: 'www.smythtavern.com',
        },
      },
      {
        id: 'test-site',
        name: 'Test Site',
        aliases: [],
        site: {
          adminUrl: 'https://test-abc.squarespace.com/config',
        },
      },
    ],
  })),
}));

import { getSiteBaseUrl } from '../session.js';

describe('getSiteBaseUrl', () => {
  it('returns customDomain with https when available', () => {
    const url = getSiteBaseUrl('smyth-tavern');
    expect(url).toBe('https://www.smythtavern.com');
  });

  it('returns squarespace subdomain URL when no customDomain', () => {
    const url = getSiteBaseUrl('test-site');
    expect(url).toBe('https://test-abc.squarespace.com');
  });

  it('throws for unknown site', () => {
    expect(() => getSiteBaseUrl('nonexistent')).toThrow('Unknown site');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/session-helpers.test.ts`
Expected: FAIL — `getSiteBaseUrl` is not exported

**Step 3: Write minimal implementation**

Add to `src/mcp-server/session.ts` after the `getSubdomain` function (~line 103):

```typescript
/**
 * Get the public base URL for a site.
 * Prefers customDomain (with https://), falls back to squarespace subdomain.
 * Used for resolving relative URLs during link validation.
 */
export function getSiteBaseUrl(siteId: string): string {
  const site = findSite(siteId);
  if (!site) {
    const config = loadSitesConfig();
    const available = config.clients.map((c) => {
      const subdomain = new URL(c.site.adminUrl).hostname.split('.')[0];
      return `"${c.id}" (${c.name ?? subdomain})`;
    }).join(', ');
    throw new Error(`Unknown site: "${siteId}". Available: ${available}`);
  }

  if (site.site.customDomain) {
    const domain = site.site.customDomain;
    return domain.startsWith('http') ? domain : `https://${domain}`;
  }

  const subdomain = new URL(site.site.adminUrl).hostname.split('.')[0];
  return `https://${subdomain}.squarespace.com`;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/session-helpers.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/mcp-server/session.ts src/mcp-server/__tests__/session-helpers.test.ts
git commit -m "feat: add getSiteBaseUrl() to MCP session for link validation"
```

---

### Task 2: Create `sq_validate_links` MCP tool

**Files:**
- Create: `src/mcp-server/tools/links.ts`
- Create: `src/mcp-server/__tests__/link-tools.test.ts`

**Step 1: Write the failing tests**

Create `src/mcp-server/__tests__/link-tools.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session module
const mockClient = {
  getPageSections: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
  getSiteBaseUrl: vi.fn(() => 'https://www.example.com'),
}));

// Mock link-validator
vi.mock('../../services/link-validator.js', () => ({
  extractAndValidateLinks: vi.fn(async () => ({
    total: 3,
    ok: 2,
    broken: 1,
    redirected: 0,
    timedOut: 0,
    skipped: 0,
    invalidEmails: 0,
    allPassed: false,
    results: [
      { href: 'https://example.com', text: 'Example', status: 'ok', durationMs: 100 },
      { href: 'https://good.com', text: 'Good', status: 'ok', durationMs: 50 },
      { href: 'https://broken.com', text: 'Broken', status: 'broken', statusCode: 404, error: 'HTTP 404', durationMs: 200 },
    ],
  })),
}));

import { resolvePageIds, getSiteBaseUrl } from '../session.js';
import { extractAndValidateLinks } from '../../services/link-validator.js';
import { registerLinkTools } from '../tools/links.js';

// Create a mock McpServer that captures registrations
function createMockServer() {
  const tools = new Map<string, { config: any; handler: Function }>();
  return {
    registerTool: vi.fn((name: string, config: any, handler: Function) => {
      tools.set(name, { config, handler });
    }),
    tools,
    callTool: async (name: string, params: any) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(params);
    },
  };
}

describe('Link Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerLinkTools(server as any);
  });

  it('should register sq_validate_links', () => {
    expect(server.tools.has('sq_validate_links')).toBe(true);
  });

  describe('sq_validate_links', () => {
    it('should validate links on a page and return summary', async () => {
      mockClient.getPageSections.mockResolvedValue({
        sections: [{ fluidEngineContext: { gridContents: [] } }],
      });

      const result = await server.callTool('sq_validate_links', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
      });

      expect(resolvePageIds).toHaveBeenCalledWith('smyth-tavern', 'home');
      expect(mockClient.getPageSections).toHaveBeenCalledWith('psi-home');
      expect(getSiteBaseUrl).toHaveBeenCalledWith('smyth-tavern');
      expect(extractAndValidateLinks).toHaveBeenCalledWith(
        [{ fluidEngineContext: { gridContents: [] } }],
        { siteBaseUrl: 'https://www.example.com' },
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.total).toBe(3);
      expect(data.ok).toBe(2);
      expect(data.broken).toBe(1);
      expect(data.allPassed).toBe(false);
    });

    it('should return error when page not found', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_validate_links', {
        siteId: 'smyth-tavern',
        pageSlug: 'nonexistent',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error on thrown exception', async () => {
      mockClient.getPageSections.mockRejectedValue(new Error('Session expired'));

      const result = await server.callTool('sq_validate_links', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Session expired');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/mcp-server/__tests__/link-tools.test.ts`
Expected: FAIL — `../tools/links.js` doesn't exist

**Step 3: Write minimal implementation**

Create `src/mcp-server/tools/links.ts`:

```typescript
/**
 * MCP Tools — Link validation
 *
 * sq_validate_links: Validate all links on a page (HTTP, mailto, relative)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, resolvePageIds, getSiteBaseUrl } from '../session.js';
import { extractAndValidateLinks } from '../../services/link-validator.js';

export function registerLinkTools(server: McpServer) {
  server.registerTool('sq_validate_links', {
    description:
      'Validate all links on a Squarespace page. Checks HTTP URLs (HEAD then GET), mailto addresses, and resolves relative URLs. Returns a summary with broken/ok/redirected counts and per-link details.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug (e.g. "home", "about", "menu")'),
    },
  }, async ({ siteId, pageSlug }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return {
          content: [{ type: 'text' as const, text: `Could not resolve page "${pageSlug}" on site "${siteId}"` }],
          isError: true,
        };
      }

      const client = getClient(siteId);
      const data = await client.getPageSections(ids.pageSectionsId);
      const sections = data.sections ?? [];

      const siteBaseUrl = getSiteBaseUrl(siteId);
      const summary = await extractAndValidateLinks(sections, { siteBaseUrl });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/mcp-server/__tests__/link-tools.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/mcp-server/tools/links.ts src/mcp-server/__tests__/link-tools.test.ts
git commit -m "feat: add sq_validate_links MCP tool"
```

---

### Task 3: Register the tool and wire up the supervisor

**Files:**
- Modify: `src/mcp-server/index.ts` — add `registerLinkTools` import + call
- Modify: `src/orchestrator/orchestrator.ts` — add tool to supervisor's `allowedTools`
- Modify: `src/orchestrator/prompts/supervisor.md` — add link validation section

**Step 1: Register the tool in index.ts**

Add import at the top (after the divider tools import):
```typescript
import { registerLinkTools } from './tools/links.js';
```

Add call (after `registerDividerTools`):
```typescript
registerLinkTools(server);
```

**Step 2: Add to supervisor allowedTools in orchestrator.ts**

Add `'mcp__squarespace__sq_validate_links'` to the supervisor's `allowedTools` array (after `sq_get_menu`):

```typescript
  supervisor: {
    name: 'supervisor',
    model: 'sonnet',
    maxTurns: 5,
    systemPromptFile: join(PROMPTS_DIR, 'supervisor.md'),
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_list_pages',
      'mcp__squarespace__sq_get_navigation',
      'mcp__squarespace__sq_get_settings',
      'mcp__squarespace__sq_get_design',
      'mcp__squarespace__sq_take_screenshot',
      'mcp__squarespace__sq_get_code_injection',
      'mcp__squarespace__sq_get_menu',
      'mcp__squarespace__sq_validate_links',
    ],
  },
```

**Step 3: Add link validation section to supervisor prompt**

Add the following after the "Code Injection Changes" section in `src/orchestrator/prompts/supervisor.md` (before the "Output Format" section):

```markdown
### Link Validation

After verifying content, validate links on any page that had operations involving links (text with `<a>` tags, buttons, images with clickthrough URLs):

1. `sq_validate_links(siteId, pageSlug)` — validates all links on the page
2. Check the `allPassed` field — if `false`, there are broken links
3. Report any broken links in your `issues[]` array with the specific URLs and status codes
4. Broken links should cause the overall operation to be marked `"fail"` with a suggestion to fix the URL

**When to skip:** Skip link validation for operations that don't involve links (style changes, section reordering, image replacements without clickthrough URLs).
```

Also add the tool to the "Your Tools" table:

```markdown
| `sq_validate_links(siteId, pageSlug)` | Validate all links on a page — find broken URLs, invalid emails |
```

**Step 4: Run full test suite to verify nothing broke**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/mcp-server/index.ts src/orchestrator/orchestrator.ts src/orchestrator/prompts/supervisor.md
git commit -m "feat: wire sq_validate_links into MCP server and supervisor agent"
```

---

### Task 4: Update CLAUDE.md and memory

**Files:**
- Modify: `CLAUDE.md` — update tool count, add link validation to MCP tool list
- Modify: memory files — remove stale TODO, add note about link validation

**Step 1: Update CLAUDE.md**

- Update "~47 tools" references to "~48 tools" (search for "47" and update)
- Add `sq_validate_links` mention under MCP tool references where appropriate

**Step 2: Update memory**

- Remove the link validation TODO from `api-capabilities.md` Remaining TODO section
- Remove the link validation entry from `known-limitations.md`

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with sq_validate_links tool"
```
