# Video & Embed MCP Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 4 MCP tools (`sq_add_video`, `sq_update_video`, `sq_add_embed`, `sq_update_embed`) so Claude Desktop and the orchestrator can add/update video and embed blocks without browser automation.

**Architecture:** Thin MCP tool wrappers in `blocks.ts` calling existing `ContentSaveClient` methods. `offsetColumns` layout param resolved to `startX`/`endX` before calling the client. Tests follow existing mock pattern.

**Tech Stack:** TypeScript, Zod 3, @modelcontextprotocol/sdk, vitest

---

### Task 1: Add `sq_add_video` and `sq_update_video` tools

**Files:**
- Modify: `src/mcp-server/tools/blocks.ts` (append after `sq_duplicate_block` tool, line ~349)

**Step 1: Add sq_add_video tool to blocks.ts**

Append after the `sq_duplicate_block` registration (before the closing `}` of `registerBlockTools`):

```typescript
  // ── sq_add_video ──────────────────────────────────────────────────────────
  server.registerTool('sq_add_video', {
    description:
      'Add a video block (YouTube, Vimeo, etc.) to a section on a Squarespace page. Default: full-width (24 cols), 8 rows tall.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the video to'),
      videoUrl: z.string().describe('Video URL (YouTube, Vimeo, etc.)'),
      title: z.string().optional().describe('Optional video title'),
      description: z.string().optional().describe('Optional video description'),
      layout: z.object({
        columns: z.number().optional().describe('Grid columns to span (default: 24)'),
        offsetColumns: z.number().optional().describe('Push block right by N columns (e.g. 12 = right half)'),
        rowHeight: z.number().optional().describe('Rows tall (default: 8)'),
        startX: z.number().optional().describe('Absolute grid start X (overrides columns/offset)'),
        endX: z.number().optional().describe('Absolute grid end X'),
        startY: z.number().optional().describe('Absolute grid start Y'),
        endY: z.number().optional().describe('Absolute grid end Y'),
      }).optional().describe('Optional grid layout settings'),
    },
  }, async ({ siteId, pageSlug, sectionIndex, videoUrl, title, description, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      // Resolve offsetColumns to startX/endX
      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 24);
      }

      const options: Record<string, any> = {};
      if (title !== undefined) options.title = title;
      if (description !== undefined) options.description = description;
      if (resolvedLayout) options.layout = resolvedLayout;
      const result = await client.addVideoBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, videoUrl, Object.keys(options).length > 0 ? options : undefined);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
```

**Step 2: Add sq_update_video tool to blocks.ts**

Append immediately after `sq_add_video`:

```typescript
  // ── sq_update_video ───────────────────────────────────────────────────────
  server.registerTool('sq_update_video', {
    description:
      'Update an existing video block on a Squarespace page. Finds the video by search text (matches URL, title, or description) and updates fields.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Text to find the video block (matches URL, title, or description)'),
      videoUrl: z.string().optional().describe('New video URL'),
      title: z.string().optional().describe('New video title'),
      description: z.string().optional().describe('New video description'),
    },
  }, async ({ siteId, pageSlug, searchText, videoUrl, title, description }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const updates: Record<string, any> = {};
      if (videoUrl !== undefined) updates.url = videoUrl;
      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      const result = await client.updateVideoBlock(ids.pageSectionsId, ids.collectionId, searchText, updates);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
```

**Step 3: Run existing tests to confirm nothing broke**

Run: `npx vitest run src/mcp-server/__tests__/block-tools.test.ts`
Expected: All 20 existing tests pass (the registration count test will fail — we fix that in Task 3)

**Step 4: Commit**

```bash
git add src/mcp-server/tools/blocks.ts
git commit -m "feat: add sq_add_video and sq_update_video MCP tools"
```

---

### Task 2: Add `sq_add_embed` and `sq_update_embed` tools

**Files:**
- Modify: `src/mcp-server/tools/blocks.ts` (append after `sq_update_video`)

**Step 1: Add sq_add_embed tool to blocks.ts**

Append after `sq_update_video`:

```typescript
  // ── sq_add_embed ──────────────────────────────────────────────────────────
  server.registerTool('sq_add_embed', {
    description:
      'Add a raw HTML embed block to a section on a Squarespace page. Use for iframes, Google Maps, Calendly, custom scripts, etc. Default: 12 cols wide, 6 rows tall.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      sectionIndex: z.number().describe('0-based section index to add the embed to'),
      html: z.string().optional().describe('Raw HTML embed code (iframe, script, etc.) — blank placeholder if omitted'),
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
  }, async ({ siteId, pageSlug, sectionIndex, html, layout }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);

      // Resolve offsetColumns to startX/endX
      const resolvedLayout = layout ? { ...layout } : undefined;
      if (resolvedLayout && resolvedLayout.offsetColumns != null && resolvedLayout.startX == null) {
        resolvedLayout.startX = resolvedLayout.offsetColumns + 1;
        resolvedLayout.endX = resolvedLayout.startX + (resolvedLayout.columns ?? 12);
      }

      const result = await client.addEmbedBlock(ids.pageSectionsId, ids.collectionId, sectionIndex, html, resolvedLayout);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
```

