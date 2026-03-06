# Design: Split content-save.ts into Domain Modules

## Problem

`src/services/content-save.ts` is 10,781 lines with 125 methods in a single `ContentSaveClient` class. It's the biggest file in the codebase and hard to navigate/maintain.

## Solution

Convert `content-save.ts` into a `content-save/` directory. The class stays as one class — methods get distributed across domain files using TypeScript prototype augmentation + declaration merging.

## Directory Structure

```
src/services/content-save/
  index.ts              (~500 lines)  Base class + infrastructure + side-effect imports
  types.ts              (1,220 lines) Moved from content-save-types.ts (rename only)
  text.ts               (~700 lines)  Text block CRUD + HTML helpers
  blocks.ts             (~2,500 lines) Add/update for all non-text block types
  block-layout.ts       (~1,500 lines) Move, swap, resize, position, remove, duplicate blocks
  mobile.ts             (~400 lines)  Mobile visibility, layout, move, resize
  sections.ts           (~800 lines)  Section style, duplicate, reorder, add, copy template, dividers
  header-footer.ts      (~500 lines)  Header/footer get/update/patch
  pages.ts              (~1,000 lines) Collections, page CRUD, blog posts
  site.ts               (~700 lines)  Settings, identity, CSS, code injection, navigation, social accounts
  design.ts             (~400 lines)  Fonts, colors, tweaks, advanced settings
  gallery.ts            (~500 lines)  Gallery items, images, upload, section catalog
  commerce.ts           (~350 lines)  Products, store page, product images
```

## Mechanism: Prototype Augmentation + Declaration Merging

Each domain file follows this pattern:

```typescript
// text.ts
import { ContentSaveClient } from './index.js';
import type { TextUpdateResult } from './types.js';

declare module './index.js' {
  interface ContentSaveClient {
    updateTextBlock(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      newText: string,
    ): Promise<TextUpdateResult>;
  }
}

ContentSaveClient.prototype.updateTextBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  newText: string,
): Promise<TextUpdateResult> {
  // exact same implementation, unchanged
};
```

The base `index.ts` imports each domain file for side effects:

```typescript
// index.ts (at the bottom, after class definition)
import './text.js';
import './blocks.js';
import './block-layout.js';
import './mobile.js';
import './sections.js';
import './header-footer.js';
import './pages.js';
import './site.js';
import './design.js';
import './gallery.js';
import './commerce.js';

export { ContentSaveClient, createContentSaveClient };
```

## What Lives in index.ts (Base Class)

### Private fields
- siteSubdomain, siteCookieHeader, crumbToken, sessionAgeHours, sessionLoadedAt
- websiteIdCache, memberAccountIdCache

### Constructor + session management
- constructor(siteSubdomain)
- loadSessionCookies(), reloadSessionCookies()

### Core read/write
- getPageSections(), savePageSections()

### Infrastructure (used by domain files)
- ensureCookies(), buildApiUrl(), buildHeaders(), buildPutUrl()
- isLikelyAuthError(), enhanceWriteError()
- updateSectionRows(), findTextBlock(), stripHtml(), normalizeSlug()
- fetchAuthenticatedPageHtml()

### Static helpers
- generateSectionId(), generateBlockId()
- buildSingleElement(), escapeHtml()
- checkSessionHealth() (if it exists)
- TYPE_NAMES map
- buildMapBlockContent()

### Constants
- All BLOCK_TYPE_* constants
- SESSION_PATH, FETCH_TIMEOUT_MS, USER_AGENT
- BUTTON_DEFINITION_NAME, CODE_BLOCK_ENGINE, FORM_BLOCK_DISCRIMINATOR

### Factory
- createContentSaveClient()

### Re-exports
- All types from ./types.js (backward compat)

## Method-to-File Mapping

### text.ts
- updateTextBlock, patchTextBlock, updateTextBlockHtml
- replaceTextInHtml (private), tokenizeHtml (private), decodeEntities (private), decodedToRawOffset (private)
- addTextBlock, fillLastTextBlockInSection

