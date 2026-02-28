# High-Priority Block Implementations — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 6 new Squarespace block types (Newsletter, Accordion, Marquee, Social Links, Embed, Form) in the Content Save API pipeline.

**Architecture:** Each block follows the same 5-file pattern: constants + add/update methods in `content-save.ts`, result types in `content-save-types.ts`, `ApiXBlock` interface + type guard in `types.ts`, routing in `api-executor.ts`, and example added to the content strategist system prompt. Tier 1 blocks (Newsletter, Accordion, Marquee) have fully-known structures and can be implemented immediately. Tier 2 blocks (Social Links, Embed, Form) require live discovery first.

**Tech Stack:** TypeScript, Squarespace Content Save API (PUT /api/page-sections/{id}/collection/{id}), vitest, Playwright (for discovery)

**Parallelization note:** Task 1 (discovery) runs in parallel with Tasks 2–4 (Tier 1 blocks). Tasks 5–7 (Tier 2 blocks) start after Task 1 completes. Tasks 8–9 run after all blocks are implemented.

---

## Reference: Shared Code Patterns

All add methods follow this skeleton (copied from `addDividerBlock`/`addQuoteBlock`):

```typescript
async addXBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  /* block-specific params */,
  layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number; }
): Promise<XBlockAddResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }
    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext` };
    }
    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Backfill verticalAlignment and zIndex (REQUIRED to avoid Squarespace 400)
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

    // Calculate maxY / maxMobileY
    let maxY = 0; let maxMobileY = 0;
    for (const gc of gridContents) {
      if ((gc.layout?.desktop?.end?.y ?? 0) > maxY) maxY = gc.layout!.desktop!.end!.y;
      if ((gc.layout?.mobile?.end?.y ?? 0) > maxMobileY) maxMobileY = gc.layout!.mobile!.end!.y;
    }

    const rowHeight = layout?.rowHeight ?? DEFAULT_ROW_HEIGHT;  // varies per block
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);
    const startX = layout?.startX != null ? Math.max(1, layout.startX) : 1;
    const endX = layout?.endX != null ? Math.min(maxColumns + 1, layout.endX) : Math.min(startX + (layout?.columns ?? maxColumns), maxColumns + 1);
    const startY = layout?.startY != null ? Math.max(0, layout.startY) : maxY + gapRows;
    const endY = layout?.endY != null ? layout.endY : startY + rowHeight;

    const blockId = ContentSaveClient.generateBlockId();
    const maxZ = gridContents.reduce((max, gc) => Math.max(max, gc.layout?.desktop?.zIndex ?? 0, gc.layout?.mobile?.zIndex ?? 0), 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_X,
          value: { /* block-specific value */ },
        },
      },
    };

    gridContents.push(newBlock);
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}
```

All update methods follow this skeleton (from `updateQuoteBlock`):

```typescript
async updateXBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { field1?: string; ... }
): Promise<XBlockUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const match = this.findBlock(data.sections, searchText);
    if (!match) return { success: false, error: `No block found matching "${searchText}"` };
    const { gridContent } = match;
    const blockValue = gridContent.content.value;
    if (blockValue.type !== BLOCK_TYPE_X) {
      return { success: false, error: `Block is type ${blockValue.type}, not X (expected ${BLOCK_TYPE_X})` };
    }
    if (!blockValue.value) blockValue.value = {};
    // Apply updates
    if (updates.field1 !== undefined) blockValue.value.field1 = updates.field1;
    // ...
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId: blockValue.id };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}
```

Test setup (copy from `src/services/__tests__/content-save-add-block.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent } from '../content-save.js';

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

function makeSections(...blocks: GridContent[]): PageSection[] {
  return [{
    id: 'section-1',
    sectionName: 'FLUID_ENGINE',
    fluidEngineContext: {
      gridContents: blocks,
      gridSettings: { breakpointSettings: { desktop: { columns: 24 }, mobile: { columns: 8 } } },
    },
  }];
}
```

---

## Task 1: Live Discovery — Capture Tier 2 Block Structures

> **Run in parallel with Tasks 2–4**
>
> **Who:** A general-purpose agent with Playwright MCP access and an active Squarespace session.
>
> **Goal:** Configure Social Links (54), Embed (22), and Form (1337 variant) with real content in the Squarespace editor, run the discovery script, and document the exact JSON value structures.

**Files:**
- Read: `data/block-type-discovery.json` (last discovery run)
- Read: `scripts/discover-block-types.ts` (understand what it outputs)
- Modify: `block-search.md`
- Read: `storage/session-grey-yellow-hbxc.json` (or equivalent session file)

**Step 1: Read last discovery JSON**

```bash
cat data/block-type-discovery.json | npx tsx -e "
const d = JSON.parse(require('fs').readFileSync('data/block-type-discovery.json','utf8'));
const targets = d.filter(b => [54, 22].includes(b.blockType) || (b.blockType === 1337 && b.value?.buttonVariant != null));
console.log(JSON.stringify(targets, null, 2));
"
```

If Social Links (54) shows `{ iconAlignment, iconSize, iconStyle, iconColor }` AND has an `icons` or `socialAccounts` array → structures are known, skip to Step 5.

If Embed (22) shows non-empty value → structure known, skip to Step 5.

**Step 2: Open Squarespace editor via Playwright**

Navigate to: `https://grey-yellow-hbxc.squarespace.com/config/pages` using existing session cookies.

Find the test-page, open Fluid Engine editor.

**Step 3: Configure Social Links block**

In the editor, find the Social Links block (type 54). Open its settings. Add 3 social icons:
- Twitter/X: `https://twitter.com/test`
- Instagram: `https://instagram.com/test`
- Facebook: `https://facebook.com/test`

Save the block settings.

**Step 4: Configure Embed block**

Find the Embed block (type 22). Open its settings. Paste this HTML:
```html
<p>Hello World from embed</p>
```
Save.

**Step 5: Save page and run discovery**

```bash
cd "/Users/timcox/squarespace helper"
npx tsx scripts/discover-block-types.ts \
  --site grey-yellow-hbxc \
  --page test-page \
  --pageSectionsId 699f3d5bd9db5d1500d60c01
```

**Step 6: Extract target structures**

Read `data/block-type-discovery.json` and extract the `value` field for:
- Type 54 (Social Links) — note exact field names for icon array
- Type 22 (Embed) — note exact HTML field name (`html`? `code`? `embedCode`?)
- Type 1337 with `buttonVariant` field (Form variant)

**Step 7: Update block-search.md**

