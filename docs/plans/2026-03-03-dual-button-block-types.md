# Dual Button Block Types Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support both Squarespace button block formats (legacy type 46 and new type 1337) across all API methods, action handlers, and agent types.

**Architecture:** Add a thin normalization layer (`isButtonBlock`, `getButtonFields`, `setButtonFields`) in `content-save.ts` that abstracts over both types. All new buttons use type 1337 format. Existing type 46 buttons are read/updated through the same normalized interface.

**Tech Stack:** TypeScript, vitest, Squarespace Content Save API

---

### Task 1: Add Button Normalization Helpers + Tests

**Files:**
- Modify: `src/services/content-save.ts:249-279` (constants) and new helper section after line 279
- Test: `src/services/__tests__/content-save-button-block.test.ts`

**Step 1: Write the failing tests for normalization helpers**

Add after the existing helper functions (around line 58) in the test file, a new `makeNewButtonBlock` helper, then new describe block:

```typescript
/** Type 1337 (new format) button block — matches real Squarespace output */
function makeNewButtonBlock(
  blockId: string,
  buttonText: string,
  buttonLink: string,
  options?: { size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean },
): GridContent {
  return {
    layout: { ...STUB_LAYOUT },
    content: {
      value: {
        id: blockId,
        type: 1337,
        value: {
          buttonText,
          buttonLink,
          newWindow: options?.newWindow ?? false,
          buttonAlignment: options?.alignment ?? 'center',
          buttonSize: options?.size ?? 'medium',
          ...(options?.style ? { buttonStyle: options.style } : {}),
          ...(options?.variant ? { buttonVariant: options.variant } : {}),
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
    },
  };
}
```

Then add a test describe block at the end of the file:

```typescript
// ── Button type detection helpers ──────────────────────────────────────────

describe('ContentSaveClient — button type helpers', () => {
  it('isButtonBlock returns true for type 46', () => {
    const block = makeButtonBlock('btn-1', 'Click', 'https://example.com');
    expect(ContentSaveClient.isButtonBlock(block.content.value)).toBe(true);
  });

  it('isButtonBlock returns true for type 1337 with button definitionName', () => {
    const block = makeNewButtonBlock('btn-2', 'Click', 'https://example.com');
    expect(ContentSaveClient.isButtonBlock(block.content.value)).toBe(true);
  });

  it('isButtonBlock returns false for type 1337 image block', () => {
    const imageBlock: GridContent = {
      layout: { ...STUB_LAYOUT },
      content: {
        value: {
          id: 'img-1',
          type: 1337,
          value: { title: 'Photo', assetUrl: 'https://images.squarespace-cdn.com/test.jpg' },
        },
      },
    };
    expect(ContentSaveClient.isButtonBlock(imageBlock.content.value)).toBe(false);
  });

  it('isButtonBlock returns false for text block', () => {
    const block = makeTextBlock('t1', '<p>Text</p>');
    expect(ContentSaveClient.isButtonBlock(block.content.value)).toBe(false);
  });

  it('getButtonFields normalizes type 46 fields', () => {
    const block = makeButtonBlock('btn-1', 'Book Now', 'https://example.com/book');
    const fields = ContentSaveClient.getButtonFields(block.content.value);
    expect(fields).toEqual({
      text: 'Book Now',
      url: 'https://example.com/book',
    });
  });

  it('getButtonFields normalizes type 1337 fields', () => {
    const block = makeNewButtonBlock('btn-2', 'Reserve', 'https://example.com/reserve', {
      size: 'large', style: 'secondary', alignment: 'left', variant: 'outline', newWindow: true,
    });
    const fields = ContentSaveClient.getButtonFields(block.content.value);
    expect(fields).toEqual({
      text: 'Reserve',
      url: 'https://example.com/reserve',
      size: 'large',
      style: 'secondary',
      alignment: 'left',
      variant: 'outline',
      newWindow: true,
    });
  });

  it('getButtonFields returns null for non-button', () => {
    const block = makeTextBlock('t1', '<p>Text</p>');
    expect(ContentSaveClient.getButtonFields(block.content.value)).toBeNull();
  });

  it('setButtonFields updates type 46 label and url', () => {
    const block = makeButtonBlock('btn-1', 'Old', 'https://old.com');
    const bv = block.content.value;
    ContentSaveClient.setButtonFields(bv, { text: 'New', url: 'https://new.com' });
    expect(bv.value.label).toBe('New');
    expect(bv.value.url).toBe('https://new.com');
  });

  it('setButtonFields updates type 1337 buttonText, buttonLink, and design fields', () => {
    const block = makeNewButtonBlock('btn-2', 'Old', 'https://old.com');
    const bv = block.content.value;
    ContentSaveClient.setButtonFields(bv, {
      text: 'New', url: 'https://new.com',
      size: 'small', style: 'tertiary', alignment: 'right', variant: 'outline',
    });
    expect(bv.value.buttonText).toBe('New');
    expect(bv.value.buttonLink).toBe('https://new.com');
    expect(bv.value.buttonSize).toBe('small');
    expect(bv.value.buttonStyle).toBe('tertiary');
    expect(bv.value.buttonAlignment).toBe('right');
    expect(bv.value.buttonVariant).toBe('outline');
  });

  it('setButtonFields skips undefined fields', () => {
    const block = makeNewButtonBlock('btn-2', 'Keep', 'https://keep.com', { size: 'large' });
    const bv = block.content.value;
    ContentSaveClient.setButtonFields(bv, { text: 'Changed' });
    expect(bv.value.buttonText).toBe('Changed');
    expect(bv.value.buttonLink).toBe('https://keep.com'); // unchanged
    expect(bv.value.buttonSize).toBe('large'); // unchanged
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-button-block.test.ts`
Expected: FAIL — `ContentSaveClient.isButtonBlock is not a function`

