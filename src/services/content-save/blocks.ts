import { randomBytes } from 'crypto';
import {
  ContentSaveClient,
  BLOCK_TYPE_IMAGE,
  BLOCK_TYPE_DIVIDER,
  BLOCK_TYPE_VIDEO,
  BLOCK_TYPE_QUOTE,
  BLOCK_TYPE_CODE,
  CODE_BLOCK_ENGINE,
  BLOCK_TYPE_NEWSLETTER,
  BLOCK_TYPE_ACCORDION,
  BLOCK_TYPE_MARQUEE,
  BLOCK_TYPE_SOCIAL_LINKS,
  BLOCK_TYPE_EMBED,
  BLOCK_TYPE_MENU,
  BLOCK_TYPE_AUDIO,
  BLOCK_TYPE_PAGE_LINK,
  BLOCK_TYPE_HORIZONTAL_RULE,
  BLOCK_TYPE_MARKDOWN,
  BLOCK_TYPE_SUMMARY,
  PRODUCT_DEFINITION_NAME,
  BUTTON_DEFINITION_NAME,
  FORM_BLOCK_DISCRIMINATOR,
  FETCH_TIMEOUT_MS,
} from './client.js';
import type {
  GridContent,
  PageSection,
  ImageBlockUpdateResult,
  ButtonBlockAddResult,
  ButtonBlockUpdateResult,
  ImageBlockAddResult,
  ImageBlockBatchResult,
  DividerBlockAddResult,
  VideoBlockAddResult,
  VideoBlockUpdateResult,
  QuoteBlockAddResult,
  QuoteBlockUpdateResult,
  CodeBlockAddResult,
  CodeBlockUpdateResult,
  NewsletterBlockAddResult,
  NewsletterBlockUpdateResult,
  AccordionBlockAddResult,
  AccordionBlockUpdateResult,
  MarqueeBlockAddResult,
  MarqueeBlockUpdateResult,
  FormBlockAddResult,
  FormBlockUpdateResult,
  FormListResult,
  FormCreateResult,
  FormGetResult,
  FormUpdateResult,
  SocialLinksBlockAddResult,
  SocialLinksBlockUpdateResult,
  EmbedBlockAddResult,
  EmbedBlockUpdateResult,
  MenuBlockAddResult,
  MenuBlockUpdateResult,
  MapBlockAddResult,
  MapBlockUpdateResult,
  AudioBlockAddResult,
  AudioBlockUpdateResult,
  PageLinkBlockAddResult,
  PageLinkBlockUpdateResult,
  HorizontalRuleBlockAddResult,
  SearchBlockAddResult,
  SearchBlockUpdateResult,
  MarkdownBlockAddResult,
  MarkdownBlockUpdateResult,
  SummaryBlockAddResult,
  SummaryBlockUpdateResult,
  ProductBlockAddResult,
  ProductBlockUpdateResult,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    updateImageBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      fields: { title?: string; description?: string; subtitle?: string; altText?: string; linkTo?: string; assetUrl?: string },
    ): Promise<ImageBlockUpdateResult>;
    addButtonBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      label: string, url: string,
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
      design?: { size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean },
    ): Promise<ButtonBlockAddResult>;
    updateButtonBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { newLabel?: string; url?: string; size?: string; style?: string; alignment?: string; variant?: string; newWindow?: boolean },
    ): Promise<ButtonBlockUpdateResult>;
    addImageBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number, assetUrl: string,
      options?: { altText?: string; title?: string; description?: string; subtitle?: string; linkTo?: string; layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number } },
    ): Promise<ImageBlockAddResult>;
    addImageBlockBatch(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      images: Array<{ assetUrl: string; altText?: string; title?: string; layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number } }>,
    ): Promise<ImageBlockBatchResult>;
    addDividerBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<DividerBlockAddResult>;
    addVideoBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number, videoUrl: string,
      options?: { title?: string; description?: string; layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number } },
    ): Promise<VideoBlockAddResult>;
    updateVideoBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { url?: string; title?: string; description?: string },
    ): Promise<VideoBlockUpdateResult>;
    addQuoteBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      quoteText: string, attribution?: string,
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<QuoteBlockAddResult>;
    updateQuoteBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { quoteText?: string; attribution?: string },
    ): Promise<QuoteBlockUpdateResult>;
    addCodeBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      code: string, language?: string,
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<CodeBlockAddResult>;
    updateCodeBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { code?: string; language?: string },
    ): Promise<CodeBlockUpdateResult>;
    addNewsletterBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      options?: { description?: string; alignment?: string; captchaEnabled?: boolean; captchaTheme?: number; captchaAlignment?: number; submitButtonText?: string; title?: string },
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<NewsletterBlockAddResult>;
    updateNewsletterBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { description?: string; alignment?: string; captchaEnabled?: boolean; submitButtonText?: string; title?: string },
    ): Promise<NewsletterBlockUpdateResult>;
    addAccordionBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      items: Array<{ title: string; description: string }>,
      options?: { isExpandedFirstItem?: boolean; shouldAllowMultipleOpenItems?: boolean },
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<AccordionBlockAddResult>;
    updateAccordionBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { items?: Array<{ title: string; description: string }>; isExpandedFirstItem?: boolean; shouldAllowMultipleOpenItems?: boolean },
    ): Promise<AccordionBlockUpdateResult>;
    addMarqueeBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      items: Array<{ text: string; linkTo?: string }>,
      options?: { animationDirection?: 'left' | 'right'; animationSpeed?: number; textStyle?: string; pausedOnHover?: boolean; fadeEdges?: boolean; waveFrequency?: number; waveIntensity?: number },
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<MarqueeBlockAddResult>;
    updateMarqueeBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { items?: Array<{ text: string; linkTo?: string }>; animationDirection?: 'left' | 'right'; animationSpeed?: number; textStyle?: string; pausedOnHover?: boolean },
    ): Promise<MarqueeBlockUpdateResult>;
    addFormBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number, formId: string,
      options?: { buttonVariant?: 'primary' | 'secondary' | 'tertiary'; buttonAlignment?: 'left' | 'center' | 'right'; useLightbox?: boolean },
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<FormBlockAddResult>;
    updateFormBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { buttonVariant?: 'primary' | 'secondary' | 'tertiary'; buttonAlignment?: 'left' | 'center' | 'right'; useLightbox?: boolean },
    ): Promise<FormBlockUpdateResult>;
    getAvailableForms(): Promise<FormListResult>;
    createForm(
      name?: string, fields?: string[],
      options?: { submitButtonText?: string },
    ): Promise<FormCreateResult>;
    getForm(formId: string): Promise<FormGetResult>;
    updateForm(
      formId: string,
      updates: { name?: string; fields?: string[]; submitButtonText?: string; submissionMessage?: string },
    ): Promise<FormUpdateResult>;
    addSocialLinksBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      options?: { iconAlignment?: 'left' | 'center' | 'right'; iconSize?: 'small' | 'medium' | 'large'; iconStyle?: 'icon-only' | 'icon-text'; iconColor?: 'black' | 'white' },
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<SocialLinksBlockAddResult>;
    updateSocialLinksBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { iconAlignment?: 'left' | 'center' | 'right'; iconSize?: 'small' | 'medium' | 'large'; iconStyle?: 'icon-only' | 'icon-text'; iconColor?: 'black' | 'white' },
    ): Promise<SocialLinksBlockUpdateResult>;
    addEmbedBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number, html?: string,
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<EmbedBlockAddResult>;
    updateEmbedBlock(
      pageSectionsId: string, collectionId: string, searchText: string, html: string,
    ): Promise<EmbedBlockUpdateResult>;
    findMenuBlock(
      sections: PageSection[], searchText: string,
    ): { section: PageSection; gridContent: GridContent; sectionIndex: number; blockIndex: number; menuValue: any } | null;
    addMenuBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number, menuText?: string,
      options?: { menuStyle?: string; currencySymbol?: string; columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<MenuBlockAddResult>;
    getMenuBlock(
      pageSectionsId: string, searchText: string,
    ): Promise<{ success: boolean; menus?: any[]; menuStyle?: number; currencySymbol?: string; blockId?: string; raw?: string; error?: string }>;
    updateMenuBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      newMenus: any[], options?: { preserveRaw?: boolean },
    ): Promise<MenuBlockUpdateResult>;
    addMapBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      lat: number, lng: number,
      options?: { zoom?: number; style?: number; labels?: boolean; terrain?: boolean; controls?: boolean; layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number } },
    ): Promise<MapBlockAddResult>;
    updateMapBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { lat?: number; lng?: number; zoom?: number; style?: number; labels?: boolean; terrain?: boolean },
    ): Promise<MapBlockUpdateResult>;
    addAudioBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number, audioAssetId: string,
      options?: {
        title?: string; author?: string; designStyle?: string; colorTheme?: string; showDownload?: boolean;
        layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number };
      },
    ): Promise<AudioBlockAddResult>;
    updateAudioBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { title?: string; author?: string; designStyle?: string; colorTheme?: string; showDownload?: boolean },
    ): Promise<AudioBlockUpdateResult>;
    addPageLinkBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      linkTitle: string, linkTarget: string,
      options?: { newWindow?: boolean; layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number } },
    ): Promise<PageLinkBlockAddResult>;
    updatePageLinkBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { linkTitle?: string; linkTarget?: string; newWindow?: boolean },
    ): Promise<PageLinkBlockUpdateResult>;
    addHorizontalRuleBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<HorizontalRuleBlockAddResult>;
    addSearchBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      options?: {
        targetCollectionId?: string; searchPreview?: boolean; theme?: string;
        layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number };
      },
    ): Promise<SearchBlockAddResult>;
    updateSearchBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { targetCollectionId?: string; searchPreview?: boolean; theme?: string },
    ): Promise<SearchBlockUpdateResult>;
    addMarkdownBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      source: string,
      layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
    ): Promise<MarkdownBlockAddResult>;
    updateMarkdownBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: { source?: string },
    ): Promise<MarkdownBlockUpdateResult>;
    addSummaryBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      targetCollectionId: string,
      options?: {
        design?: string; headerText?: string; pageSize?: number; showTitle?: boolean; showThumbnail?: boolean;
        showExcerpt?: boolean; showReadMoreLink?: boolean; showPrice?: boolean; textAlignment?: string;
        imageAspectRatio?: number;
        layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number };
      },
    ): Promise<SummaryBlockAddResult>;
    updateSummaryBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: {
        targetCollectionId?: string; design?: string; headerText?: string; pageSize?: number;
        showTitle?: boolean; showThumbnail?: boolean; showExcerpt?: boolean; showReadMoreLink?: boolean;
        showPrice?: boolean; textAlignment?: string; imageAspectRatio?: number;
      },
    ): Promise<SummaryBlockUpdateResult>;
    addProductBlock(
      pageSectionsId: string, collectionId: string, sectionIndex: number,
      productId: string,
      options?: {
        showTitle?: boolean; showPrice?: boolean; showBuyButton?: boolean; showQuantity?: boolean;
        showExcerpt?: boolean; showImage?: boolean; alignment?: string;
        layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number };
      },
    ): Promise<ProductBlockAddResult>;
    updateProductBlock(
      pageSectionsId: string, collectionId: string, searchText: string,
      updates: {
        productId?: string; showTitle?: boolean; showPrice?: boolean; showBuyButton?: boolean;
        showQuantity?: boolean; showExcerpt?: boolean; showImage?: boolean; alignment?: string;
      },
    ): Promise<ProductBlockUpdateResult>;
  }
}