Update the relevant rows in block-search.md `## Complete Block Type Map` table with:
- Social Links (54): full value signature including icon array structure
- Embed (22): full value signature including HTML field name
- Form variant (1337): confirm field names (`buttonVariant`, `submissionTextAlignment`, `firstFieldHighlightType`)

**Step 8: Write `data/discovered-tier2-structures.json`**

```bash
cat > data/discovered-tier2-structures.json << 'EOF'
{
  "socialLinks": {
    "blockType": 54,
    "valueSignature": { /* paste exact value from discovery */ }
  },
  "embed": {
    "blockType": 22,
    "htmlField": "html",  // UPDATE THIS with actual field name
    "valueSignature": { /* paste exact value */ }
  },
  "form": {
    "blockType": 1337,
    "discriminator": "buttonVariant",
    "valueSignature": { /* paste exact value */ }
  }
}
EOF
```

**Step 9: Commit discovery results**

```bash
cd "/Users/timcox/squarespace helper"
git add data/block-type-discovery.json data/discovered-tier2-structures.json block-search.md
git commit -m "chore: capture Tier 2 block structures via live discovery (Social Links, Embed, Form)"
```

Expected: commit succeeds, `block-search.md` updated with exact value signatures for types 54, 22, and 1337 Form variant.

---

## Task 2: Newsletter Block (type 51)

> **Run in parallel with Tasks 1, 3, 4**
>
> **Implement in a git worktree.**

**Files:**
- Modify: `src/services/content-save-types.ts` (add result types)
- Modify: `src/services/content-save.ts` (add BLOCK_TYPE_NEWSLETTER + add/update methods)
- Modify: `src/agents/types.ts` (add ApiNewsletterBlock + type guard + union)
- Modify: `src/services/api-executor.ts` (add cases to executeAddBlock + executeModifyBlock)
- Modify: `src/agents/content-strategist-agent.ts` (add prompt example)
- Create: `src/services/__tests__/content-save-newsletter.test.ts`

**Step 1: Add result types to content-save-types.ts**

Find the end of the result types section (search for `DividerBlockAddResult`). Add after it:

```typescript
/** Result of adding a newsletter block */
export interface NewsletterBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of updating a newsletter block */
export interface NewsletterBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}
```

**Step 2: Write failing tests**

Create `src/services/__tests__/content-save-newsletter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent } from '../content-save.js';

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
};
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

function makeSections(...blocks: GridContent[]): PageSection[] {
  return [{
    id: 'section-1',
    sectionName: 'FLUID_ENGINE',
    fluidEngineContext: {
      gridContents: blocks,
      gridSettings: { breakpointSettings: { desktop: { columns: 24 }, mobile: { columns: 8 } } },
    },
  }];
}

function makeNewsletterBlock(blockId: string, description: string): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 4 }, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 4 }, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 51,
        value: { alignment: 'center', captchaEnabled: false, description },
      },
    },
  };
}

describe('addNewsletterBlock', () => {
  let client: ContentSaveClient;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPut: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    mockGet = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sections: makeSections() }) });
    mockPut = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
      if ((opts?.method ?? 'GET') === 'GET') return mockGet(url, opts);
      return mockPut(url, opts);
    });
  });

  it('adds a newsletter block with description to empty section', async () => {
    const result = await client.addNewsletterBlock(
      'page-sections-id', 'collection-id', 0,
      { description: 'Subscribe for updates', alignment: 'center' }
    );
    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();

    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.type).toBe(51);
    expect(block.content.value.value.description).toBe('Subscribe for updates');
    expect(block.content.value.value.alignment).toBe('center');
  });

  it('uses full width (24 cols) by default', async () => {
    const result = await client.addNewsletterBlock('pid', 'cid', 0, { description: 'test' });
    expect(result.success).toBe(true);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.layout.desktop.start.x).toBe(1);
    expect(block.layout.desktop.end.x).toBe(25);  // 24 cols + 1
  });

  it('returns error for out-of-range section index', async () => {
    const result = await client.addNewsletterBlock('pid', 'cid', 5, { description: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/out of range/);
  });

  it('sets captchaEnabled when provided', async () => {
    await client.addNewsletterBlock('pid', 'cid', 0, { description: 'test', captchaEnabled: true });
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.captchaEnabled).toBe(true);
  });
});

describe('updateNewsletterBlock', () => {
  let client: ContentSaveClient;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPut: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    const sections = makeSections(makeNewsletterBlock('block-abc', 'Original description'));
    mockGet = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sections }) });
    mockPut = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
      if ((opts?.method ?? 'GET') === 'GET') return mockGet(url, opts);
      return mockPut(url, opts);
    });
  });

  it('updates description by searchText match', async () => {
    const result = await client.updateNewsletterBlock('pid', 'cid', 'Original description', {
      description: 'New description',
    });
    expect(result.success).toBe(true);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.description).toBe('New description');
  });

  it('updates alignment only', async () => {
    await client.updateNewsletterBlock('pid', 'cid', 'Original description', { alignment: 'left' });
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.alignment).toBe('left');
    // description unchanged
    expect(block.content.value.value.description).toBe('Original description');
  });

  it('returns error when block not found', async () => {
    const result = await client.updateNewsletterBlock('pid', 'cid', 'Nonexistent', { description: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No block found/);
  });
});
```

**Step 3: Run test to verify it fails**

```bash
cd "/Users/timcox/squarespace helper"
npx vitest run src/services/__tests__/content-save-newsletter.test.ts
```

Expected: FAIL — `addNewsletterBlock is not a function` (or similar)

**Step 4: Add BLOCK_TYPE constant to content-save.ts**

Find the BLOCK_TYPE constants (around line 151–169). Add:

```typescript
const BLOCK_TYPE_NEWSLETTER = 51;
```

**Step 5: Add addNewsletterBlock method to ContentSaveClient**

Find `addDividerBlock` in `content-save.ts`. Add `addNewsletterBlock` immediately before it:

