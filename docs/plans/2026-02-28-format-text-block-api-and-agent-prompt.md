# Design: formatTextBlock API Fast Path + Browser Agent Prompt API Guidance

**Date:** 2026-02-28
**Status:** Approved

---

## Problem

1. `formatTextBlock` uses 9-step UI automation even for simple heading/bold/italic/alignment changes that could be done in ~100ms via the Content Save API.
2. The browser agent prompt has no documentation of which actions have API fast paths, so the agent can't reason about when to expect API calls vs UI automation.

---

## Solution

### Part 1: formatTextBlock API Fast Path

**Scope:** Handle `heading1–4`, `bold`, `italic`, `alignment` via API. Fall through to UI for `paragraph1–3`, `monospace`, `fontSize` (class names unverified / no clean API mapping).

**New pieces:**

1. **`applyFormattingToHtml(html, opts)`** — pure helper in `handler-utils.ts`
   - Parses block-level HTML elements (`<p>`, `<h1>`–`<h6>`, `<div>`)
   - Applies per-element: tag replacement (headings), inline wrapping (`<strong>`, `<em>`), style attribute (`text-align`)
   - Returns transformed HTML
   - Fully testable without a browser

2. **`tryFormatTextBlockApi(page, action)`** — in `handler-utils.ts`
   - Follows exact `extractApiContext` → read → transform → `updateTextBlockHtml` → return pattern
   - Returns `ActionResult` on success, `null` on failure (falls through to UI)

3. **Modified `handleFormatTextBlock()`** in `text-editing-handlers.ts`
   - Calls `tryFormatTextBlockApi()` first for eligible format types
   - Falls through to existing 9-step UI path on null return

**API-eligible:** `formatLevel` in `{heading1, heading2, heading3, heading4}`, `bold`, `italic`, `alignment`
**UI-only:** `paragraph1–3`, `monospace`, `fontSize`

---

### Part 2: Browser Agent Prompt — API Fast Paths Section

**New `PromptSection`** in `PROMPT_SECTIONS` array in `browser-agent-prompt.ts`:

```
id: 'api_fast_paths'
category: 'interaction_pattern'
minHighConfToReduce: 3
removable: false
```

**Content:** One-sentence principle ("The system always tries the Content Save API before UI automation for the actions below") + table:

| Action | API method | What it skips |
|---|---|---|
| `editTextBlock` | `updateTextBlock` / `patchTextBlock` | 10-step UI automation |
| `formatTextBlock` | `tryFormatTextBlockApi` (headings/bold/italic/align) | 9-step UI automation |
| `moveBlockInSection` | `moveBlock` | Arrow keys / drag handle |
| `resizeBlock` | `resizeBlock` | Drag edge handles |
| `removeBlock` | `removeBlock` | 6-step UI compound |
| `moveSectionUp/Down` | `moveSection` | Section toolbar arrows |
| `replaceImage` / `addImageBlock` | `updateImageBlock` | 7-step UI compound |
| `editMenuBlock` | `updateMenuBlock` | 8-step UI automation |
| `editButtonBlock` | `updateButtonBlock` | 5-step UI automation |
| `editQuoteBlock` | `updateQuoteBlock` | UI toolbar |
| `editCodeBlock` | `updateCodeBlock` | UI editor |
| `editSectionStyle` | `editSectionStyle` | 15–20 step UI automation |

---

## File Changes

### Part 1 (formatTextBlock)
- `src/automation/actions/handler-utils.ts` — add `applyFormattingToHtml()` + `tryFormatTextBlockApi()`
- `src/automation/actions/text-editing-handlers.ts` — call `tryFormatTextBlockApi()` at top of `handleFormatTextBlock()`
- `src/automation/actions/__tests__/` — unit tests for `applyFormattingToHtml()`

### Part 2 (prompt)
- `src/automation/browser-agent-prompt.ts` — add new `api_fast_paths` PromptSection

---

## Team Structure

Two fully independent worktrees running in parallel:
- **Agent A:** Part 1 (formatTextBlock API path + tests)
- **Agent B:** Part 2 (browser-agent-prompt.ts changes)