**Step 3: Implement the normalization helpers**

In `src/services/content-save.ts`, after the block type constants (around line 279), add:

```typescript
// Button block definitionName for type 1337 (new format)
const BUTTON_DEFINITION_NAME = 'website.components.button';
```

Add these as static methods on the `ContentSaveClient` class (after the existing static `generateBlockId` and `generateSectionId` methods):

```typescript
  /**
   * Check if a block value represents a button block (either type 46 or type 1337 with button definitionName).
   */
  static isButtonBlock(blockValue: { type: number; definitionName?: string }): boolean {
    if (blockValue.type === BLOCK_TYPE_BUTTON) return true;
    if (blockValue.type === BLOCK_TYPE_IMAGE && blockValue.definitionName === BUTTON_DEFINITION_NAME) return true;
    return false;
  }

  /**
   * Get normalized button fields from either type 46 or type 1337 button blocks.
   * Returns null if block is not a button.
   */
  static getButtonFields(
    blockValue: { type: number; definitionName?: string; value?: Record<string, unknown> },
  ): { text: string; url: string; size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean } | null {
    if (!ContentSaveClient.isButtonBlock(blockValue)) return null;
    const v = blockValue.value ?? {};

    if (blockValue.type === BLOCK_TYPE_BUTTON) {
      return { text: v.label as string ?? '', url: v.url as string ?? '' };
    }

    // Type 1337 new button
    const result: { text: string; url: string; size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean } = {
      text: v.buttonText as string ?? '',
      url: v.buttonLink as string ?? '',
    };
    if (v.buttonSize) result.size = v.buttonSize as string;
    if (v.buttonStyle) result.style = v.buttonStyle as string;
    if (v.buttonAlignment) result.alignment = v.buttonAlignment as string;
    if (v.buttonVariant) result.variant = v.buttonVariant as string;
    if (v.newWindow !== undefined) result.newWindow = v.newWindow as boolean;
    return result;
  }

  /**
   * Set button fields on either type 46 or type 1337 button blocks.
   * Only updates fields that are explicitly provided (not undefined).
   */
  static setButtonFields(
    blockValue: { type: number; definitionName?: string; value?: Record<string, unknown> },
    updates: { text?: string; url?: string; size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean },
  ): void {
    if (!blockValue.value) blockValue.value = {};
    const v = blockValue.value;

    if (blockValue.type === BLOCK_TYPE_BUTTON) {
      // Type 46 legacy
      if (updates.text !== undefined) v.label = updates.text;
      if (updates.url !== undefined) v.url = updates.url;
      return;
    }

    // Type 1337 new button
    if (updates.text !== undefined) v.buttonText = updates.text;
    if (updates.url !== undefined) v.buttonLink = updates.url;
    if (updates.size !== undefined) v.buttonSize = updates.size;
    if (updates.style !== undefined) v.buttonStyle = updates.style;
    if (updates.alignment !== undefined) v.buttonAlignment = updates.alignment;
    if (updates.variant !== undefined) v.buttonVariant = updates.variant;
    if (updates.newWindow !== undefined) v.newWindow = updates.newWindow;
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-button-block.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/services/content-save.ts src/services/__tests__/content-save-button-block.test.ts
git commit -m "feat: add button block type normalization helpers (isButtonBlock, getButtonFields, setButtonFields)"
```