```typescript
async addNewsletterBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  options: {
    description?: string;
    alignment?: 'left' | 'center' | 'right';
    captchaEnabled?: boolean;
    captchaTheme?: string;
    captchaAlignment?: string;
  } = {},
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<NewsletterBlockAddResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }
    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext` };
    }
    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

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

    let maxY = 0; let maxMobileY = 0;
    for (const gc of gridContents) {
      if ((gc.layout?.desktop?.end?.y ?? 0) > maxY) maxY = gc.layout!.desktop!.end!.y;
      if ((gc.layout?.mobile?.end?.y ?? 0) > maxMobileY) maxMobileY = gc.layout!.mobile!.end!.y;
    }

    const rowHeight = layout?.rowHeight ?? 4;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);
    const cols = layout?.columns ?? maxColumns;
    const startX = layout?.startX != null ? Math.max(1, layout.startX) : 1;
    const endX = layout?.endX != null ? Math.min(maxColumns + 1, layout.endX) : Math.min(startX + cols, maxColumns + 1);
    const startY = layout?.startY != null ? Math.max(0, layout.startY) : maxY + gapRows;
    const endY = layout?.endY != null ? layout.endY : startY + rowHeight;

    const blockId = ContentSaveClient.generateBlockId();
    const maxZ = gridContents.reduce((max, gc) => Math.max(max, gc.layout?.desktop?.zIndex ?? 0, gc.layout?.mobile?.zIndex ?? 0), 0);
    const zIndex = maxZ + 1;

    const newsletterValue: Record<string, unknown> = {
      alignment: options.alignment ?? 'center',
      captchaEnabled: options.captchaEnabled ?? false,
      captchaTheme: options.captchaTheme ?? 'light',
      captchaAlignment: options.captchaAlignment ?? 'center',
    };
    if (options.description !== undefined) {
      newsletterValue.description = options.description;
    }

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_NEWSLETTER,
          value: newsletterValue,
        },
      },
    };

    gridContents.push(newBlock);
    logger.info({ blockId, description: options.description }, 'Added newsletter block via Content Save API');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}
```

**Step 6: Add updateNewsletterBlock method**

Add immediately after `addNewsletterBlock`:

```typescript
async updateNewsletterBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    description?: string;
    alignment?: string;
    captchaEnabled?: boolean;
    captchaTheme?: string;
    captchaAlignment?: string;
  },
): Promise<NewsletterBlockUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const match = this.findBlock(data.sections, searchText);
    if (!match) return { success: false, error: `No block found matching "${searchText}"` };

    const { gridContent } = match;
    const blockValue = gridContent.content.value;
    if (blockValue.type !== BLOCK_TYPE_NEWSLETTER) {
      return { success: false, error: `Block is type ${blockValue.type}, not a newsletter block (${BLOCK_TYPE_NEWSLETTER})` };
    }

    if (!blockValue.value) blockValue.value = {};
    if (updates.description !== undefined) blockValue.value.description = updates.description;
    if (updates.alignment !== undefined) blockValue.value.alignment = updates.alignment;
    if (updates.captchaEnabled !== undefined) blockValue.value.captchaEnabled = updates.captchaEnabled;
    if (updates.captchaTheme !== undefined) blockValue.value.captchaTheme = updates.captchaTheme;
    if (updates.captchaAlignment !== undefined) blockValue.value.captchaAlignment = updates.captchaAlignment;

    logger.info({ blockId: blockValue.id, searchText }, 'Updating newsletter block via Content Save API');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId: blockValue.id };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}
```

Also add `NewsletterBlockAddResult` and `NewsletterBlockUpdateResult` to the imports at the top of `content-save.ts` (they're imported from `content-save-types.ts`).

**Step 7: Run tests to verify pass**

```bash
npx vitest run src/services/__tests__/content-save-newsletter.test.ts
```

Expected: All tests PASS

**Step 8: Add ApiNewsletterBlock to types.ts**

Find the `AnyApiBlock` union type. Add before it:

```typescript
/** A newsletter block to add via Content Save API */
export interface ApiNewsletterBlock {
  type: 'newsletter';
  description?: string;
  alignment?: 'left' | 'center' | 'right';
  captchaEnabled?: boolean;
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
  };
}
```

Add to `AnyApiBlock` union:
```typescript
export type AnyApiBlock = ApiTextBlock | ApiButtonBlock | ApiImageBlock | ApiGalleryBlock | ApiDividerBlock | ApiVideoBlock | ApiQuoteBlock | ApiCodeBlock | ApiNewsletterBlock;
```

Add type guard after the other guards:
```typescript
/** Type guard: is this apiBlock a newsletter block? */
export function isApiNewsletterBlock(block: AnyApiBlock): block is ApiNewsletterBlock {
  return 'type' in block && (block as ApiNewsletterBlock).type === 'newsletter';
}
```

**Step 9: Add routing to api-executor.ts**

In `executeAddBlock()`, find the `case 'code':` block. Add after it:

```typescript
case 'newsletter': {
  const result = await client.addNewsletterBlock(
    ctx.pageSectionsId, ctx.collectionId, lastSectionIndex,
    {
      description: op.content.bodyText ?? op.content.heading,
      alignment: (op.content as Record<string, unknown>).alignment as string | undefined,
      captchaEnabled: (op.content as Record<string, unknown>).captchaEnabled as boolean | undefined,
    },
  );
  if (!result.success) throw new Error(result.error ?? 'addNewsletterBlock failed');
  return `Added newsletter block to section ${lastSectionIndex}`;
}
```

In `executeModifyBlock()` (or wherever text/quote updates are handled), find the section for quote updates. Add a similar block for newsletter:

```typescript
if (blockType === 'newsletter') {
  const searchText = op.content.bodyText ?? op.placement;
  if (!searchText) throw new Error('modify_block (newsletter): need search text (bodyText or placement)');
  const result = await client.updateNewsletterBlock(
    ctx.pageSectionsId, ctx.collectionId, searchText,
    {
      description: op.content.bodyText,
      alignment: (op.content as Record<string, unknown>).alignment as string | undefined,
    },
  );
  if (!result.success) throw new Error(result.error ?? 'updateNewsletterBlock failed');
  return `Updated newsletter block "${searchText.slice(0, 50)}"`;
}
```

Also add `isApiNewsletterBlock` to the import from `../agents/types.js`.

**Step 10: Update content strategist prompt**

In `src/agents/content-strategist-agent.ts`, find the apiBlocks documentation section (the part that shows example block types with `{ type: 'button', ... }`, `{ type: 'quote', ... }` etc.). Add:

```
Newsletter signup:  { "type": "newsletter", "description": "Subscribe to our newsletter for updates", "alignment": "center", "captchaEnabled": false }
```

**Step 11: Update api-wishlist.md**

Change Newsletter row from `🔴 High` to `✅ Full | addNewsletterBlock updateNewsletterBlock`.

**Step 12: Commit**

```bash
cd "/Users/timcox/squarespace helper"
git add src/services/content-save.ts src/services/content-save-types.ts src/agents/types.ts \
        src/services/api-executor.ts src/agents/content-strategist-agent.ts \
        src/services/__tests__/content-save-newsletter.test.ts api-wishlist.md
