# Content Save Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the 10,781-line `content-save.ts` monolith into ~13 domain files inside a `content-save/` directory with zero consumer changes.

**Architecture:** Convert `ContentSaveClient` from a single file to a directory module. The class definition lives in `index.ts` with core infrastructure. Domain files add methods via TypeScript prototype augmentation + declaration merging. All existing imports resolve unchanged because Node resolves `content-save.js` → `content-save/index.ts`.

**Tech Stack:** TypeScript, ES modules, vitest

**Design doc:** `docs/plans/2026-03-06-content-save-split-design.md`

---

## Pre-flight

Before starting, verify the baseline:

```bash
npm test 2>&1 | tail -5
```

Expected: all 1,343+ tests pass. Note the exact count for comparison after each task.

---

### Task 1: Create directory and move types

**Files:**
- Create: `src/services/content-save/` (directory)
- Move: `src/services/content-save-types.ts` → `src/services/content-save/types.ts`

**Step 1: Create directory and move types file**

```bash
mkdir -p src/services/content-save
git mv src/services/content-save-types.ts src/services/content-save/types.ts
```

**Step 2: Fix the one direct import of content-save-types**

File `src/services/__tests__/content-save-design-nav.test.ts` line 3 imports from `'../content-save-types.js'`. Update to `'../content-save/types.js'`.

**Step 3: Run tests**

```bash
npm test 2>&1 | tail -5
```

Expected: FAIL — `content-save.ts` still imports from `'./content-save-types.js'` which no longer exists. That's expected; we fix it in the next task.

**Step 4: Don't commit yet** — wait for Task 2 (the main file also references the old path).

---

### Task 2: Create index.ts with base class

**Files:**
- Create: `src/services/content-save/index.ts`
- Delete: `src/services/content-save.ts` (after extracting into index.ts)

**Step 1: Create `src/services/content-save/index.ts`**

This file contains:

1. All imports (`fs`, `crypto`, `path`, `logger`, `errMsg`, commerce types)
2. All constants (`SESSION_PATH`, `FETCH_TIMEOUT_MS`, `USER_AGENT`, all `BLOCK_TYPE_*`, `BUTTON_DEFINITION_NAME`, `CODE_BLOCK_ENGINE`, `FORM_BLOCK_DISCRIMINATOR`)
3. The `SessionCookie` interface
4. The `ContentSaveClient` class with:
   - All 7 fields (change `private` → public for: `siteSubdomain`, `siteCookieHeader`, `crumbToken`, `sessionAgeHours`, `sessionLoadedAt`, `websiteIdCache`, `memberAccountIdCache`)
   - `constructor`, `loadSessionCookies`, `reloadSessionCookies`
   - `getPageSections`, `savePageSections` (core read/write — lines 446–535)
   - Infrastructure methods (change `private` → public): `ensureCookies`, `buildApiUrl`, `buildHeaders`, `buildPutUrl`, `isLikelyAuthError`, `enhanceWriteError`, `updateSectionRows`, `findTextBlock`, `stripHtml`, `normalizeSlug`, `fetchAuthenticatedPageHtml`, `formatHtml`
   - Static methods: `checkSessionHealth`, `generateBlockId`, `generateSectionId`, `isButtonBlock`, `getButtonFields`, `setButtonFields`, `buildRichHtml`, `buildSingleElement` (change `private static` → `static`), `escapeHtml` (change `private static` → `static`), `buildTextBlockContent`, `buildEmbedBlockContent`, `buildButtonBlockContent`, `buildImageBlockContent`, `buildVideoBlockContent`, `buildMapBlockContent`
   - Static readonly: `TYPE_NAMES`, `FormattingDefaults`
5. The `createContentSaveClient` factory function
6. Re-export all types from `'./types.js'` (the big `export type { ... }` block — lines 27–145 of old file, updated path)
7. Side-effect imports for domain files (add these as empty initially, uncomment as each domain file is created):