**Step 2: Add sq_update_embed tool to blocks.ts**

Append immediately after `sq_add_embed`:

```typescript
  // ── sq_update_embed ───────────────────────────────────────────────────────
  server.registerTool('sq_update_embed', {
    description:
      'Update the HTML content of an existing embed block on a Squarespace page. Finds the block by ID prefix or content match.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      searchText: z.string().describe('Block ID prefix or content text to find the embed block'),
      html: z.string().describe('New HTML embed code'),
    },
  }, async ({ siteId, pageSlug, searchText, html }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.updateEmbedBlock(ids.pageSectionsId, ids.collectionId, searchText, html);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
```

**Step 3: Commit**

```bash
git add src/mcp-server/tools/blocks.ts
git commit -m "feat: add sq_add_embed and sq_update_embed MCP tools"
```

---

### Task 3: Write tests for all 4 new tools

**Files:**
- Modify: `src/mcp-server/__tests__/block-tools.test.ts`

**Step 1: Add mock methods to mockClient**

At the top of block-tools.test.ts, add 4 new mock methods to the `mockClient` object (after `duplicateBlock`):

```typescript
  addVideoBlock: vi.fn(),
  updateVideoBlock: vi.fn(),
  addEmbedBlock: vi.fn(),
  updateEmbedBlock: vi.fn(),
```

**Step 2: Update registration count test**

Change the test `'should register all 10 block tools'` to `'should register all 14 block tools'` and add:

```typescript
    expect(server.tools.has('sq_add_video')).toBe(true);
    expect(server.tools.has('sq_update_video')).toBe(true);
    expect(server.tools.has('sq_add_embed')).toBe(true);
    expect(server.tools.has('sq_update_embed')).toBe(true);
```

**Step 3: Add sq_add_video tests**

Add after the `sq_duplicate_block` describe block:

```typescript
  // ── sq_add_video ───────────────────────────────────────────────────────
  describe('sq_add_video', () => {
    it('should add a video block with URL', async () => {
      mockClient.addVideoBlock.mockResolvedValue({ success: true, blockId: 'vid-1' });

      const result = await server.callTool('sq_add_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        videoUrl: 'https://www.youtube.com/watch?v=WCkcPcMTYuQ',
      });

      expect(mockClient.addVideoBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, 'https://www.youtube.com/watch?v=WCkcPcMTYuQ', undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('vid-1');
    });

    it('should pass title, description, and layout', async () => {
      mockClient.addVideoBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 1,
        videoUrl: 'https://vimeo.com/12345',
        title: 'Our Story',
        description: 'A short video about us',
        layout: { columns: 12, rowHeight: 10 },
      });

      expect(mockClient.addVideoBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 1, 'https://vimeo.com/12345',
        { title: 'Our Story', description: 'A short video about us', layout: { columns: 12, rowHeight: 10 } },
      );
    });

    it('should resolve offsetColumns to startX/endX', async () => {
      mockClient.addVideoBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        videoUrl: 'https://www.youtube.com/watch?v=abc',
        layout: { columns: 12, offsetColumns: 12 },
      });

      const callArgs = mockClient.addVideoBlock.mock.calls[0];
      const options = callArgs[4];
      expect(options.layout.startX).toBe(13);
      expect(options.layout.endX).toBe(25);
    });

    it('should not override explicit startX/endX with offsetColumns', async () => {
      mockClient.addVideoBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        videoUrl: 'https://www.youtube.com/watch?v=abc',
        layout: { startX: 5, endX: 20, offsetColumns: 12 },
      });

      const callArgs = mockClient.addVideoBlock.mock.calls[0];
      const options = callArgs[4];
      // startX/endX are explicit, so offsetColumns should not override
      expect(options.layout.startX).toBe(5);
      expect(options.layout.endX).toBe(20);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_video', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
        videoUrl: 'https://www.youtube.com/watch?v=abc',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });
  });
```

**Step 4: Add sq_update_video tests**

```typescript
  // ── sq_update_video ────────────────────────────────────────────────────
  describe('sq_update_video', () => {
    it('should update video URL', async () => {
      mockClient.updateVideoBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'youtube.com',
        videoUrl: 'https://www.youtube.com/watch?v=newvid',
      });

      expect(mockClient.updateVideoBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'youtube.com', { url: 'https://www.youtube.com/watch?v=newvid' },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should update title and description', async () => {
      mockClient.updateVideoBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_update_video', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        searchText: 'Our Story',
        title: 'Updated Title',
        description: 'Updated description',
      });

      expect(mockClient.updateVideoBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 'Our Story', { title: 'Updated Title', description: 'Updated description' },
      );
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_video', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
      });

      expect(result.isError).toBe(true);
    });
  });
```