git commit -m "feat: add Newsletter block (type 51) — addNewsletterBlock + updateNewsletterBlock"
```

Expected: `npm run test` passes. Newsletter shows in api-wishlist.md as ✅.

---

## Task 3: Accordion Block (type 69)

> **Run in parallel with Tasks 1, 2, 4**
>
> **Implement in a git worktree.**

**Files:**
- Modify: `src/services/content-save-types.ts`
- Modify: `src/services/content-save.ts`
- Modify: `src/agents/types.ts`
- Modify: `src/services/api-executor.ts`
- Modify: `src/agents/content-strategist-agent.ts`
- Create: `src/services/__tests__/content-save-accordion.test.ts`

**Step 1: Add result types to content-save-types.ts**

```typescript
/** Result of adding an accordion block */
export interface AccordionBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of updating an accordion block */
export interface AccordionBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}
```

**Step 2: Write failing tests**

Create `src/services/__tests__/content-save-accordion.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent } from '../content-save.js';

const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
};
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

function makeSections(...blocks: GridContent[]): PageSection[] {
  return [{
    id: 'section-1',
    sectionName: 'FLUID_ENGINE',
    fluidEngineContext: {
      gridContents: blocks,
      gridSettings: { breakpointSettings: { desktop: { columns: 24 }, mobile: { columns: 8 } } },
    },
  }];
}

function makeAccordionBlock(blockId: string, items: Array<{ title: string; description: string }>): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 6 }, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 6 }, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 69,
        value: { accordionItems: items },
      },
    },
  };
}

describe('addAccordionBlock', () => {
  let client: ContentSaveClient;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPut: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    mockGet = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sections: makeSections() }) });
    mockPut = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
      if ((opts?.method ?? 'GET') === 'GET') return mockGet(url, opts);
      return mockPut(url, opts);
    });
  });

  it('adds accordion with items to empty section', async () => {
    const items = [
      { title: 'Q: What is this?', description: 'A: This is a test.' },
      { title: 'Q: How does it work?', description: 'A: Very well.' },
    ];
    const result = await client.addAccordionBlock('pid', 'cid', 0, items);
    expect(result.success).toBe(true);
    expect(result.blockId).toBeDefined();

    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.type).toBe(69);
    expect(block.content.value.value.accordionItems).toHaveLength(2);
    expect(block.content.value.value.accordionItems[0].title).toBe('Q: What is this?');
    expect(block.content.value.value.accordionItems[0].description).toBe('A: This is a test.');
  });

  it('returns error for out-of-range section', async () => {
    const result = await client.addAccordionBlock('pid', 'cid', 99, [{ title: 'Q', description: 'A' }]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/out of range/);
  });
});

describe('updateAccordionBlock', () => {
  let client: ContentSaveClient;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPut: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    const sections = makeSections(makeAccordionBlock('block-acc', [
      { title: 'Original Q', description: 'Original A' },
    ]));
    mockGet = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sections }) });
    mockPut = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
      if ((opts?.method ?? 'GET') === 'GET') return mockGet(url, opts);
      return mockPut(url, opts);
    });
  });

  it('replaces accordion items by searching first item title', async () => {
    const result = await client.updateAccordionBlock('pid', 'cid', 'Original Q', {
      items: [
        { title: 'New Q1', description: 'New A1' },
        { title: 'New Q2', description: 'New A2' },
      ],
    });
    expect(result.success).toBe(true);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.accordionItems).toHaveLength(2);
    expect(block.content.value.value.accordionItems[0].title).toBe('New Q1');
  });

  it('returns error when block not found', async () => {
    const result = await client.updateAccordionBlock('pid', 'cid', 'Nonexistent', { items: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No block found/);
  });
});
```

**Step 3: Run tests to verify they fail**

```bash
npx vitest run src/services/__tests__/content-save-accordion.test.ts
```

Expected: FAIL

**Step 4: Add constant + implement addAccordionBlock + updateAccordionBlock**

In `content-save.ts`, add constant with the others:
```typescript
const BLOCK_TYPE_ACCORDION = 69;
```

Add `addAccordionBlock` method (follow the exact skeleton from the Reference section above, with):
- `rowHeight ?? 6` (accordion blocks are taller)
- Value object: `{ accordionItems: items }`
- Params: `items: Array<{ title: string; description: string }>`

```typescript
async addAccordionBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  items: Array<{ title: string; description: string }>,
  layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number; }
): Promise<AccordionBlockAddResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }
    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext` };
    }
    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

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

    let maxY = 0; let maxMobileY = 0;
    for (const gc of gridContents) {
      if ((gc.layout?.desktop?.end?.y ?? 0) > maxY) maxY = gc.layout!.desktop!.end!.y;
      if ((gc.layout?.mobile?.end?.y ?? 0) > maxMobileY) maxMobileY = gc.layout!.mobile!.end!.y;
    }

    const rowHeight = layout?.rowHeight ?? 6;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);
    const cols = layout?.columns ?? maxColumns;
    const startX = layout?.startX != null ? Math.max(1, layout.startX) : 1;
    const endX = layout?.endX != null ? Math.min(maxColumns + 1, layout.endX) : Math.min(startX + cols, maxColumns + 1);
    const startY = layout?.startY != null ? Math.max(0, layout.startY) : maxY + gapRows;
    const endY = layout?.endY != null ? layout.endY : startY + rowHeight;

    const blockId = ContentSaveClient.generateBlockId();
    const maxZ = gridContents.reduce((max, gc) => Math.max(max, gc.layout?.desktop?.zIndex ?? 0, gc.layout?.mobile?.zIndex ?? 0), 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_ACCORDION,
          value: { accordionItems: items },
        },
      },
    };

    gridContents.push(newBlock);
    logger.info({ blockId, itemCount: items.length }, 'Added accordion block via Content Save API');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}

async updateAccordionBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { items?: Array<{ title: string; description: string }> },
): Promise<AccordionBlockUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const match = this.findBlock(data.sections, searchText);
    if (!match) return { success: false, error: `No block found matching "${searchText}"` };

    const { gridContent } = match;
    const blockValue = gridContent.content.value;
    if (blockValue.type !== BLOCK_TYPE_ACCORDION) {
      return { success: false, error: `Block is type ${blockValue.type}, not an accordion block (${BLOCK_TYPE_ACCORDION})` };
    }

    if (!blockValue.value) blockValue.value = {};
    if (updates.items !== undefined) blockValue.value.accordionItems = updates.items;

    logger.info({ blockId: blockValue.id, searchText, itemCount: updates.items?.length }, 'Updating accordion block');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId: blockValue.id };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}
```

