# Atomic Section Creation + Template Orphan Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix section creation so blocks can be added to new sections by creating sections with initial content atomically, and fix the template section orphan bug.

**Architecture:** New `addSectionWithBlocks()` method on ContentSaveClient builds a section with pre-populated `gridContents` in a single PUT. Block-building logic extracted from existing `addTextBlock`/`addEmbedBlock`/etc. into reusable builder functions. Template section fix appends the copied section to the target page via GET → append → PUT after the copy API call.

**Tech Stack:** TypeScript, Vitest, Squarespace Content Save API (PUT /api/page-sections)

---

### Task 1: Add Types for InitialBlock and AddSectionWithBlocksResult

**Files:**
- Modify: `src/services/content-save-types.ts:335-339` (insert after AddBlankSectionResult)

**Step 1: Add the new types**

Add after `AddBlankSectionResult` (line 339):

```typescript
/** Hints for block positioning within a section */
export interface LayoutHints {
  columns?: number;
  rowHeight?: number;
  gapRows?: number;
  startX?: number;
  endX?: number;
  startY?: number;
  endY?: number;
}

/** Text formatting options for text blocks */
export interface TextBlockFormatting {
  tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'p';
  alignment?: 'left' | 'center' | 'right';
  bold?: boolean;
  italic?: boolean;
}

/** Block specification for atomic section creation */
export type InitialBlock =
  | { type: 'text'; html: string; layout?: LayoutHints; formatting?: TextBlockFormatting }
  | { type: 'embed'; html: string; layout?: LayoutHints }
  | { type: 'button'; text: string; url: string; layout?: LayoutHints }
  | { type: 'image'; assetUrl: string; altText?: string; layout?: LayoutHints }
  | { type: 'video'; videoUrl: string; title?: string; description?: string; layout?: LayoutHints };

/** Result of adding a section with initial blocks */
export interface AddSectionWithBlocksResult {
  success: boolean;
  sectionId?: string;
  sectionIndex?: number;
  blockIds?: string[];
  error?: string;
}
```

**Step 2: Verify build compiles**

Run: `npx tsc --noCheck --noEmit 2>&1 | head -5`
Expected: No new errors related to these types

**Step 3: Commit**

```bash
git add src/services/content-save-types.ts
git commit -m "feat: add InitialBlock and AddSectionWithBlocksResult types"
```

---

### Task 2: Extract Block Builder Functions

Extract the block content-building logic from existing methods into reusable functions. These go in `content-save.ts` as static methods on ContentSaveClient.

**Files:**
- Modify: `src/services/content-save.ts` (add static methods near line ~3200, before `addTextBlock`)

**Step 1: Write tests for block builders**

Add to `src/services/__tests__/content-save-sections.test.ts` at the end of the file (before the closing `});`):