**Step 5: Add sq_add_embed tests**

```typescript
  // ── sq_add_embed ───────────────────────────────────────────────────────
  describe('sq_add_embed', () => {
    it('should add an embed block with HTML', async () => {
      mockClient.addEmbedBlock.mockResolvedValue({ success: true, blockId: 'emb-1' });

      const result = await server.callTool('sq_add_embed', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        sectionIndex: 1,
        html: '<iframe src="https://calendly.com/example"></iframe>',
      });

      expect(mockClient.addEmbedBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 1, '<iframe src="https://calendly.com/example"></iframe>', undefined,
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.blockId).toBe('emb-1');
    });

    it('should add blank embed when html omitted', async () => {
      mockClient.addEmbedBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_embed', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(mockClient.addEmbedBlock).toHaveBeenCalledWith(
        'psi-home', 'col-home', 0, undefined, undefined,
      );
    });

    it('should resolve offsetColumns to startX/endX', async () => {
      mockClient.addEmbedBlock.mockResolvedValue({ success: true });

      await server.callTool('sq_add_embed', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        sectionIndex: 0,
        html: '<div>test</div>',
        layout: { columns: 12, offsetColumns: 12 },
      });

      const callArgs = mockClient.addEmbedBlock.mock.calls[0];
      const passedLayout = callArgs[4];
      expect(passedLayout.startX).toBe(13);
      expect(passedLayout.endX).toBe(25);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_embed', {
        siteId: 'bad-site',
        pageSlug: 'home',
        sectionIndex: 0,
      });

      expect(result.isError).toBe(true);
    });
  });
```

**Step 6: Add sq_update_embed tests**

```typescript
  // ── sq_update_embed ────────────────────────────────────────────────────
  describe('sq_update_embed', () => {
    it('should update embed HTML', async () => {
      mockClient.updateEmbedBlock.mockResolvedValue({ success: true });

      const result = await server.callTool('sq_update_embed', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        searchText: 'calendly',
        html: '<iframe src="https://calendly.com/new-link"></iframe>',
      });

      expect(mockClient.updateEmbedBlock).toHaveBeenCalledWith(
        'psi-contact', 'col-contact', 'calendly', '<iframe src="https://calendly.com/new-link"></iframe>',
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it('should return error on page resolve failure', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_update_embed', {
        siteId: 'bad-site',
        pageSlug: 'home',
        searchText: 'X',
        html: '<div>test</div>',
      });

      expect(result.isError).toBe(true);
    });
  });
```

**Step 7: Run all block tool tests**

Run: `npx vitest run src/mcp-server/__tests__/block-tools.test.ts`
Expected: All tests pass (old 20 + new ~16 = ~36 tests)

**Step 8: Commit**

```bash
git add src/mcp-server/__tests__/block-tools.test.ts
git commit -m "test: add tests for video and embed MCP tools"
```

---

### Task 4: Update MCP server instructions and prompt

**Files:**
- Modify: `src/mcp-server/index.ts` (INSTRUCTIONS constant and squarespace-guide prompt)

**Step 1: Update INSTRUCTIONS in index.ts**

In the "Building a New Page" section (line ~67), add video/embed to the tool list:

After line `3. Use sq_add_text_block, sq_add_button, sq_add_image to add content blocks.`, change it to:
```
3. Use sq_add_text_block, sq_add_button, sq_add_image, sq_add_video, sq_add_embed to add content blocks.
```

**Step 2: Update squarespace-guide prompt**

In the `squarespace-guide` prompt's tool catalog, add a new "### Video & Embeds" section after "### Buttons":

```
### Video & Embeds
- sq_add_video — add a video block (YouTube, Vimeo URL). Supports layout with offsetColumns for positioning.
- sq_update_video — update video URL, title, or description
- sq_add_embed — add raw HTML embed block (iframes, Google Maps, Calendly, scripts)
- sq_update_embed — update embed block HTML content
```

**Step 3: Commit**

```bash
git add src/mcp-server/index.ts
git commit -m "docs: add video and embed tools to MCP server instructions and guide"
```

---

### Task 5: Update CLAUDE.md and run full test suite

**Files:**
- Modify: `CLAUDE.md` (block tools count, MCP tool references)

**Step 1: Update CLAUDE.md**

Update the MCP tool count from "~40 tools" to "~44 tools" (search for occurrences). Add `sq_add_video`, `sq_update_video`, `sq_add_embed`, `sq_update_embed` to the block tools description in the tools table if present.

**Step 2: Run the full test suite**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
Expected: All tests pass (existing ~1349 + new ~16 = ~1365)

**Step 3: Compile to verify MCP server builds**

Run: `npx tsc --noCheck`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with video and embed MCP tools"
```