**Note on findBlock + accordion:** `findBlock` searches `value.text` and `value.label`. For accordion blocks, search text won't match automatically. After implementing, check if findBlock needs to be extended to search `accordionItems[0].title`. If updateAccordionBlock tests fail to find the block, add this to `findBlock`:

```typescript
// In findBlock, after value.text / value.label checks:
if (blockValue.type === 69 && Array.isArray(blockValue.value?.accordionItems)) {
  const firstTitle = blockValue.value.accordionItems[0]?.title ?? '';
  if (firstTitle.toLowerCase().includes(searchText.toLowerCase())) {
    return { section, gridContent: gc, blockIndex };
  }
}
```

**Step 5: Run tests to verify pass**

```bash
npx vitest run src/services/__tests__/content-save-accordion.test.ts
```

Expected: All PASS

**Step 6: Add ApiAccordionBlock to types.ts + api-executor + strategist**

```typescript
// types.ts
export interface ApiAccordionBlock {
  type: 'accordion';
  items: Array<{ title: string; description: string }>;
  layout?: { columns?: number; rowHeight?: number; gapRows?: number; };
}
export function isApiAccordionBlock(block: AnyApiBlock): block is ApiAccordionBlock {
  return 'type' in block && (block as ApiAccordionBlock).type === 'accordion';
}
// Add ApiAccordionBlock to AnyApiBlock union
```

In `api-executor.ts` `executeAddBlock` switch:
```typescript
case 'accordion': {
  const itemsRaw = (op.content as Record<string, unknown>).items;
  const items = Array.isArray(itemsRaw) ? itemsRaw as Array<{ title: string; description: string }> : [];
  if (items.length === 0 && op.content.bodyText) {
    // Parse "Title: Description" pairs from bodyText if items not provided
    items.push({ title: op.content.heading ?? 'FAQ', description: op.content.bodyText });
  }
  const result = await client.addAccordionBlock(ctx.pageSectionsId, ctx.collectionId, lastSectionIndex, items);
  if (!result.success) throw new Error(result.error ?? 'addAccordionBlock failed');
  return `Added accordion block with ${items.length} items to section ${lastSectionIndex}`;
}
```

In strategist prompt:
```
FAQ / Accordion:   { "type": "accordion", "items": [{ "title": "Q: How does shipping work?", "description": "A: We ship within 2 business days." }, { "title": "Q: What is your return policy?", "description": "A: 30-day returns, no questions asked." }] }
```

**Step 7: Commit**

```bash
git add src/services/content-save.ts src/services/content-save-types.ts src/agents/types.ts \
        src/services/api-executor.ts src/agents/content-strategist-agent.ts \
        src/services/__tests__/content-save-accordion.test.ts api-wishlist.md
git commit -m "feat: add Accordion block (type 69) — addAccordionBlock + updateAccordionBlock"
```

---

## Task 4: Scrolling/Marquee Block (type 70)

> **Run in parallel with Tasks 1, 2, 3**
>
> **Implement in a git worktree.**

**Files:** Same 5 files as Task 2/3 + new test file.

**Step 1: Add result types to content-save-types.ts**

```typescript
export interface MarqueeBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  error?: string;
}

export interface MarqueeBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}
```

**Step 2: Write failing tests**

Create `src/services/__tests__/content-save-marquee.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';
import type { PageSection, GridContent } from '../content-save.js';

const MOCK_SESSION = { cookies: [
  { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
  { name: 'crumb', value: 'crumb-abc', domain: '.test-site.squarespace.com', path: '/' },
]};
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

function makeSections(...blocks: GridContent[]): PageSection[] {
  return [{ id: 'section-1', sectionName: 'FLUID_ENGINE', fluidEngineContext: { gridContents: blocks, gridSettings: { breakpointSettings: { desktop: { columns: 24 }, mobile: { columns: 8 } } } } }];
}

function makeMarqueeBlock(blockId: string, items: string[]): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 3 }, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 }, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 70,
        value: { marqueeItems: items.map(text => ({ text })), waveFrequency: 3, waveIntensity: 5, animationSpeed: 5 },
      },
    },
  };
}

describe('addMarqueeBlock', () => {
  let client: ContentSaveClient;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPut: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    mockGet = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sections: makeSections() }) });
    mockPut = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
      if ((opts?.method ?? 'GET') === 'GET') return mockGet(url, opts);
      return mockPut(url, opts);
    });
  });

  it('adds marquee with items to empty section', async () => {
    const result = await client.addMarqueeBlock('pid', 'cid', 0, ['Sale on now', 'Free shipping']);
    expect(result.success).toBe(true);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.type).toBe(70);
    expect(block.content.value.value.marqueeItems).toHaveLength(2);
    expect(block.content.value.value.marqueeItems[0].text).toBe('Sale on now');
  });

  it('sets wave and animation defaults', async () => {
    await client.addMarqueeBlock('pid', 'cid', 0, ['test']);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const val = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(val.waveFrequency).toBe(3);
    expect(val.waveIntensity).toBe(5);
    expect(val.animationSpeed).toBe(5);
  });

  it('uses custom wave settings when provided', async () => {
    await client.addMarqueeBlock('pid', 'cid', 0, ['test'], { waveFrequency: 10, animationSpeed: 2 });
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const val = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(val.waveFrequency).toBe(10);
    expect(val.animationSpeed).toBe(2);
  });
});

describe('updateMarqueeBlock', () => {
  let client: ContentSaveClient;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPut: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    const sections = makeSections(makeMarqueeBlock('block-mrq', ['Original text']));
    mockGet = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sections }) });
    mockPut = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.spyOn(global, 'fetch').mockImplementation((url, opts) => {
      if ((opts?.method ?? 'GET') === 'GET') return mockGet(url, opts);
      return mockPut(url, opts);
    });
  });

  it('replaces marquee items', async () => {
    const result = await client.updateMarqueeBlock('pid', 'cid', 'Original text', {
      items: ['New item 1', 'New item 2'],
    });
    expect(result.success).toBe(true);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const val = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(val.marqueeItems).toHaveLength(2);
    expect(val.marqueeItems[0].text).toBe('New item 1');
  });
});
```

**Step 3: Run tests to verify failure**

```bash
npx vitest run src/services/__tests__/content-save-marquee.test.ts
```

