# Section Divider Tools — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add MCP tools to enable/configure/remove section dividers on Squarespace pages.

**Architecture:** Dividers are section-level properties (`section.divider`) saved via the existing page-sections PUT endpoint. Two new ContentSaveClient methods + two new MCP tools + operationType addition.

**Tech Stack:** TypeScript, Zod, vitest, MCP SDK

---

### Task 1: Add `update_divider` to operationType union

**Files:**
- Modify: `src/agents/types.ts:53`

**Step 1: Add the type**

At line 53, after `| 'swap_blocks'`, add:

```typescript
    | 'update_divider';
```

**Step 2: Commit**

```bash
git add src/agents/types.ts
git commit -m "feat: add update_divider operationType"
```

---

### Task 2: Write failing tests for ContentSaveClient divider methods

**Files:**
- Create: `src/services/__tests__/content-save-divider.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';

// Mock session file
const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

function makeClient(): ContentSaveClient {
  const client = new ContentSaveClient('test-site');
  client.loadSessionCookies('/fake/session.json');
  return client;
}

function mockFetch(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 500),
      json: async () => resp.body,
      text: async () => (typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)),
    };
  });
}

// Helper: minimal page sections data with divider
function makeSections(divider?: Record<string, unknown>) {
  return {
    sections: [
      {
        id: 'sec-0',
        sectionName: 'FLUID_ENGINE',
        divider: divider ?? { enabled: false },
        styles: { sectionTheme: 'light' },
        fluidEngineContext: { id: 'fe-0', gridSettings: {}, gridContents: [] },
      },
      {
        id: 'sec-1',
        sectionName: 'FLUID_ENGINE',
        divider: { enabled: false },
        styles: { sectionTheme: 'dark' },
        fluidEngineContext: { id: 'fe-1', gridSettings: {}, gridContents: [] },
      },
    ],
  };
}

describe('ContentSaveClient — Section Divider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── updateSectionDivider ──────────────────────────────────────────────────

  describe('updateSectionDivider()', () => {
    it('enables a divider with type and default settings', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections() },   // GET page sections
        { ok: true, body: { sections: [] } }, // PUT save
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 0, {
        enabled: true,
        type: 'jagged',
      });

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('sec-0');

      // Verify the PUT body has the divider set
      const putCall = fetchMock.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      expect(putBody.sections[0].divider.enabled).toBe(true);
      expect(putBody.sections[0].divider.type).toBe('jagged');
    });

    it('merges partial updates onto existing divider', async () => {
      const existingDivider = {
        enabled: true,
        type: 'scalloped',
        width: { value: 100, unit: 'vw' },
        height: { value: 6, unit: 'vw' },
        isFlipX: false,
        isFlipY: false,
      };
      const fetchMock = mockFetch([
        { ok: true, body: makeSections(existingDivider) },
        { ok: true, body: { sections: [] } },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 0, {
        type: 'wavy',
        isFlipY: true,
      });

      expect(result.success).toBe(true);

      const putBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      const divider = putBody.sections[0].divider;
      // Changed fields
      expect(divider.type).toBe('wavy');
      expect(divider.isFlipY).toBe(true);
      // Preserved fields
      expect(divider.enabled).toBe(true);
      expect(divider.width).toEqual({ value: 100, unit: 'vw' });
      expect(divider.isFlipX).toBe(false);
    });

    it('returns error for out-of-bounds sectionIndex', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections() },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 5, {
        enabled: true,
        type: 'jagged',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of bounds');
    });

    it('returns error when GET fails', async () => {
      const fetchMock = mockFetch([
        { ok: false, status: 500, body: 'Server error' },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 0, {
        enabled: true,
        type: 'pointed',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns error when PUT fails', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections() },
        { ok: false, status: 400, body: 'Bad request' },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.updateSectionDivider('ps-1', 'col-1', 0, {
        enabled: true,
        type: 'rounded',
      });

      expect(result.success).toBe(false);
    });
  });

  // ── removeSectionDivider ──────────────────────────────────────────────────

  describe('removeSectionDivider()', () => {
    it('disables an existing divider', async () => {
      const existingDivider = {
        enabled: true,
        type: 'jagged',
        width: { value: 100, unit: 'vw' },
        height: { value: 6, unit: 'vw' },
      };
      const fetchMock = mockFetch([
        { ok: true, body: makeSections(existingDivider) },
        { ok: true, body: { sections: [] } },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.removeSectionDivider('ps-1', 'col-1', 0);

      expect(result.success).toBe(true);
      expect(result.sectionId).toBe('sec-0');

      const putBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(putBody.sections[0].divider.enabled).toBe(false);
    });

    it('succeeds even if divider was already disabled', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections({ enabled: false }) },
        { ok: true, body: { sections: [] } },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.removeSectionDivider('ps-1', 'col-1', 0);

      expect(result.success).toBe(true);
    });

    it('returns error for out-of-bounds sectionIndex', async () => {
      const fetchMock = mockFetch([
        { ok: true, body: makeSections() },
      ]);
      vi.stubGlobal('fetch', fetchMock);

      const client = makeClient();
      const result = await client.removeSectionDivider('ps-1', 'col-1', 99);

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of bounds');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-divider.test.ts`
Expected: FAIL — `updateSectionDivider` and `removeSectionDivider` not defined

