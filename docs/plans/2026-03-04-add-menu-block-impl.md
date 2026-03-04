# Add Menu Block Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `sq_add_menu` MCP tool + `addMenuBlock()` ContentSaveClient method to create new menu blocks (type 18).

**Architecture:** Follows the `addEmbedBlock()` pattern: GET sections → validate → backfill → calculate grid position → build type 18 block → push to gridContents → PUT. Menu text parsed via existing `parseMenuText()`.

**Tech Stack:** TypeScript, vitest, Zod (MCP schemas), existing menu-parser.ts

---

### Task 1: Add MenuBlockAddResult type

**Files:**
- Modify: `src/services/content-save-types.ts:760` (after EmbedBlockAddResult)

**Step 1: Add the type**

Insert after line 760 (`}` closing EmbedBlockAddResult):

```ts
/** Result of adding a menu block */
export interface MenuBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  sectionId?: string;
  error?: string;
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit --noCheck 2>&1 | head -5`
Expected: no new errors

**Step 3: Commit**

```bash
git add src/services/content-save-types.ts
git commit -m "feat: add MenuBlockAddResult type"
```

---

### Task 2: Write failing tests for addMenuBlock()

**Files:**
- Modify: `src/services/__tests__/content-save-menu.test.ts` (add new describe block after existing tests, before final `});`)

**Step 1: Add the mock for parseMenuText**

The test file already mocks `../menu-parser.js` with `serializeMenu`. Update the existing mock at line 27 to also include `parseMenuText`:

```ts
vi.mock('../menu-parser.js', () => ({
  serializeMenu: vi.fn((menus: any[]) => menus.map((t: any) => t.title).join('\n')),
  parseMenuText: vi.fn((text: string) => {
    // Simple mock: split by ========, return as tabs
    const tabs = text.split(/\n={3,}\n?/).filter(Boolean);
    return tabs.map(t => ({ title: t.trim().split('\n')[0], description: null, sections: [{ title: null, description: null, items: [] }] }));
  }),
}));
```

**Step 2: Write the test block**

Add before the final `});` of the describe block (before line 574):

