/**
 * Type definitions for the Squarespace Content Save Service.
 *
 * Extracted from content-save.ts for better navigability.
 * All types are re-exported from content-save.ts for backward compatibility.
 */

// ── Block Layout Types ──────────────────────────────────────────────────────

/** Element descriptor for buildRichHtml() */
export interface RichHtmlElement {
  text: string;
  tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'li';
  style?: Record<string, string>;
  bold?: boolean;
  italic?: boolean;
  link?: { href: string; target?: string };
  className?: string;
}

/** Grid coordinate (column/row position) */
export interface GridCoord { x: number; y: number }

/** Layout for a single breakpoint (mobile or desktop) */
export interface BreakpointLayout {
  start: GridCoord; end: GridCoord;
  verticalAlignment?: string; visible?: boolean; zIndex?: number;
  stickyScroll?: { enabled: boolean; position?: string; offset?: { unit: string; value: number } };
}

/** Full block layout across breakpoints */
export interface BlockLayout { mobile: BreakpointLayout; desktop: BreakpointLayout }

// ── Operation Result Types ──────────────────────────────────────────────────

/** Result of a block move operation */
export interface BlockMoveResult {
  success: boolean; blockId?: string; direction?: string;
  oldPosition?: { desktop: { start: GridCoord; end: GridCoord } };
  newPosition?: { desktop: { start: GridCoord; end: GridCoord } };
  clamped?: boolean; error?: string;
}

/** Result of a block resize operation */
export interface BlockResizeResult {
  success: boolean; blockId?: string;
  oldSize?: { width: number; height: number; desktop: { start: GridCoord; end: GridCoord } };
  newSize?: { width: number; height: number; desktop: { start: GridCoord; end: GridCoord } };
  clamped?: boolean; error?: string;
}

/** Options for removeBlock */
export interface BlockRemoveOptions {
  /** Set sectionHeight: 'auto' on the section after removal. Defaults to true. */
  shrinkSection?: boolean;
}

/** Result of a block remove operation */
export interface BlockRemoveResult {
  success: boolean;
  blockId?: string;
  blockType?: number;
  sectionId?: string;
  error?: string;
}

/** Result of a section move operation */
export interface SectionMoveResult {
  success: boolean;
  sectionId?: string;
  sectionName?: string;
  oldIndex?: number;
  newIndex?: number;
  error?: string;
}

/** Result of an image block update operation */
export interface ImageBlockUpdateResult {
  success: boolean;
  blockId?: string;
  updatedFields?: string[];
  error?: string;
}

/** Result of a footer text update operation */
export interface FooterTextUpdateResult {
  success: boolean;
  blockId?: string;
  oldText?: string;
  newHtml?: string;
  error?: string;
}