**Step 3: Commit failing tests**

```bash
git add src/services/__tests__/content-save-divider.test.ts
git commit -m "test: add failing tests for section divider ContentSaveClient methods"
```

---

### Task 3: Implement ContentSaveClient divider methods

**Files:**
- Modify: `src/services/content-save.ts` — add methods before line 9451 (end of class, before closing `}`)

**Step 1: Add `updateSectionDivider()` and `removeSectionDivider()`**

Insert before the closing `}` of the class (line 9451):

```typescript
  // ── Section Divider ──────────────────────────────────────────────────────

  /**
   * Update (or enable) a section divider.
   * Merges the provided config onto the existing divider object.
   */
  async updateSectionDivider(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    dividerConfig: Record<string, unknown>,
  ): Promise<ContentSaveResult & { sectionId?: string }> {
    try {
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      if (!sections || sectionIndex < 0 || sectionIndex >= sections.length) {
        return {
          success: false,
          error: `Section index ${sectionIndex} out of bounds (page has ${sections?.length ?? 0} sections)`,
        };
      }

      const section = sections[sectionIndex];
      // Merge onto existing divider (preserve fields not in dividerConfig)
      section.divider = { ...(section.divider ?? {}), ...dividerConfig };

      const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      logger.info(
        { pageSectionsId, sectionIndex, sectionId: section.id, dividerType: dividerConfig.type },
        'Section divider updated',
      );

      return { success: true, sectionId: section.id };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }

  /**
   * Remove (disable) a section divider.
   */
  async removeSectionDivider(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
  ): Promise<ContentSaveResult & { sectionId?: string }> {
    try {
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      if (!sections || sectionIndex < 0 || sectionIndex >= sections.length) {
        return {
          success: false,
          error: `Section index ${sectionIndex} out of bounds (page has ${sections?.length ?? 0} sections)`,
        };
      }

      const section = sections[sectionIndex];
      section.divider = { enabled: false };

      const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      logger.info(
        { pageSectionsId, sectionIndex, sectionId: section.id },
        'Section divider removed',
      );

      return { success: true, sectionId: section.id };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-divider.test.ts`
Expected: ALL PASS (7 tests)

**Step 3: Commit**

```bash
git add src/services/content-save.ts
git commit -m "feat: add updateSectionDivider() and removeSectionDivider() to ContentSaveClient"
```

---

### Task 4: Write failing tests for MCP divider tools