```ts
  describe('addMenuBlock', () => {
    it('adds an empty menu block when no menuText provided', async () => {
      const sections = makeSections(makeTextBlock('txt-1', '<p>Hello</p>'));
      const fetchSpy = vi.spyOn(client as any, 'fetchWithSession')
        .mockResolvedValueOnce({ ok: true, json: async () => makePageSectionsData(sections) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'saved' }) });

      const result = await client.addMenuBlock('ps-1', 'col-1', 0);

      expect(result.success).toBe(true);
      expect(result.blockId).toBeDefined();
      expect(result.sectionIndex).toBe(0);

      // Verify the PUT body
      const putCall = fetchSpy.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const addedBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
      expect(addedBlock.content.value.type).toBe(18);
      expect(addedBlock.content.value.value.menuStyle).toBe('classic');
      expect(addedBlock.content.value.value.currencySymbol).toBe('$');
      expect(addedBlock.content.value.value.menus).toEqual([{ title: null, description: null, sections: [{ title: null, description: null, items: [] }] }]);
      expect(addedBlock.content.value.value.raw).toBe('');
    });

    it('adds a menu block with menuText parsed into structured menus', async () => {
      const sections = makeSections();
      const fetchSpy = vi.spyOn(client as any, 'fetchWithSession')
        .mockResolvedValueOnce({ ok: true, json: async () => makePageSectionsData(sections) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'saved' }) });

      const menuText = 'Lunch\n========\nStarters\n------\nSoup\n$10';
      const result = await client.addMenuBlock('ps-1', 'col-1', 0, menuText);

      expect(result.success).toBe(true);

      const putCall = fetchSpy.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const addedBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(addedBlock.content.value.type).toBe(18);
      expect(addedBlock.content.value.value.raw).toBe(menuText);
      // parseMenuText mock was called
      const { parseMenuText } = await import('../menu-parser.js') as any;
      expect(parseMenuText).toHaveBeenCalledWith(menuText);
    });

    it('uses custom menuStyle and currencySymbol', async () => {
      const sections = makeSections();
      const fetchSpy = vi.spyOn(client as any, 'fetchWithSession')
        .mockResolvedValueOnce({ ok: true, json: async () => makePageSectionsData(sections) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'saved' }) });

      const result = await client.addMenuBlock('ps-1', 'col-1', 0, undefined, {
        menuStyle: 'modern',
        currencySymbol: '£',
      });

      expect(result.success).toBe(true);
      const putCall = fetchSpy.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const addedBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(addedBlock.content.value.value.menuStyle).toBe('modern');
      expect(addedBlock.content.value.value.currencySymbol).toBe('£');
    });

    it('returns error for out-of-range sectionIndex', async () => {
      const sections = makeSections();
      vi.spyOn(client as any, 'fetchWithSession')
        .mockResolvedValueOnce({ ok: true, json: async () => makePageSectionsData(sections) });

      const result = await client.addMenuBlock('ps-1', 'col-1', 5);

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');
    });

    it('calculates grid position below existing blocks', async () => {
      const existingBlock = makeTextBlock('txt-1', '<p>Hello</p>');
      existingBlock.layout.desktop = { start: { x: 1, y: 0 }, end: { x: 13, y: 5 }, verticalAlignment: 'top', zIndex: 0 };
      existingBlock.layout.mobile = { start: { x: 1, y: 0 }, end: { x: 9, y: 5 }, verticalAlignment: 'top', zIndex: 0 };
      const sections = makeSections(existingBlock);
      const fetchSpy = vi.spyOn(client as any, 'fetchWithSession')
        .mockResolvedValueOnce({ ok: true, json: async () => makePageSectionsData(sections) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'saved' }) });

      await client.addMenuBlock('ps-1', 'col-1', 0);

      const putCall = fetchSpy.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const addedBlock = putBody.sections[0].fluidEngineContext.gridContents[1];
      // Should be below existing block (y=5) + gap (2) = 7
      expect(addedBlock.layout.desktop.start.y).toBe(7);
    });

    it('respects custom layout options (columns, startX, endX)', async () => {
      const sections = makeSections();
      const fetchSpy = vi.spyOn(client as any, 'fetchWithSession')
        .mockResolvedValueOnce({ ok: true, json: async () => makePageSectionsData(sections) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'saved' }) });

      await client.addMenuBlock('ps-1', 'col-1', 0, undefined, {
        startX: 5,
        endX: 20,
        rowHeight: 10,
      });

      const putCall = fetchSpy.mock.calls[1];
      const putBody = JSON.parse(putCall[1].body);
      const addedBlock = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(addedBlock.layout.desktop.start.x).toBe(5);
      expect(addedBlock.layout.desktop.end.x).toBe(20);
    });

    it('returns error when save fails', async () => {
      const sections = makeSections();
      vi.spyOn(client as any, 'fetchWithSession')
        .mockResolvedValueOnce({ ok: true, json: async () => makePageSectionsData(sections) })
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Server error' });

      const result = await client.addMenuBlock('ps-1', 'col-1', 0);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
```