```typescript
// Domain method modules (prototype augmentation)
// Uncomment as each file is created:
// import './text.js';
// import './blocks.js';
// import './block-layout.js';
// import './mobile.js';
// import './sections.js';
// import './header-footer.js';
// import './pages.js';
// import './site.js';
// import './design.js';
// import './gallery.js';
// import './commerce.js';
```

**Key changes from original:**
- `private` fields/methods → public (needed for prototype augmentation access)
- `private static` helpers → `static` (needed for domain files to call them)
- Import path for types: `'./content-save-types.js'` → `'./types.js'`
- Constants and `SessionCookie` interface must be **exported** so domain files can use them (e.g., `BLOCK_TYPE_TEXT`, `FETCH_TIMEOUT_MS`, `USER_AGENT`)

**Step 2: Delete the old file**

```bash
rm src/services/content-save.ts
```

**Step 3: Run tests**

```bash
npm test 2>&1 | tail -5
```

Expected: MANY failures — all the domain methods are missing (they haven't been extracted yet). But import resolution should work (`'../services/content-save.js'` → `content-save/index.ts`). Verify by checking that test errors say "not a function" (methods missing) rather than "cannot find module" (path wrong).

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: create content-save/ directory with base class and types"
```

---

### Task 3: Extract text.ts

**Files:**
- Create: `src/services/content-save/text.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './text.js'`)

**Methods to move (from original line numbers):**
- `updateTextBlock` (537–610)
- `patchTextBlock` (612–695)
- `updateTextBlockHtml` (697–821)
- `replaceTextInHtml` (823–908) — was private
- `tokenizeHtml` (910–936) — was private
- `decodeEntities` (938–955) — was private
- `decodedToRawOffset` (957–984) — was private
- `addTextBlock` (3413–3555)
- `fillLastTextBlockInSection` (6765–6849)

**Pattern for this file (and all subsequent domain files):**

```typescript
import { ContentSaveClient, BLOCK_TYPE_TEXT, FETCH_TIMEOUT_MS } from './index.js';
import type { TextUpdateResult, TextPatchResult, /* etc */ } from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    updateTextBlock(/* params */): Promise<TextUpdateResult>;
    patchTextBlock(/* params */): Promise<TextPatchResult>;
    // ... all method signatures
  }
}

ContentSaveClient.prototype.updateTextBlock = async function (
  this: ContentSaveClient,
  /* params */
): Promise<TextUpdateResult> {
  // exact method body from original, unchanged
  // references to `this.ensureCookies()`, `this.buildHeaders()` etc work because those are now public
};
```

**Private instance methods** (`replaceTextInHtml`, `tokenizeHtml`, `decodeEntities`, `decodedToRawOffset`): Convert to **module-scoped functions** that take the needed args. They don't need `this` access — they're pure string manipulation. Define them as standalone functions in `text.ts` (not on the prototype).

**Step 1: Create `src/services/content-save/text.ts`** with all methods above.

**Step 2: Uncomment `import './text.js';`** in `index.ts`.

**Step 3: Run text-related tests**

```bash
npx vitest run src/services/__tests__/content-save.test.ts src/services/__tests__/content-save-patch.test.ts src/services/__tests__/content-save-rich-html.test.ts src/services/__tests__/content-save-formatting.test.ts src/services/__tests__/content-save-add-block.test.ts 2>&1 | tail -10
```

Expected: All pass.

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract text methods to content-save/text.ts"
```

---

### Task 4: Extract blocks.ts

**Files:**
- Create: `src/services/content-save/blocks.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './blocks.js'`)