// ── Chunk 1 ────────────────────────────────────────────────────────────

// ── Image Block Update ────────────────────────────────────────────────

ContentSaveClient.prototype.updateImageBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  fields: { title?: string; description?: string; subtitle?: string; altText?: string; linkTo?: string; assetUrl?: string },
): Promise<ImageBlockUpdateResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Step 3: Verify block type is image (1337)
    if (blockValue.type !== BLOCK_TYPE_IMAGE) {
      return {
        success: false,
        error: `Block "${searchText}" is type ${blockValue.type}, not an image block (expected ${BLOCK_TYPE_IMAGE})`,
      };
    }

    const blockId = blockValue.id;
    const updatedFields: string[] = [];

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 4: Update provided fields
    if (fields.title !== undefined) {
      blockValue.value.title = fields.title;
      updatedFields.push('title');
    }
    if (fields.description !== undefined) {
      blockValue.value.description = fields.description;
      updatedFields.push('description');
    }
    if (fields.subtitle !== undefined) {
      blockValue.value.subtitle = fields.subtitle;
      updatedFields.push('subtitle');
    }
    if (fields.altText !== undefined) {
      // altText is stored at the block level (content.value.altText)
      blockValue.altText = fields.altText;
      updatedFields.push('altText');
    }
    if (fields.linkTo !== undefined) {
      blockValue.value.linkTo = fields.linkTo;
      updatedFields.push('linkTo');
    }
    if (fields.assetUrl !== undefined) {
      blockValue.value.assetUrl = fields.assetUrl;
      updatedFields.push('assetUrl');
      // Create new content image record for the new asset URL
      const contentImg = await this.createContentImage(fields.assetUrl);
      if (contentImg.imageId) {
        blockValue.value.imageId = contentImg.imageId;
        updatedFields.push('imageId');
      } else {
        logger.warn({ error: contentImg.error }, 'Could not create content image for updated assetUrl');
      }
    }

    if (updatedFields.length === 0) {
      return { success: false, error: 'No fields provided to update' };
    }

    logger.info(
      { blockId, updatedFields, searchText },
      'Updating image block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, updatedFields };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Button Block Add ──────────────────────────────────────────────────

ContentSaveClient.prototype.addButtonBlock = async function (
  this: ContentSaveClient,
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
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    // Default button: 7 columns wide, 2 rows tall
    const rowHeight = layout?.rowHeight ?? 2;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? 7;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

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

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, label, url, position: { startX, startY, endX, endY } },
      'Adding button block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Button Block Update ───────────────────────────────────────────────

/**
 * Update a button block's label, URL, and/or design fields.
 * Supports both type 46 (legacy) and type 1337 (new) button blocks.
 * Uses findBlock() which matches on label/buttonText.
 */
ContentSaveClient.prototype.updateButtonBlock = async function (
  this: ContentSaveClient,
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
};

// ── Image Block Add ───────────────────────────────────────────────────

ContentSaveClient.prototype.addImageBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  assetUrl: string,
  options?: {
    altText?: string;
    title?: string;
    description?: string;
    subtitle?: string;
    linkTo?: string;
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    };
  },
): Promise<ImageBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;
    const layout = options?.layout;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    // Default image: 12 columns wide, 8 rows tall
    const rowHeight = layout?.rowHeight ?? 8;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? 12;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    // Create content image record (required for Fluid Engine to render the image)
    const contentImg = await this.createContentImage(assetUrl);
    if (!contentImg.imageId) {
      logger.warn({ error: contentImg.error }, 'Could not create content image — block may not render');
    }

    // Use full block structure (required by Squarespace PUT validation)
    const content = ContentSaveClient.buildImageBlockContent(blockId, assetUrl, options?.altText, contentImg.imageId);

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content,
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, assetUrl, position: { startX, startY, endX, endY } },
      'Adding image block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Image Block Batch Add ─────────────────────────────────────────────

ContentSaveClient.prototype.addImageBlockBatch = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  images: Array<{
    assetUrl: string;
    altText?: string;
    title?: string;
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    };
  }>,
): Promise<ImageBlockBatchResult> {
  if (images.length === 0) {
    return { success: false, blocks: [], error: 'No images provided' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, blocks: [], error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, blocks: [], error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Track max Y across all existing blocks
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    let maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);

    const addedBlocks: Array<{ blockId: string; assetUrl: string }> = [];

    // Step 3: Create and push each image block
    for (let idx = 0; idx < images.length; idx++) {
      const img = images[idx];
      const layout = img.layout;

      const rowHeight = layout?.rowHeight ?? 8;
      const gapRows = layout?.gapRows ?? ((gridContents.length > addedBlocks.length ? addedBlocks.length > 0 : false) || gridContents.length > 0 ? 2 : 0);
      const effectiveGap = (idx === 0 && gridContents.length - addedBlocks.length === 0) ? 0 : gapRows;

      let startX: number;
      let endX: number;
      let startY: number;
      let endY: number;

      if (layout?.startX != null && layout?.endX != null) {
        startX = Math.max(1, layout.startX);
        endX = Math.min(maxColumns + 1, layout.endX);
      } else {
        const cols = layout?.columns ?? 12;
        startX = 1;
        endX = Math.min(startX + cols, maxColumns + 1);
      }

      if (layout?.startY != null && layout?.endY != null) {
        startY = Math.max(0, layout.startY);
        endY = layout.endY;
      } else {
        startY = maxY + effectiveGap;
        endY = startY + rowHeight;
      }

      const blockId = ContentSaveClient.generateBlockId();
      maxZ += 1;

      // Create content image record (required for Fluid Engine to render)
      const contentImg = await this.createContentImage(img.assetUrl);
      if (!contentImg.imageId) {
        logger.warn({ error: contentImg.error, assetUrl: img.assetUrl }, 'Could not create content image — block may not render');
      }

      // Use full block structure (required by Squarespace PUT validation)
      const content = ContentSaveClient.buildImageBlockContent(blockId, img.assetUrl, img.altText, contentImg.imageId);

      const newBlock: GridContent = {
        layout: {
          mobile: { start: { x: 1, y: maxMobileY + effectiveGap }, end: { x: 9, y: maxMobileY + effectiveGap + rowHeight }, visible: true, verticalAlignment: 'top', zIndex: maxZ },
          desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex: maxZ },
        },
        content,
      };

      gridContents.push(newBlock);
      addedBlocks.push({ blockId, assetUrl: img.assetUrl });

      // Update running maxY for next block
      maxY = endY;
      maxMobileY = maxMobileY + effectiveGap + rowHeight;
    }

    // Update section rows to accommodate all new blocks
    this.updateSectionRows(section, maxY, maxMobileY);

    logger.info(
      { sectionIndex, sectionId: section.id, imageCount: images.length, blockIds: addedBlocks.map(b => b.blockId) },
      'Batch-adding image blocks via Content Save API',
    );

    // Step 4: PUT the modified sections (single write for all blocks)
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, blocks: [], error: saveResult.error };
    }

    return { success: true, blocks: addedBlocks, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, blocks: [], error: errMsg(err) };
  }
};

// ── Divider Block Add ─────────────────────────────────────────────────

ContentSaveClient.prototype.addDividerBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<DividerBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    // Default divider: full width (24 cols), 1 row tall
    const rowHeight = layout?.rowHeight ?? 1;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_DIVIDER,
          value: {},
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, position: { startX, startY, endX, endY } },
      'Adding divider block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Chunk 2 ────────────────────────────────────────────────────────────