**Files:**
- Create: `src/mcp-server/__tests__/divider-tools.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  updateSectionDivider: vi.fn(),
  removeSectionDivider: vi.fn(),
};

vi.mock('../session.js', () => ({
  getClient: vi.fn(() => mockClient),
  resolvePageIds: vi.fn(async (siteId: string, slug: string) => ({
    pageSectionsId: `psi-${slug}`,
    collectionId: `col-${slug}`,
  })),
}));

import { resolvePageIds } from '../session.js';
import { registerDividerTools } from '../tools/divider.js';

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

describe('MCP Divider Tools', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerDividerTools(server as any);
  });

  it('should register both divider tools', () => {
    expect(server.tools.has('sq_update_section_divider')).toBe(true);
    expect(server.tools.has('sq_remove_section_divider')).toBe(true);
  });

  // ── sq_update_section_divider ─────────────────────────────────────────────

  describe('sq_update_section_divider', () => {
    it('calls updateSectionDivider with correct params', async () => {
      mockClient.updateSectionDivider.mockResolvedValue({
        success: true,
        sectionId: 'sec-0',
      });

      const result = await server.callTool('sq_update_section_divider', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 0,
        type: 'jagged',
      });

      expect(mockClient.updateSectionDivider).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0,
        expect.objectContaining({ enabled: true, type: 'jagged' }),
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('passes all optional params as divider config', async () => {
      mockClient.updateSectionDivider.mockResolvedValue({
        success: true,
        sectionId: 'sec-0',
      });

      await server.callTool('sq_update_section_divider', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 1,
        type: 'scalloped',
        width: 50,
        height: 4,
        flipX: true,
        flipY: false,
        offset: 10,
        strokeStyle: 'dashed',
        strokeThickness: 8,
      });

      expect(mockClient.updateSectionDivider).toHaveBeenCalledWith(
        'psi-home', 'col-home', 1,
        expect.objectContaining({
          enabled: true,
          type: 'scalloped',
          width: { value: 50, unit: 'vw' },
          height: { value: 4, unit: 'vw' },
          isFlipX: true,
          isFlipY: false,
          offset: { value: 10, unit: 'px' },
          stroke: expect.objectContaining({
            style: 'dashed',
            thickness: { value: 8, unit: 'px' },
          }),
        }),
      );
    });

    it('returns error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_section_divider', {
        siteId: 'bad-site',
        pageSlug: 'nope',
        sectionIndex: 0,
        type: 'wavy',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('returns error when client method fails', async () => {
      mockClient.updateSectionDivider.mockResolvedValue({
        success: false,
        error: 'Section index 5 out of bounds',
      });

      const result = await server.callTool('sq_update_section_divider', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 5,
        type: 'pointed',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('out of bounds');
    });
  });

  // ── sq_remove_section_divider ─────────────────────────────────────────────

  describe('sq_remove_section_divider', () => {
    it('calls removeSectionDivider with correct params', async () => {
      mockClient.removeSectionDivider.mockResolvedValue({
        success: true,
        sectionId: 'sec-0',
      });

      const result = await server.callTool('sq_remove_section_divider', {
        siteId: 'test-site',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(mockClient.removeSectionDivider).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('returns error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_remove_section_divider', {
        siteId: 'bad-site',
        pageSlug: 'nope',
        sectionIndex: 0,
      });

      expect(result.isError).toBe(true);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp-server/__tests__/divider-tools.test.ts`
Expected: FAIL — `registerDividerTools` module not found

**Step 3: Commit failing tests**

```bash
git add src/mcp-server/__tests__/divider-tools.test.ts
git commit -m "test: add failing tests for MCP divider tools"
```

---

### Task 5: Implement MCP divider tools

**Files:**
- Create: `src/mcp-server/tools/divider.ts`

**Step 1: Write the tool module**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getClient, resolvePageIds } from '../session.js';

const DIVIDER_TYPES = ['none', 'rounded', 'soft-corners', 'slanted', 'scalloped', 'wavy', 'jagged', 'pointed'] as const;
const STROKE_STYLES = ['none', 'solid', 'dashed'] as const;