### blocks.ts
- addButtonBlock, updateButtonBlock
- addImageBlock, addImageBlockBatch, updateImageBlock
- addDividerBlock
- addVideoBlock, updateVideoBlock
- addQuoteBlock, updateQuoteBlock
- addCodeBlock, updateCodeBlock
- addNewsletterBlock, updateNewsletterBlock
- addAccordionBlock, updateAccordionBlock
- addMarqueeBlock, updateMarqueeBlock
- addFormBlock, updateFormBlock, getAvailableForms, createForm, getForm, updateForm
- addSocialLinksBlock, updateSocialLinksBlock
- addEmbedBlock, updateEmbedBlock
- addMenuBlock, getMenuBlock, updateMenuBlock
- addMapBlock, updateMapBlock

### block-layout.ts
- moveBlock, swapBlocks, resizeBlock
- setBlockPosition, setBlockSize
- removeBlock, duplicateBlock

### mobile.ts
- hideOnMobile, showOnMobile
- setMobileLayout, moveBlockMobile, resizeBlockMobile

### sections.ts
- moveSection, editSectionStyle
- duplicateSection, reorderSections
- addBlankSection, addSectionWithBlocks
- copyTemplateSection, verifySectionAdded
- updateSectionDivider, removeSectionDivider

### header-footer.ts
- getHeaderFooter, saveHeaderFooter
- getFooterSections, updateFooterTextBlock, patchFooterTextBlock
- getHeaderSections, patchHeaderTextBlock

### pages.ts
- getCollectionSettings, getPageIds
- listCollections, getPageMetadata, getCollectionItems
- createPageViaApi, resolveWebsiteId (private), addPageToNavigation (private)
- createBlogPost, updateBlogPost, findBlogPostByTitle
- deletePageViaApi, tryHidePageFromNav (private)
- updatePageMetadata

### site.ts
- getSiteIdentity, updateSiteIdentity
- getSettings, updateSettings
- getCustomCSS, saveCustomCSS
- getCodeInjection, saveCodeInjection
- getNavigation, updateNavigation
- getSocialAccounts, addSocialAccount, removeSocialAccount

### design.ts
- getWebsiteFonts, updateWebsiteFonts, updateFont
- getWebsiteColors, updateWebsiteColors, updatePaletteColor
- getAdvancedSettings, saveAdvancedSettings
- getTemplateTweakSettings, setTemplateTweakSettings

### gallery.ts
- updateGallerySettings
- getGalleryItems, getGalleryItemCount
- addGalleryImage, removeGalleryImage, reorderGalleryImages
- uploadImageToSite, pollJob (private)
- getSectionCatalog

### commerce.ts
- createProductShell, getProduct, updateProduct, deleteProduct
- attachProductImage, setProductThumbnail, updateProductImage
- createStorePage, listProducts

## Consumer Impact

**Zero changes required.** All existing imports resolve correctly:

```typescript
// Before and after — identical import path
import { ContentSaveClient } from '../services/content-save.js';
import { createContentSaveClient } from '../services/content-save.js';
import type { PageSection, GridContent } from '../services/content-save.js';
```

Node/TypeScript resolves `content-save.js` → `content-save/index.ts` automatically.

## Visibility

Domain files need access to private infrastructure methods (ensureCookies, buildHeaders, etc.). Since prototype augmentation can't access TypeScript `private` fields, the base class fields/methods used by domain files must be non-private. Options:

1. **Make them public** — simplest, they're internal-only anyway (no external consumers)
2. **Use `protected`** — doesn't work with prototype augmentation (not subclassing)

Decision: Make shared infrastructure methods and fields **public**. They were only "private" by convention — the class is never instantiated outside `createContentSaveClient()`.

## Migration Steps

1. Create `src/services/content-save/` directory
2. Move `content-save-types.ts` → `content-save/types.ts`
3. Create `content-save/index.ts` with base class + constants + infrastructure
4. Create each domain file, moving methods from the original
5. Delete original `content-save.ts`
6. Update `content-save-types.ts` import path in any file that imported it directly
7. Run tests — all 1,343 should pass with no changes
8. Delete empty `content-save.ts` if not already removed

## Risks

- **Private → public fields**: Low risk. No external consumers access the class directly.
- **Circular imports**: `index.ts` imports domain files, domain files import from `index.ts`. This is safe because domain files only use the class at prototype-assignment time (not at import time), and the class is fully defined before side-effect imports run.
- **`this` binding**: All prototype methods must use `function()` not arrow functions (arrow functions don't bind `this`).
