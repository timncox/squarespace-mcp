# formatTextBlock API Fast Path + Browser Agent Prompt Implementation Plan

> **Status: COMPLETE** — Implemented prior to plan execution. All code live on `main` as of 2026-02-28.

**Goal:** Add a Content Save API fast path to `formatTextBlock` (handling heading/bold/italic/alignment transforms without UI automation), and document all API fast paths in the browser agent's system prompt.

**Architecture:** Two independent tasks run in parallel worktrees. Task A adds `applyFormattingToHtml()` (pure helper) + `tryFormatTextBlockApi()` (follows the `try*Api` pattern in `handler-utils.ts`) + wires it into `handleFormatTextBlock()`. Task B adds a new `PromptSection` to `browser-agent-prompt.ts` listing all API fast paths with a one-sentence principle.

**Tech Stack:** TypeScript, Vitest, existing `ContentSaveClient` in `src/services/content-save.ts`, `extractApiContext()` in `src/automation/actions/handler-utils.ts`.

---

## Task A: formatTextBlock API Fast Path

**Files:**
- Modify: `src/automation/actions/handler-utils.ts`
- Modify: `src/automation/actions/text-editing-handlers.ts:699-1221`
- Create: `src/automation/__tests__/format-text-block-api.test.ts`

---

### A1: Write failing tests for `applyFormattingToHtml`

`applyFormattingToHtml` is a **pure function** — no browser, no API. It takes a Squarespace text block's HTML string and a formatting spec, and returns transformed HTML. Squarespace text blocks look like:

```html
<p class="" style="white-space:pre-wrap;">Hello World</p>
```

Multi-paragraph blocks look like:
```html
<p class="" style="white-space:pre-wrap;">First paragraph</p><p class="" style="white-space:pre-wrap;">Second paragraph</p>
```

Create `src/automation/__tests__/format-text-block-api.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyFormattingToHtml } from '../actions/handler-utils.js';

const P = (text: string, style = 'white-space:pre-wrap;') =>
  `<p class="" style="${style}">${text}</p>`;
const H = (n: number, text: string) =>
  `<h${n} class="" style="white-space:pre-wrap;">${text}</h${n}>`;

describe('applyFormattingToHtml', () => {
  // ── heading conversion ────────────────────────────────────────────────

  it('converts <p> to <h2> for heading2', () => {
    expect(applyFormattingToHtml(P('Hello'), { formatLevel: 'heading2' }))
      .toBe(H(2, 'Hello'));
  });

  it('converts <p> to <h1> for heading1', () => {
    expect(applyFormattingToHtml(P('Title'), { formatLevel: 'heading1' }))
      .toBe(H(1, 'Title'));
  });

  it('converts <h3> to <h2>', () => {
    expect(applyFormattingToHtml(H(3, 'Old'), { formatLevel: 'heading2' }))
      .toBe(H(2, 'Old'));
  });

  it('converts each paragraph in a multi-paragraph block', () => {
    const html = P('First') + P('Second');
    expect(applyFormattingToHtml(html, { formatLevel: 'heading2' }))
      .toBe(H(2, 'First') + H(2, 'Second'));
  });

  // ── bold / italic ─────────────────────────────────────────────────────

  it('wraps content in <strong> when bold: true', () => {
    expect(applyFormattingToHtml(P('Hello'), { bold: true }))
      .toBe(P('<strong>Hello</strong>'));
  });

  it('wraps content in <em> when italic: true', () => {
    expect(applyFormattingToHtml(P('Hello'), { italic: true }))
      .toBe(P('<em>Hello</em>'));
  });

  it('wraps in both <strong><em> when bold and italic', () => {
    expect(applyFormattingToHtml(P('Hello'), { bold: true, italic: true }))
      .toBe(P('<strong><em>Hello</em></strong>'));
  });

  it('does not double-wrap <strong> if already present', () => {
    expect(applyFormattingToHtml(P('<strong>Hello</strong>'), { bold: true }))
      .toBe(P('<strong>Hello</strong>'));
  });

  // ── alignment ─────────────────────────────────────────────────────────

  it('adds text-align to style for center alignment', () => {
    expect(applyFormattingToHtml(P('Hello'), { alignment: 'center' }))
      .toBe(`<p class="" style="white-space:pre-wrap;text-align:center;">Hello</p>`);
  });

  it('replaces existing text-align', () => {
    const html = `<p class="" style="white-space:pre-wrap;text-align:left;">Hello</p>`;
    expect(applyFormattingToHtml(html, { alignment: 'right' }))
      .toBe(`<p class="" style="white-space:pre-wrap;text-align:right;">Hello</p>`);
  });

  // ── combined ──────────────────────────────────────────────────────────

  it('combines heading2 + bold + center alignment', () => {
    const result = applyFormattingToHtml(P('Hello'), {
      formatLevel: 'heading2',
      bold: true,
      alignment: 'center',
    });
    expect(result).toBe(
      `<h2 class="" style="white-space:pre-wrap;text-align:center;"><strong>Hello</strong></h2>`,
    );
  });

  // ── passthrough ───────────────────────────────────────────────────────

  it('returns HTML unchanged when no opts provided', () => {
    const html = P('Hello');
    expect(applyFormattingToHtml(html, {})).toBe(html);
  });
});
```