export function registerDividerTools(server: McpServer) {
  // ── sq_update_section_divider ───────────────────────────────────────────
  server.registerTool('sq_update_section_divider', {
    description: 'Enable or update a decorative divider on the bottom edge of a section. Dividers are visual separators between sections (e.g. wavy lines, jagged edges, scalloped curves). Set type to choose the shape, and optionally configure width, height, flip, and stroke.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      pageSlug: z.string().describe('Page URL slug (e.g. "home", "about")'),
      sectionIndex: z.number().describe('0-based section index'),
      type: z.enum(DIVIDER_TYPES).optional().describe('Divider shape: none, rounded, soft-corners, slanted, scalloped, wavy, jagged, pointed'),
      width: z.number().optional().describe('Width in vw units (e.g. 5=small, 50=medium, 100=full width)'),
      height: z.number().optional().describe('Height in vw units (e.g. 2=small, 4=medium, 6=large)'),
      flipX: z.boolean().optional().describe('Flip horizontally'),
      flipY: z.boolean().optional().describe('Flip vertically'),
      offset: z.number().optional().describe('Vertical offset in px'),
      strokeStyle: z.enum(STROKE_STYLES).optional().describe('Stroke style: none, solid, dashed'),
      strokeThickness: z.number().optional().describe('Stroke thickness in px (e.g. 5=small, 10=medium, 15=large)'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, type, width, height, flipX, flipY, offset, strokeStyle, strokeThickness }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return {
          content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }],
          isError: true,
        };
      }

      // Build divider config from provided params
      const dividerConfig: Record<string, unknown> = { enabled: true };
      if (type !== undefined) dividerConfig.type = type;
      if (width !== undefined) dividerConfig.width = { value: width, unit: 'vw' };
      if (height !== undefined) dividerConfig.height = { value: height, unit: 'vw' };
      if (flipX !== undefined) dividerConfig.isFlipX = flipX;
      if (flipY !== undefined) dividerConfig.isFlipY = flipY;
      if (offset !== undefined) dividerConfig.offset = { value: offset, unit: 'px' };
      if (strokeStyle !== undefined || strokeThickness !== undefined) {
        const stroke: Record<string, unknown> = {};
        if (strokeStyle !== undefined) stroke.style = strokeStyle;
        if (strokeThickness !== undefined) stroke.thickness = { value: strokeThickness, unit: 'px' };
        stroke.color = { type: 'THEME_COLOR' };
        dividerConfig.stroke = stroke;
      }

      const client = getClient(siteId);
      const result = await client.updateSectionDivider(
        ids.pageSectionsId, ids.collectionId, sectionIndex, dividerConfig,
      );

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to update divider'}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          sectionId: result.sectionId ?? null,
          sectionIndex,
          dividerConfig,
        }, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_remove_section_divider ───────────────────────────────────────────
  server.registerTool('sq_remove_section_divider', {
    description: 'Remove (disable) a decorative divider from a section.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      pageSlug: z.string().describe('Page URL slug (e.g. "home", "about")'),
      sectionIndex: z.number().describe('0-based section index'),
    },
  }, async ({ siteId, pageSlug, sectionIndex }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return {
          content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }],
          isError: true,
        };
      }

      const client = getClient(siteId);
      const result = await client.removeSectionDivider(
        ids.pageSectionsId, ids.collectionId, sectionIndex,
      );

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to remove divider'}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          sectionId: result.sectionId ?? null,
          sectionIndex,
        }, null, 2) }],
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

**Step 2: Run tests to verify they pass**

Run: `npx vitest run src/mcp-server/__tests__/divider-tools.test.ts`
Expected: ALL PASS (7 tests)

**Step 3: Commit**

```bash
git add src/mcp-server/tools/divider.ts
git commit -m "feat: add sq_update_section_divider and sq_remove_section_divider MCP tools"
```

---

### Task 6: Register divider tools in MCP server index

**Files:**
- Modify: `src/mcp-server/index.ts:22` (add import) and `index.ts:85` (add registration)

**Step 1: Add import**

After line 22 (`import { registerFormTools } from './tools/forms.js';`), add:

```typescript
import { registerDividerTools } from './tools/divider.js';
```

**Step 2: Add registration**

After line 85 (`registerFormTools(server);`), add:

```typescript
registerDividerTools(server);
```

**Step 3: Run all divider tests to confirm nothing broke**

Run: `npx vitest run src/services/__tests__/content-save-divider.test.ts src/mcp-server/__tests__/divider-tools.test.ts`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/mcp-server/index.ts
git commit -m "feat: register divider tools in MCP server"
```

---

### Task 7: Run full test suite and verify

**Step 1: Run full test suite**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
Expected: All tests pass (previous ~1417 + 14 new = ~1431)

**Step 2: Build to verify TypeScript compiles**

Run: `npx tsc --noCheck`
Expected: Compiles without errors

**Step 3: Final commit if any fixes needed**

If tests or build revealed issues, fix and commit.