**Methods to move:**
- `addButtonBlock` (3572–3731), `updateButtonBlock` (3733–3815)
- `addImageBlock` (3836–3992), `addImageBlockBatch` (3994–4146), `updateImageBlock` (2121–2211)
- `addDividerBlock` (4161–4285)
- `addVideoBlock` (4300–4444), `updateVideoBlock` (4446–4514)
- `addQuoteBlock` (4531–4678), `updateQuoteBlock` (4680–4747)
- `addCodeBlock` (4764–4898), `updateCodeBlock` (4900–4966)
- `addNewsletterBlock` (4981–5140), `updateNewsletterBlock` (5142–5220)
- `addAccordionBlock` (5236–5401), `updateAccordionBlock` (5403–5471)
- `addMarqueeBlock` (5487–5643), `updateMarqueeBlock` (5645–5722)
- `addFormBlock` (5740–5910), `updateFormBlock` (5912–5986), `getAvailableForms` (5988–6025), `createForm` (6027–6082), `getForm` (6084–6111), `updateForm` (6113–6148)
- `addSocialLinksBlock` (6165–6311), `updateSocialLinksBlock` (6313–6398)
- `addEmbedBlock` (6400–6534), `updateEmbedBlock` (6690–6749)
- `addMenuBlock` (6536–6688), `getMenuBlock` (6883–6924), `updateMenuBlock` (6926–6977)
- `addMapBlock` (10545–10672), `updateMapBlock` (10679–10763)

**Step 1: Create `src/services/content-save/blocks.ts`** with all methods above.

**Step 2: Uncomment `import './blocks.js';`** in `index.ts`.

**Step 3: Run block-related tests**

```bash
npx vitest run src/services/__tests__/content-save-button-block.test.ts src/services/__tests__/content-save-image-block.test.ts src/services/__tests__/content-save-simple-blocks.test.ts src/services/__tests__/content-save-quote-code-block.test.ts src/services/__tests__/content-save-divider-video-block.test.ts src/services/__tests__/content-save-form.test.ts src/services/__tests__/content-save-social.test.ts src/services/__tests__/content-save-menu.test.ts src/services/__tests__/content-save-map.test.ts 2>&1 | tail -10
```

