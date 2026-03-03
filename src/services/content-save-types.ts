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

/**
 * Section divider shape options.
 *
 * Discovered via live API capture (grey-yellow-hbxc, Mar 2026).
 * Lives at `section.divider` (top-level, NOT inside `section.styles`).
 */
export interface SectionDividerOptions {
  enabled: boolean;
  /**
   * Divider shape type.
   * Confirmed value: "pointed". Other expected values: "wave", "slant", "brush", "paint".
   * Omit or set to "none" for no shape.
   */
  type?: string;
  /** Width. Default: { unit: "vw", value: 100 } */
  width?: { unit: string; value: number };
  /** Height. Default: { unit: "vw", value: 12 } */
  height?: { unit: string; value: number };
  /** Flip horizontally */
  isFlipX?: boolean;
  /** Flip vertically */
  isFlipY?: boolean;
  /** Vertical offset */
  offset?: { unit: string; value: number };
  /** Edge stroke / outline */
  stroke?: {
    style?: string;
    color?: { type: string };
    thickness?: { unit: string; value: number };
    dashLength?: { unit: string; value: number };
    gapLength?: { unit: string; value: number };
    linecap?: string;
  };
}

/**
 * Options for editSectionStyle.
 *
 * API field locations (discovered via live capture, grey-yellow-hbxc, Mar 2026):
 * - `section.styles.sectionTheme`     → "white" | "light" | "dark" | "black" | ""
 * - `section.styles.sectionHeight`    → "section-height--small" | "--medium" | "--large" | "--full"
 * - `section.styles.contentWidth`     → "content-width--wide" | "--inset" | "--full"
 * - `section.styles.verticalAlignment`→ "vertical-alignment--top" | "--middle" | "--bottom"
 * - `section.divider`                 → { enabled, type, width, height, ... } (top-level)
 *
 * NOTE: backgroundColor, paddingTop, paddingBottom, blockSpacing are NOT confirmed
 * API fields — they are set at section top-level as a best-effort fallback only.
 */