**Step 3: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-menu.test.ts 2>&1 | tail -20`
Expected: FAIL — `client.addMenuBlock is not a function`

**Step 4: Commit**

```bash
git add src/services/__tests__/content-save-menu.test.ts
git commit -m "test: add failing tests for addMenuBlock()"
```

---

### Task 3: Implement addMenuBlock() on ContentSaveClient

**Files:**
- Modify: `src/services/content-save.ts` — add method after `addEmbedBlock()` (after line 6229), add import for MenuBlockAddResult

**Step 1: Add MenuBlockAddResult to imports**

Find the import line for content-save-types.ts and add `MenuBlockAddResult`:

```ts
// Find existing import from './content-save-types.js' and add MenuBlockAddResult
```

**Step 2: Implement addMenuBlock()**

Insert after line 6229 (closing `}` of `addEmbedBlock`):

```ts
  /**
   * Add a new menu block (type 18) to a section.
   * If menuText is provided, parses it via parseMenuText() into structured menus.
   * Otherwise creates an empty menu with one blank tab/section.
   */
  async addMenuBlock(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    menuText?: string,
    options?: {
      menuStyle?: string;
      currencySymbol?: string;
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    },
  ): Promise<MenuBlockAddResult> {
    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);
      const sections = data.sections;

      // Step 2: Validate section index
      if (sectionIndex < 0 || sectionIndex >= sections.length) {
        return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
      }

      const section = sections[sectionIndex];
      if (!section.fluidEngineContext) {
        return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
      }

      const gridContents = section.fluidEngineContext.gridContents;
      const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

      // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
      for (let i = 0; i < gridContents.length; i++) {
        const gc = gridContents[i];
        if (gc.layout?.desktop) {
          if (gc.layout.desktop.verticalAlignment == null) gc.layout.desktop.verticalAlignment = 'top';
          if (gc.layout.desktop.zIndex == null) gc.layout.desktop.zIndex = i;
        }
        if (gc.layout?.mobile) {
          if (gc.layout.mobile.verticalAlignment == null) gc.layout.mobile.verticalAlignment = 'top';
          if (gc.layout.mobile.zIndex == null) gc.layout.mobile.zIndex = i;
        }
      }

      // Step 3: Calculate position
      let maxY = 0;
      let maxMobileY = 0;
      for (const gc of gridContents) {
        const endYVal = gc.layout?.desktop?.end?.y ?? 0;
        const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
        if (endYVal > maxY) maxY = endYVal;
        if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
      }

      const rowHeight = options?.rowHeight ?? 6;
      const gapRows = options?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

      let startX: number;
      let endX: number;
      let startY: number;
      let endY: number;

      if (options?.startX != null && options?.endX != null) {
        startX = Math.max(1, options.startX);
        endX = Math.min(maxColumns + 1, options.endX);
      } else {
        const cols = options?.columns ?? 12;
        startX = 1;
        endX = Math.min(startX + cols, maxColumns + 1);
      }

      if (options?.startY != null && options?.endY != null) {
        startY = Math.max(0, options.startY);
        endY = options.endY;
      } else {
        startY = maxY + gapRows;
        endY = startY + rowHeight;
      }

      // Step 4: Generate block ID and build menu content
      const blockId = ContentSaveClient.generateBlockId();

      const maxZ = gridContents.reduce((max, gc) => {
        const dz = gc.layout?.desktop?.zIndex ?? 0;
        const mz = gc.layout?.mobile?.zIndex ?? 0;
        return Math.max(max, dz, mz);
      }, 0);
      const zIndex = maxZ + 1;

      // Parse menu text or create empty default
      let menus: any[];
      let raw: string;
      if (menuText) {
        const { parseMenuText } = await import('./menu-parser.js');
        menus = parseMenuText(menuText);
        raw = menuText;
      } else {
        menus = [{ title: null, description: null, sections: [{ title: null, description: null, items: [] }] }];
        raw = '';
      }

      const newBlock: GridContent = {
        layout: {
          mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
          desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
        },
        content: {
          value: {
            id: blockId,
            type: BLOCK_TYPE_MENU,
            value: {
              raw,
              menus,
              menuStyle: options?.menuStyle ?? 'classic',
              currencySymbol: options?.currencySymbol ?? '$',
            },
          },
        },
      };

      // Step 5: Push to gridContents
      gridContents.push(newBlock);

      logger.info(
        { blockId, sectionIndex, sectionId: section.id, hasMenuText: !!menuText, position: { startX, startY, endX, endY } },
        'Adding menu block via Content Save API',
      );

      // Step 6: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return { success: true, blockId, sectionIndex, sectionId: section.id };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }
```

**Step 3: Run the tests**

Run: `npx vitest run src/services/__tests__/content-save-menu.test.ts 2>&1 | tail -20`
Expected: All addMenuBlock tests PASS

**Step 4: Commit**

```bash
git add src/services/content-save.ts src/services/content-save-types.ts
git commit -m "feat: add addMenuBlock() to ContentSaveClient"
```

---

### Task 4: Write failing tests for sq_add_menu MCP tool

**Files:**
- Modify: `src/mcp-server/__tests__/content-tools.test.ts`

**Step 1: Add sq_add_menu to the tool registration check**

Find the line that checks `sq_update_menu` registration and add after it:

```ts
expect(server.tools.has('sq_add_menu')).toBe(true);
```

**Step 2: Add test block**

Add after the `sq_update_menu` describe block:

```ts
  describe('sq_add_menu', () => {
    it('should add a menu block with menuText', async () => {
      mockClient.addMenuBlock.mockResolvedValue({ success: true, blockId: 'menu-1', sectionIndex: 0 });

      const result = await server.callTool('sq_add_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'menu-page',
        sectionIndex: 0,
        menuText: 'Lunch\n========\nStarters\n------\nSoup\n$10',
      });

      expect(mockClient.addMenuBlock).toHaveBeenCalledWith(
        'psi-menu-page', 'col-menu-page', 0, 'Lunch\n========\nStarters\n------\nSoup\n$10', undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('menu-1');
    });

    it('should add empty menu block when menuText omitted', async () => {
      mockClient.addMenuBlock.mockResolvedValue({ success: true, blockId: 'menu-2' });

      await server.callTool('sq_add_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(mockClient.addMenuBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, undefined, undefined,
      );
    });

    it('should pass menuStyle and currencySymbol as options', async () => {
      mockClient.addMenuBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        menuStyle: 'modern',
        currencySymbol: '€',
      });

      const callArgs = mockClient.addMenuBlock.mock.calls[0];
      const passedOpts = callArgs[4];
      expect(passedOpts.menuStyle).toBe('modern');
      expect(passedOpts.currencySymbol).toBe('€');
    });

    it('should resolve offsetColumns to startX/endX', async () => {
      mockClient.addMenuBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_menu', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        layout: { columns: 12, offsetColumns: 12 },
      });

      const callArgs = mockClient.addMenuBlock.mock.calls[0];
      const passedOpts = callArgs[4];
      expect(passedOpts.startX).toBe(13);
      expect(passedOpts.endX).toBe(25);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_menu', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(result.isError).toBe(true);
    });
  });