/** The site header/footer configuration from GET /api/site-header-footer */
export interface HeaderFooterConfig {
  footer?: {
    pageSectionsId?: string;
    [key: string]: unknown;
  };
  header?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Result of adding a text block to a section */
export interface TextBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of adding a button block to a section */
export interface ButtonBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of adding an image block to a section */
export interface ImageBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of batch-adding image blocks to a section */
export interface ImageBlockBatchResult {
  success: boolean;
  blocks: Array<{ blockId: string; assetUrl: string }>;
  sectionId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of updating a button block */
export interface ButtonBlockUpdateResult {
  success: boolean;
  blockId?: string;
  oldLabel?: string;
  newLabel?: string;
  oldUrl?: string;
  newUrl?: string;
  error?: string;
}

/** Result of filling a placeholder text block in a section */
export interface FillBlockResult {
  success: boolean;
  blockId?: string;
  error?: string;
}

// ── Data Structure Types ────────────────────────────────────────────────────

/**
 * A Fluid Engine grid content item (block within a section).
 *
 * Real structure from GET /api/page-sections:
 * ```json
 * {
 *   "layout": { "mobile": {...}, "desktop": {...} },
 *   "content": {
 *     "value": {
 *       "id": "a7a6278d708bd0f7265c",
 *       "type": 2,
 *       "value": {
 *         "engine": "wysiwyg",
 *         "source": "<p>text</p>",
 *         "html": "<p>text</p>",
 *         "textAttributes": []
 *       },
 *       "containerStyles": {...}
 *     }
 *   }
 * }
 * ```
 */
export interface GridContent {
  layout?: BlockLayout;
  content: {
    value: {
      id: string;
      type: number; // 2 = text/html, 1337 = image, etc.
      value?: {
        engine?: string;
        source?: string;
        html?: string;
        textAttributes?: unknown[];
        text?: string;
        label?: string;
        title?: string;
        description?: string;
        subtitle?: string;
        [key: string]: unknown;
      };
      containerStyles?: unknown;
      [key: string]: unknown;
    };
  };
  [key: string]: unknown;
}

/** Grid settings within a section's fluidEngineContext */
export interface GridSettings {
  breakpointSettings?: {
    desktop?: { columns?: number };
    mobile?: { columns?: number };
  };
}

/** A section in the page-sections data */
export interface PageSection {
  id: string;
  sectionName: string;
  fluidEngineContext?: {
    gridContents: GridContent[];
    gridSettings?: GridSettings;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** The full page-sections payload (sent and received on PUT) */
export interface PageSectionsData {
  id?: string;
  websiteId?: string;
  collectionId?: string;
  sections: PageSection[];
  updatedOn?: number;
  [key: string]: unknown;
}

/** Result of a content save operation */
export interface ContentSaveResult {
  success: boolean;
  pageSectionsId: string;
  collectionId: string;
  sectionsCount: number;
  error?: string;
}

/** Result of a menu block update operation */
export interface MenuBlockUpdateResult {
  success: boolean;
  blockId?: string;
  sectionId?: string;
  oldTabCount?: number;
  newTabCount?: number;
  oldItemCount?: number;
  newItemCount?: number;
  error?: string;
}

/** Result of a text block update */
export interface TextUpdateResult {
  success: boolean;
  blockId?: string;
  oldText?: string;
  newHtml?: string;
  error?: string;
}

/** Result of a surgical text patch (substring replacement within a block) */
export interface TextPatchResult {
  success: boolean;
  blockId?: string;
  patchedSegment?: string;
  oldText?: string;
  error?: string;
}

// ── Gallery Types ───────────────────────────────────────────────────────────

/** Gallery display settings (type 8 block properties) */
export interface GallerySettings {
  'thumbnails-per-row'?: number;
  'aspect-ratio'?: string;
  design?: string;
  padding?: number;
  lightbox?: boolean;
  'auto-crop'?: boolean;
  'square-thumbs'?: boolean;
  'show-meta'?: boolean;
  'show-meta-basic'?: boolean;
  'show-meta-only-title'?: boolean;
  'show-meta-only-description'?: boolean;
}

/** Result of updating gallery settings */
export interface GallerySettingsUpdateResult {
  success: boolean;
  blockId?: string;
  updatedFields?: string[];
  error?: string;
}

/** Result of adding an image to a gallery */
export interface AddGalleryImageResult {
  success: boolean;
  itemId?: string;
  error?: string;
}

/** Gallery collection item */
export interface GalleryItem {
  id: string;
  title?: string;
  description?: string;
  assetUrl?: string;
  [key: string]: unknown;
}

// ── Section API Types ───────────────────────────────────────────────────────

/** Result of adding a blank section via API */
export interface AddBlankSectionResult {
  success: boolean;
  sectionId?: string;
  error?: string;
}

/** Result of copying a template section via API */
export interface CopyTemplateSectionResult {
  success: boolean;
  sectionId?: string;
  sectionData?: unknown;
  error?: string;
}

/** Section catalog entry from GET /api/section-catalog/sections */
export interface SectionCatalogEntry {
  websiteId: string;
  collectionId: string;
  sectionId: string;
  taxonomy?: { tags?: string[]; categories?: string[] };
  catalogWebsiteRev?: number;
  componentReplacements?: unknown[];
  [key: string]: unknown;
}

/** Section catalog response — keyed by category (e.g., "CONTACT", "MENUS") */
export interface SectionCatalogResponse {
  success: boolean;
  /** Category → entries map (e.g., { "CONTACT": [...], "MENUS": [...] }) */
  catalog?: Record<string, SectionCatalogEntry[]>;
  /** Flattened array of all entries across categories */
  sections?: SectionCatalogEntry[];
  /** Category names */
  categories?: string[];
  error?: string;
}

/** Options for editSectionStyle */
export interface SectionStyleOptions {
  sectionTheme?: string;
  backgroundColor?: string;
  sectionHeight?: 'auto' | 'small' | 'medium' | 'large' | 'full';
  paddingTop?: string;
  paddingBottom?: string;
  blockSpacing?: string;
  contentWidth?: 'inset' | 'full';
  verticalAlignment?: 'top' | 'middle' | 'bottom';
}

/** Result of editSectionStyle */
export interface SectionStyleResult {
  success: boolean;
  sectionId?: string;
  sectionIndex?: number;
  updatedFields?: string[];
  error?: string;
}

/** Result of duplicateSection */
export interface SectionDuplicateResult {
  success: boolean;
  originalSectionId?: string;
  newSectionId?: string;
  newSectionIndex?: number;
  error?: string;
}

/** Result of reorderSections */
export interface SectionReorderResult {
  success: boolean;
  newOrder?: number[];
  sectionsCount?: number;
  error?: string;
}

/** Result of duplicateBlock */
export interface BlockDuplicateResult {
  success: boolean;
  originalBlockId?: string;
  newBlockId?: string;
  sectionId?: string;
  error?: string;
}

// ── Collection/Page Types ───────────────────────────────────────────────────

/** Collection info from GetCollections API */
export interface CollectionInfo {
  id: string;
  urlId: string;
  title: string;
  type: number;
  typeName: string;
  itemCount?: number;
  enabled?: boolean;
  ordering?: number;
  navigationTitle?: string;
  description?: string;
}

/** Page metadata (enriched collection info) */
export interface PageMetadata {
  collectionId: string;
  urlId: string;
  title: string;
  type: number;
  typeName: string;
  enabled?: boolean;
  navigationTitle?: string;
}

/** Collection item (blog post, gallery item, etc.) */
export interface CollectionItem {
  id: string;
  title: string;
  urlId?: string;
  body?: string;
  excerpt?: string;
  status?: string;
  publishOn?: number;
  updatedOn?: number;
  tags?: string[];
  categories?: string[];
  [key: string]: unknown;
}

/** Options for getCollectionItems */
export interface CollectionItemsOptions {
  limit?: number;
  offset?: number;
  filter?: 'published' | 'draft' | 'all';
}

/** Result of getCollectionItems */
export interface CollectionItemsResult {
  success: boolean;
  items?: CollectionItem[];
  total?: number;
  error?: string;
}

// ── Page/Blog Creation Types ────────────────────────────────────────────────

/** Result of createPageViaApi */
export interface PageCreateResult {
  success: boolean;
  pageId?: string;
  urlId?: string;
  endpointAvailable: boolean;
  error?: string;
}

/** Result of createBlogPost */
export interface BlogPostCreateResult {
  success: boolean;
  itemId?: string;
  urlId?: string;
  endpointAvailable: boolean;
  error?: string;
}

/** Options for updateBlogPost */
export interface BlogPostUpdateOptions {
  title?: string;
  body?: string;
  excerpt?: string;
  tags?: string[];
  categories?: string[];
  urlId?: string;
  draft?: boolean;
}

/** Result of updateBlogPost */
export interface BlogPostUpdateResult {
  success: boolean;
  itemId: string;
  updatedFields: string[];
  error?: string;
}

// ── Page Deletion/Update Types ──────────────────────────────────────────────

/** Result of deletePageViaApi */
export interface PageDeleteResult {
  success: boolean;
  collectionId?: string;
  error?: string;
}

/** Options for updatePageMetadata */
export interface PageMetadataUpdateOptions {
  title?: string;
  urlId?: string;
  description?: string;
  seoTitle?: string;
  seoDescription?: string;
  navigationTitle?: string;
  enabled?: boolean;
}

/** Result of updatePageMetadata */
export interface PageMetadataUpdateResult {
  success: boolean;
  collectionId?: string;
  updatedFields?: string[];
  error?: string;
}

// ── New Block Type Results ──────────────────────────────────────────────────

/** Result of adding a quote block */
export interface QuoteBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of updating a quote block */
export interface QuoteBlockUpdateResult {
  success: boolean;
  blockId?: string;
  oldQuote?: string;
  newQuote?: string;
  error?: string;
}

/** Result of adding a code block */
export interface CodeBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of updating a code block */
export interface CodeBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}

/** Result of adding a divider block */
export interface DividerBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of adding a video block */
export interface VideoBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of updating a video block */
export interface VideoBlockUpdateResult {
  success: boolean;
  blockId?: string;
  updatedFields?: string[];
  error?: string;
}

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

/** Result of adding a marquee (scrolling text) block */
export interface MarqueeBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of updating a marquee block */
export interface MarqueeBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}

/** Result of adding a form block */
export interface FormBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  error?: string;
}

/** Result of updating a form block */
export interface FormBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}