```typescript
  // ── Block Builders (static) ────────────────────────────────────────────

  describe('buildBlockContent (static helpers)', () => {
    it('buildTextBlockContent creates type 2 block content', () => {
      const content = ContentSaveClient.buildTextBlockContent('blk-1', '<p>Hello</p>');
      expect(content.value.id).toBe('blk-1');
      expect(content.value.type).toBe(2);
      expect(content.value.value.engine).toBe('wysiwyg');
      expect(content.value.value.source).toBe('<p>Hello</p>');
      expect(content.value.value.html).toBe('<p>Hello</p>');
    });

    it('buildTextBlockContent with formatting wraps plain text', () => {
      const content = ContentSaveClient.buildTextBlockContent('blk-1', 'Hello', { tag: 'h2', alignment: 'center' });
      expect(content.value.value.source).toContain('<h2');
      expect(content.value.value.source).toContain('text-align:center');
      expect(content.value.value.source).toContain('Hello');
    });

    it('buildEmbedBlockContent creates type 22 block content', () => {
      const content = ContentSaveClient.buildEmbedBlockContent('blk-2', '<iframe src="https://example.com"></iframe>');
      expect(content.value.id).toBe('blk-2');
      expect(content.value.type).toBe(22);
      expect(content.value.value.html).toBe('<iframe src="https://example.com"></iframe>');
      expect(content.value.containerStyles).toEqual({ backgroundEnabled: false, stretchedToFill: false });
    });

    it('buildButtonBlockContent creates type 1337 with definitionName', () => {
      const content = ContentSaveClient.buildButtonBlockContent('blk-3', 'Click Me', 'https://example.com');
      expect(content.value.id).toBe('blk-3');
      expect(content.value.type).toBe(1337);
      expect(content.value.value.buttonText).toBe('Click Me');
      expect(content.value.value.buttonLink).toBe('https://example.com');
      expect(content.value.definitionName).toBe('website.components.button');
    });

    it('buildImageBlockContent creates type 1337 without definitionName', () => {
      const content = ContentSaveClient.buildImageBlockContent('blk-4', 'https://images.squarespace-cdn.com/test.jpg', 'A photo');
      expect(content.value.id).toBe('blk-4');
      expect(content.value.type).toBe(1337);
      expect(content.value.value.assetUrl).toBe('https://images.squarespace-cdn.com/test.jpg');
      expect(content.value.altText).toBe('A photo');
      expect(content.value.definitionName).toBeUndefined();
    });

    it('buildVideoBlockContent creates type 32 block content', () => {
      const content = ContentSaveClient.buildVideoBlockContent('blk-5', 'https://youtube.com/watch?v=abc');
      expect(content.value.id).toBe('blk-5');
      expect(content.value.type).toBe(32);
      expect(content.value.value.url).toBe('https://youtube.com/watch?v=abc');
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-sections.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `buildTextBlockContent` is not a function

**Step 3: Implement block builder static methods**

Add these static methods to `ContentSaveClient` class in `content-save.ts`, right before the `addTextBlock` method (around line ~3300). These extract the content-building from existing `addTextBlock`, `addEmbedBlock`, `addButtonBlock`, `addImageBlock`, `addVideoBlock` without changing those methods.

```typescript
  // ── Block Content Builders (static) ──────────────────────────────────
  // Reusable functions to build GridContent.content for each block type.
  // Used by addSectionWithBlocks() and could replace inline construction
  // in existing addXxxBlock methods in the future.

  static buildTextBlockContent(
    blockId: string,
    html: string,
    formatting?: { tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'p'; alignment?: 'left' | 'center' | 'right'; bold?: boolean; italic?: boolean },
  ): GridContent['content'] {
    // Reuse formatHtml logic — if formatting provided and html has no tags, wrap it
    let formattedHtml = html;
    if (formatting && !html.startsWith('<')) {
      const tag = formatting.tag ?? 'p';
      const styles = ['white-space:pre-wrap'];
      if (formatting.alignment) styles.push(`text-align:${formatting.alignment}`);
      let inner = html;
      if (formatting.italic) inner = `<em>${inner}</em>`;
      if (formatting.bold) inner = `<strong>${inner}</strong>`;
      formattedHtml = `<${tag} style="${styles.join(';')}">${inner}</${tag}>`;
    }
    return {
      value: {
        id: blockId,
        type: 2, // BLOCK_TYPE_TEXT
        value: { engine: 'wysiwyg', source: formattedHtml, html: formattedHtml, textAttributes: [] },
      },
    };
  }

  static buildEmbedBlockContent(blockId: string, html: string): GridContent['content'] {
    return {
      value: {
        id: blockId,
        type: 22, // BLOCK_TYPE_EMBED
        value: html ? { html } : {},
        containerStyles: { backgroundEnabled: false, stretchedToFill: false },
      },
    };
  }

  static buildButtonBlockContent(blockId: string, text: string, url: string): GridContent['content'] {
    return {
      value: {
        id: blockId,
        type: 1337, // BLOCK_TYPE_IMAGE (buttons share this type)
        value: {
          buttonText: text,
          buttonLink: url,
          newWindow: false,
          buttonAlignment: 'center',
          buttonSize: 'medium',
          containerStyles: { stretchedToFill: true },
          transforms: {
            rotation: { value: 0, unit: 'deg' },
            scale: { x: { value: 100, unit: '%' }, y: { value: 100, unit: '%' } },
            opacity: { value: 100, unit: '%' },
            offset: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } },
            origin: { x: { value: 50, unit: '%' }, y: { value: 50, unit: '%' } },
            skew: { x: { value: 0, unit: 'deg' }, y: { value: 0, unit: 'deg' } },
          },
          animations: [],
          breakpointOverrides: {},
        },
        containerStyles: { backgroundEnabled: false, stretchedToFill: false },
        definitionName: 'website.components.button',
      },
    };
  }

  static buildImageBlockContent(blockId: string, assetUrl: string, altText?: string): GridContent['content'] {
    const blockContent: Record<string, unknown> = {
      id: blockId,
      type: 1337, // BLOCK_TYPE_IMAGE
      value: { assetUrl, layout: 'caption-below', linkTo: '' },
    };
    if (altText !== undefined) blockContent.altText = altText;
    return { value: blockContent as GridContent['content']['value'] };
  }

  static buildVideoBlockContent(blockId: string, videoUrl: string, title?: string, description?: string): GridContent['content'] {
    return {
      value: {
        id: blockId,
        type: 32, // BLOCK_TYPE_VIDEO
        value: { url: videoUrl, title, description },
      },
    };
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-sections.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All block builder tests PASS

**Step 5: Commit**

```bash
git add src/services/content-save.ts src/services/__tests__/content-save-sections.test.ts
git commit -m "feat: extract block content builders as static methods on ContentSaveClient"
```

---

### Task 3: Implement `addSectionWithBlocks()` Method

**Files:**
- Modify: `src/services/content-save.ts` (add method after `addBlankSection`, around line ~8348)
- Modify: `src/services/__tests__/content-save-sections.test.ts` (add tests)

**Step 1: Write failing tests**

Add to `src/services/__tests__/content-save-sections.test.ts` before the closing `});`:

```typescript
  // ── addSectionWithBlocks ──────────────────────────────────────────────

  describe('addSectionWithBlocks()', () => {
    it('creates a section with a single text block in one PUT', async () => {
      mockGetPut([makeSection('sec-0', [makeTextBlock('blk-0', '<p>Existing</p>')])]);

      const result = await client.addSectionWithBlocks(PS_ID, COLL_ID, [
        { type: 'text', html: '<p>Contact us</p>' },
      ]);

      expect(result.success).toBe(true);
      expect(result.sectionId).toMatch(/^[0-9a-f]{24}$/);
      expect(result.blockIds).toHaveLength(1);
      expect(result.blockIds![0]).toMatch(/^[0-9a-f]{20}$/);
      expect(result.sectionIndex).toBe(1); // Appended after sec-0

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(putBody.sections).toHaveLength(2);
      const newSection = putBody.sections[1];
      expect(newSection.sectionName).toBe('FLUID_ENGINE');
      expect(newSection.fluidEngineContext.gridContents).toHaveLength(1);
      expect(newSection.fluidEngineContext.gridContents[0].content.value.type).toBe(2);
    });

    it('creates a section with multiple mixed blocks', async () => {
      mockGetPut([]);

      const result = await client.addSectionWithBlocks(PS_ID, COLL_ID, [
        { type: 'text', html: '<h2>Welcome</h2>' },
        { type: 'embed', html: '<iframe src="https://maps.google.com"></iframe>' },
        { type: 'button', text: 'Contact Us', url: '/contact' },
      ]);

      expect(result.success).toBe(true);
      expect(result.blockIds).toHaveLength(3);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const gridContents = putBody.sections[0].fluidEngineContext.gridContents;
      expect(gridContents).toHaveLength(3);
      expect(gridContents[0].content.value.type).toBe(2);  // text
      expect(gridContents[1].content.value.type).toBe(22); // embed
      expect(gridContents[2].content.value.type).toBe(1337); // button
    });

    it('stacks blocks vertically with gap rows', async () => {
      mockGetPut([]);

      await client.addSectionWithBlocks(PS_ID, COLL_ID, [
        { type: 'text', html: '<p>First</p>' },
        { type: 'text', html: '<p>Second</p>' },
      ]);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const blocks = putBody.sections[0].fluidEngineContext.gridContents;
      // First block starts at y=0
      expect(blocks[0].layout.desktop.start.y).toBe(0);
      // Second block starts after first block end + gap
      expect(blocks[1].layout.desktop.start.y).toBeGreaterThan(blocks[0].layout.desktop.end.y);
    });

    it('inserts at specified position', async () => {
      mockGetPut([
        makeSection('sec-0', [makeTextBlock('blk-0', '<p>First</p>')]),
        makeSection('sec-1', [makeTextBlock('blk-1', '<p>Last</p>')]),
      ]);

      const result = await client.addSectionWithBlocks(PS_ID, COLL_ID,
        [{ type: 'text', html: '<p>Middle</p>' }],
        { position: 1 },
      );

      expect(result.success).toBe(true);
      expect(result.sectionIndex).toBe(1);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(putBody.sections).toHaveLength(3);
      // New section is at index 1
      expect(putBody.sections[1].fluidEngineContext.gridContents[0].content.value.value.source).toBe('<p>Middle</p>');
      // Original sec-1 moved to index 2
      expect(putBody.sections[2].id).toBe('sec-1');
    });

    it('rejects empty blocks array', async () => {
      const result = await client.addSectionWithBlocks(PS_ID, COLL_ID, []);

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least one block');
    });

    it('returns error when GET fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Server error' });

      const result = await client.addSectionWithBlocks(PS_ID, COLL_ID, [
        { type: 'text', html: '<p>Test</p>' },
      ]);

      expect(result.success).toBe(false);
    });

    it('returns error when PUT fails', async () => {
      mockGetPutFail([]);

      const result = await client.addSectionWithBlocks(PS_ID, COLL_ID, [
        { type: 'text', html: '<p>Test</p>' },
      ]);

      expect(result.success).toBe(false);
    });

    it('all blocks have verticalAlignment and zIndex set', async () => {
      mockGetPut([]);

      await client.addSectionWithBlocks(PS_ID, COLL_ID, [
        { type: 'text', html: '<p>A</p>' },
        { type: 'embed', html: '<div>B</div>' },
      ]);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const blocks = putBody.sections[0].fluidEngineContext.gridContents;
      for (const block of blocks) {
        expect(block.layout.desktop.verticalAlignment).toBe('top');
        expect(block.layout.desktop.zIndex).toBeDefined();
        expect(block.layout.mobile.verticalAlignment).toBe('top');
        expect(block.layout.mobile.zIndex).toBeDefined();
      }
    });

    it('supports image and video block types', async () => {
      mockGetPut([]);

      const result = await client.addSectionWithBlocks(PS_ID, COLL_ID, [
        { type: 'image', assetUrl: 'https://images.squarespace-cdn.com/test.jpg', altText: 'Photo' },
        { type: 'video', videoUrl: 'https://youtube.com/watch?v=abc' },
      ]);

      expect(result.success).toBe(true);
      expect(result.blockIds).toHaveLength(2);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const blocks = putBody.sections[0].fluidEngineContext.gridContents;
      expect(blocks[0].content.value.type).toBe(1337); // image
      expect(blocks[0].content.value.value.assetUrl).toBe('https://images.squarespace-cdn.com/test.jpg');
      expect(blocks[1].content.value.type).toBe(32);   // video
    });

    it('applies text formatting when provided', async () => {
      mockGetPut([]);

      await client.addSectionWithBlocks(PS_ID, COLL_ID, [
        { type: 'text', html: 'Contact Us', formatting: { tag: 'h2', alignment: 'center' } },
      ]);

      const putBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const block = putBody.sections[0].fluidEngineContext.gridContents[0];
      expect(block.content.value.value.source).toContain('<h2');
      expect(block.content.value.value.source).toContain('text-align:center');
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-sections.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: FAIL — `addSectionWithBlocks` is not a function

**Step 3: Implement `addSectionWithBlocks()`**

Add this method to `ContentSaveClient` in `content-save.ts`, right after `addBlankSection` (after line ~8348):

```typescript
  // ── Atomic Section + Blocks Creation ─────────────────────────────────

  /**
   * Create a new Fluid Engine section with initial blocks pre-populated.
   * This is the preferred way to add new sections because Squarespace's
   * backend may not fully initialize empty sections created via API,
   * causing 500 errors on subsequent block insertions.
   *
   * All blocks are positioned using the same auto-stacking logic as
   * addTextBlock() — each block placed below the previous with gap rows.
   */
  async addSectionWithBlocks(
    pageSectionsId: string,
    collectionId: string,
    blocks: InitialBlock[],
    options?: {
      position?: number;
      styles?: Partial<SectionStyles>;
    },
  ): Promise<AddSectionWithBlocksResult> {
    try {
      if (blocks.length === 0) {
        return { success: false, error: 'addSectionWithBlocks requires at least one block' };
      }

      this.ensureCookies();
      const data = await this.getPageSections(pageSectionsId);

      // Build blank section skeleton (same as addBlankSection)
      const newSectionId = ContentSaveClient.generateSectionId();
      const defaultStyles = {
        backgroundWidth: 'background-width--full-bleed',
        imageOverlayOpacity: 0.15,
        sectionHeight: 'section-height--medium',
        customSectionHeight: 10,
        horizontalAlignment: 'horizontal-alignment--center',
        verticalAlignment: 'vertical-alignment--middle',
        contentWidth: 'content-width--wide',
        customContentWidth: 50,
        sectionTheme: '',
        sectionAnimation: 'none',
        backgroundMode: 'image',
        ...(options?.styles ?? {}),
      };

      // Build gridContents from InitialBlock specs
      const gridContents: GridContent[] = [];
      const blockIds: string[] = [];
      const maxColumns = 24;
      let maxY = 0;
      let maxMobileY = 0;

      for (let i = 0; i < blocks.length; i++) {
        const spec = blocks[i];
        const blockId = ContentSaveClient.generateBlockId();
        blockIds.push(blockId);

        // Build content for this block type
        let content: GridContent['content'];
        let defaultCols: number;
        let defaultRowHeight: number;

        switch (spec.type) {
          case 'text':
            content = ContentSaveClient.buildTextBlockContent(blockId, spec.html, spec.formatting);
            defaultCols = maxColumns;
            defaultRowHeight = 3;
            break;
          case 'embed':
            content = ContentSaveClient.buildEmbedBlockContent(blockId, spec.html);
            defaultCols = 12;
            defaultRowHeight = 6;
            break;
          case 'button':
            content = ContentSaveClient.buildButtonBlockContent(blockId, spec.text, spec.url);
            defaultCols = 7;
            defaultRowHeight = 2;
            break;
          case 'image':
            content = ContentSaveClient.buildImageBlockContent(blockId, spec.assetUrl, spec.altText);
            defaultCols = 12;
            defaultRowHeight = 8;
            break;
          case 'video':
            content = ContentSaveClient.buildVideoBlockContent(blockId, spec.videoUrl, spec.title, spec.description);
            defaultCols = maxColumns;
            defaultRowHeight = 8;
            break;
          default:
            return { success: false, error: `Unknown block type: ${(spec as any).type}` };
        }

        // Calculate layout
        const layout = spec.layout;
        const gapRows = layout?.gapRows ?? (i > 0 ? 2 : 0);
        const rowHeight = layout?.rowHeight ?? defaultRowHeight;
        let startX: number, endX: number, startY: number, endY: number;

        if (layout?.startX != null && layout?.endX != null) {
          startX = Math.max(1, layout.startX);
          endX = Math.min(maxColumns + 1, layout.endX);
        } else {
          const cols = layout?.columns ?? defaultCols;
          startX = 1;
          endX = Math.min(startX + cols, maxColumns + 1);
        }

        if (layout?.startY != null && layout?.endY != null) {
          startY = Math.max(0, layout.startY);
          endY = layout.endY;
        } else {
          startY = maxY + gapRows;
          endY = startY + rowHeight;
        }

        const mobileStartY = maxMobileY + gapRows;
        const mobileEndY = mobileStartY + rowHeight;

        const zIndex = i;

        gridContents.push({
          layout: {
            mobile: { start: { x: 1, y: mobileStartY }, end: { x: 9, y: mobileEndY }, visible: true, verticalAlignment: 'top', zIndex },
            desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
          },
          content,
        });

        // Update maxY for next block
        maxY = endY;
        maxMobileY = mobileEndY;
      }

      const newSection: PageSection = {
        id: newSectionId,
        sectionName: 'FLUID_ENGINE',
        isCloneable: false,
        styles: defaultStyles,
        sourceType: 'blank',
        fluidEngineContext: {
          id: ContentSaveClient.generateSectionId(),
          gridContents,
          gridSettings: {
            rowGap: { unit: 'px', value: 11 },
            columnGap: { unit: 'px', value: 11 },
            rowStretch: false,
            breakpointSettings: {
              mobile: { rows: Math.max(2, maxMobileY), columns: 8, rowSize: { unit: 'vw', value: 6 } },
              desktop: { rows: Math.max(8, maxY), columns: 24, rowSize: { unit: 'vw', value: 2 } },
            },
          },
        },
      };

      // Insert at position or append
      const sections = [...data.sections];
      let sectionIndex: number;
      if (options?.position !== undefined && options.position >= 0 && options.position < sections.length) {
        sections.splice(options.position, 0, newSection);
        sectionIndex = options.position;
      } else {
        sections.push(newSection);
        sectionIndex = sections.length - 1;
      }

      logger.info({ pageSectionsId, newSectionId, blockCount: blocks.length, sectionIndex }, 'Adding section with blocks via PUT');

      const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error ?? 'savePageSections failed' };
      }

      return { success: true, sectionId: newSectionId, sectionIndex, blockIds };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }
```

**Important:** You also need to add `import type { InitialBlock, AddSectionWithBlocksResult } from './content-save-types.js';` at the top of the file — but check if the existing import from that file already exists and add the new types to it.

Also need to add the type imports: `LayoutHints`, `TextBlockFormatting`, `InitialBlock`, `AddSectionWithBlocksResult` — check the existing imports and add to them. And re-export them from `content-save.ts` if the pattern is to re-export types.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-sections.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: All `addSectionWithBlocks` tests PASS

**Step 5: Commit**

```bash
git add src/services/content-save.ts src/services/__tests__/content-save-sections.test.ts
git commit -m "feat: add addSectionWithBlocks() for atomic section creation"
```

---

### Task 4: Fix `sq_add_template_section` Orphan Bug

The `copyTemplateSection` API creates a section on the site but doesn't attach it to any page. The MCP tool needs to: copy → GET page sections → find the new section in site data → build a PageSection → append to page → PUT.

**Files:**
- Modify: `src/mcp-server/tools/section.ts:89-189` (the `sq_add_template_section` handler)
- Modify: `src/mcp-server/__tests__/section-tools.test.ts` (add tests)

**Step 1: Write failing tests**

Add to `src/mcp-server/__tests__/section-tools.test.ts` before the closing `});`:

```typescript
  // ── sq_add_template_section (orphan fix) ──────────────────────────────

  describe('sq_add_template_section', () => {
    it('appends copied section to target page via GET+PUT', async () => {
      const { lookupCatalogEntry } = await import('../../services/section-catalog.js');
      vi.mocked(lookupCatalogEntry).mockReturnValue({
        websiteId: 'template-site',
        collectionId: 'template-col',
        sectionId: 'template-sec',
      });

      mockClient.getSectionCatalog.mockResolvedValue({
        success: true,
        catalog: { CONTACT: [{ websiteId: 'template-site', collectionId: 'template-col', sectionId: 'template-sec' }] },
      });

      // copyTemplateSection returns the new section data
      mockClient.copyTemplateSection.mockResolvedValue({
        success: true,
        sectionId: 'new-sec-id',
        sectionData: {
          id: 'new-sec-id',
          sectionName: 'FLUID_ENGINE',
          fluidEngineContext: {
            id: 'ctx-new',
            gridContents: [{ content: { value: { id: 'blk-1', type: 2, value: { html: '<p>Template content</p>' } } } }],
            gridSettings: { breakpointSettings: { desktop: { columns: 24 } } },
          },
        },
      });

      // getPageSections returns current page (via client.getPageSections)
      mockClient.getPageSections = vi.fn().mockResolvedValue({
        sections: [{ id: 'existing-sec', sectionName: 'FLUID_ENGINE', fluidEngineContext: { gridContents: [] } }],
      });

      mockClient.savePageSections = vi.fn().mockResolvedValue({ success: true });

      const result = await server.callTool('sq_add_template_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        category: 'Contact',
        templateIndex: 0,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.sectionId).toBe('new-sec-id');
      // Verify the section was attached to the page
      expect(mockClient.savePageSections).toHaveBeenCalled();
      const savedSections = mockClient.savePageSections.mock.calls[0][2];
      expect(savedSections).toHaveLength(2);
      expect(savedSections[1].id).toBe('new-sec-id');
    });

    it('returns error when copy fails', async () => {
      const { lookupCatalogEntry } = await import('../../services/section-catalog.js');
      vi.mocked(lookupCatalogEntry).mockReturnValue({
        websiteId: 'template-site',
        collectionId: 'template-col',
        sectionId: 'template-sec',
      });

      mockClient.getSectionCatalog.mockResolvedValue({ success: true, catalog: { CONTACT: [{}] } });
      mockClient.copyTemplateSection.mockResolvedValue({ success: false, error: 'Copy failed' });

      const result = await server.callTool('sq_add_template_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        category: 'Contact',
        templateIndex: 0,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Copy failed');
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp-server/__tests__/section-tools.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — the new tests should fail because the current implementation doesn't call `getPageSections`/`savePageSections`

**Step 3: Fix the implementation**

Modify `sq_add_template_section` in `src/mcp-server/tools/section.ts`. The key change is after `copyTemplateSection()` returns, GET the page sections, append the new section, and PUT.

Replace the section after `copyResult` success check (around lines 137-142) with:

```typescript
      // After copy, attach the section to the target page.
      // copyTemplateSection creates the section site-wide (orphaned).
      // We need to GET page sections → append → PUT.
      const sectionData = copyResult.sectionData as Record<string, unknown> | undefined;
      if (sectionData && typeof sectionData === 'object') {
        try {
          const pageData = await client.getPageSections(pageSectionsId);
          const updatedSections = [...pageData.sections, sectionData as any];
          const saveResult = await client.savePageSections(pageSectionsId, collectionId, updatedSections);
          if (!saveResult.success) {
            results.attachWarning = `Section copied but failed to attach to page: ${saveResult.error}`;
          }
        } catch (attachErr) {
          results.attachWarning = `Section copied but failed to attach: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`;
        }
      } else {
        results.attachWarning = 'Section copied but no section data returned — may need manual placement.';
      }
```

Also need to expose `getPageSections` and `savePageSections` if they aren't already accessible through the client. Check if the MCP tool can call these — the `client` variable from `getClient(siteId)` should have them since they're instance methods on `ContentSaveClient`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/mcp-server/__tests__/section-tools.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All template section tests PASS

**Step 5: Commit**

```bash
git add src/mcp-server/tools/section.ts src/mcp-server/__tests__/section-tools.test.ts
git commit -m "fix: attach template sections to target page after copy (orphan bug)"
```

---

### Task 5: Add `sq_add_section` MCP Tool

**Files:**
- Modify: `src/mcp-server/tools/section.ts` (add new tool registration)
- Modify: `src/mcp-server/__tests__/section-tools.test.ts` (add tests)

**Step 1: Write failing tests**

Add to `src/mcp-server/__tests__/section-tools.test.ts`:

First, add `addSectionWithBlocks` to the `mockClient` object at the top:
```typescript
addSectionWithBlocks: vi.fn(),
```

Then add tests before the closing `});`:

```typescript
  // ── sq_add_section ────────────────────────────────────────────────────

  describe('sq_add_section', () => {
    it('should register sq_add_section tool', () => {
      expect(server.tools.has('sq_add_section')).toBe(true);
    });

    it('should call addSectionWithBlocks with text block', async () => {
      mockClient.addSectionWithBlocks.mockResolvedValue({
        success: true,
        sectionId: 'sec-new',
        sectionIndex: 2,
        blockIds: ['blk-1'],
      });

      const result = await server.callTool('sq_add_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'contact',
        blocks: [{ type: 'text', html: '<p>Contact us at hello@example.com</p>' }],
      });

      expect(mockClient.addSectionWithBlocks).toHaveBeenCalledWith(
        'psi-contact', 'col-contact',
        [{ type: 'text', html: '<p>Contact us at hello@example.com</p>' }],
        { position: undefined, styles: undefined },
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.sectionId).toBe('sec-new');
      expect(data.blockIds).toEqual(['blk-1']);
    });

    it('should pass position and styles options', async () => {
      mockClient.addSectionWithBlocks.mockResolvedValue({
        success: true,
        sectionId: 'sec-new',
        sectionIndex: 0,
        blockIds: ['blk-1'],
      });

      await server.callTool('sq_add_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        blocks: [{ type: 'text', html: '<h1>Hero</h1>' }],
        position: 0,
        styles: { sectionTheme: 'dark' },
      });

      expect(mockClient.addSectionWithBlocks).toHaveBeenCalledWith(
        'psi-home', 'col-home',
        [{ type: 'text', html: '<h1>Hero</h1>' }],
        { position: 0, styles: { sectionTheme: 'dark' } },
      );
    });

    it('should return error when page resolve fails', async () => {
      vi.mocked(resolvePageIds).mockResolvedValueOnce(null);

      const result = await server.callTool('sq_add_section', {
        siteId: 'bad-site',
        pageSlug: 'home',
        blocks: [{ type: 'text', html: '<p>Test</p>' }],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Could not resolve page');
    });

    it('should return error when addSectionWithBlocks fails', async () => {
      mockClient.addSectionWithBlocks.mockResolvedValue({
        success: false,
        error: 'at least one block required',
      });

      const result = await server.callTool('sq_add_section', {
        siteId: 'smyth-tavern',
        pageSlug: 'home',
        blocks: [],
      });

      expect(result.isError).toBe(true);
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp-server/__tests__/section-tools.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `sq_add_section` tool not registered

**Step 3: Implement the MCP tool**

Add to `src/mcp-server/tools/section.ts`, after the `sq_add_blank_section` registration (after line ~60):

```typescript
  // ── sq_add_section ──────────────────────────────────────────────────────
  server.registerTool('sq_add_section', {
    description:
      'Add a new section to a page with initial content blocks. Preferred over sq_add_blank_section because blank sections may reject subsequent block insertions. ' +
      'Supports text, embed, button, image, and video blocks.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      pageSlug: z.string().describe('Page URL slug'),
      blocks: z.array(z.union([
        z.object({
          type: z.literal('text'),
          html: z.string().describe('HTML content or plain text'),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
          formatting: z.object({
            tag: z.enum(['h1', 'h2', 'h3', 'h4', 'p']).optional(),
            alignment: z.enum(['left', 'center', 'right']).optional(),
            bold: z.boolean().optional(),
            italic: z.boolean().optional(),
          }).optional(),
        }),
        z.object({
          type: z.literal('embed'),
          html: z.string().describe('Raw HTML (iframes, scripts, etc.)'),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
        }),
        z.object({
          type: z.literal('button'),
          text: z.string().describe('Button label'),
          url: z.string().describe('Button link URL'),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
        }),
        z.object({
          type: z.literal('image'),
          assetUrl: z.string().describe('Image asset URL (from sq_upload_image)'),
          altText: z.string().optional().describe('Image alt text'),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
        }),
        z.object({
          type: z.literal('video'),
          videoUrl: z.string().describe('Video URL (YouTube, Vimeo)'),
          title: z.string().optional(),
          description: z.string().optional(),
          layout: z.object({
            columns: z.number().optional(),
            rowHeight: z.number().optional(),
            gapRows: z.number().optional(),
            startX: z.number().optional(),
            endX: z.number().optional(),
            startY: z.number().optional(),
            endY: z.number().optional(),
          }).optional(),
        }),
      ])).min(1).describe('Array of blocks to add to the new section'),
      position: z.number().optional().describe('Section index position (0-based). Omit to append at end.'),
      styles: z.object({
        sectionTheme: z.string().optional().describe('Section theme (e.g. "dark", "light")'),
        sectionHeight: z.string().optional().describe('Section height (e.g. "medium", "large")'),
        contentWidth: z.string().optional().describe('Content width (e.g. "wide", "full")'),
      }).optional().describe('Section style overrides'),
    },
  }, async ({ siteId, pageSlug, blocks, position, styles }) => {
    try {
      const ids = await resolvePageIds(siteId, pageSlug);
      if (!ids) {
        return { content: [{ type: 'text' as const, text: `Error: Could not resolve page "${pageSlug}" on site "${siteId}"` }], isError: true };
      }
      const client = getClient(siteId);
      const result = await client.addSectionWithBlocks(ids.pageSectionsId, ids.collectionId, blocks, { position, styles });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to add section'}` }],
          isError: true,
        };
      }

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

**Step 4: Update the tool count assertion**

In `section-tools.test.ts`, update the "should register all 5 section tools" test to check for 6 tools:
```typescript
  it('should register all 6 section tools', () => {
    expect(server.tools.has('sq_add_blank_section')).toBe(true);
    expect(server.tools.has('sq_add_section')).toBe(true);
    expect(server.tools.has('sq_add_template_section')).toBe(true);
    expect(server.tools.has('sq_edit_section_style')).toBe(true);
    expect(server.tools.has('sq_move_section')).toBe(true);
    expect(server.tools.has('sq_duplicate_section')).toBe(true);
  });
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/mcp-server/__tests__/section-tools.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/mcp-server/tools/section.ts src/mcp-server/__tests__/section-tools.test.ts
git commit -m "feat: add sq_add_section MCP tool for atomic section creation"
```

---

### Task 6: Update `sq_add_blank_section` Description + Position Support

**Files:**
- Modify: `src/mcp-server/tools/section.ts:18-60` (update description, implement position)
- Modify: `src/services/content-save.ts:8284-8348` (add position param to `addBlankSection`)

**Step 1: Update `sq_add_blank_section` tool description**

In `section.ts`, change the description (line 19):
```typescript
    description: 'Add a new blank (empty) section. WARNING: Squarespace may reject subsequent block insertions into API-created blank sections — use sq_add_section instead to create sections with initial content.',
```

**Step 2: Add position support to `addBlankSection`**

In `content-save.ts`, modify the method signature to accept an optional `position` parameter:

```typescript
  async addBlankSection(
    pageSectionsId: string,
    collectionId: string,
    position?: number,
  ): Promise<AddBlankSectionResult> {
```

And replace the section insertion line (around line 8333):
```typescript
      // Insert at position or append
      const updatedSections = [...data.sections];
      let sectionIndex: number;
      if (position !== undefined && position >= 0 && position < updatedSections.length) {
        updatedSections.splice(position, 0, blankSection);
        sectionIndex = position;
      } else {
        updatedSections.push(blankSection);
        sectionIndex = updatedSections.length - 1;
      }
```

**Step 3: Update the MCP tool to pass position**

In `section.ts`, update the `sq_add_blank_section` handler to pass `position`:

```typescript
      const result = await client.addBlankSection(ids.pageSectionsId, ids.collectionId, position);
```

And remove the TODO comment about position not being implemented (lines 41-42).

**Step 4: Run all tests**

Run: `npx vitest run src/services/__tests__/content-save-sections.test.ts src/mcp-server/__tests__/section-tools.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: All tests PASS (existing addBlankSection tests should still pass since position is optional)

**Step 5: Commit**

```bash
git add src/services/content-save.ts src/mcp-server/tools/section.ts
git commit -m "feat: add position support to addBlankSection, warn about blank section limitations"
```

---

### Task 7: Update MCP Server Coaching + CLAUDE.md

**Files:**
- Modify: `src/mcp-server/index.ts` (update instructions to mention sq_add_section)
- Modify: `CLAUDE.md` (add sq_add_section docs, update tool count)

**Step 1: Update MCP server instructions**

In `src/mcp-server/index.ts`, find the `instructions` string that's sent during MCP handshake. Add guidance about preferring `sq_add_section` over `sq_add_blank_section`:

Search for the instructions text and add a line like:
```
- **Adding new sections**: Use sq_add_section (not sq_add_blank_section) to create sections with initial content. Blank sections may reject subsequent block insertions.
```

**Step 2: Update CLAUDE.md**

Update the tool count (~62 → ~63 tools). Add `sq_add_section` to the MCP tools section. Update the known gotchas to mention the fix.

**Step 3: Run full test suite to confirm nothing is broken**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**' 2>&1 | tail -10`
Expected: All tests PASS, total count increased by the new tests

**Step 4: Commit**

```bash
git add src/mcp-server/index.ts CLAUDE.md
git commit -m "docs: update coaching and CLAUDE.md for sq_add_section tool"
```

---

### Task 8: Update Memory File

**Files:**
- Modify: `/Users/timcox/.claude/projects/-Users-timcox-squarespace-helper/memory/MEMORY.md`

**Step 1: Update memory with the changes**

Add to the "Recent Changes" section:
- `sq_add_section` MCP tool for atomic section+block creation
- Template section orphan fix (GET → append → PUT after copy)
- Position support for `addBlankSection` and `sq_add_section`
- Block builder static methods on ContentSaveClient

Update the "Critical Gotchas" section:
- Add: **Blank sections may reject block insertions**: Use `sq_add_section` instead of `sq_add_blank_section` + separate block adds. The server may not fully initialize API-created empty sections.
- Update: **`copyTemplateSection` orphans sections** — now fixed in `sq_add_template_section` (auto-attaches to page)

**Step 2: Commit**

```bash
git add /Users/timcox/.claude/projects/-Users-timcox-squarespace-helper/memory/MEMORY.md
git commit -m "docs: update memory with atomic section creation changes"
```