```

**Step 3: Run tests to verify they fail**

Run: `npx vitest run src/mcp-server/__tests__/content-tools.test.ts 2>&1 | tail -20`
Expected: FAIL — `sq_add_menu` not registered

**Step 4: Commit**

```bash
git add src/mcp-server/__tests__/content-tools.test.ts
git commit -m "test: add failing tests for sq_add_menu MCP tool"
```

---

### Task 5: Implement sq_add_menu MCP tool

**Files:**
- Modify: `src/mcp-server/tools/content.ts` — add tool after `sq_update_menu` (after line 276)

**Step 1: Update the file header comment**

Add `sq_add_menu: Add a new menu block` to the header comment.

**Step 2: Register the tool**

Insert after line 276 (closing of sq_update_menu handler):

```ts
  // ── sq_add_menu ──────────────────────────────────────────────────────────────
  server.registerTool('sq_add_menu', {
    description:
      'Add a new menu block (type 18) to a section on a Squarespace page. Optionally provide initial menu content in Squarespace menu text format (tabs with ========, sections with ------, items with $price).',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the menu to'),
      menuText: z.string().optional().describe('Menu content in Squarespace text format — tabs (========), sections (------), items ($price). Omit for empty menu.'),
      menuStyle: z.string().optional().describe('Menu display style (default: "classic")'),
      currencySymbol: z.string().optional().describe('Currency symbol (default: "$")'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 12)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns (e.g. 12 = right half)'),
        rowHeight: z.number().optional().describe('Rows tall (default: 6)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, menuText, menuStyle, currencySymbol, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      // Resolve offsetColumns to startX/endX, then strip convenience keys
      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 12);
      }
      if (resolvedLayout) delete resolvedLayout.offsetColumns;

      // Build options from top-level params + resolved layout
      const options = (menuStyle || currencySymbol || resolvedLayout)
        ? { ...resolvedLayout, ...(menuStyle ? { menuStyle } : {}), ...(currencySymbol ? { currencySymbol } : {}) }
        : undefined;

      const result = await client.addMenuBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, menuText, options);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(result.success ? {} : { isError: true }),
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
```

**Step 3: Add `addMenuBlock` to the mock in content-tools.test.ts**

Check the mockClient setup in the test file — ensure `addMenuBlock` is in the mock object.

**Step 4: Run tests**

Run: `npx vitest run src/mcp-server/__tests__/content-tools.test.ts 2>&1 | tail -20`
Expected: All sq_add_menu tests PASS

**Step 5: Run full test suite**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**' 2>&1 | tail -5`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/mcp-server/tools/content.ts src/mcp-server/__tests__/content-tools.test.ts
git commit -m "feat: add sq_add_menu MCP tool for creating menu blocks"
```

---

### Task 6: Update MCP server tool count and docs

**Files:**
- Modify: `src/mcp-server/index.ts` — verify tool count comment if present
- Verify: tool shows up in MCP server tool list

**Step 1: Check tool count**

Run: `npx vitest run src/mcp-server/__tests__/tools.test.ts 2>&1 | tail -10`

If the test checks a specific tool count, update it to include the new tool.

**Step 2: Compile for MCP**

Run: `npx tsc --noCheck`
Expected: compiles successfully, `dist/src/mcp-server/index.js` updated

**Step 3: Commit if needed**

```bash
git add -A
git commit -m "chore: update tool count for sq_add_menu"
```
