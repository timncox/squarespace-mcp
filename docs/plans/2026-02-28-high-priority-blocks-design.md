# High-Priority Block Implementations — Design Doc

**Date:** 2026-02-28
**Status:** Approved
**Scope:** 6 new block types across `api-wishlist.md` High Priority + `block-search.md` High

---

## Blocks to Implement

| Block | Type # | Tier | Structure |
|-------|---------|------|-----------|
| Newsletter | 51 | 1 (known) | `{ alignment, captchaEnabled, captchaTheme, captchaAlignment, description }` |
| Accordion | 69 | 1 (known) | `{ accordionItems: [{ title, description }] }` |
| Scrolling/Marquee | 70 | 1 (known) | `{ marqueeItems: [{ text }], linkTo, waveFrequency, waveIntensity, animationSpeed }` |
| Social Links | 54 | 2 (needs discovery) | `{ iconAlignment, iconSize, iconStyle, iconColor }` + icon array (unknown) |
| Embed (HTML) | 22 | 2 (needs discovery) | `{}` when empty; HTML field name unknown |
| Form | 1337 variant | 2 (needs discovery) | `{ buttonVariant, submissionTextAlignment, firstFieldHighlightType }` + unknown |

---

## Architecture

Each block follows the same **5-file pattern**:

1. **`src/services/content-save.ts`** — `BLOCK_TYPE_X` constant + `addXBlock()` + `updateXBlock()`
2. **`src/services/content-save-types.ts`** — `XBlockAddResult` + `XBlockUpdateResult` interfaces
3. **`src/agents/types.ts`** — `ApiXBlock` interface + type guard + add to `AnyApiBlock` union
4. **`src/services/api-executor.ts`** — case in `executeAddBlock()` switch + `executeModifyBlock()` routing
5. **`src/agents/content-strategist-agent.ts`** — add example to apiBlocks documentation in system prompt

---

## Discovery Design

Before implementing Tier 2 blocks, a discovery agent must:

1. Open Squarespace editor on `grey-yellow-hbxc` test-page via Playwright (existing session)
2. **Social Links (54):** Find block → configure 3 icons (Twitter/Instagram/Facebook) → save
3. **Embed (22):** Find block → paste `<p>Hello World</p>` → save
4. **Form (1337 variant):** Find existing form block → note current value structure
5. Run: `npx tsx scripts/discover-block-types.ts --site grey-yellow-hbxc --page test-page --pageSectionsId 699f3d5bd9db5d1500d60c01`
6. Write discovered JSON structures to `block-search.md` and `data/block-type-discovery.json`

---

## Block Method Signatures

### Newsletter (51)

```typescript
addNewsletterBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  options: {
    description?: string;
    alignment?: 'left' | 'center' | 'right';
    captchaEnabled?: boolean;
    captchaTheme?: string;
    captchaAlignment?: string;
  },
  layout?: BlockLayout
): Promise<NewsletterBlockAddResult>

updateNewsletterBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,          // matches description field via findBlock
  updates: {
    description?: string;
    alignment?: string;
    captchaEnabled?: boolean;
    captchaTheme?: string;
    captchaAlignment?: string;
  }
): Promise<NewsletterBlockUpdateResult>
```

**ApiBlock type:** `{ type: 'newsletter'; description?: string; alignment?: string; captchaEnabled?: boolean }`

### Accordion (69)

```typescript
addAccordionBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  items: Array<{ title: string; description: string }>,
  layout?: BlockLayout
): Promise<AccordionBlockAddResult>

updateAccordionBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,          // matches first item title via findBlock
  updates: { items?: Array<{ title: string; description: string }> }
): Promise<AccordionBlockUpdateResult>
```

**ApiBlock type:** `{ type: 'accordion'; items: Array<{ title: string; description: string }> }`

### Scrolling/Marquee (70)