Expected: All pass.

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract block methods to content-save/blocks.ts"
```

---

### Task 5: Extract block-layout.ts

**Files:**
- Create: `src/services/content-save/block-layout.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './block-layout.js'`)

**Methods to move:**
- `moveBlock` (1248–1355)
- `swapBlocks` (1357–1408)
- `resizeBlock` (1410–1510)
- `setBlockPosition` (1512–1606)
- `setBlockSize` (1608–1681)
- `removeBlock` (2067–2119)
- `duplicateBlock` (8125–8213)

**Step 1: Create the file with all methods.**

**Step 2: Uncomment import in index.ts.**

**Step 3: Run tests**

```bash
npx vitest run src/services/__tests__/content-save.test.ts 2>&1 | tail -10
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract block layout methods to content-save/block-layout.ts"
```

---

### Task 6: Extract mobile.ts

**Files:**
- Create: `src/services/content-save/mobile.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './mobile.js'`)

**Methods to move:**
- `hideOnMobile` (1691–1730)
- `showOnMobile` (1732–1773)
- `setMobileLayout` (1775–1868)
- `moveBlockMobile` (1870–1969)
- `resizeBlockMobile` (1971–2065)

**Step 1: Create the file.**

**Step 2: Uncomment import.**

**Step 3: Run tests**

```bash
npx vitest run src/services/__tests__/content-save-mobile.test.ts 2>&1 | tail -10
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract mobile methods to content-save/mobile.ts"
```

---

### Task 7: Extract sections.ts

**Files:**
- Create: `src/services/content-save/sections.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './sections.js'`)

**Methods to move:**
- `moveSection` (2213–2297)
- `editSectionStyle` (7837–7970)
- `duplicateSection` (7972–8058)
- `reorderSections` (8060–8123)
- `addBlankSection` (8575–8649)
- `addSectionWithBlocks` (8662–8827)
- `copyTemplateSection` (8840–8893)
- `verifySectionAdded` (8960–8979)
- `updateSectionDivider` (10102–10137)
- `removeSectionDivider` (10142–10175)

**Step 1: Create the file.**

**Step 2: Uncomment import.**

**Step 3: Run tests**

```bash
npx vitest run src/services/__tests__/content-save-sections.test.ts src/services/__tests__/content-save-divider.test.ts 2>&1 | tail -10
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract section methods to content-save/sections.ts"
```

---

### Task 8: Extract header-footer.ts

**Files:**
- Create: `src/services/content-save/header-footer.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './header-footer.js'`)

**Methods to move:**
- `getHeaderFooter` (2311–2360)
- `getFooterSections` (2362–2433)
- `updateFooterTextBlock` (2435–2535)
- `patchFooterTextBlock` (2537–2654)
- `getHeaderSections` (2656–2714)
- `patchHeaderTextBlock` (2716–2823)
- `saveHeaderFooter` (2825–2850)

**Step 1: Create the file.**

**Step 2: Uncomment import.**

**Step 3: Run tests**

```bash
npx vitest run src/services/__tests__/content-save-footer.test.ts 2>&1 | tail -10
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract header/footer methods to content-save/header-footer.ts"
```

---

### Task 9: Extract pages.ts

**Files:**
- Create: `src/services/content-save/pages.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './pages.js'`)

**Methods to move:**
- `getCollectionSettings` (986–1026)
- `getPageIds` (1028–1246)
- `listCollections` (6995–7050) + `TYPE_NAMES` static — note: `TYPE_NAMES` stays in index.ts since it's `static readonly` on the class
- `getPageMetadata` (7052–7082)
- `getCollectionItems` (7084–7142)
- `createPageViaApi` (7144–7284)
- `resolveWebsiteId` (7286–7314) — was private, convert to module-scoped or add to prototype
- `addPageToNavigation` (7316–7358) — was private, same treatment
- `createBlogPost` (7360–7478)
- `updateBlogPost` (7480–7564)
- `findBlogPostByTitle` (7566–7579)
- `deletePageViaApi` (7588–7665)
- `tryHidePageFromNav` (7667–7740) — was private
- `updatePageMetadata` (7742–7827)

**Private methods** (`resolveWebsiteId`, `addPageToNavigation`, `tryHidePageFromNav`): Add to prototype as public (they're only used within pages.ts, but prototype augmentation doesn't support private).

**Step 1: Create the file.**

**Step 2: Uncomment import.**

**Step 3: Run tests**

```bash
npx vitest run src/services/__tests__/content-save-collections.test.ts src/services/__tests__/content-save-page-management.test.ts src/services/__tests__/content-save-blog.test.ts src/services/__tests__/content-save-speculative.test.ts 2>&1 | tail -10
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract page/collection methods to content-save/pages.ts"
```

---

### Task 10: Extract site.ts

**Files:**
- Create: `src/services/content-save/site.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './site.js'`)

**Methods to move:**
- `getSiteIdentity` (2957–3012), `updateSiteIdentity` (3014–3117)
- `getCustomCSS` (2859–2901), `saveCustomCSS` (2903–2947)
- `getSettings` (9384–9413), `updateSettings` (9415–9462)
- `getCodeInjection` (9470–9505), `saveCodeInjection` (9512–9558)
- `getNavigation` (9322–9374), `updateNavigation` (9572–9634)
- `getSocialAccounts` (9976–10007), `addSocialAccount` (10014–10063), `removeSocialAccount` (10070–10094)

**Step 1: Create the file.**

**Step 2: Uncomment import.**

**Step 3: Run tests**

```bash
npx vitest run src/services/__tests__/content-save-navigation-settings.test.ts src/services/__tests__/content-save-social.test.ts 2>&1 | tail -10
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract site/settings methods to content-save/site.ts"
```

---

### Task 11: Extract design.ts

**Files:**
- Create: `src/services/content-save/design.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './design.js'`)

**Methods to move:**
- `getWebsiteFonts` (9642–9664), `updateWebsiteFonts` (9726–9749), `updateFont` (9903–9935)
- `getWebsiteColors` (9670–9692), `updateWebsiteColors` (9755–9782), `updatePaletteColor` (9944–9967)
- `getAdvancedSettings` (9698–9720), `saveAdvancedSettings` (9789–9817)
- `getTemplateTweakSettings` (9823–9845), `setTemplateTweakSettings` (9854–9894)

**Step 1: Create the file.**

**Step 2: Uncomment import.**

**Step 3: Run tests**

```bash
npx vitest run src/services/__tests__/content-save-design.test.ts src/services/__tests__/content-save-design-nav.test.ts 2>&1 | tail -10
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract design methods to content-save/design.ts"
```

---

### Task 12: Extract gallery.ts

**Files:**
- Create: `src/services/content-save/gallery.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './gallery.js'`)

**Methods to move:**
- `updateGallerySettings` (8441–8562)
- `getGalleryItems` (8988–9034), `getGalleryItemCount` (9036–9076)
- `addGalleryImage` (9078–9127), `removeGalleryImage` (9129–9164), `reorderGalleryImages` (9166–9219)
- `uploadImageToSite` (9221–9274), `pollJob` (9276–9313) — was private, convert to module-scoped function
- `getSectionCatalog` (8895–8948)

**Step 1: Create the file.**

**Step 2: Uncomment import.**

**Step 3: Run tests**

```bash
npx vitest run src/services/__tests__/content-save-gallery.test.ts 2>&1 | tail -10
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract gallery methods to content-save/gallery.ts"
```

---

### Task 13: Extract commerce.ts

**Files:**
- Create: `src/services/content-save/commerce.ts`
- Modify: `src/services/content-save/index.ts` (uncomment `import './commerce.js'`)

**Methods to move:**
- `createProductShell` (10183–10235)
- `getProduct` (10238–10256)
- `updateProduct` (10259–10286)
- `deleteProduct` (10289–10310)
- `attachProductImage` (10313–10343)
- `setProductThumbnail` (10346–10375)
- `updateProductImage` (10378–10405)
- `createStorePage` (10411–10473)
- `listProducts` (10476–10500)

**Note:** This file needs `import type { InternalProduct, UpdateProductRequest, AssetReferenceResponse, InternalProductImage, ProductImageUpdateRequest, CommerceResult } from '../internal-commerce-types.js'` — the commerce types live in a separate file already.

**Step 1: Create the file.**

**Step 2: Uncomment import.**

**Step 3: Run tests**

```bash
npx vitest run src/services/__tests__/content-save-commerce.test.ts 2>&1 | tail -10
```

**Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract commerce methods to content-save/commerce.ts"
```