export interface SectionStyleOptions {
  /** Color theme. Values: "white", "light", "dark", "black", "" (default). Case-insensitive. */
  sectionTheme?: string;
  /**
   * Section height. Pass simplified ("small", "medium", "large", "full") or
   * full CSS class ("section-height--small"). Both are accepted.
   */
  sectionHeight?: string;
  /**
   * Content width. Pass simplified ("inset", "wide", "full") or
   * full CSS class ("content-width--inset"). Both are accepted.
   */
  contentWidth?: string;
  /**
   * Vertical alignment. Pass simplified ("top", "middle", "bottom") or
   * full CSS class ("vertical-alignment--middle"). Both are accepted.
   */
  verticalAlignment?: string;
  /** Section divider. Pass null or { enabled: false } to disable. */
  divider?: SectionDividerOptions | null;
  // ── Legacy / unverified fields ────────────────────────────────────────────
  // These fields are not confirmed in the Squarespace section API. They are
  // written to section top-level as a best-effort; the browser agent handles
  // them via UI automation as a more reliable fallback.
  backgroundColor?: string;
  paddingTop?: string;
  paddingBottom?: string;
  blockSpacing?: string;
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
  publishDate?: string; // ISO 8601 string → converted to publishOn (Unix ms)
  coverImageUrl?: string; // Featured image / thumbnail URL (from sq_upload_image)
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
  /** 'deleted' if DELETE API worked, 'hidden_from_nav' if fallback removed from navigation */
  method?: 'deleted' | 'hidden_from_nav';
  /** Human-readable note about what happened (especially for fallback) */
  note?: string;
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

/** A single form available on the site */
export interface FormInfo {
  id: string;
  name: string;
}

/** Result of listing available forms */
export interface FormListResult {
  success: boolean;
  forms: FormInfo[];
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

// ── Navigation Types ─────────────────────────────────────────────────────────

/** A single navigation item from GET /api/navigation */
export interface NavigationItem {
  id: string;
  title: string;
  urlSlug: string;
  collectionId?: string;
  collectionType?: number;  // 10=page, 1=blog
  enabled?: boolean;
  isDraft?: boolean;
  isFolder?: boolean;
  ordering?: number;
  type?: string;
  children?: NavigationItem[];
}

/** Navigation data from GET /api/navigation */
export interface NavigationData {
  mainNavigation: NavigationItem[];
  notLinked: NavigationItem[];
}

/** Full site settings from GET /api/settings (~63 fields) */
export interface SiteSettings {
  [key: string]: unknown;
  siteTitle?: string;
  siteDescription?: string;
  siteTagLine?: string;
  businessName?: string;
  contactEmail?: string;
  contactPhoneNumber?: string;
  internalContactPhoneNumber?: string;
  internalContactEmail?: string;
  businessHours?: Record<string, unknown>;
  commentsEnabled?: boolean;
  isCookieBannerEnabled?: boolean;
  seoHidden?: boolean;
  homepageTitleFormat?: string;
  collectionTitleFormat?: string;
  announcementBarSettings?: Record<string, unknown>;
}

/** Result of getNavigation() */
export interface NavigationResult {
  success: boolean;
  data?: NavigationData;
  error?: string;
}

/** Result of getSettings() or updateSettings() */
export interface SettingsResult {
  success: boolean;
  data?: SiteSettings;
  updatedFields?: string[];
  error?: string;
}

/** Code injection data (header/footer scripts) */
export interface CodeInjectionData {
  header: string;
  footer: string;
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

// ── Navigation Update Types ─────────────────────────────────────────────────

/** Item in the UpdateNavigation request body */
export interface UpdateNavigationItem {
  title: string;
  urlId: string;
  typeName: string;
  collectionId: string;
  enabled: boolean;
  passwordProtected: boolean;
  collectionType: number;
  isFolder: boolean;
  ordering: number;
  updatedOn: number;
  pagePermissionType: number;
  isDraft: boolean;
  items: UpdateNavigationItem[];
  id: string;
  acceptTypes?: string[];
  metaExcludeTypes?: string[];
  isNavigation?: boolean;
  emptyRegionMessage?: string;
  canAdd?: boolean;
  isCollapsible?: boolean;
  supportsEmptyRegion?: boolean;
}

/** Request body for POST /api/widget/UpdateNavigation */
export interface UpdateNavigationRequest {
  fieldName: string;
  templateId: string;
  navigation: {
    items: UpdateNavigationItem[];
  };
}

/** Result of updateNavigation() */
export interface UpdateNavigationResult {
  success: boolean;
  error?: string;
}

// ── Design Settings Types ───────────────────────────────────────────────────

/** A value with a unit (e.g., { value: 1.2, unit: "em" }) */
export interface UnitValue {
  value: number;
  unit: string;
}

/** Font style properties (used inside MasterFont.fontValue and FontMapping.customFontValue) */
export interface FontValue {
  fontFamily: string;
  fontStyle?: string;   // "normal" | "italic"
  fontWeight?: number;  // 100-900
  textTransform?: string; // "none" | "uppercase" | "lowercase" | "capitalize"
  letterSpacing?: UnitValue;  // e.g., { value: -0.02, unit: "em" }
  lineHeight?: UnitValue;     // e.g., { value: 1.2, unit: "em" }
}

/** Master font definition in a font pack (real API shape from GET /api/website-fonts) */
export interface MasterFont {
  name: string;         // e.g., "heading-font", "body-font", "meta-font"
  fontValue: FontValue; // nested font properties
}

/** Font size definition in a font pack (real API shape) */
export interface MasterSize {
  name: string;       // e.g., "heading-1-size", "normal-text-size"
  value: UnitValue;   // e.g., { value: 4, unit: "rem" }
}

/** Font mapping rule (real API shape) */
export interface FontMapping {
  name: string;              // e.g., "site-title-font", "primary-button-font"
  fontMapping: string;       // references a MasterFont name, e.g., "heading-font"
  sizeMapping: string;       // references a MasterSize name, e.g., "heading-1-size"
  customFontValue?: FontValue; // optional per-mapping font override
  customSizeValue?: UnitValue; // optional per-mapping size override
}

/** Response from GET /api/website-fonts */
export interface WebsiteFontsData {
  name: string;              // font pack name, e.g., "libre-baskerville"
  baseFontSize?: number;     // e.g., 16
  masterFonts: MasterFont[];
  masterSizes: MasterSize[];
  fontMappings: FontMapping[];
}

/** HSL color values */
export interface HSLValues {
  hue: number;
  saturation: number;
  lightness: number;
}

/** Color value in the palette (real API shape: nested value.values) */
export interface PaletteColorValue {
  values: HSLValues;
  userFormat?: string;  // "hex" | "rgb" | "hsl"
}

/** A single palette color entry from GET /api/website-colors */
export interface PaletteColor {
  id: string;                // e.g., "white", "black", "accent", "lightAccent", "darkAccent"
  value: PaletteColorValue;
}

/** A single color mapping within a color theme */
export interface ColorThemeMapping {
  variableName: string;                    // CSS variable, e.g., "paragraphSmallColor"
  paletteColorMapping: {
    colorName: string;                     // references a PaletteColor id, e.g., "black"
    alphaModifier: number;                 // 0-1, typically 1
  };
}

/** Color theme (real API shape from GET /api/website-colors) */
export interface ColorTheme {
  themeName: string;                       // e.g., "white", "dark", "light", "black"
  mappings: ColorThemeMapping[];
}

/** Response from GET /api/website-colors */
export interface WebsiteColorsData {
  palette: PaletteColor[];
  colorThemes: ColorTheme[];
  defaultTheme?: string;
}

/** Result of getWebsiteFonts() */
export interface WebsiteFontsResult {
  success: boolean;
  data?: WebsiteFontsData;
  error?: string;
}

/** Result of getWebsiteColors() */
export interface WebsiteColorsResult {
  success: boolean;
  data?: WebsiteColorsData;
  error?: string;
}

/** Result of getAdvancedSettings() */
export interface AdvancedSettingsResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Result of updateWebsiteFonts() */
export interface WebsiteFontsUpdateResult {
  success: boolean;
  error?: string;
}

/** Result of updateWebsiteColors() */
export interface WebsiteColorsUpdateResult {
  success: boolean;
  data?: WebsiteColorsData;
  error?: string;
}

/** Result of updateFont() convenience helper */
export interface FontUpdateResult {
  success: boolean;
  fontName?: string;
  updatedFields?: string[];
  error?: string;
}

/** Result of updatePaletteColor() convenience helper */
export interface PaletteColorUpdateResult {
  success: boolean;
  colorId?: string;
  oldValues?: HSLValues;
  newValues?: HSLValues;
  error?: string;
}

/** Result of saveAdvancedSettings() */
export interface AdvancedSettingsSaveResult {
  success: boolean;
  error?: string;
}

// ── Template Tweak Settings Types ───────────────────────────────────────────

/** Response from GET /api/template/GetTemplateTweakSettings?version=3 */
export type TemplateTweakSettings = Record<string, string>;

/** Result of getTemplateTweakSettings() */
export interface TemplateTweakSettingsResult {
  success: boolean;
  data?: TemplateTweakSettings;
  error?: string;
}

/** Result of setTemplateTweakSettings() */
export interface TemplateTweakSettingsUpdateResult {
  success: boolean;
  error?: string;
}