Expected: FAIL

**Step 4: Add BLOCK_TYPE_MARQUEE constant and implement methods**

```typescript
const BLOCK_TYPE_MARQUEE = 70;
```

```typescript
async addMarqueeBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  items: string[],
  options?: {
    waveFrequency?: number;
    waveIntensity?: number;
    animationSpeed?: number;
    linkTo?: string;
  },
  layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number; }
): Promise<MarqueeBlockAddResult> {
  // ... (same skeleton, with)
  // Value:
  // {
  //   marqueeItems: items.map(text => ({ text })),
  //   linkTo: options?.linkTo ?? null,
  //   waveFrequency: options?.waveFrequency ?? 3,
  //   waveIntensity: options?.waveIntensity ?? 5,
  //   animationSpeed: options?.animationSpeed ?? 5,
  // }
  // rowHeight default: 3
}

async updateMarqueeBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { items?: string[]; waveFrequency?: number; waveIntensity?: number; animationSpeed?: number; linkTo?: string; }
): Promise<MarqueeBlockUpdateResult> {
  // findBlock with marqueeItems[0].text search (may need findBlock extension, see Task 3 accordion note)
  // if updates.items: blockValue.value.marqueeItems = updates.items.map(text => ({ text }))
  // if updates.waveFrequency: blockValue.value.waveFrequency = updates.waveFrequency
  // etc.
}
```

**Note:** Extend `findBlock` to search `value.marqueeItems[0].text` for type 70, similar to accordion.

**Step 5: Run tests to verify pass**

```bash
npx vitest run src/services/__tests__/content-save-marquee.test.ts
```

**Step 6: Add ApiMarqueeBlock to types.ts**

```typescript
export interface ApiMarqueeBlock {
  type: 'marquee';
  items: string[];
  waveFrequency?: number;
  waveIntensity?: number;
  animationSpeed?: number;
  linkTo?: string;
  layout?: { columns?: number; rowHeight?: number; };
}
export function isApiMarqueeBlock(block: AnyApiBlock): block is ApiMarqueeBlock {
  return 'type' in block && (block as ApiMarqueeBlock).type === 'marquee';
}
```

**Step 7: Add to api-executor + strategist prompt**

api-executor case:
```typescript
case 'marquee':
case 'scrolling': {
  const itemsRaw = (op.content as Record<string, unknown>).items;
  const items = Array.isArray(itemsRaw)
    ? (itemsRaw as string[])
    : (op.content.bodyText ? [op.content.bodyText] : ['New marquee item']);
  const result = await client.addMarqueeBlock(ctx.pageSectionsId, ctx.collectionId, lastSectionIndex, items);
  if (!result.success) throw new Error(result.error ?? 'addMarqueeBlock failed');
  return `Added marquee block with ${items.length} items to section ${lastSectionIndex}`;
}
```

Strategist prompt:
```
Scrolling text (marquee): { "type": "marquee", "items": ["Sale on now", "Free shipping over $50", "New arrivals weekly"] }
```

**Step 8: Commit**

```bash
git add src/services/content-save.ts src/services/content-save-types.ts src/agents/types.ts \
        src/services/api-executor.ts src/agents/content-strategist-agent.ts \
        src/services/__tests__/content-save-marquee.test.ts api-wishlist.md
git commit -m "feat: add Scrolling/Marquee block (type 70) — addMarqueeBlock + updateMarqueeBlock"
```

---

## Task 5: Social Links Block (type 54)

> **Starts after Task 1 (discovery) completes**
> **Run in parallel with Tasks 6, 7**

**Pre-requisite:** Read `data/discovered-tier2-structures.json` to get the exact icon array structure from live discovery.

**Files:** Same 5 files + new test file.

**Step 1: Read discovered structure**

```bash
cat data/discovered-tier2-structures.json
```

Note the `socialLinks.valueSignature` — especially:
- Is the icon array called `icons`, `socialAccounts`, `links`, or something else?
- What does each icon object look like? `{ platform, url }` or `{ type, link }` or similar?

**Step 2: Add result types**

```typescript
export interface SocialLinksBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  error?: string;
}

export interface SocialLinksBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}
```

**Step 3: Write tests based on discovered structure**

Create `src/services/__tests__/content-save-sociallinks.test.ts`.

Adapt the value object to match the discovered structure. Example assuming `{ iconAlignment, iconSize, iconStyle, iconColor, icons: [{platform, url}] }`:

```typescript
function makeSocialLinksBlock(blockId: string): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 3 }, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 3 }, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 54,
        value: {
          iconAlignment: 'center',
          iconSize: 'small',
          iconStyle: 'round',
          iconColor: 'black',
          // Add icon array with discovered structure:
          // icons: [{ platform: 'twitter', url: 'https://twitter.com/test' }]
        },
      },
    },
  };
}

describe('addSocialLinksBlock', () => {
  it('adds social links block with config', async () => {
    const result = await client.addSocialLinksBlock('pid', 'cid', 0, {
      iconAlignment: 'center',
      iconSize: 'small',
      iconStyle: 'round',
    });
    expect(result.success).toBe(true);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.type).toBe(54);
    expect(block.content.value.value.iconAlignment).toBe('center');
  });
});

describe('updateSocialLinksBlock', () => {
  it('updates icon style', async () => {
    const result = await client.updateSocialLinksBlock('pid', 'cid', 'center', { iconStyle: 'square' });
    expect(result.success).toBe(true);
    // verify iconStyle changed
  });
});
```

**Step 4: Implement addSocialLinksBlock + updateSocialLinksBlock**

```typescript
const BLOCK_TYPE_SOCIAL_LINKS = 54;

async addSocialLinksBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  options: {
    iconAlignment?: string;
    iconSize?: string;
    iconStyle?: string;
    iconColor?: string;
    icons?: Array<unknown>;    // use exact type from discovery
  } = {},
  layout?: { columns?: number; rowHeight?: number; gapRows?: number; }
): Promise<SocialLinksBlockAddResult> {
  // Same skeleton. Value object:
  // {
  //   iconAlignment: options.iconAlignment ?? 'center',
  //   iconSize: options.iconSize ?? 'small',
  //   iconStyle: options.iconStyle ?? 'round',
  //   iconColor: options.iconColor ?? 'black',
  //   [iconArrayField]: options.icons ?? [],  // use field name from discovery
  // }
  // rowHeight default: 3
}

async updateSocialLinksBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,   // typically 'center', 'left', or 'right' matching iconAlignment
  updates: { iconAlignment?: string; iconSize?: string; iconStyle?: string; iconColor?: string; }
): Promise<SocialLinksBlockUpdateResult> {
  // findBlock will likely not find by iconAlignment — add type 54 lookup by block type:
  // Search sections for first block of type 54
  // Then apply updates
}
```