**Step 1: Run the test to verify it fails**

```bash
cd "/Users/timcox/squarespace helper" && npx vitest run src/automation/__tests__/format-text-block-api.test.ts 2>&1 | tail -20
```

Expected: FAIL with `applyFormattingToHtml is not a function` or similar.

---

### A2: Implement `applyFormattingToHtml` in `handler-utils.ts`

Add this **exported** function before the `extractApiContext` function (around line 60). It must be exported so tests can import it.

```typescript
/**
 * Pure helper: apply formatting transformations to a Squarespace text block's HTML.
 *
 * Processes each block-level element (<p>, <h1>-<h6>) independently:
 * - formatLevel: replaces the element tag (heading1→h1, heading2→h2, etc.)
 * - alignment: adds/replaces text-align in the style attribute
 * - bold: wraps inner content in <strong> (no-ops if already present)
 * - italic: wraps inner content in <em> (no-ops if already present)
 *
 * Returns html unchanged if no opts are provided.
 * Only handles heading1-4 for formatLevel — paragraph variants are not supported
 * (class names vary by site theme). Falls through to UI for those cases.
 */
export function applyFormattingToHtml(
  html: string,
  opts: {
    formatLevel?: 'heading1' | 'heading2' | 'heading3' | 'heading4';
    bold?: boolean;
    italic?: boolean;
    alignment?: 'left' | 'center' | 'right';
  },
): string {
  const { formatLevel, bold, italic, alignment } = opts;

  const tagMap: Record<string, string> = {
    heading1: 'h1', heading2: 'h2', heading3: 'h3', heading4: 'h4',
  };
  const newTag = formatLevel ? tagMap[formatLevel] : undefined;

  // Match each block-level element: opening tag + content + closing tag
  // Non-greedy so multiple elements in a row are processed separately
  return html.replace(
    /<(p|h[1-6])(\s[^>]*)?>[\s\S]*?<\/\1>/gi,
    (match, tag, rawAttrs) => {
      const attrs: string = rawAttrs ?? '';

      // ── 1. Compute the new tag ───────────────────────────────────────
      const finalTag = newTag ?? tag.toLowerCase();

      // ── 2. Compute new style attribute ──────────────────────────────
      // Extract existing style value (always present in SQS HTML)
      const styleMatch = attrs.match(/style="([^"]*)"/i);
      let style = styleMatch ? styleMatch[1] : 'white-space:pre-wrap;';

      if (alignment) {
        // Remove any existing text-align, then append new one
        style = style.replace(/;?\s*text-align:[^;]+/gi, '').replace(/;$/, '');
        style = `${style};text-align:${alignment};`.replace(/^;/, '');
      }

      // Rebuild attrs: keep class, replace style
      const classMatch = attrs.match(/class="([^"]*)"/i);
      const className = classMatch ? classMatch[1] : '';
      const newAttrs = ` class="${className}" style="${style}"`;

      // ── 3. Extract inner content (everything between opening & closing tag) ──
      const innerMatch = match.match(
        /^<(?:p|h[1-6])(?:\s[^>]*)?>( [\s\S]*?)<\/(?:p|h[1-6])>$/i,
      );
      let inner = innerMatch ? innerMatch[1] : '';

      // ── 4. Apply bold ────────────────────────────────────────────────
      if (bold !== undefined) {
        // Strip existing <strong> wrappers, then re-apply if bold=true
        inner = inner.replace(/<strong>([\s\S]*?)<\/strong>/gi, '$1');
        if (bold) inner = `<strong>${inner}</strong>`;
      }

      // ── 5. Apply italic ──────────────────────────────────────────────
      if (italic !== undefined) {
        inner = inner.replace(/<em>([\s\S]*?)<\/em>/gi, '$1');
        if (italic) inner = `<em>${inner}</em>`;
      }

      return `<${finalTag}${newAttrs}>${inner}</${finalTag}>`;
    },
  );
}
```