---

### Task 2: Update `findBlock()` to Search Type 1337 Buttons

**Files:**
- Modify: `src/services/content-save.ts:1034-1055` (the type 1337 branch in findBlock)
- Test: `src/services/__tests__/content-save-button-block.test.ts`

**Step 1: Write failing tests**

Add a new describe block to the test file:

```typescript
// ── findBlock with button types ───────────────────────────────────────────

describe('ContentSaveClient — findBlock button type support', () => {
  let client: ContentSaveClient;

  beforeEach(() => {
    client = new ContentSaveClient('test-site');
    client.loadSessionCookies('/fake/session.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds type 46 button by label', () => {
    const sections = makeSections(makeButtonBlock('btn-1', 'Contact Us', 'https://example.com'));
    const result = client.findBlock(sections, 'Contact Us');
    expect(result).not.toBeNull();
    expect(result!.gridContent.content.value.id).toBe('btn-1');
  });

  it('finds type 1337 button by buttonText', () => {
    const sections = makeSections(makeNewButtonBlock('btn-2', 'Learn More', 'https://example.com'));
    const result = client.findBlock(sections, 'Learn More');
    expect(result).not.toBeNull();
    expect(result!.gridContent.content.value.id).toBe('btn-2');
  });

  it('finds type 1337 button by buttonLink', () => {
    const sections = makeSections(makeNewButtonBlock('btn-2', 'Click', 'https://example.com/special'));
    const result = client.findBlock(sections, 'example.com/special');
    expect(result).not.toBeNull();
    expect(result!.gridContent.content.value.id).toBe('btn-2');
  });

  it('finds type 1337 button among mixed blocks', () => {
    const sections = makeSections(
      makeTextBlock('t1', '<p>Header text</p>'),
      makeNewButtonBlock('btn-new', 'Reserve Now', 'https://example.com/reserve'),
      makeButtonBlock('btn-old', 'Old Button', 'https://old.com'),
    );
    const result = client.findBlock(sections, 'Reserve Now');
    expect(result).not.toBeNull();
    expect(result!.gridContent.content.value.id).toBe('btn-new');
  });

  it('does not match type 1337 image block when searching for button text', () => {
    // Image block also type 1337 but no definitionName for button
    const imageBlock: GridContent = {
      layout: { ...STUB_LAYOUT },
      content: {
        value: {
          id: 'img-1',
          type: 1337,
          value: { title: 'Reserve Now', assetUrl: 'https://images.squarespace-cdn.com/test.jpg' },
        },
      },
    };
    const sections = makeSections(
      imageBlock,
      makeNewButtonBlock('btn-1', 'Reserve Now', 'https://example.com'),
    );
    // findBlock should return the button, not the image (image matches on title too, but button should be found first or also)
    const result = client.findBlock(sections, 'Reserve Now');
    expect(result).not.toBeNull();
    // Either the image or the button matches — both are valid finds. Just confirm it works.
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-button-block.test.ts`
Expected: FAIL on "finds type 1337 button by buttonText" — `findBlock` returns null or wrong match

**Step 3: Implement findBlock changes**

In `src/services/content-save.ts`, in the `findBlock` method, modify the type 1337 branch (around line 1034-1055). Insert a button check BEFORE the existing code/form/image checks:

Replace the block starting at line 1034:
```typescript
        // Type 1337: Code HTML blocks, Form blocks, or Image blocks (same outer type, different value structure)
        if (bv.type === BLOCK_TYPE_IMAGE) {
```

With:
```typescript
        // Type 1337 buttons: check definitionName before falling into image/code/form checks
        if (bv.type === BLOCK_TYPE_IMAGE && bv.definitionName === BUTTON_DEFINITION_NAME) {
          const btnText = bv.value?.buttonText ?? '';
          const btnLink = bv.value?.buttonLink ?? '';
          if ((btnText && String(btnText).toLowerCase().includes(needle)) ||
              (btnLink && String(btnLink).toLowerCase().includes(needle))) {
            return { section, gridContent: gc, sectionIndex: si, blockIndex: bi, gridSettings: ctx.gridSettings };
          }
        }

        // Type 1337: Code HTML blocks, Form blocks, or Image blocks (same outer type, different value structure)
        if (bv.type === BLOCK_TYPE_IMAGE && bv.definitionName !== BUTTON_DEFINITION_NAME) {
```