/** Result of adding a social links block */
export interface SocialLinksBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  sectionId?: string;
  error?: string;
}

/** Result of updating a social links block */
export interface SocialLinksBlockUpdateResult {
  success: boolean;
  blockId?: string;
  updatedFields?: string[];
  error?: string;
}

/** Result of adding an embed block */
export interface EmbedBlockAddResult {
  success: boolean;
  blockId?: string;
  sectionIndex?: number;
  sectionId?: string;
  error?: string;
}

/** Result of updating an embed block */
export interface EmbedBlockUpdateResult {
  success: boolean;
  blockId?: string;
  error?: string;
}

// ── Mobile Layout Types ──────────────────────────────────────────────────────

/** Result of hiding or showing a block on mobile */
export interface MobileVisibilityResult {
  success: boolean;
  blockId?: string;
  /** The new visibility state (false = hidden, true = visible) */
  visible?: boolean;
  error?: string;
}

/** Result of setting a block's mobile layout (position, size, or visibility) */
export interface MobileLayoutSetResult {
  success: boolean;
  blockId?: string;
  oldLayout?: { start: GridCoord; end: GridCoord; visible?: boolean };
  newLayout?: { start: GridCoord; end: GridCoord; visible?: boolean };
  clamped?: boolean;
  error?: string;
}