**Note on the regex:** The `( [\s\S]*?)` has a leading space that's intentional — remove it, it should be `([\s\S]*?)`. Written here with space to avoid markdown rendering issues. In the actual file, write it without the space.

**Step 2: Run tests to verify `applyFormattingToHtml` passes**

```bash
cd "/Users/timcox/squarespace helper" && npx vitest run src/automation/__tests__/format-text-block-api.test.ts 2>&1 | tail -30
```

Expected: All tests PASS. Debug any failures by re-reading the regex carefully.

**Step 3: Commit**

```bash
cd "/Users/timcox/squarespace helper" && git add src/automation/__tests__/format-text-block-api.test.ts src/automation/actions/handler-utils.ts && git commit -m "feat: add applyFormattingToHtml pure helper for text block formatting"
```

---

### A3: Implement `tryFormatTextBlockApi` in `handler-utils.ts`

Add this function after `tryCodeBlockApi` (around line 830) and before the `trySectionStyleApi` function. Follow the exact same `extractApiContext` → read → transform → write → return pattern as all other `try*Api` functions.

```typescript
/**
 * Attempt to format a text block via the Content Save API (no UI).
 *
 * Supported via API: heading1-4 (tag replacement), bold, italic, alignment.
 * Unsupported via API (returns null to fall through): paragraph1-3, monospace,
 * fontSize (class names theme-dependent; no clean API mapping).
 *
 * Returns ActionResult on success, null on failure. Never throws.
 */
export async function tryFormatTextBlockApi(
  page: Page,
  action: {
    searchText: string;
    formatLevel?: 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'paragraph1' | 'paragraph2' | 'paragraph3' | 'monospace';
    bold?: boolean;
    italic?: boolean;
    alignment?: 'left' | 'center' | 'right';
    fontSize?: 'increase' | 'decrease';
  },
): Promise<ActionResult | null> {
  const { searchText, formatLevel, bold, italic, alignment, fontSize } = action;

  // fontSize has no clean API mapping — skip entirely
  if (fontSize) return null;
  // paragraph1-3 and monospace have theme-dependent class names — skip
  if (formatLevel && !['heading1', 'heading2', 'heading3', 'heading4'].includes(formatLevel)) {
    return null;
  }
  // Nothing API-eligible
  if (!formatLevel && bold === undefined && italic === undefined && !alignment) {
    return null;
  }

  const ctx = await extractApiContext(page, 'tryFormatTextBlockApi');
  if (!ctx) return null;

  try {
    // GET current sections → find the block
    const data = await ctx.client.getPageSections(ctx.pageSectionsId);
    const blockMatch = ctx.client.findBlock(data.sections, searchText);
    if (!blockMatch) {
      logger.debug({ searchText }, 'tryFormatTextBlockApi: block not found');
      return null;
    }

    // Read current HTML
    const currentHtml: string =
      blockMatch.gridContent.content.value.value?.html ??
      blockMatch.gridContent.content.value.value?.source ?? '';

    if (!currentHtml) {
      logger.debug({ searchText }, 'tryFormatTextBlockApi: block has no HTML content');
      return null;
    }

    // Apply formatting transformations
    const newHtml = applyFormattingToHtml(currentHtml, {
      formatLevel: formatLevel as 'heading1' | 'heading2' | 'heading3' | 'heading4' | undefined,
      bold,
      italic,
      alignment,
    });

    if (newHtml === currentHtml) {
      // Nothing changed — return success so the UI path isn't attempted unnecessarily
      return {
        success: true,
        message: `formatTextBlock: No changes needed — block "${searchText}" already has the requested formatting.`,
      };
    }

    // Write back via updateTextBlockHtml (bypasses formatHtml() wrapper — we built the HTML ourselves)
    const result = await ctx.client.updateTextBlockHtml(
      ctx.pageSectionsId,
      ctx.collectionId,
      searchText,
      newHtml,
    );

    if (result.success) {
      const parts: string[] = [];
      if (formatLevel) parts.push(`format → ${formatLevel}`);
      if (bold) parts.push('bold');
      if (italic) parts.push('italic');
      if (alignment) parts.push(`align → ${alignment}`);
      logger.info(
        { blockId: result.blockId, searchText, formatLevel, bold, italic, alignment },
        'Format Text Block API: formatting applied successfully',
      );
      return {
        success: true,
        message: `formatTextBlock: Applied ${parts.join(', ')} to block "${searchText}" via Content Save API (block ${result.blockId}). Reload the page to see the change in the editor.`,
      };
    }

    logger.warn({ error: result.error, searchText }, 'Format Text Block API: update failed');
    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'tryFormatTextBlockApi: failed');
    return null;
  }
}
```