Note: the closing brace of the original `if (bv.type === BLOCK_TYPE_IMAGE)` block stays unchanged. We just add the button check before it and add `&& bv.definitionName !== BUTTON_DEFINITION_NAME` to exclude buttons from the image/code/form path.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-button-block.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/services/content-save.ts src/services/__tests__/content-save-button-block.test.ts
git commit -m "feat: findBlock searches type 1337 button blocks by buttonText and buttonLink"
```

---

### Task 3: Update `updateButtonBlock()` to Handle Both Types + Design Fields

**Files:**
- Modify: `src/services/content-save.ts:3287-3357` (updateButtonBlock method)
- Modify: `src/services/content-save-types.ts:141-149` (ButtonBlockUpdateResult)
- Test: `src/services/__tests__/content-save-button-block.test.ts`

**Step 1: Write failing tests**

Add to the existing `updateButtonBlock` describe block:

```typescript
  it('updates type 1337 button text and link', async () => {
    const sections = makeSections(makeNewButtonBlock('btn-new', 'Old Text', 'https://old.com'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Old Text', { newLabel: 'New Text', url: 'https://new.com' },
    );

    expect(result.success).toBe(true);
    expect(result.blockId).toBe('btn-new');
    expect(result.oldLabel).toBe('Old Text');
    expect(result.newLabel).toBe('New Text');
    expect(result.oldUrl).toBe('https://old.com');
    expect(result.newUrl).toBe('https://new.com');

    // Verify PUT body uses type 1337 field names
    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.buttonText).toBe('New Text');
    expect(block.content.value.value.buttonLink).toBe('https://new.com');

    fetchSpy.mockRestore();
  });

  it('updates type 1337 button design fields (size, style, alignment, variant)', async () => {
    const sections = makeSections(makeNewButtonBlock('btn-new', 'CTA', 'https://example.com', { size: 'medium' }));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'CTA',
      { size: 'large', style: 'secondary', alignment: 'left', variant: 'outline' },
    );

    expect(result.success).toBe(true);

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const block = putBody.sections[0].fluidEngineContext.gridContents[0];
    expect(block.content.value.value.buttonSize).toBe('large');
    expect(block.content.value.value.buttonStyle).toBe('secondary');
    expect(block.content.value.value.buttonAlignment).toBe('left');
    expect(block.content.value.value.buttonVariant).toBe('outline');

    fetchSpy.mockRestore();
  });

  it('accepts design-only updates (no label/url) for type 1337', async () => {
    const sections = makeSections(makeNewButtonBlock('btn-new', 'Keep Text', 'https://keep.com'));
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await client.updateButtonBlock(
      'psid-1', 'cid-1', 'Keep Text', { size: 'small' },
    );

    expect(result.success).toBe(true);
    // Label/URL unchanged
    expect(result.newLabel).toBe('Keep Text');
    expect(result.newUrl).toBe('https://keep.com');

    fetchSpy.mockRestore();
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-button-block.test.ts`
Expected: FAIL — "not a button block (expected 46)" for type 1337 buttons, and "Must provide at least newLabel or url" for design-only

**Step 3: Update the types and implement**

First, update `ButtonBlockUpdateResult` in `src/services/content-save-types.ts:141-149` — no change needed, existing fields are fine.

Then update the `updateButtonBlock` signature and body in `src/services/content-save.ts:3287-3357`:

Replace the full method:

```typescript
  async updateButtonBlock(
    pageSectionsId: string,
    collectionId: string,
    searchText: string,
    updates: {
      newLabel?: string;
      url?: string;
      size?: string;
      style?: string;
      alignment?: string;
      variant?: string;
      newWindow?: boolean;
    },
  ): Promise<ButtonBlockUpdateResult> {
    const hasAnyUpdate = updates.newLabel !== undefined || updates.url !== undefined ||
      updates.size !== undefined || updates.style !== undefined ||
      updates.alignment !== undefined || updates.variant !== undefined ||
      updates.newWindow !== undefined;

    if (!hasAnyUpdate) {
      return { success: false, error: 'Must provide at least one field to update' };
    }

    try {
      // Step 1: GET current sections
      const data = await this.getPageSections(pageSectionsId);

      // Step 2: Find the button block
      const match = this.findBlock(data.sections, searchText);
      if (!match) {
        return { success: false, error: `No block found matching "${searchText}"` };
      }

      const { gridContent } = match;
      const blockValue = gridContent.content.value;

      // Step 3: Verify block is a button (either type 46 or type 1337 button)
      if (!ContentSaveClient.isButtonBlock(blockValue)) {
        return {
          success: false,
          error: `Block "${searchText}" is type ${blockValue.type}, not a button block`,
        };
      }

      const blockId = blockValue.id;
      const oldFields = ContentSaveClient.getButtonFields(blockValue)!;
      const oldLabel = oldFields.text;
      const oldUrl = oldFields.url;

      // Step 4: Update provided fields using normalized setter
      ContentSaveClient.setButtonFields(blockValue, {
        text: updates.newLabel,
        url: updates.url,
        size: updates.size,
        style: updates.style,
        alignment: updates.alignment,
        variant: updates.variant,
        newWindow: updates.newWindow,
      });

      logger.info(
        { blockId, searchText, oldLabel, newLabel: updates.newLabel, oldUrl, newUrl: updates.url },
        'Updating button block via Content Save API',
      );

      // Step 5: PUT the modified sections
      const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }

      return {
        success: true,
        blockId,
        oldLabel,
        newLabel: updates.newLabel ?? oldLabel,
        oldUrl,
        newUrl: updates.url ?? oldUrl,
      };
    } catch (err) {
      return { success: false, error: errMsg(err) };
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-button-block.test.ts`
Expected: ALL PASS (existing type 46 tests still pass, new type 1337 tests pass)

**Step 5: Commit**

```bash
git add src/services/content-save.ts src/services/__tests__/content-save-button-block.test.ts
git commit -m "feat: updateButtonBlock handles both type 46 and type 1337 buttons with design fields"
```

---

### Task 4: Rewrite `addButtonBlock()` to Create Type 1337

**Files:**
- Modify: `src/services/content-save.ts:3244-3256` (the GridContent creation in addButtonBlock)
- Test: `src/services/__tests__/content-save-button-block.test.ts`

**Step 1: Write failing tests**

Add to the existing `addButtonBlock` describe block:

```typescript
  it('creates type 1337 button block (new format) with definitionName', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addButtonBlock('psid-1', 'cid-1', 0, 'Book Now', 'https://example.com/book');

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    // Type 1337 with button definitionName
    expect(newBlock.content.value.type).toBe(1337);
    expect(newBlock.content.value.definitionName).toBe('website.components.button');

    // New field names
    expect(newBlock.content.value.value.buttonText).toBe('Book Now');
    expect(newBlock.content.value.value.buttonLink).toBe('https://example.com/book');

    // Design defaults
    expect(newBlock.content.value.value.buttonSize).toBe('medium');
    expect(newBlock.content.value.value.buttonAlignment).toBe('center');
    expect(newBlock.content.value.value.newWindow).toBe(false);

    // Required structures
    expect(newBlock.content.value.value.containerStyles).toBeDefined();
    expect(newBlock.content.value.value.transforms).toBeDefined();
    expect(newBlock.content.value.containerStyles).toBeDefined();

    fetchSpy.mockRestore();
  });

  it('creates type 1337 button with custom design fields', async () => {
    const sections = makeSections();
    const data = makePageSectionsData(sections);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.addButtonBlock('psid-1', 'cid-1', 0, 'CTA', 'https://example.com', undefined, {
      size: 'large', style: 'secondary', alignment: 'right', variant: 'outline', newWindow: true,
    });

    const [, putOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const putBody = JSON.parse(putOptions.body as string);
    const newBlock = putBody.sections[0].fluidEngineContext.gridContents[0];

    expect(newBlock.content.value.value.buttonSize).toBe('large');
    expect(newBlock.content.value.value.buttonStyle).toBe('secondary');
    expect(newBlock.content.value.value.buttonAlignment).toBe('right');
    expect(newBlock.content.value.value.buttonVariant).toBe('outline');
    expect(newBlock.content.value.value.newWindow).toBe(true);

    fetchSpy.mockRestore();
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-button-block.test.ts`
Expected: FAIL — block type is still 46, field names are `label`/`url` not `buttonText`/`buttonLink`

**Step 3: Implement**

Update the `addButtonBlock` method signature to accept optional design fields:

```typescript
  async addButtonBlock(
    pageSectionsId: string,
    collectionId: string,
    sectionIndex: number,
    label: string,
    url: string,
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    },
    design?: {
      size?: string;
      style?: string;
      alignment?: string;
      variant?: string;
      newWindow?: boolean;
    },
  ): Promise<ButtonBlockAddResult> {
```

Then replace the `newBlock` GridContent creation (lines 3244-3256) with:

```typescript
      const newBlock: GridContent = {
        layout: {
          mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
          desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
        },
        content: {
          value: {
            id: blockId,
            type: BLOCK_TYPE_IMAGE, // 1337
            value: {
              buttonText: label,
              buttonLink: url,
              newWindow: design?.newWindow ?? false,
              buttonAlignment: design?.alignment ?? 'center',
              buttonSize: design?.size ?? 'medium',
              ...(design?.style ? { buttonStyle: design.style } : {}),
              ...(design?.variant ? { buttonVariant: design.variant } : {}),
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
            definitionName: BUTTON_DEFINITION_NAME,
          },
        },
      };
```

**Step 4: Update existing tests that check for type 46**

The existing test "creates correct GridContent structure (type=46, label, url, mobile+desktop layout)" at line 367 needs updating. Change:
- `expect(newBlock.content.value.type).toBe(46);` → `expect(newBlock.content.value.type).toBe(1337);`
- `expect(newBlock.content.value.value.label).toBe('Book Now');` → `expect(newBlock.content.value.value.buttonText).toBe('Book Now');`
- `expect(newBlock.content.value.value.url).toBe('https://example.com/book');` → `expect(newBlock.content.value.value.buttonLink).toBe('https://example.com/book');`

Also update line 150:
- `expect(gridContents[0].content.value.type).toBe(46);` → `expect(gridContents[0].content.value.type).toBe(1337);`
- `expect(gridContents[0].content.value.value.label).toBe('Reserve Now');` → `expect(gridContents[0].content.value.value.buttonText).toBe('Reserve Now');`
- `expect(gridContents[0].content.value.value.url).toBe('https://example.com/reserve');` → `expect(gridContents[0].content.value.value.buttonLink).toBe('https://example.com/reserve');`

Also rename the test from "creates correct GridContent structure (type=46, label, url, mobile+desktop layout)" to "creates correct GridContent structure (type=1337, buttonText, buttonLink, mobile+desktop layout)".

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-button-block.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/services/content-save.ts src/services/__tests__/content-save-button-block.test.ts
git commit -m "feat: addButtonBlock creates type 1337 buttons by default with design field support"
```

---

### Task 5: Update Action Types, Handler Utils, and Agent Types

**Files:**
- Modify: `src/automation/actions/types.ts:22` (editButtonBlock action type)
- Modify: `src/automation/actions/types.ts:38` (addButtonBlock action type)
- Modify: `src/automation/actions/handler-utils.ts:822-855` (tryButtonBlockApi)
- Modify: `src/automation/actions/text-editing-handlers.ts:1256-1275` (handleEditButtonBlock signature + fast path)
- Modify: `src/agents/types.ts:106-110` (ContentSpec buttonVariant field)
- Modify: `src/agents/types.ts:142` (BlockReplacementOptions buttons)
- Modify: `src/agents/types.ts:218-231` (ApiButtonBlock)

**Step 1: Update action types**

In `src/automation/actions/types.ts`, line 22, add `variant`:

```typescript
  | { action: 'editButtonBlock'; searchText: string; newLabel?: string; url?: string; size?: 'small' | 'medium' | 'large'; style?: 'primary' | 'secondary' | 'tertiary'; alignment?: 'left' | 'center' | 'right'; variant?: 'solid' | 'outline' }
```

Line 38, add `variant`:

```typescript
  | { action: 'addButtonBlock'; label: string; url: string; size?: 'small' | 'medium' | 'large'; style?: 'primary' | 'secondary' | 'tertiary'; alignment?: 'left' | 'center' | 'right'; variant?: 'solid' | 'outline' }
```

**Step 2: Update agent types**

In `src/agents/types.ts`, add after `buttonAlignment` (line 110):

```typescript
  /** Button design: variant (solid or outline) */
  buttonVariant?: 'solid' | 'outline';
```

Update `ApiButtonBlock` (line 218-231) to add design fields:

```typescript
export interface ApiButtonBlock {
  type: 'button';
  label: string;
  url: string;
  size?: 'small' | 'medium' | 'large';
  style?: 'primary' | 'secondary' | 'tertiary';
  alignment?: 'left' | 'center' | 'right';
  variant?: 'solid' | 'outline';
  newWindow?: boolean;
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  };
}
```

Update `BlockReplacementOptions.buttons` (around line 142) to add design fields:

```typescript
  buttons?: Array<{
    searchText: string;
    newLabel?: string;
    url?: string;
    size?: string;
    style?: string;
    alignment?: string;
    variant?: string;
  }>;
```

**Step 3: Update handler-utils `tryButtonBlockApi`**

In `src/automation/actions/handler-utils.ts`, update the function signature and body:

```typescript
export async function tryButtonBlockApi(
  page: Page,
  searchText: string,
  updates: { newLabel?: string; url?: string; size?: string; style?: string; alignment?: string; variant?: string },
): Promise<ActionResult | null> {
  const ctx = await extractApiContext(page, 'tryButtonBlockApi');
  if (!ctx) return null;

  try {
    const result = await ctx.client.updateButtonBlock(
      ctx.pageSectionsId,
      ctx.collectionId,
      searchText,
      updates,
    );

    if (result.success) {
      logger.info(
        { blockId: result.blockId, searchText, newLabel: updates.newLabel, newUrl: updates.url },
        'Content Save API: button block updated successfully',
      );
      return {
        success: true,
        message: `editButtonBlock: Updated button via Content Save API (block ${result.blockId}). Label: "${result.newLabel}", URL: "${result.newUrl}". Reload the page to see the change.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Content Save API: button update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'tryButtonBlockApi: failed');
    return null;
  }
}
```

**Step 4: Update `handleEditButtonBlock` signature and fast path**

In `src/automation/actions/text-editing-handlers.ts`, update the action type in the signature (line 1258) to include `variant`:

```typescript
  action: { action: 'editButtonBlock'; searchText: string; newLabel?: string; url?: string; size?: 'small' | 'medium' | 'large'; style?: 'primary' | 'secondary' | 'tertiary'; alignment?: 'left' | 'center' | 'right'; variant?: 'solid' | 'outline' },
```

Update the destructuring (line 1260):
```typescript
  const { searchText, newLabel, url, size, style, alignment, variant } = action;
```

Update the early return check (line 1262):
```typescript
  if (!newLabel && !url && !size && !style && !alignment && !variant) {
    return { success: false, message: 'editButtonBlock: must provide at least newLabel, url, size, style, alignment, or variant' };
  }
```

Update the API fast path call (lines 1268-1274) to pass all fields:
```typescript
  // ── Fast path: try Content Save API first (no UI, ~100ms) ─────────────
  if (newLabel !== undefined || url !== undefined || size !== undefined || style !== undefined || alignment !== undefined || variant !== undefined) {
    logger.info({ searchText }, 'editButtonBlock[0/6]: trying Content Save API fast path');
    const apiResult = await tryButtonBlockApi(page, searchText, { newLabel, url, size, style, alignment, variant });
    if (apiResult) {
      return apiResult;
    }
    logger.info('editButtonBlock[0/6]: API fast path unavailable, falling back to UI automation');
  }
```

Note: We remove the old comment about "size, style, alignment require UI" since the API now handles them for type 1337 buttons. The UI fallback still works as before for both types.

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (no breaking changes — the existing UI code paths are unchanged)

**Step 6: Commit**

```bash
git add src/automation/actions/types.ts src/agents/types.ts src/automation/actions/handler-utils.ts src/automation/actions/text-editing-handlers.ts
git commit -m "feat: add variant field to button action types and pass design fields through API fast path"
```

---

### Task 6: Update API Executor + Browser Agent Prompt

**Files:**
- Modify: `src/services/api-executor.ts:436-447` (template button replacement)
- Modify: `src/services/api-executor.ts:555-567` (modify_block button)
- Modify: `src/services/api-executor.ts:667-673` (add_block button)
- Modify: `src/automation/browser-agent-prompt.ts:145-149` (button documentation)

**Step 1: Update api-executor template button replacement**

In `src/services/api-executor.ts` around line 436, pass design fields:

```typescript
    // Update buttons
    if (replacements.buttons) {
      for (const btn of replacements.buttons) {
        const result = await client.updateButtonBlock(
          ctx.pageSectionsId, ctx.collectionId, btn.searchText,
          { newLabel: btn.newLabel, url: btn.url, size: btn.size, style: btn.style, alignment: btn.alignment, variant: btn.variant },
        );
        if (result.success) replacementsApplied++;
        else logger.warn({ error: result.error, searchText: btn.searchText }, 'api-executor: template button replacement failed');
      }
    }
```

**Step 2: Update api-executor modify_block button**

Around line 555, pass design fields from `op.content.button`:

```typescript
  // Button modification
  if (button || blockType === 'button') {
    const searchText = heading ?? button?.label ?? op.placement;
    if (!searchText) throw new Error('modify_block (button): need search text');

    const result = await client.updateButtonBlock(
      ctx.pageSectionsId, ctx.collectionId, searchText,
      {
        newLabel: button?.label,
        url: button?.url,
        size: button?.size,
        style: button?.style,
        alignment: button?.alignment,
        variant: button?.variant,
      },
    );
    if (!result.success) throw new Error(result.error ?? 'updateButtonBlock failed');
    return `Updated button "${searchText.slice(0, 50)}"`;
  }
```

Note: This requires the `ContentOperationButton` type (in the `op.content.button` field) to have size/style/alignment/variant. Check `src/agents/types.ts` for the button sub-type. If it doesn't have those fields, add them.

**Step 3: Update api-executor add_block button**

Around line 667, pass design fields:

```typescript
    case 'button': {
      const label = op.content.button?.label ?? 'Button';
      const url = op.content.button?.url ?? '#';
      const result = await client.addButtonBlock(
        ctx.pageSectionsId, ctx.collectionId, lastSectionIndex, label, url,
        undefined, // layout
        {
          size: op.content.button?.size,
          style: op.content.button?.style,
          alignment: op.content.button?.alignment,
          variant: op.content.button?.variant,
        },
      );
      if (!result.success) throw new Error(result.error ?? 'addButtonBlock failed');
      return `Added button "${label}" to section ${lastSectionIndex}`;
    }
```

**Step 4: Update browser agent prompt**

In `src/automation/browser-agent-prompt.ts` around line 145-149, update the Button Blocks documentation. Find the `full:` template string for the `block_types` section and update the Button subsection:

```
#### Button Blocks
- A button is its own block — NOT the same as the section it sits in
- **Double-click** the button to edit its text, link URL, and style
- Design properties: size (small/medium/large), style (primary/secondary/tertiary), alignment (left/center/right), variant (solid/outline)
- To REMOVE a button: enter section edit mode (click Edit Section), select the button block, then click its delete icon
- NEVER remove the section to remove a button — other blocks in the section will be destroyed
```

Also update the `reduced:` string to mention variant.

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/services/api-executor.ts src/automation/browser-agent-prompt.ts
git commit -m "feat: api-executor passes button design fields, browser agent prompt documents variant"
```

---

### Task 7: Update Content Strategist `parseContentSpec()` + Blank API Button Path

**Files:**
- Modify: `src/agents/content-strategist-agent.ts` (parseContentSpec — extract buttonVariant)
- Modify: `src/services/conversation/execution.ts` (blank_api button block path — pass design fields to addButtonBlock)

**Step 1: Update `parseContentSpec()` to extract `buttonVariant`**

In `src/agents/content-strategist-agent.ts`, find the section that extracts `buttonAlignment`. Add after it:

```typescript
  if (raw.buttonVariant !== undefined) spec.buttonVariant = raw.buttonVariant;
```

**Step 2: Update blank_api button block execution**

In `src/services/conversation/execution.ts`, find where `addButtonBlock` is called for `type: 'button'` apiBlocks. Pass design fields from the apiBlock:

```typescript
const result = await client.addButtonBlock(
  pageSectionsId, collectionId, sectionIndex,
  block.label, block.url,
  block.layout,
  { size: block.size, style: block.style, alignment: block.alignment, variant: block.variant, newWindow: block.newWindow },
);
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/agents/content-strategist-agent.ts src/services/conversation/execution.ts
git commit -m "feat: parseContentSpec extracts buttonVariant, blank_api path passes button design fields"
```

---

### Task 8: Final Verification + CLAUDE.md Update

**Step 1: Run full test suite**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**'`
Expected: ALL PASS, no regressions

**Step 2: Count changes**

Run: `git diff --stat main`

Verify touch points:
- `src/services/content-save.ts` — helpers, findBlock, updateButtonBlock, addButtonBlock
- `src/services/__tests__/content-save-button-block.test.ts` — new tests
- `src/automation/actions/types.ts` — variant field
- `src/agents/types.ts` — ApiButtonBlock, ContentSpec, BlockReplacementOptions
- `src/automation/actions/handler-utils.ts` — design fields passthrough
- `src/automation/actions/text-editing-handlers.ts` — variant in signature
- `src/services/api-executor.ts` — design fields in 3 places
- `src/automation/browser-agent-prompt.ts` — variant documentation
- `src/agents/content-strategist-agent.ts` — parseContentSpec
- `src/services/conversation/execution.ts` — blank_api button path

**Step 3: Update CLAUDE.md memory notes**

Update the button-related entry in MEMORY.md to reflect that both types are now fully supported.