ContentSaveClient.prototype.addVideoBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  videoUrl: string,
  options?: {
    title?: string;
    description?: string;
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    };
  },
): Promise<VideoBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    const layout = options?.layout;

    // Default video block: full width (24 cols), 8 rows tall
    const rowHeight = layout?.rowHeight ?? 8;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_VIDEO,
          value: {
            url: videoUrl,
            title: options?.title,
            description: options?.description,
          },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, videoUrl, position: { startX, startY, endX, endY } },
      'Adding video block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateVideoBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { url?: string; title?: string; description?: string },
): Promise<VideoBlockUpdateResult> {
  if (!updates.url && !updates.title && !updates.description) {
    return { success: false, error: 'Must provide at least url, title, or description to update' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the video block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Step 3: Verify block type is video (50)
    if (blockValue.type !== BLOCK_TYPE_VIDEO) {
      return {
        success: false,
        error: `Block "${searchText}" is type ${blockValue.type}, not a video block (expected ${BLOCK_TYPE_VIDEO})`,
      };
    }

    const blockId = blockValue.id;
    const updatedFields: string[] = [];

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 4: Update provided fields
    if (updates.url !== undefined) {
      blockValue.value.url = updates.url;
      updatedFields.push('url');
    }
    if (updates.title !== undefined) {
      blockValue.value.title = updates.title;
      updatedFields.push('title');
    }
    if (updates.description !== undefined) {
      blockValue.value.description = updates.description;
      updatedFields.push('description');
    }

    logger.info(
      { blockId, updatedFields, searchText },
      'Updating video block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, updatedFields };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.addQuoteBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  quoteText: string,
  attribution?: string,
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<QuoteBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    const rowHeight = layout?.rowHeight ?? 3;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const quoteValue: Record<string, unknown> = {
      quote: quoteText,
      blockAnimation: 'site-default',
      vSize: null,
      hSize: null,
      schemaName: null,
      aspectRatio: null,
      floatDir: null,
    };
    if (attribution !== undefined) {
      quoteValue.source = attribution;
    }

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_QUOTE,
          value: quoteValue,
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, quoteText: quoteText.substring(0, 100), attribution, position: { startX, startY, endX, endY } },
      'Adding quote block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateQuoteBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { quoteText?: string; attribution?: string },
): Promise<QuoteBlockUpdateResult> {
  if (!updates.quoteText && updates.attribution === undefined) {
    return { success: false, error: 'Must provide at least quoteText or attribution to update' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the quote block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Step 3: Verify block type is quote (31)
    if (blockValue.type !== BLOCK_TYPE_QUOTE) {
      return {
        success: false,
        error: `Block "${searchText}" is type ${blockValue.type}, not a quote block (expected ${BLOCK_TYPE_QUOTE})`,
      };
    }

    const blockId = blockValue.id;
    const oldQuote = blockValue.value?.quote as string | undefined;

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 4: Update provided fields
    if (updates.quoteText !== undefined) {
      blockValue.value.quote = updates.quoteText;
    }
    if (updates.attribution !== undefined) {
      blockValue.value.source = updates.attribution;
    }

    logger.info(
      { blockId, searchText, oldQuote: oldQuote?.substring(0, 100), newQuote: updates.quoteText?.substring(0, 100), attribution: updates.attribution },
      'Updating quote block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      blockId,
      oldQuote,
      newQuote: updates.quoteText ?? oldQuote,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.addCodeBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  code: string,
  language?: string,
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<CodeBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    const rowHeight = layout?.rowHeight ?? 3;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_CODE,
          value: { wysiwyg: { engine: CODE_BLOCK_ENGINE, mode: language ?? 'htmlmixed', isSource: false, source: code }, html: code },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, language: language ?? 'plain', codeLength: code.length, position: { startX, startY, endX, endY } },
      'Adding code block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateCodeBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { code?: string; language?: string },
): Promise<CodeBlockUpdateResult> {
  if (!updates.code && !updates.language) {
    return { success: false, error: 'Must provide at least code or language to update' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the code block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Step 3: Verify block type is code (type 1337 with wysiwyg.engine === 'code')
    if (blockValue.type !== BLOCK_TYPE_CODE || blockValue.value?.wysiwyg?.engine !== CODE_BLOCK_ENGINE) {
      return {
        success: false,
        error: `Block "${searchText}" is type ${blockValue.type}, not a code block (expected ${BLOCK_TYPE_CODE} with wysiwyg.engine='${CODE_BLOCK_ENGINE}')`,
      };
    }

    const blockId = blockValue.id;

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 4: Update provided fields
    if (updates.code !== undefined) {
      blockValue.value.html = updates.code;
      if (blockValue.value.wysiwyg) {
        blockValue.value.wysiwyg.source = updates.code;
      }
    }
    if (updates.language !== undefined) {
      if (blockValue.value.wysiwyg) {
        blockValue.value.wysiwyg.mode = updates.language;
      }
    }

    logger.info(
      { blockId, searchText, language: updates.language, codeLength: updates.code?.length },
      'Updating code block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Chunk 3 ────────────────────────────────────────────────────────────

ContentSaveClient.prototype.addNewsletterBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  options?: {
    description?: string;
    alignment?: string;
    captchaEnabled?: boolean;
    captchaTheme?: number;
    captchaAlignment?: number;
    submitButtonText?: string;
    title?: string;
  },
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
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    // Default newsletter block: full width (24 cols), 4 rows tall
    const rowHeight = layout?.rowHeight ?? 4;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const descHtml = options?.description
      ? `<p>${options.description}</p>`
      : '<p>Sign up with your email address to receive news and updates.</p>';

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_NEWSLETTER,
          value: {
            alignment: options?.alignment ?? 'alignCenter',
            captchaEnabled: options?.captchaEnabled ?? false,
            captchaTheme: options?.captchaTheme ?? 1,
            captchaAlignment: options?.captchaAlignment ?? 2,
            description: { engine: 'wysiwyg', html: descHtml, source: descHtml } as unknown as string,
            floatDir: null,
            hSize: null,
            layout: 'layoutFloat',
            submitButtonText: options?.submitButtonText ?? 'Sign Up',
            successRedirect: '',
            title: options?.title ?? 'Subscribe',
            hasEnabledBackends: true,
          },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, title: options?.title ?? 'Subscribe', position: { startX, startY, endX, endY } },
      'Adding newsletter block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateNewsletterBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    description?: string;
    alignment?: string;
    captchaEnabled?: boolean;
    submitButtonText?: string;
    title?: string;
  },
): Promise<NewsletterBlockUpdateResult> {
  if (!updates.description && !updates.alignment && updates.captchaEnabled === undefined &&
      !updates.submitButtonText && !updates.title) {
    return { success: false, error: 'Must provide at least one field to update' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the newsletter block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Step 3: Verify block type is newsletter (51)
    if (blockValue.type !== BLOCK_TYPE_NEWSLETTER) {
      return {
        success: false,
        error: `Block "${searchText}" is type ${blockValue.type}, not a newsletter block (expected ${BLOCK_TYPE_NEWSLETTER})`,
      };
    }

    const blockId = blockValue.id;

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 4: Update provided fields
    if (updates.description !== undefined) {
      const descHtml = `<p>${updates.description}</p>`;
      (blockValue.value as Record<string, unknown>).description = { engine: 'wysiwyg', html: descHtml, source: descHtml };
    }
    if (updates.alignment !== undefined) {
      blockValue.value.alignment = updates.alignment;
    }
    if (updates.captchaEnabled !== undefined) {
      blockValue.value.captchaEnabled = updates.captchaEnabled;
    }
    if (updates.submitButtonText !== undefined) {
      blockValue.value.submitButtonText = updates.submitButtonText;
    }
    if (updates.title !== undefined) {
      blockValue.value.title = updates.title;
    }

    logger.info(
      { blockId, searchText, updatedFields: Object.keys(updates).filter(k => updates[k as keyof typeof updates] !== undefined) },
      'Updating newsletter block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.addAccordionBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  items: Array<{ title: string; description: string }>,
  options?: {
    isExpandedFirstItem?: boolean;
    shouldAllowMultipleOpenItems?: boolean;
  },
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<AccordionBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    // Default accordion block: full width (24 cols), rowHeight based on item count
    const rowHeight = layout?.rowHeight ?? Math.max(4, items.length * 2);
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
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
          value: {
            accordionItems: items,
            isExpandedFirstItem: options?.isExpandedFirstItem ?? false,
            shouldAllowMultipleOpenItems: options?.shouldAllowMultipleOpenItems ?? false,
            accordionTitleFont: 'heading-4',
            accordionTitleAlignment: 'left',
            accordionDescriptionFont: 'paragraph-2',
            accordionDescriptionAlignment: 'left',
            isDividerEnabled: true,
            dividerOpacity: 1,
            isFirstDividerVisible: true,
            isLastDividerVisible: true,
            dividerBorderThickness: { value: 1, unit: 'px' },
            accordionIconType: 'plus',
            accordionIconPlacement: 'right',
            accordionIconSize: { value: 14, unit: 'px' },
            accordionIconThickness: { value: 1, unit: 'px' },
            accordionItemPaddingTop: { value: 30, unit: 'px' },
            accordionItemPaddingBottom: { value: 30, unit: 'px' },
            accordionItemPaddingRight: { value: 0, unit: 'px' },
            accordionItemPaddingLeft: { value: 0, unit: 'px' },
            descriptionWidth: { value: 70, unit: '%' },
            descriptionPaddingTop: { value: 0, unit: 'px' },
            descriptionPaddingBottom: { value: 30, unit: 'px' },
            descriptionPaddingRight: { value: 0, unit: 'px' },
            descriptionPaddingLeft: { value: 0, unit: 'px' },
            accordionDescriptionPlacement: 'left',
          },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, itemCount: items.length, position: { startX, startY, endX, endY } },
      'Adding accordion block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateAccordionBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    items?: Array<{ title: string; description: string }>;
    isExpandedFirstItem?: boolean;
    shouldAllowMultipleOpenItems?: boolean;
  },
): Promise<AccordionBlockUpdateResult> {
  if (!updates.items && updates.isExpandedFirstItem === undefined && updates.shouldAllowMultipleOpenItems === undefined) {
    return { success: false, error: 'Must provide at least one field to update' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the accordion block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Step 3: Verify block type is accordion (69)
    if (blockValue.type !== BLOCK_TYPE_ACCORDION) {
      return {
        success: false,
        error: `Block "${searchText}" is type ${blockValue.type}, not an accordion block (expected ${BLOCK_TYPE_ACCORDION})`,
      };
    }

    const blockId = blockValue.id;

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 4: Update provided fields
    if (updates.items !== undefined) {
      blockValue.value.accordionItems = updates.items;
    }
    if (updates.isExpandedFirstItem !== undefined) {
      blockValue.value.isExpandedFirstItem = updates.isExpandedFirstItem;
    }
    if (updates.shouldAllowMultipleOpenItems !== undefined) {
      blockValue.value.shouldAllowMultipleOpenItems = updates.shouldAllowMultipleOpenItems;
    }

    logger.info(
      { blockId, searchText, itemCount: updates.items?.length },
      'Updating accordion block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.addMarqueeBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  items: Array<{ text: string; linkTo?: string }>,
  options?: {
    animationDirection?: 'left' | 'right';
    animationSpeed?: number;
    textStyle?: string;
    pausedOnHover?: boolean;
    fadeEdges?: boolean;
    waveFrequency?: number;
    waveIntensity?: number;
  },
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<MarqueeBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    // Default marquee block: full width (24 cols), 4 rows tall
    const rowHeight = layout?.rowHeight ?? 4;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_MARQUEE,
          value: {
            marqueeItems: items,
            linkTo: '',
            newWindow: false,
            waveFrequency: options?.waveFrequency ?? 4,
            waveIntensity: options?.waveIntensity ?? 0,
            animationDirection: options?.animationDirection ?? 'left',
            animationSpeed: options?.animationSpeed ?? 1,
            pausedOnHover: options?.pausedOnHover ?? false,
            fadeEdges: options?.fadeEdges ?? false,
            textStyle: options?.textStyle ?? 'heading-1',
            textSize: { value: 1.5, unit: 'rem' },
            itemSpacing: { value: 0.5, unit: 'em' },
          },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, itemCount: items.length, animationDirection: options?.animationDirection ?? 'left', position: { startX, startY, endX, endY } },
      'Adding marquee block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateMarqueeBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    items?: Array<{ text: string; linkTo?: string }>;
    animationDirection?: 'left' | 'right';
    animationSpeed?: number;
    textStyle?: string;
    pausedOnHover?: boolean;
  },
): Promise<MarqueeBlockUpdateResult> {
  if (!updates.items && !updates.animationDirection && updates.animationSpeed === undefined &&
      !updates.textStyle && updates.pausedOnHover === undefined) {
    return { success: false, error: 'Must provide at least one field to update' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the marquee block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Step 3: Verify block type is marquee (70)
    if (blockValue.type !== BLOCK_TYPE_MARQUEE) {
      return {
        success: false,
        error: `Block "${searchText}" is type ${blockValue.type}, not a marquee block (expected ${BLOCK_TYPE_MARQUEE})`,
      };
    }

    const blockId = blockValue.id;

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 4: Update provided fields
    if (updates.items !== undefined) {
      blockValue.value.marqueeItems = updates.items;
    }
    if (updates.animationDirection !== undefined) {
      blockValue.value.animationDirection = updates.animationDirection;
    }
    if (updates.animationSpeed !== undefined) {
      blockValue.value.animationSpeed = updates.animationSpeed;
    }
    if (updates.textStyle !== undefined) {
      blockValue.value.textStyle = updates.textStyle;
    }
    if (updates.pausedOnHover !== undefined) {
      blockValue.value.pausedOnHover = updates.pausedOnHover;
    }

    logger.info(
      { blockId, searchText, itemCount: updates.items?.length },
      'Updating marquee block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.addFormBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  formId: string,
  options?: {
    buttonVariant?: 'primary' | 'secondary' | 'tertiary';
    buttonAlignment?: 'left' | 'center' | 'right';
    useLightbox?: boolean;
  },
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<FormBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    // Default form block: 16 cols wide (narrower), 8 rows tall
    const rowHeight = layout?.rowHeight ?? 8;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? 16;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_CODE,
          value: {
            buttonAlignment: options?.buttonAlignment ?? 'left',
            buttonVariant: options?.buttonVariant ?? 'primary',
            firstFieldHighlightType: 'none',
            submissionTextAlignment: 'left',
            submissionVerticalAlignment: 'top',
            submissionAnimation: 'none',
            formId,
            lightboxHandleText: '',
            useLightbox: options?.useLightbox ?? false,
            containerStyles: {
              backgroundEnabled: false,
              backgroundColor: { type: 'THEME_COLOR' },
              stroke: {
                style: 'none',
                color: { type: 'THEME_COLOR' },
                thickness: { value: 2, unit: 'px' },
              },
              borderRadii: {
                topLeft: { value: 20, unit: 'px' },
                topRight: { value: 20, unit: 'px' },
                bottomLeft: { value: 20, unit: 'px' },
                bottomRight: { value: 20, unit: 'px' },
              },
              padding: {
                top: { value: 6, unit: '%' },
                bottom: { value: 6, unit: '%' },
                left: { value: 6, unit: '%' },
                right: { value: 6, unit: '%' },
              },
            },
          },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, formId, position: { startX, startY, endX, endY } },
      'Adding form block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateFormBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    buttonVariant?: 'primary' | 'secondary' | 'tertiary';
    buttonAlignment?: 'left' | 'center' | 'right';
    useLightbox?: boolean;
  },
): Promise<FormBlockUpdateResult> {
  if (!updates.buttonVariant && !updates.buttonAlignment && updates.useLightbox === undefined) {
    return { success: false, error: 'Must provide at least one field to update' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the form block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Step 3: Verify block type is form (type 1337 with buttonVariant discriminator)
    if (blockValue.type !== BLOCK_TYPE_CODE || blockValue.value?.[FORM_BLOCK_DISCRIMINATOR] === undefined) {
      return {
        success: false,
        error: `Block "${searchText}" is not a form block (expected type ${BLOCK_TYPE_CODE} with ${FORM_BLOCK_DISCRIMINATOR} field)`,
      };
    }

    const blockId = blockValue.id;

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 4: Update provided fields
    if (updates.buttonVariant !== undefined) {
      blockValue.value.buttonVariant = updates.buttonVariant;
    }
    if (updates.buttonAlignment !== undefined) {
      blockValue.value.buttonAlignment = updates.buttonAlignment;
    }
    if (updates.useLightbox !== undefined) {
      blockValue.value.useLightbox = updates.useLightbox;
    }

    logger.info(
      { blockId, searchText, updatedFields: Object.keys(updates).filter(k => updates[k as keyof typeof updates] !== undefined) },
      'Updating form block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Chunk 4 ────────────────────────────────────────────────────────────

// ── Form CRUD, Social Links, Embed, Menu, Map block methods ──────────────

ContentSaveClient.prototype.getAvailableForms = async function (
  this: ContentSaveClient,
): Promise<FormListResult> {
  this.ensureCookies();
  const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
  try {
    const url = `${siteUrl}/api/rolodex/1/forms`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { success: false, forms: [], error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as unknown;
    const rec = data as Record<string, unknown>;
    const raw: unknown[] = Array.isArray(rec.formSummaries)
      ? (rec.formSummaries as unknown[])
      : Array.isArray(data)
        ? (data as unknown[])
        : [];
    const forms = raw.map((f) => {
      const item = f as Record<string, unknown>;
      return {
        id: String(item.id ?? item.formId ?? ''),
        name: String(item.title ?? item.name ?? ''),
      };
    });
    return { success: true, forms };
  } catch (err) {
    return { success: false, forms: [], error: errMsg(err) };
  }
};

ContentSaveClient.prototype.createForm = async function (
  this: ContentSaveClient,
  name?: string,
  fields?: string[],
  options?: { submitButtonText?: string },
): Promise<FormCreateResult> {
  this.ensureCookies();
  const url = this.buildApiUrl('/api/rest/forms');

  // Default contact form fields
  const defaultFields = [
    JSON.stringify({ type: 'name', id: `name-${randomBytes(8).toString('hex')}`, title: 'Name', description: '', required: true }),
    JSON.stringify({ type: 'email', id: `email-${randomBytes(8).toString('hex')}`, title: 'Email', description: '', required: true }),
    JSON.stringify({ type: 'textarea', id: `textarea-${randomBytes(8).toString('hex')}`, title: 'Message', description: '', required: true }),
  ];

  const body = {
    name: name ?? 'Contact Form',
    fields: fields ?? defaultFields,
    submitButtonText: options?.submitButtonText ?? 'Submit',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, text, `POST /api/rest/forms failed: ${response.status} ${text}`) };
    }

    const data = (await response.json()) as Record<string, unknown>;
    const formId = String(data.id ?? '');
    if (!formId) {
      return { success: false, error: 'Form created but no id returned' };
    }

    logger.info({ siteSubdomain: this.siteSubdomain, formId, name: body.name }, 'Form created');
    return { success: true, formId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.getForm = async function (
  this: ContentSaveClient,
  formId: string,
): Promise<FormGetResult> {
  this.ensureCookies();
  const url = this.buildApiUrl(`/api/rest/forms/${formId}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: `GET /api/rest/forms/${formId} failed: ${response.status} ${text}` };
    }

    const data = (await response.json()) as Record<string, unknown>;
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateForm = async function (
  this: ContentSaveClient,
  formId: string,
  updates: {
    name?: string;
    fields?: string[];
    submitButtonText?: string;
    submissionMessage?: string;
  },
): Promise<FormUpdateResult> {
  this.ensureCookies();
  const url = this.buildApiUrl(`/api/rest/forms/${formId}`);

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: JSON.stringify(updates),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, text, `PUT /api/rest/forms/${formId} failed: ${response.status} ${text}`) };
    }

    const data = (await response.json()) as Record<string, unknown>;
    logger.info({ siteSubdomain: this.siteSubdomain, formId }, 'Form updated');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Social Links Block (type 54) ────────────────────────────────────────

ContentSaveClient.prototype.addSocialLinksBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  options?: {
    iconAlignment?: 'left' | 'center' | 'right';
    iconSize?: 'small' | 'medium' | 'large';
    iconStyle?: 'icon-only' | 'icon-text';
    iconColor?: 'black' | 'white';
  },
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<SocialLinksBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    // Default social links block: 12 cols wide, 3 rows tall
    const rowHeight = layout?.rowHeight ?? 3;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? 12;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_SOCIAL_LINKS,
          value: {
            iconAlignment: options?.iconAlignment ?? 'center',
            iconSize: options?.iconSize ?? 'small',
            iconStyle: options?.iconStyle ?? 'icon-only',
            iconColor: options?.iconColor ?? 'black',
          },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, position: { startX, startY, endX, endY } },
      'Adding social links block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateSocialLinksBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    iconAlignment?: 'left' | 'center' | 'right';
    iconSize?: 'small' | 'medium' | 'large';
    iconStyle?: 'icon-only' | 'icon-text';
    iconColor?: 'black' | 'white';
  },
): Promise<SocialLinksBlockUpdateResult> {
  if (!updates.iconAlignment && !updates.iconSize && !updates.iconStyle && !updates.iconColor) {
    return { success: false, error: 'Must provide at least one field to update' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the block — try findBlock() first, then fall back to first type 54 block
    let match = this.findBlock(data.sections, searchText);
    if (!match || match.gridContent.content.value.type !== BLOCK_TYPE_SOCIAL_LINKS) {
      // Fall back to first type 54 block in any section
      outerSearch:
      for (const section of data.sections) {
        const gridContents = section.fluidEngineContext?.gridContents ?? [];
        for (const gc of gridContents) {
          if (gc.content?.value?.type === BLOCK_TYPE_SOCIAL_LINKS) {
            const si = data.sections.indexOf(section);
            const bi = (section.fluidEngineContext?.gridContents ?? []).indexOf(gc);
            match = { gridContent: gc, section, sectionIndex: si, blockIndex: bi };
            break outerSearch;
          }
        }
      }
    }

    if (!match || match.gridContent.content.value.type !== BLOCK_TYPE_SOCIAL_LINKS) {
      return { success: false, error: `No social links block (type ${BLOCK_TYPE_SOCIAL_LINKS}) found` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;
    const blockId = blockValue.id;

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 3: Apply updates
    const updatedFields: string[] = [];
    if (updates.iconAlignment !== undefined) { blockValue.value.iconAlignment = updates.iconAlignment; updatedFields.push('iconAlignment'); }
    if (updates.iconSize !== undefined) { blockValue.value.iconSize = updates.iconSize; updatedFields.push('iconSize'); }
    if (updates.iconStyle !== undefined) { blockValue.value.iconStyle = updates.iconStyle; updatedFields.push('iconStyle'); }
    if (updates.iconColor !== undefined) { blockValue.value.iconColor = updates.iconColor; updatedFields.push('iconColor'); }

    logger.info(
      { blockId, searchText, updatedFields },
      'Updating social links block via Content Save API',
    );

    // Step 4: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, updatedFields };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Embed Block (type 22) ───────────────────────────────────────────────

ContentSaveClient.prototype.addEmbedBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  html?: string,
  layout?: {
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<EmbedBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    // Default embed block: 12 cols wide, 6 rows tall
    const rowHeight = layout?.rowHeight ?? 6;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? 12;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    // Embed value: empty {} when no html, otherwise { html } when html provided
    const embedValue: Record<string, unknown> = html ? { html } : {};

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_EMBED,
          value: embedValue,
          containerStyles: { backgroundEnabled: false, stretchedToFill: false },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, hasHtml: !!html, position: { startX, startY, endX, endY } },
      'Adding embed block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionIndex, sectionId: section.id };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateEmbedBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  html: string,
): Promise<EmbedBlockUpdateResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the embed block
    let match = this.findBlock(data.sections, searchText);
    if (!match || match.gridContent.content.value.type !== BLOCK_TYPE_EMBED) {
      // Fall back to first type 22 block in any section
      outerSearch:
      for (const section of data.sections) {
        const gridContents = section.fluidEngineContext?.gridContents ?? [];
        for (const gc of gridContents) {
          if (gc.content?.value?.type === BLOCK_TYPE_EMBED) {
            const si = data.sections.indexOf(section);
            const bi = gridContents.indexOf(gc);
            match = { gridContent: gc, section, sectionIndex: si, blockIndex: bi };
            break outerSearch;
          }
        }
      }
    }

    if (!match || match.gridContent.content.value.type !== BLOCK_TYPE_EMBED) {
      return { success: false, error: `No embed block (type ${BLOCK_TYPE_EMBED}) found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;
    const blockId = blockValue.id;

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 3: Update html
    blockValue.value.html = html;

    logger.info(
      { blockId, searchText, htmlLength: html.length },
      'Updating embed block via Content Save API',
    );

    // Step 4: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Menu Block (type 18) ────────────────────────────────────────────────

ContentSaveClient.prototype.findMenuBlock = function (
  this: ContentSaveClient,
  sections: PageSection[],
  searchText: string,
): {
  section: PageSection;
  gridContent: GridContent;
  sectionIndex: number;
  blockIndex: number;
  menuValue: any;
} | null {
  const found = this.findBlock(sections, searchText);
  if (!found) return null;

  const bv = found.gridContent.content.value;
  if (bv.type !== BLOCK_TYPE_MENU) return null;

  return {
    ...found,
    menuValue: bv.value,
  };
};

ContentSaveClient.prototype.addMenuBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  menuText?: string,
  options?: {
    menuStyle?: string;
    currencySymbol?: string;
    columns?: number;
    rowHeight?: number;
    gapRows?: number;
    startX?: number;
    endX?: number;
    startY?: number;
    endY?: number;
  },
): Promise<MenuBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    const rowHeight = options?.rowHeight ?? 6;
    const gapRows = options?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (options?.startX != null && options?.endX != null) {
      startX = Math.max(1, options.startX);
      endX = Math.min(maxColumns + 1, options.endX);
    } else {
      const cols = options?.columns ?? 12;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (options?.startY != null && options?.endY != null) {
      startY = Math.max(0, options.startY);
      endY = options.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and build menu content
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    // Parse menu text or create empty default
    let menus: any[];
    let raw: string;
    if (menuText) {
      const { parseMenuText } = await import('../menu-parser.js');
      menus = parseMenuText(menuText);
      raw = menuText;
    } else {
      menus = [{ title: null, description: null, sections: [{ title: null, description: null, items: [] }] }];
      raw = '';
    }

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_MENU,
          value: {
            raw,
            menus,
            menuStyle: options?.menuStyle ?? 'classic',
            currencySymbol: options?.currencySymbol ?? '$',
          },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, hasMenuText: !!menuText, position: { startX, startY, endX, endY } },
      'Adding menu block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionIndex, sectionId: section.id };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.getMenuBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  searchText: string,
): Promise<{
  success: boolean;
  menus?: any[];
  menuStyle?: number;
  currencySymbol?: string;
  blockId?: string;
  raw?: string;
  error?: string;
}> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const found = this.findMenuBlock(data.sections, searchText);
    if (!found) {
      return { success: false, error: `Menu block not found for searchText "${searchText}"` };
    }
    const mv = found.menuValue;
    return {
      success: true,
      menus: mv.menus || [],
      menuStyle: mv.menuStyle,
      currencySymbol: mv.currencySymbol,
      blockId: found.gridContent.content.value.id,
      raw: mv.raw,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateMenuBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  newMenus: any[],
  options?: { preserveRaw?: boolean },
): Promise<MenuBlockUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const found = this.findMenuBlock(data.sections, searchText);
    if (!found) {
      return { success: false, error: `Menu block not found for searchText "${searchText}"` };
    }

    const bv = found.gridContent.content.value;
    const oldMenus = found.menuValue.menus || [];
    const oldItemCount = oldMenus.reduce((sum: number, tab: any) =>
      sum + (tab.sections || []).reduce((s: number, sec: any) => s + (sec.items || []).length, 0), 0);
    const newItemCount = newMenus.reduce((sum: number, tab: any) =>
      sum + (tab.sections || []).reduce((s: number, sec: any) => s + (sec.items || []).length, 0), 0);

    // Update menus, preserve everything else (spread preserves unknown fields)
    bv.value = {
      ...bv.value,
      menus: newMenus,
    };

    // Regenerate raw field unless told to preserve it
    if (!options?.preserveRaw) {
      const { serializeMenu } = await import('../menu-parser.js');
      bv.value.raw = serializeMenu(newMenus);
    }

    // Save
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error || 'Save failed' };
    }

    return {
      success: true,
      blockId: bv.id,
      sectionId: found.section.id,
      oldTabCount: oldMenus.length,
      newTabCount: newMenus.length,
      oldItemCount,
      newItemCount,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Map Block (type 1337) ───────────────────────────────────────────────

ContentSaveClient.prototype.addMapBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  lat: number,
  lng: number,
  options?: {
    zoom?: number;
    style?: number;
    labels?: boolean;
    terrain?: boolean;
    controls?: boolean;
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    };
  },
): Promise<MapBlockAddResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Backfill verticalAlignment and zIndex on existing blocks
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

    // Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    const layout = options?.layout;
    const rowHeight = layout?.rowHeight ?? 12;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: ContentSaveClient.buildMapBlockContent(blockId, lat, lng, {
        zoom: options?.zoom,
        style: options?.style,
        labels: options?.labels,
        terrain: options?.terrain,
        controls: options?.controls,
      }),
    };

    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, lat, lng, position: { startX, startY, endX, endY } },
      'Adding map block via Content Save API',
    );

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateMapBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    lat?: number;
    lng?: number;
    zoom?: number;
    style?: number;
    labels?: boolean;
    terrain?: boolean;
  },
): Promise<MapBlockUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);

    // Find map block — search through all sections for type 1337 with location.mapLat
    let foundBlock: GridContent | null = null;
    for (const section of data.sections) {
      if (!section.fluidEngineContext) continue;
      for (const gc of section.fluidEngineContext.gridContents) {
        const bv = gc.content?.value;
        if (bv?.type === 1337 && bv?.value?.location?.mapLat != null) {
          // If searchText provided, try to match on block ID prefix
          if (searchText) {
            if (bv.id?.startsWith(searchText)) {
              foundBlock = gc;
              break;
            }
          } else {
            foundBlock = gc;
            break;
          }
        }
      }
      if (foundBlock) break;
    }

    // If no match by ID prefix, fall back to first map block
    if (!foundBlock && searchText) {
      for (const section of data.sections) {
        if (!section.fluidEngineContext) continue;
        for (const gc of section.fluidEngineContext.gridContents) {
          const bv = gc.content?.value;
          if (bv?.type === 1337 && bv?.value?.location?.mapLat != null) {
            foundBlock = gc;
            break;
          }
        }
        if (foundBlock) break;
      }
    }

    if (!foundBlock) {
      return { success: false, error: `No map block found${searchText ? ` matching "${searchText}"` : ''}` };
    }

    const blockValue = foundBlock.content.value;
    const blockId = blockValue.id;

    // Update location (value is guaranteed to exist — we found this block by checking value.location.mapLat)
    const bvVal = blockValue.value!;
    if (updates.lat !== undefined) bvVal.location.mapLat = updates.lat;
    if (updates.lng !== undefined) bvVal.location.mapLng = updates.lng;
    if (updates.zoom !== undefined) bvVal.location.mapZoom = updates.zoom;

    // Update display options
    if (updates.style !== undefined) bvVal.style = updates.style;
    if (updates.labels !== undefined) bvVal.labels = updates.labels;
    if (updates.terrain !== undefined) bvVal.terrain = updates.terrain;

    logger.info(
      { blockId, searchText, updates },
      'Updating map block via Content Save API',
    );

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Audio Block Add ──────────────────────────────────────────────────

ContentSaveClient.prototype.addAudioBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  audioAssetId: string,
  options?: {
    title?: string;
    author?: string;
    designStyle?: string;
    colorTheme?: string;
    showDownload?: boolean;
    layout?: {
      columns?: number;
      rowHeight?: number;
      gapRows?: number;
      startX?: number;
      endX?: number;
      startY?: number;
      endY?: number;
    };
  },
): Promise<AudioBlockAddResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    // Step 2: Validate section index
    if (sectionIndex < 0 || sectionIndex >= sections.length) {
      return { success: false, error: `Section index ${sectionIndex} out of range (0-${sections.length - 1})` };
    }

    const section = sections[sectionIndex];
    if (!section.fluidEngineContext) {
      return { success: false, error: `Section ${sectionIndex} has no fluidEngineContext (not a Fluid Engine section)` };
    }

    const gridContents = section.fluidEngineContext.gridContents;
    const maxColumns = section.fluidEngineContext.gridSettings?.breakpointSettings?.desktop?.columns ?? 24;

    // Step 2b: Backfill verticalAlignment and zIndex on existing blocks
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

    // Step 3: Calculate position
    let maxY = 0;
    let maxMobileY = 0;
    for (const gc of gridContents) {
      const endYVal = gc.layout?.desktop?.end?.y ?? 0;
      const mobileEndY = gc.layout?.mobile?.end?.y ?? 0;
      if (endYVal > maxY) maxY = endYVal;
      if (mobileEndY > maxMobileY) maxMobileY = mobileEndY;
    }

    const layout = options?.layout;

    // Default audio block: full width (24 cols), 2 rows tall (compact player)
    const rowHeight = layout?.rowHeight ?? 2;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);

    let startX: number;
    let endX: number;
    let startY: number;
    let endY: number;

    if (layout?.startX != null && layout?.endX != null) {
      startX = Math.max(1, layout.startX);
      endX = Math.min(maxColumns + 1, layout.endX);
    } else {
      const cols = layout?.columns ?? maxColumns;
      startX = 1;
      endX = Math.min(startX + cols, maxColumns + 1);
    }

    if (layout?.startY != null && layout?.endY != null) {
      startY = Math.max(0, layout.startY);
      endY = layout.endY;
    } else {
      startY = maxY + gapRows;
      endY = startY + rowHeight;
    }

    // Step 4: Generate block ID and create GridContent
    const blockId = ContentSaveClient.generateBlockId();

    const maxZ = gridContents.reduce((max, gc) => {
      const dz = gc.layout?.desktop?.zIndex ?? 0;
      const mz = gc.layout?.mobile?.zIndex ?? 0;
      return Math.max(max, dz, mz);
    }, 0);
    const zIndex = maxZ + 1;

    const newBlock: GridContent = {
      layout: {
        mobile: { start: { x: 1, y: maxMobileY + gapRows }, end: { x: 9, y: maxMobileY + gapRows + rowHeight }, visible: true, verticalAlignment: 'top', zIndex },
        desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
      },
      content: {
        value: {
          id: blockId,
          type: BLOCK_TYPE_AUDIO,
          value: {
            audioAssetId,
            audioAssetExternalUrl: null,
            title: options?.title ?? '',
            iTunesAuthor: options?.author ?? '',
            designStyle: options?.designStyle ?? 'minimal',
            colorTheme: options?.colorTheme ?? 'dark',
            showDownload: options?.showDownload ?? false,
          },
        },
      },
    };

    // Step 5: Push to gridContents and update section rows
    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);

    logger.info(
      { blockId, sectionIndex, sectionId: section.id, audioAssetId, position: { startX, startY, endX, endY } },
      'Adding audio block via Content Save API',
    );

    // Step 6: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Audio Block Update ───────────────────────────────────────────────

ContentSaveClient.prototype.updateAudioBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { title?: string; author?: string; designStyle?: string; colorTheme?: string; showDownload?: boolean },
): Promise<AudioBlockUpdateResult> {
  if (!updates.title && !updates.author && !updates.designStyle && !updates.colorTheme && updates.showDownload === undefined) {
    return { success: false, error: 'Must provide at least one field to update (title, author, designStyle, colorTheme, or showDownload)' };
  }

  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Step 2: Find the audio block
    const match = this.findBlock(data.sections, searchText);
    if (!match) {
      return { success: false, error: `No block found matching "${searchText}"` };
    }

    const { gridContent } = match;
    const blockValue = gridContent.content.value;

    // Step 3: Verify block type is audio (41)
    if (blockValue.type !== BLOCK_TYPE_AUDIO) {
      return {
        success: false,
        error: `Block "${searchText}" is type ${blockValue.type}, not an audio block (expected ${BLOCK_TYPE_AUDIO})`,
      };
    }

    const blockId = blockValue.id;
    const updatedFields: string[] = [];

    // Ensure value sub-object exists
    if (!blockValue.value) {
      blockValue.value = {};
    }

    // Step 4: Update provided fields
    if (updates.title !== undefined) {
      blockValue.value.title = updates.title;
      updatedFields.push('title');
    }
    if (updates.author !== undefined) {
      blockValue.value.iTunesAuthor = updates.author;
      updatedFields.push('author');
    }
    if (updates.designStyle !== undefined) {
      blockValue.value.designStyle = updates.designStyle;
      updatedFields.push('designStyle');
    }
    if (updates.colorTheme !== undefined) {
      blockValue.value.colorTheme = updates.colorTheme;
      updatedFields.push('colorTheme');
    }
    if (updates.showDownload !== undefined) {
      blockValue.value.showDownload = updates.showDownload;
      updatedFields.push('showDownload');
    }

    logger.info(
      { blockId, updatedFields, searchText },
      'Updating audio block via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId, updatedFields };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Page Link Block Add ───────────────────────────────────────────────

ContentSaveClient.prototype.addPageLinkBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  linkTitle: string,
  linkTarget: string,
  options?: {
    newWindow?: boolean;
    layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number };
  },
): Promise<PageLinkBlockAddResult> {
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
      if (gc.layout?.desktop) { if (gc.layout.desktop.verticalAlignment == null) gc.layout.desktop.verticalAlignment = 'top'; if (gc.layout.desktop.zIndex == null) gc.layout.desktop.zIndex = i; }
      if (gc.layout?.mobile) { if (gc.layout.mobile.verticalAlignment == null) gc.layout.mobile.verticalAlignment = 'top'; if (gc.layout.mobile.zIndex == null) gc.layout.mobile.zIndex = i; }
    }

    let maxY = 0, maxMobileY = 0;
    for (const gc of gridContents) { const ey = gc.layout?.desktop?.end?.y ?? 0; const my = gc.layout?.mobile?.end?.y ?? 0; if (ey > maxY) maxY = ey; if (my > maxMobileY) maxMobileY = my; }

    const layout = options?.layout;
    const rowHeight = layout?.rowHeight ?? 2;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);
    let startX: number, endX: number, startY: number, endY: number;
    if (layout?.startX != null && layout?.endX != null) { startX = Math.max(1, layout.startX); endX = Math.min(maxColumns + 1, layout.endX); }
    else { const cols = layout?.columns ?? maxColumns; startX = 1; endX = Math.min(startX + cols, maxColumns + 1); }
    if (layout?.startY != null && layout?.endY != null) { startY = Math.max(0, layout.startY); endY = layout.endY; }
    else { startY = maxY + gapRows; endY = startY + rowHeight; }

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
          type: BLOCK_TYPE_PAGE_LINK,
          value: { linkTitle, linkTarget, newWindow: options?.newWindow ?? false },
          containerStyles: { backgroundEnabled: false, stretchedToFill: false },
        },
      },
    };

    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);
    logger.info({ blockId, sectionIndex, sectionId: section.id, linkTitle, linkTarget }, 'Adding page link block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Page Link Block Update ────────────────────────────────────────────

ContentSaveClient.prototype.updatePageLinkBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { linkTitle?: string; linkTarget?: string; newWindow?: boolean },
): Promise<PageLinkBlockUpdateResult> {
  if (updates.linkTitle === undefined && updates.linkTarget === undefined && updates.newWindow === undefined) {
    return { success: false, error: 'Must provide at least one field to update (linkTitle, linkTarget, or newWindow)' };
  }
  try {
    const data = await this.getPageSections(pageSectionsId);
    const match = this.findBlock(data.sections, searchText);
    if (!match) return { success: false, error: `No block found matching "${searchText}"` };

    const blockValue = match.gridContent.content.value;
    if (blockValue.type !== BLOCK_TYPE_PAGE_LINK) {
      return { success: false, error: `Block "${searchText}" is type ${blockValue.type}, not a page link block (expected ${BLOCK_TYPE_PAGE_LINK})` };
    }

    const blockId = blockValue.id;
    const updatedFields: string[] = [];
    if (!blockValue.value) blockValue.value = {};
    if (updates.linkTitle !== undefined) { blockValue.value.linkTitle = updates.linkTitle; updatedFields.push('linkTitle'); }
    if (updates.linkTarget !== undefined) { blockValue.value.linkTarget = updates.linkTarget; updatedFields.push('linkTarget'); }
    if (updates.newWindow !== undefined) { blockValue.value.newWindow = updates.newWindow; updatedFields.push('newWindow'); }

    logger.info({ blockId, updatedFields, searchText }, 'Updating page link block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, updatedFields };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Horizontal Rule Block Add ─────────────────────────────────────────

ContentSaveClient.prototype.addHorizontalRuleBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
): Promise<HorizontalRuleBlockAddResult> {
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
      if (gc.layout?.desktop) { if (gc.layout.desktop.verticalAlignment == null) gc.layout.desktop.verticalAlignment = 'top'; if (gc.layout.desktop.zIndex == null) gc.layout.desktop.zIndex = i; }
      if (gc.layout?.mobile) { if (gc.layout.mobile.verticalAlignment == null) gc.layout.mobile.verticalAlignment = 'top'; if (gc.layout.mobile.zIndex == null) gc.layout.mobile.zIndex = i; }
    }

    let maxY = 0, maxMobileY = 0;
    for (const gc of gridContents) { const ey = gc.layout?.desktop?.end?.y ?? 0; const my = gc.layout?.mobile?.end?.y ?? 0; if (ey > maxY) maxY = ey; if (my > maxMobileY) maxMobileY = my; }

    const rowHeight = layout?.rowHeight ?? 1;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);
    let startX: number, endX: number, startY: number, endY: number;
    if (layout?.startX != null && layout?.endX != null) { startX = Math.max(1, layout.startX); endX = Math.min(maxColumns + 1, layout.endX); }
    else { const cols = layout?.columns ?? maxColumns; startX = 1; endX = Math.min(startX + cols, maxColumns + 1); }
    if (layout?.startY != null && layout?.endY != null) { startY = Math.max(0, layout.startY); endY = layout.endY; }
    else { startY = maxY + gapRows; endY = startY + rowHeight; }

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
          type: BLOCK_TYPE_HORIZONTAL_RULE,
          value: {},
          containerStyles: { backgroundEnabled: false, stretchedToFill: false },
        },
      },
    };

    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);
    logger.info({ blockId, sectionIndex, sectionId: section.id }, 'Adding horizontal rule block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Search Block Add ──────────────────────────────────────────────────

ContentSaveClient.prototype.addSearchBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  options?: {
    targetCollectionId?: string;
    searchPreview?: boolean;
    theme?: string;
    layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number };
  },
): Promise<SearchBlockAddResult> {
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
      if (gc.layout?.desktop) { if (gc.layout.desktop.verticalAlignment == null) gc.layout.desktop.verticalAlignment = 'top'; if (gc.layout.desktop.zIndex == null) gc.layout.desktop.zIndex = i; }
      if (gc.layout?.mobile) { if (gc.layout.mobile.verticalAlignment == null) gc.layout.mobile.verticalAlignment = 'top'; if (gc.layout.mobile.zIndex == null) gc.layout.mobile.zIndex = i; }
    }

    let maxY = 0, maxMobileY = 0;
    for (const gc of gridContents) { const ey = gc.layout?.desktop?.end?.y ?? 0; const my = gc.layout?.mobile?.end?.y ?? 0; if (ey > maxY) maxY = ey; if (my > maxMobileY) maxMobileY = my; }

    const layout = options?.layout;
    const rowHeight = layout?.rowHeight ?? 3;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);
    let startX: number, endX: number, startY: number, endY: number;
    if (layout?.startX != null && layout?.endX != null) { startX = Math.max(1, layout.startX); endX = Math.min(maxColumns + 1, layout.endX); }
    else { const cols = layout?.columns ?? maxColumns; startX = 1; endX = Math.min(startX + cols, maxColumns + 1); }
    if (layout?.startY != null && layout?.endY != null) { startY = Math.max(0, layout.startY); endY = layout.endY; }
    else { startY = maxY + gapRows; endY = startY + rowHeight; }

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
          type: BLOCK_TYPE_HORIZONTAL_RULE, // Search blocks share type 33 with horizontal rules
          value: {
            collectionFilter: true,
            collectionId: options?.targetCollectionId ?? '',
            searchPreview: options?.searchPreview ?? true,
            theme: options?.theme ?? 'dark',
          },
          containerStyles: { backgroundEnabled: false, stretchedToFill: false },
        },
      },
    };

    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);
    logger.info({ blockId, sectionIndex, sectionId: section.id }, 'Adding search block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Search Block Update ───────────────────────────────────────────────

ContentSaveClient.prototype.updateSearchBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { targetCollectionId?: string; searchPreview?: boolean; theme?: string },
): Promise<SearchBlockUpdateResult> {
  if (updates.targetCollectionId === undefined && updates.searchPreview === undefined && updates.theme === undefined) {
    return { success: false, error: 'Must provide at least one field to update (targetCollectionId, searchPreview, or theme)' };
  }
  try {
    const data = await this.getPageSections(pageSectionsId);
    // Search blocks are type 33 with collectionFilter in value — find manually
    let found: { section: any; gridContent: any; sectionIndex: number; blockIndex: number } | null = null;
    const needle = searchText.toLowerCase();
    for (const [si, section] of (data.sections || []).entries()) {
      for (const [bi, gc] of (section.fluidEngineContext?.gridContents || []).entries()) {
        const bv = gc.content?.value;
        if (bv?.type === BLOCK_TYPE_HORIZONTAL_RULE && bv.value?.collectionFilter) {
          // Match by collectionId, theme, or block ID
          const fields = [bv.value?.collectionId, bv.value?.theme, bv.id].filter(Boolean);
          for (const f of fields) {
            if (String(f).toLowerCase().includes(needle)) {
              found = { section, gridContent: gc, sectionIndex: si, blockIndex: bi };
              break;
            }
          }
          if (found) break;
        }
      }
      if (found) break;
    }
    if (!found) return { success: false, error: `No search block found matching "${searchText}"` };

    const blockValue = found.gridContent.content.value;
    const blockId = blockValue.id;
    const updatedFields: string[] = [];
    if (!blockValue.value) blockValue.value = {};
    if (updates.targetCollectionId !== undefined) { blockValue.value.collectionId = updates.targetCollectionId; updatedFields.push('collectionId'); }
    if (updates.searchPreview !== undefined) { blockValue.value.searchPreview = updates.searchPreview; updatedFields.push('searchPreview'); }
    if (updates.theme !== undefined) { blockValue.value.theme = updates.theme; updatedFields.push('theme'); }

    logger.info({ blockId, updatedFields, searchText }, 'Updating search block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, updatedFields };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Markdown Block Add ────────────────────────────────────────────────

ContentSaveClient.prototype.addMarkdownBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  source: string,
  layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number },
): Promise<MarkdownBlockAddResult> {
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
      if (gc.layout?.desktop) { if (gc.layout.desktop.verticalAlignment == null) gc.layout.desktop.verticalAlignment = 'top'; if (gc.layout.desktop.zIndex == null) gc.layout.desktop.zIndex = i; }
      if (gc.layout?.mobile) { if (gc.layout.mobile.verticalAlignment == null) gc.layout.mobile.verticalAlignment = 'top'; if (gc.layout.mobile.zIndex == null) gc.layout.mobile.zIndex = i; }
    }

    let maxY = 0, maxMobileY = 0;
    for (const gc of gridContents) { const ey = gc.layout?.desktop?.end?.y ?? 0; const my = gc.layout?.mobile?.end?.y ?? 0; if (ey > maxY) maxY = ey; if (my > maxMobileY) maxMobileY = my; }

    const rowHeight = layout?.rowHeight ?? 4;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);
    let startX: number, endX: number, startY: number, endY: number;
    if (layout?.startX != null && layout?.endX != null) { startX = Math.max(1, layout.startX); endX = Math.min(maxColumns + 1, layout.endX); }
    else { const cols = layout?.columns ?? maxColumns; startX = 1; endX = Math.min(startX + cols, maxColumns + 1); }
    if (layout?.startY != null && layout?.endY != null) { startY = Math.max(0, layout.startY); endY = layout.endY; }
    else { startY = maxY + gapRows; endY = startY + rowHeight; }

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
          type: BLOCK_TYPE_MARKDOWN,
          value: {
            wysiwyg: { engine: 'code', mode: 'markdown', isSource: false, source },
            html: '',
          },
          containerStyles: { backgroundEnabled: false, stretchedToFill: false },
        },
      },
    };

    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);
    logger.info({ blockId, sectionIndex, sectionId: section.id }, 'Adding markdown block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Markdown Block Update ─────────────────────────────────────────────

ContentSaveClient.prototype.updateMarkdownBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: { source?: string },
): Promise<MarkdownBlockUpdateResult> {
  if (updates.source === undefined) {
    return { success: false, error: 'Must provide source (markdown text) to update' };
  }
  try {
    const data = await this.getPageSections(pageSectionsId);
    const match = this.findBlock(data.sections, searchText);
    if (!match) return { success: false, error: `No block found matching "${searchText}"` };

    const blockValue = match.gridContent.content.value;
    if (blockValue.type !== BLOCK_TYPE_MARKDOWN) {
      return { success: false, error: `Block "${searchText}" is type ${blockValue.type}, not a markdown block (expected ${BLOCK_TYPE_MARKDOWN})` };
    }

    const blockId = blockValue.id;
    const updatedFields: string[] = [];
    if (!blockValue.value) blockValue.value = {};
    if (!blockValue.value.wysiwyg) blockValue.value.wysiwyg = { engine: 'code', mode: 'markdown', isSource: false, source: '' };
    blockValue.value.wysiwyg.source = updates.source;
    updatedFields.push('source');

    logger.info({ blockId, updatedFields, searchText }, 'Updating markdown block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, updatedFields };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Summary Block Add ─────────────────────────────────────────────────

ContentSaveClient.prototype.addSummaryBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  targetCollectionId: string,
  options?: {
    design?: string;
    headerText?: string;
    pageSize?: number;
    showTitle?: boolean;
    showThumbnail?: boolean;
    showExcerpt?: boolean;
    showReadMoreLink?: boolean;
    showPrice?: boolean;
    textAlignment?: string;
    imageAspectRatio?: number;
    layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number };
  },
): Promise<SummaryBlockAddResult> {
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
      if (gc.layout?.desktop) { if (gc.layout.desktop.verticalAlignment == null) gc.layout.desktop.verticalAlignment = 'top'; if (gc.layout.desktop.zIndex == null) gc.layout.desktop.zIndex = i; }
      if (gc.layout?.mobile) { if (gc.layout.mobile.verticalAlignment == null) gc.layout.mobile.verticalAlignment = 'top'; if (gc.layout.mobile.zIndex == null) gc.layout.mobile.zIndex = i; }
    }

    let maxY = 0, maxMobileY = 0;
    for (const gc of gridContents) { const ey = gc.layout?.desktop?.end?.y ?? 0; const my = gc.layout?.mobile?.end?.y ?? 0; if (ey > maxY) maxY = ey; if (my > maxMobileY) maxMobileY = my; }

    const layout = options?.layout;
    const rowHeight = layout?.rowHeight ?? 8;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);
    let startX: number, endX: number, startY: number, endY: number;
    if (layout?.startX != null && layout?.endX != null) { startX = Math.max(1, layout.startX); endX = Math.min(maxColumns + 1, layout.endX); }
    else { const cols = layout?.columns ?? maxColumns; startX = 1; endX = Math.min(startX + cols, maxColumns + 1); }
    if (layout?.startY != null && layout?.endY != null) { startY = Math.max(0, layout.startY); endY = layout.endY; }
    else { startY = maxY + gapRows; endY = startY + rowHeight; }

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
          type: BLOCK_TYPE_SUMMARY,
          value: {
            collectionId: targetCollectionId,
            design: options?.design ?? 'autocolumns',
            headerText: options?.headerText ?? 'Featured',
            textSize: 'medium',
            pageSize: options?.pageSize ?? 3,
            imageAspectRatio: options?.imageAspectRatio ?? 1.5,
            columnWidth: 270,
            gutter: 60,
            textAlignment: options?.textAlignment ?? 'left',
            showTitle: options?.showTitle ?? true,
            showThumbnail: options?.showThumbnail ?? true,
            showExcerpt: options?.showExcerpt ?? true,
            showReadMoreLink: options?.showReadMoreLink ?? false,
            showPrice: options?.showPrice ?? true,
            metadataPosition: 'below-content',
            primaryMetadata: 'none',
            secondaryMetadata: 'none',
            filter: {},
            autoCrop: true,
            mixedContent: true,
          },
          containerStyles: { backgroundEnabled: false, stretchedToFill: false },
        },
      },
    };

    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);
    logger.info({ blockId, sectionIndex, sectionId: section.id, targetCollectionId }, 'Adding summary block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Summary Block Update ──────────────────────────────────────────────

ContentSaveClient.prototype.updateSummaryBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    targetCollectionId?: string; design?: string; headerText?: string; pageSize?: number;
    showTitle?: boolean; showThumbnail?: boolean; showExcerpt?: boolean; showReadMoreLink?: boolean;
    showPrice?: boolean; textAlignment?: string; imageAspectRatio?: number;
  },
): Promise<SummaryBlockUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const match = this.findBlock(data.sections, searchText);
    if (!match) return { success: false, error: `No block found matching "${searchText}"` };

    const blockValue = match.gridContent.content.value;
    if (blockValue.type !== BLOCK_TYPE_SUMMARY) {
      return { success: false, error: `Block "${searchText}" is type ${blockValue.type}, not a summary block (expected ${BLOCK_TYPE_SUMMARY})` };
    }

    const blockId = blockValue.id;
    const updatedFields: string[] = [];
    if (!blockValue.value) blockValue.value = {};
    if (updates.targetCollectionId !== undefined) { blockValue.value.collectionId = updates.targetCollectionId; updatedFields.push('collectionId'); }
    if (updates.design !== undefined) { blockValue.value.design = updates.design; updatedFields.push('design'); }
    if (updates.headerText !== undefined) { blockValue.value.headerText = updates.headerText; updatedFields.push('headerText'); }
    if (updates.pageSize !== undefined) { blockValue.value.pageSize = updates.pageSize; updatedFields.push('pageSize'); }
    if (updates.showTitle !== undefined) { blockValue.value.showTitle = updates.showTitle; updatedFields.push('showTitle'); }
    if (updates.showThumbnail !== undefined) { blockValue.value.showThumbnail = updates.showThumbnail; updatedFields.push('showThumbnail'); }
    if (updates.showExcerpt !== undefined) { blockValue.value.showExcerpt = updates.showExcerpt; updatedFields.push('showExcerpt'); }
    if (updates.showReadMoreLink !== undefined) { blockValue.value.showReadMoreLink = updates.showReadMoreLink; updatedFields.push('showReadMoreLink'); }
    if (updates.showPrice !== undefined) { blockValue.value.showPrice = updates.showPrice; updatedFields.push('showPrice'); }
    if (updates.textAlignment !== undefined) { blockValue.value.textAlignment = updates.textAlignment; updatedFields.push('textAlignment'); }
    if (updates.imageAspectRatio !== undefined) { blockValue.value.imageAspectRatio = updates.imageAspectRatio; updatedFields.push('imageAspectRatio'); }

    logger.info({ blockId, updatedFields, searchText }, 'Updating summary block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, updatedFields };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Product Block Add ─────────────────────────────────────────────────

ContentSaveClient.prototype.addProductBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  productId: string,
  options?: {
    showTitle?: boolean;
    showPrice?: boolean;
    showBuyButton?: boolean;
    showQuantity?: boolean;
    showExcerpt?: boolean;
    showImage?: boolean;
    alignment?: string;
    layout?: { columns?: number; rowHeight?: number; gapRows?: number; startX?: number; endX?: number; startY?: number; endY?: number };
  },
): Promise<ProductBlockAddResult> {
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
      if (gc.layout?.desktop) { if (gc.layout.desktop.verticalAlignment == null) gc.layout.desktop.verticalAlignment = 'top'; if (gc.layout.desktop.zIndex == null) gc.layout.desktop.zIndex = i; }
      if (gc.layout?.mobile) { if (gc.layout.mobile.verticalAlignment == null) gc.layout.mobile.verticalAlignment = 'top'; if (gc.layout.mobile.zIndex == null) gc.layout.mobile.zIndex = i; }
    }

    let maxY = 0, maxMobileY = 0;
    for (const gc of gridContents) { const ey = gc.layout?.desktop?.end?.y ?? 0; const my = gc.layout?.mobile?.end?.y ?? 0; if (ey > maxY) maxY = ey; if (my > maxMobileY) maxMobileY = my; }

    const layout = options?.layout;
    const rowHeight = layout?.rowHeight ?? 6;
    const gapRows = layout?.gapRows ?? (gridContents.length > 0 ? 2 : 0);
    let startX: number, endX: number, startY: number, endY: number;
    if (layout?.startX != null && layout?.endX != null) { startX = Math.max(1, layout.startX); endX = Math.min(maxColumns + 1, layout.endX); }
    else { const cols = layout?.columns ?? maxColumns; startX = 1; endX = Math.min(startX + cols, maxColumns + 1); }
    if (layout?.startY != null && layout?.endY != null) { startY = Math.max(0, layout.startY); endY = layout.endY; }
    else { startY = maxY + gapRows; endY = startY + rowHeight; }

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
          type: 1337,
          value: {
            alignment: options?.alignment ?? 'left',
            showTitle: options?.showTitle ?? true,
            showBuyButton: options?.showBuyButton ?? false,
            showQuantity: options?.showQuantity ?? false,
            showPrice: options?.showPrice ?? true,
            showExcerpt: options?.showExcerpt ?? false,
            showImage: options?.showImage ?? true,
            productId,
            productQuickViewEnabled: false,
            addToCartButtonVariant: 'primary',
          },
          containerStyles: { backgroundEnabled: false, stretchedToFill: false },
          definitionName: PRODUCT_DEFINITION_NAME,
        },
      },
    };

    gridContents.push(newBlock);
    this.updateSectionRows(section, endY, maxMobileY + gapRows + rowHeight);
    logger.info({ blockId, sectionIndex, sectionId: section.id, productId }, 'Adding product block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, sectionId: section.id, sectionIndex };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};

// ── Product Block Update ──────────────────────────────────────────────

ContentSaveClient.prototype.updateProductBlock = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  updates: {
    productId?: string; showTitle?: boolean; showPrice?: boolean; showBuyButton?: boolean;
    showQuantity?: boolean; showExcerpt?: boolean; showImage?: boolean; alignment?: string;
  },
): Promise<ProductBlockUpdateResult> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const match = this.findBlock(data.sections, searchText);
    if (!match) return { success: false, error: `No block found matching "${searchText}"` };

    const blockValue = match.gridContent.content.value;
    if (blockValue.type !== 1337 || blockValue.definitionName !== PRODUCT_DEFINITION_NAME) {
      return { success: false, error: `Block "${searchText}" is not a product block` };
    }

    const blockId = blockValue.id;
    const updatedFields: string[] = [];
    if (!blockValue.value) blockValue.value = {};
    if (updates.productId !== undefined) { blockValue.value.productId = updates.productId; updatedFields.push('productId'); }
    if (updates.showTitle !== undefined) { blockValue.value.showTitle = updates.showTitle; updatedFields.push('showTitle'); }
    if (updates.showPrice !== undefined) { blockValue.value.showPrice = updates.showPrice; updatedFields.push('showPrice'); }
    if (updates.showBuyButton !== undefined) { blockValue.value.showBuyButton = updates.showBuyButton; updatedFields.push('showBuyButton'); }
    if (updates.showQuantity !== undefined) { blockValue.value.showQuantity = updates.showQuantity; updatedFields.push('showQuantity'); }
    if (updates.showExcerpt !== undefined) { blockValue.value.showExcerpt = updates.showExcerpt; updatedFields.push('showExcerpt'); }
    if (updates.showImage !== undefined) { blockValue.value.showImage = updates.showImage; updatedFields.push('showImage'); }
    if (updates.alignment !== undefined) { blockValue.value.alignment = updates.alignment; updatedFields.push('alignment'); }

    logger.info({ blockId, updatedFields, searchText }, 'Updating product block via Content Save API');
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) return { success: false, error: saveResult.error };
    return { success: true, blockId, updatedFields };
  } catch (err) { return { success: false, error: errMsg(err) }; }
};