**Step 4: Wire into `handleFormatTextBlock` in `text-editing-handlers.ts`**

At the top of the `handleFormatTextBlock` function body, right after the param validation block (after line ~711), add the API fast path call. Find this block:

```typescript
  // ── Step 2/9: Find the text in the iframe ────────────────────────────
  logger.info({ searchText }, 'formatTextBlock[2/9]: finding text');
```

Insert BEFORE step 2/9:

```typescript
  // ── API Fast Path ────────────────────────────────────────────────────
  // Try the Content Save API first for heading/bold/italic/alignment.
  // Returns null for unsupported cases (paragraph variants, monospace, fontSize)
  // which fall through to the 9-step UI automation below.
  const { tryFormatTextBlockApi } = await import('./handler-utils.js');
  const apiResult = await tryFormatTextBlockApi(page, action);
  if (apiResult !== null) return apiResult;

```

**Step 5: Run the full test suite**

```bash
cd "/Users/timcox/squarespace helper" && npm run test 2>&1 | tail -20
```

Expected: All existing tests still pass. The new `format-text-block-api.test.ts` tests pass.

**Step 6: Commit**

```bash
cd "/Users/timcox/squarespace helper" && git add src/automation/actions/handler-utils.ts src/automation/actions/text-editing-handlers.ts && git commit -m "feat: add tryFormatTextBlockApi — API fast path for heading/bold/italic/alignment formatting"
```

---

## Task B: Browser Agent Prompt — API Fast Paths Section

**Files:**
- Modify: `src/automation/browser-agent-prompt.ts:527-528` (insert new PromptSection before the closing `]`)

---

### B1: Add the `api_fast_paths` PromptSection

The `PROMPT_SECTIONS` array ends at line 528 with `];`. Insert a new section object before that closing bracket.

Find this exact text at the end of the array:

```typescript
### Saving
1. Click **"Save"** (top-right area) to save changes and keep editing
2. Click **"Exit"** then **"Save"** to close the editor
3. Block editors (text, buttons, menus) auto-save when you click away
4. If Save button is disabled/grayed out — changes were already auto-saved (this is normal)

### Section Management (hover to reveal controls)
- **Edit section content**: Click the **pencil icon** on the section toolbar
- **Move section**: Click **up/down arrows** on the section toolbar
- **Duplicate section**: Click the **duplicate icon**
- **Delete section**: Click the **trash icon** (WARNING: deletes ALL blocks in the section)
- **Save section as template**: Click the **heart icon**`,
  },
];
```

Replace the `},\n];` at the end with:

```typescript
  },
  {
    id: 'api_fast_paths',
    category: 'interaction_pattern',
    minHighConfToReduce: 3,
    removable: false,
    reduced: 'The system tries Content Save API before UI for: editTextBlock, formatTextBlock (heading/bold/italic/align), moveBlockInSection, resizeBlock, removeBlock, moveSectionUp/Down, replaceImage, addImageBlock, editMenuBlock, editButtonBlock, editQuoteBlock, editCodeBlock, editSectionStyle. If an action says "via Content Save API" in its result — the change is saved server-side and you should reload the page to confirm.',
    full: `## API Fast Paths — The System Tries These Before UI Automation

For the actions below, the system **automatically attempts the Content Save API first** before falling back to UI automation. API calls complete in ~100–500ms vs 5–30s for UI automation. You do not need to do anything differently — just use these action types as normal.

**Key principle:** If an action result says "via Content Save API", the change is already saved server-side. You should use a \`navigate\` action to reload the page before verifying the result visually.

| Action | What the API handles | Falls back to UI when... |
|---|---|---|
| \`editTextBlock\` | Full block replacement or surgical substring patch | Block not found, API unreachable |
| \`formatTextBlock\` | heading1–4, bold, italic, alignment | paragraph variants, monospace, fontSize |
| \`moveBlockInSection\` | Shifts desktop grid coordinates | API fails |
| \`resizeBlock\` | Adjusts grid end coordinates | API fails |
| \`removeBlock\` | Splices block from gridContents | API fails |
| \`moveSectionUp\` / \`moveSectionDown\` | Reorders sections array | API fails |
| \`replaceImage\` / \`addImageBlock\` | Updates image metadata (title, description, altText, linkTo) | Needs actual file upload |
| \`editMenuBlock\` | Structured JSON read-modify-write on menu tabs/sections/items | API fails |
| \`editButtonBlock\` | Updates button label and/or URL | API fails |
| \`editQuoteBlock\` | Updates quote text and attribution | API fails |
| \`editCodeBlock\` | Updates code content and language | API fails |
| \`editSectionStyle\` | Updates section padding, theme, block spacing | API fails |

**After an API-backed action:** Use \`navigate\` to reload the page (same URL) to see the changes reflected in the editor. Do not try to verify changes by reading the DOM before reloading — the editor's in-memory state won't show server-side changes until reload.`,
  },
];
```

**Step 1: Verify the file builds (TypeScript check)**

```bash
cd "/Users/timcox/squarespace helper" && npx tsc --noEmit 2>&1 | grep -i "browser-agent-prompt" | head -20
```

Expected: No errors mentioning `browser-agent-prompt.ts`.

**Step 2: Verify the prompt renders correctly**

Open a Node REPL or add a quick sanity check:

```bash
cd "/Users/timcox/squarespace helper" && node -e "
import('/Users/timcox/squarespace helper/src/automation/browser-agent-prompt.js').then(m => {
  const blocks = m.buildSystemPrompt();
  const text = blocks[0].text;
  console.log('api_fast_paths included:', text.includes('API Fast Paths'));
  console.log('Total chars:', text.length);
}).catch(e => console.error(e.message));
" 2>&1
```

Expected: `api_fast_paths included: true`.

**Step 3: Run the full test suite**

```bash
cd "/Users/timcox/squarespace helper" && npm run test 2>&1 | tail -20
```

Expected: All tests pass.

**Step 4: Commit**

```bash
cd "/Users/timcox/squarespace helper" && git add src/automation/browser-agent-prompt.ts && git commit -m "feat: add api_fast_paths prompt section — document API fast paths for browser agent"
```

---

## Integration Check (after both tasks merged)

```bash
cd "/Users/timcox/squarespace helper" && npm run test 2>&1 | tail -10
```

Expected: All tests pass with the new `format-text-block-api.test.ts` tests included.