---

### Task 14: Final verification

**Step 1: Run the full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: ALL 1,343+ tests pass. Same count as pre-flight.

**Step 2: Run TypeScript compile**

```bash
npm run build 2>&1 | tail -10
```

Expected: No errors.

**Step 3: Verify the old file is gone**

```bash
ls src/services/content-save.ts 2>&1
```

Expected: "No such file or directory"

**Step 4: Verify directory structure**

```bash
ls -la src/services/content-save/
```

Expected: 13 files (index.ts, types.ts, + 11 domain files).

**Step 5: Verify no stale content-save-types.ts**

```bash
ls src/services/content-save-types.ts 2>&1
```

Expected: "No such file or directory" (moved to content-save/types.ts).

**Step 6: Commit any final cleanup**

```bash
git add -A && git commit -m "refactor: complete content-save.ts split into domain modules"
```

---

## Summary

| Task | File | Est. Lines | Key Risk |
|------|------|-----------|----------|
| 1 | types.ts (move) | 1,220 | Path references |
| 2 | index.ts (base) | ~500 | private → public |
| 3 | text.ts | ~700 | Private HTML helpers → module functions |
| 4 | blocks.ts | ~2,500 | Largest file, many block types |
| 5 | block-layout.ts | ~1,500 | — |
| 6 | mobile.ts | ~400 | — |
| 7 | sections.ts | ~800 | — |
| 8 | header-footer.ts | ~500 | — |
| 9 | pages.ts | ~1,000 | Private methods → prototype |
| 10 | site.ts | ~700 | — |
| 11 | design.ts | ~400 | — |
| 12 | gallery.ts | ~500 | pollJob private → module function |
| 13 | commerce.ts | ~350 | External type import path |
| 14 | Verify | — | Full test suite |