/** Result of moving a block on the mobile grid */
export interface MobileMoveResult {
  success: boolean;
  blockId?: string;
  direction?: string;
  oldPosition?: { mobile: { start: GridCoord; end: GridCoord } };
  newPosition?: { mobile: { start: GridCoord; end: GridCoord } };
  clamped?: boolean;
  error?: string;
}

/** Result of resizing a block on the mobile grid */
export interface MobileResizeResult {
  success: boolean;
  blockId?: string;
  oldSize?: { width: number; height: number; mobile: { start: GridCoord; end: GridCoord } };
  newSize?: { width: number; height: number; mobile: { start: GridCoord; end: GridCoord } };
  clamped?: boolean;
  error?: string;
}

// ── Site Identity Types ──────────────────────────────────────────────────────

/** Site identity data from GET /api/rest/websites/mine and GET /api/settings */
export interface SiteIdentityData {
  businessName?: string;   // location.addressTitle
  address?: string;        // location.addressLine1
  address2?: string;       // location.addressLine2
  phone?: string;          // internalContactPhoneNumber (from /api/settings)
  email?: string;          // internalContactEmail (from /api/settings)
  siteTitle?: string;      // siteTitle (from /api/rest/websites/mine)
}

/** Options for updateSiteIdentity */
export interface SiteIdentityUpdateOptions {
  businessName?: string;
  address?: string;
  address2?: string;
  phone?: string;
  email?: string;
  siteTitle?: string;
}

/** Result of getSiteIdentity or updateSiteIdentity */
export interface SiteIdentityResult {
  success: boolean;
  data?: SiteIdentityData;
  updatedFields?: string[];
  error?: string;
}