**Note on findBlock for Social Links:** Social Links blocks have no searchable text content. Add a fallback in `updateSocialLinksBlock` to find by type 54 when `findBlock` fails:

```typescript
// If no match found by searchText, look for first type-54 block in any section
if (!match) {
  outer: for (const section of data.sections) {
    for (const gc of section.fluidEngineContext?.gridContents ?? []) {
      if (gc.content.value.type === BLOCK_TYPE_SOCIAL_LINKS) {
        match = { section, gridContent: gc, blockIndex: 0 };
        break outer;
      }
    }
  }
}
```

**Step 5: Run tests, add to types.ts + api-executor + strategist prompt**

```typescript
// types.ts
export interface ApiSocialLinksBlock {
  type: 'sociallinks';
  iconAlignment?: 'left' | 'center' | 'right';
  iconSize?: string;
  iconStyle?: string;
  iconColor?: string;
  layout?: { columns?: number; rowHeight?: number; };
}
export function isApiSocialLinksBlock(block: AnyApiBlock): block is ApiSocialLinksBlock {
  return 'type' in block && (block as ApiSocialLinksBlock).type === 'sociallinks';
}
```

api-executor case:
```typescript
case 'sociallinks':
case 'social': {
  const result = await client.addSocialLinksBlock(
    ctx.pageSectionsId, ctx.collectionId, lastSectionIndex,
    {
      iconAlignment: (op.content as Record<string, unknown>).iconAlignment as string,
      iconSize: (op.content as Record<string, unknown>).iconSize as string,
    }
  );
  if (!result.success) throw new Error(result.error ?? 'addSocialLinksBlock failed');
  return `Added social links block to section ${lastSectionIndex}`;
}
```

Strategist prompt:
```
Social Links:      { "type": "sociallinks", "iconAlignment": "center", "iconSize": "small", "iconStyle": "round" }
```

**Step 6: Commit**

```bash
git commit -m "feat: add Social Links block (type 54) — addSocialLinksBlock + updateSocialLinksBlock"
```

---

## Task 6: Embed Block (type 22)

> **Starts after Task 1 (discovery) completes**
> **Run in parallel with Tasks 5, 7**

**Pre-requisite:** Read `data/discovered-tier2-structures.json` for the HTML field name (likely `html`, `code`, or `embedCode`).

**Files:** Same 5 files + new test file.

**Step 1: Read discovered structure**

```bash
cat data/discovered-tier2-structures.json
# Look at embed.htmlField
```

**Step 2: Add result types**

```typescript
export interface EmbedBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  error?: string;
}

export interface EmbedBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}
```

**Step 3: Write tests**

Create `src/services/__tests__/content-save-embed.test.ts`:

```typescript
// Assume htmlField is 'html' — adjust if discovery says otherwise
function makeEmbedBlock(blockId: string, html: string): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 4 }, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 4 }, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: { id: blockId, type: 22, value: { html } },
    },
  };
}

describe('addEmbedBlock', () => {
  it('adds embed block with HTML', async () => {
    const result = await client.addEmbedBlock('pid', 'cid', 0, '<p>Hello World</p>');
    expect(result.success).toBe(true);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.type).toBe(22);
    expect(block.content.value.value.html).toBe('<p>Hello World</p>');
  });
});

describe('updateEmbedBlock', () => {
  it('updates HTML content', async () => {
    // Uses makeEmbedBlock('block-emb', '<p>Original</p>') in sections
    const result = await client.updateEmbedBlock('pid', 'cid', 'Original', { html: '<p>Updated</p>' });
    expect(result.success).toBe(true);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    expect(putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.html).toBe('<p>Updated</p>');
  });
});
```

**Step 4: Implement**

```typescript
const BLOCK_TYPE_EMBED = 22;
const EMBED_HTML_FIELD = 'html';  // Update based on discovery

async addEmbedBlock(
  pageSectionsId: string, collectionId: string, sectionIndex: number,
  html: string,
  layout?: { columns?: number; rowHeight?: number; gapRows?: number; }
): Promise<EmbedBlockAddResult> {
  // Value: { [EMBED_HTML_FIELD]: html }
  // rowHeight default: 4
}

async updateEmbedBlock(
  pageSectionsId: string, collectionId: string, searchText: string,
  updates: { html: string }
): Promise<EmbedBlockUpdateResult> {
  // findBlock, verify type 22, update [EMBED_HTML_FIELD]
}
```

**Note:** `findBlock` may not find Embed blocks by HTML content (it searches text blocks by stripped HTML, not by raw embed content). Add type-22 search fallback or search the embed HTML string directly.

**Step 5: types.ts + api-executor + strategist**

```typescript
export interface ApiEmbedBlock {
  type: 'embed';
  html: string;
  layout?: { columns?: number; rowHeight?: number; };
}
```

api-executor:
```typescript
case 'embed': {
  const html = op.content.bodyText ?? '';
  const result = await client.addEmbedBlock(ctx.pageSectionsId, ctx.collectionId, lastSectionIndex, html);
  if (!result.success) throw new Error(result.error ?? 'addEmbedBlock failed');
  return `Added embed block to section ${lastSectionIndex}`;
}
```

Strategist prompt:
```
HTML Embed:        { "type": "embed", "html": "<script src='https://example.com/widget.js'></script>" }
```

**Step 6: Commit**

```bash
git commit -m "feat: add Embed block (type 22) — addEmbedBlock + updateEmbedBlock"
```

---

## Task 7: Form Block (type 1337 variant)

> **Starts after Task 1 (discovery) completes**
> **Run in parallel with Tasks 5, 6**
>
> **Update-only** — form fields are created via UI, not API. Only visual config is settable.

**Pre-requisite:** Read `data/discovered-tier2-structures.json` for exact field names (`buttonVariant`, `submissionTextAlignment`, `firstFieldHighlightType`).

**Files:** Same 5 files + new test file (no addFormBlock — update only).

**Step 1: Add result types**

```typescript
export interface FormBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}
```

**Step 2: Write tests**

Create `src/services/__tests__/content-save-form.test.ts`:

```typescript
// Form is type 1337 with buttonVariant field as discriminator
function makeFormBlock(blockId: string): GridContent {
  return {
    layout: {
      desktop: { start: { x: 1, y: 0 }, end: { x: 25, y: 8 }, verticalAlignment: 'top', zIndex: 0 },
      mobile: { start: { x: 1, y: 0 }, end: { x: 9, y: 8 }, verticalAlignment: 'top', zIndex: 0 },
    },
    content: {
      value: {
        id: blockId,
        type: 1337,
        value: {
          buttonVariant: 'solid',
          submissionTextAlignment: 'center',
          firstFieldHighlightType: 'none',
          buttonAlignment: 'center',
          buttonText: 'Submit',  // typical form button
        },
      },
    },
  };
}

describe('updateFormBlock', () => {
  it('updates button variant', async () => {
    const result = await client.updateFormBlock('pid', 'cid', 'Submit', { buttonVariant: 'outline' });
    expect(result.success).toBe(true);
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    const val = putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value;
    expect(val.buttonVariant).toBe('outline');
  });

  it('updates submission text alignment', async () => {
    await client.updateFormBlock('pid', 'cid', 'Submit', { submissionTextAlignment: 'left' });
    const putBody = JSON.parse(mockPut.mock.calls[0][1].body);
    expect(putBody.sections[0].fluidEngineContext.gridContents[0].content.value.value.submissionTextAlignment).toBe('left');
  });
});
```

**Step 3: Implement updateFormBlock**

Form blocks are type 1337 (same as Image/Button/Code/Map). The discriminator is `buttonVariant` or `submissionTextAlignment` field presence. `findBlock` currently finds type 1337 blocks by `buttonText` field (they have form submit button text).

```typescript
async updateFormBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,   // matches buttonText or submissionTextAlignment value
  updates: {
    buttonVariant?: string;
    submissionTextAlignment?: string;
    firstFieldHighlightType?: string;
    buttonAlignment?: string;
  },
): Promise<FormBlockUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const match = this.findBlock(data.sections, searchText);
    if (!match) return { success: false, error: `No block found matching "${searchText}"` };

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Verify this is a form block (type 1337 with buttonVariant field)
    if (blockValue.type !== BLOCK_TYPE_IMAGE || blockValue.value?.buttonVariant === undefined) {
      return { success: false, error: `Block "${searchText}" does not appear to be a form block` };
    }

    if (!blockValue.value) blockValue.value = {};
    if (updates.buttonVariant !== undefined) blockValue.value.buttonVariant = updates.buttonVariant;
    if (updates.submissionTextAlignment !== undefined) blockValue.value.submissionTextAlignment = updates.submissionTextAlignment;
    if (updates.firstFieldHighlightType !== undefined) blockValue.value.firstFieldHighlightType = updates.firstFieldHighlightType;
    if (updates.buttonAlignment !== undefined) blockValue.value.buttonAlignment = updates.buttonAlignment;

    logger.info({ blockId: blockValue.id, searchText }, 'Updating form block config via Content Save API');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId: blockValue.id };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
}
```

Note: `BLOCK_TYPE_IMAGE = 1337` is the same constant. No new constant needed.

**Step 4: types.ts + api-executor + strategist**

```typescript
// No ApiFormBlock needed (no add path).
// Add updateFormBlock handling in executeModifyBlock:

if (blockType === 'form') {
  const searchText = op.content.heading ?? op.content.bodyText ?? op.placement;
  if (!searchText) throw new Error('modify_block (form): need search text');
  const result = await client.updateFormBlock(
    ctx.pageSectionsId, ctx.collectionId, searchText,
    {
      buttonVariant: (op.content as Record<string, unknown>).buttonVariant as string,
      submissionTextAlignment: (op.content as Record<string, unknown>).submissionTextAlignment as string,
    }
  );
  if (!result.success) throw new Error(result.error ?? 'updateFormBlock failed');
  return `Updated form block config "${searchText.slice(0, 50)}"`;
}
```

Strategist note (no apiBlock for add, just document update usage):
```
Form config update: Use operationType: "modify_block" with blockType: "form" and buttonVariant/submissionTextAlignment.
                    Note: Form fields must be created via browser UI — only visual config is settable via API.
```

**Step 5: Update api-wishlist.md**

Mark Form as: `🔶 Partial | updateFormBlock | Add not supported (form fields require UI)`

**Step 6: Commit**

```bash
git commit -m "feat: add Form block (type 1337 variant) — updateFormBlock for visual config"
```

---

## Task 8: Full api-wishlist.md Update

> **After all blocks are merged to main**

Update all 6 block rows in `api-wishlist.md` High Priority section:

| Block | New Status | Methods |
|-------|-----------|---------|
| Newsletter (51) | ✅ Full | `addNewsletterBlock` `updateNewsletterBlock` |
| Social Links (54) | ✅ Full (or 🔶 if icon array is complex) | `addSocialLinksBlock` `updateSocialLinksBlock` |
| Embed (22) | ✅ Full | `addEmbedBlock` `updateEmbedBlock` |
| Form (1337) | 🔶 Partial | `updateFormBlock` only |
| Accordion (69) | ✅ Full | `addAccordionBlock` `updateAccordionBlock` |
| Marquee (70) | ✅ Full | `addMarqueeBlock` `updateMarqueeBlock` |

Move Accordion and Marquee from the "Blocks We Don't Have Yet" section to "Blocks We Have".

```bash
git add api-wishlist.md
git commit -m "docs: update api-wishlist.md — mark Newsletter/Accordion/Marquee/Embed/Form/SocialLinks as implemented"
```

---

## Task 9: Final Verification

> **After all merges complete**

**Step 1: Run full test suite**

```bash
cd "/Users/timcox/squarespace helper"
npm run test
```

Expected: All tests pass (the 6 new test files add ~30-40 new tests). Check no regressions.

**Step 2: Spot-check api-executor imports**

```bash
npx tsx -e "
import { ContentSaveClient } from './src/services/content-save.js';
const c = new ContentSaveClient('test');
console.log('addNewsletterBlock:', typeof c.addNewsletterBlock);
console.log('addAccordionBlock:', typeof c.addAccordionBlock);
console.log('addMarqueeBlock:', typeof c.addMarqueeBlock);
console.log('addSocialLinksBlock:', typeof c.addSocialLinksBlock);
console.log('addEmbedBlock:', typeof c.addEmbedBlock);
console.log('updateFormBlock:', typeof c.updateFormBlock);
"
```

Expected: All show `'function'`

**Step 3: Final commit if any cleanup needed**

```bash
git commit -m "chore: post-merge cleanup for high-priority block implementations"
```
