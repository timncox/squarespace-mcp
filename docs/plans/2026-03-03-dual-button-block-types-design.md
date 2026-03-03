# Dual Button Block Type Support

**Date**: 2026-03-03
**Status**: Approved

## Problem

Squarespace has TWO button block formats:
- **Type 46 (legacy)**: `{ type: 46, value: { label, url } }` — what the codebase currently handles
- **Type 1337 (new)**: `{ type: 1337, definitionName: "website.components.button", value: { buttonText, buttonLink, buttonSize, buttonAlignment, buttonStyle?, buttonVariant?, newWindow } }` — what templates and the current editor produce

The codebase only supports type 46. Type 1337 buttons from template-copied sections are invisible to `findBlock()`, rejected by `updateButtonBlock()`, and cannot be created by `addButtonBlock()`.

## Design Decision

**Type 1337 is the primary format.** All new button creation uses it. Type 46 is legacy — we read and update it, but never create new ones.

## Approach: Unified Normalization Layer

Three helper functions in `content-save.ts` abstract over both types:

```typescript
isButtonBlock(block): boolean
// true for type 46 OR (type 1337 + definitionName === "website.components.button")

getButtonFields(block): { text, url, size?, style?, alignment?, variant?, newWindow? }
// Normalizes type 46 { label, url } and type 1337 { buttonText, buttonLink, ... }

setButtonFields(block, updates): void
// Writes to correct fields based on detected type
```

## Changes by File

### content-save.ts
- Add `BLOCK_TYPE_BUTTON_NEW = 1337` constant (disambiguated from image/code via `definitionName`)
- Add `isButtonBlock()`, `getButtonFields()`, `setButtonFields()` helpers
- `findBlock()`: explicit button branch before generic fallback — checks both `value.label` (46) and `value.buttonText` (1337)
- `updateButtonBlock()`: use `isButtonBlock()` + `setButtonFields()`, accept design fields (size, style, alignment, variant)
- `addButtonBlock()`: rewrite to create type 1337 by default with `transforms`, `containerStyles`, `definitionName` from baseline template

### types.ts (actions)
- `editButtonBlock` action: add `variant?: 'solid' | 'outline'`

### types.ts (agents)
- `ApiButtonBlock`: add size, style, alignment, variant, newWindow
- `BlockReplacementOptions.buttons`: add size, style, alignment, variant

### handler-utils.ts
- `tryButtonBlockApi()`: pass design fields through to `updateButtonBlock()`

### api-executor.ts
- Pass design fields when calling addButtonBlock/updateButtonBlock

### browser-agent-prompt.ts
- Add `variant: 'solid' | 'outline'` to editButtonBlock documentation

### Tests
- Type 1337 variants of findBlock, updateButtonBlock, addButtonBlock tests
- Normalization helper unit tests
- Mixed-type scenarios

## Out of Scope
- No migration of existing type 46 blocks to 1337
- No type conversion methods
- No changes to template fast path (already copies type 1337)
- No changes to `removeBlock()` (type-agnostic)
- No changes to `handleEditButtonBlock()` UI automation (works for both types already)