```typescript
addMarqueeBlock(
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
  layout?: BlockLayout
): Promise<MarqueeBlockAddResult>

updateMarqueeBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,          // matches first marquee item text
  updates: {
    items?: string[];
    waveFrequency?: number;
    waveIntensity?: number;
    animationSpeed?: number;
    linkTo?: string;
  }
): Promise<MarqueeBlockUpdateResult>
```

**ApiBlock type:** `{ type: 'marquee'; items: string[]; waveFrequency?: number; animationSpeed?: number }`

### Social Links (54) — structure from discovery

```typescript
addSocialLinksBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  options: {
    iconAlignment?: string;
    iconSize?: string;
    iconStyle?: string;
    iconColor?: string;
    icons?: Array<unknown>;    // structure from discovery
  },
  layout?: BlockLayout
): Promise<SocialLinksBlockAddResult>

updateSocialLinksBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    iconAlignment?: string;
    iconSize?: string;
    iconStyle?: string;
    iconColor?: string;
  }
): Promise<SocialLinksBlockUpdateResult>
```

**ApiBlock type:** `{ type: 'sociallinks'; iconAlignment?: string; iconSize?: string; iconStyle?: string }`

### Embed (22) — HTML field name from discovery

```typescript
addEmbedBlock(
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  html: string,
  layout?: BlockLayout
): Promise<EmbedBlockAddResult>

updateEmbedBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { html: string }
): Promise<EmbedBlockUpdateResult>
```

**ApiBlock type:** `{ type: 'embed'; html: string }`

### Form (1337 variant) — update-only

Form fields are created via UI; only visual config is settable via API.

```typescript
updateFormBlock(
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    buttonVariant?: string;
    submissionTextAlignment?: string;
    firstFieldHighlightType?: string;
  }
): Promise<FormBlockUpdateResult>
```

**ApiBlock type:** N/A (update-only; no add path)

---

## Agent Team Structure

### Phase 1 — Spawn simultaneously

| Agent | Task |
|-------|------|
| `discovery` | Configure Social Links/Embed/Form in live editor → run discovery script → write structures |
| `worktree-newsletter` | Implement Newsletter block (all 5 files + tests) |
| `worktree-accordion` | Implement Accordion block (all 5 files + tests) |
| `worktree-marquee` | Implement Marquee block (all 5 files + tests) |

### Phase 2 — After discovery signals complete

| Agent | Task |
|-------|------|
| `worktree-sociallinks` | Implement Social Links using discovered structure |
| `worktree-embed` | Implement Embed using discovered HTML field name |
| `worktree-form` | Implement Form updateFormBlock using discovered config fields |

### Merge Plan

Phase 1 merges (sequential, each followed by `npm run test`):
1. `worktree-newsletter` → main
2. `worktree-accordion` → main
3. `worktree-marquee` → main

Phase 2 merges (after discovery + Tier 2 worktrees):
4. `worktree-sociallinks` → main
5. `worktree-embed` → main
6. `worktree-form` → main

Final: update `api-wishlist.md` statuses to ✅ Full or 🔶 Partial.

---

## Tests

Each worktree agent writes tests in the nearest matching test file:
- Newsletter/Accordion/Marquee/Social Links/Embed/Form → `src/services/__tests__/content-save-[blockname].test.ts`
- Tests cover: add block constructs correct JSON, update block finds and patches correctly, edge cases (missing section, invalid search text)

---

## Content Strategist Prompt Updates

Add to the apiBlocks documentation section:

```
Newsletter:    { "type": "newsletter", "description": "Subscribe for updates", "alignment": "center" }
Accordion:     { "type": "accordion", "items": [{ "title": "Q: ...", "description": "A: ..." }] }
Marquee:       { "type": "marquee", "items": ["Sale on now", "Free shipping over $50"] }
Social Links:  { "type": "sociallinks", "iconAlignment": "center", "iconSize": "small" }
Embed:         { "type": "embed", "html": "<script src='...'></script>" }
```
