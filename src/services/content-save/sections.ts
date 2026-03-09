import { ContentSaveClient, FETCH_TIMEOUT_MS } from './client.js';
import type {
  SectionMoveResult,
  SectionStyleOptions,
  SectionStyleResult,
  SectionDuplicateResult,
  SectionReorderResult,
  AddBlankSectionResult,
  AddSectionWithBlocksResult,
  InitialBlock,
  CopyTemplateSectionResult,
  GridContent,
  PageSection,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    moveSection(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      direction: 'up' | 'down',
    ): Promise<SectionMoveResult>;
    editSectionStyle(
      pageSectionsId: string,
      collectionId: string,
      sectionSearch: number | string,
      styles: SectionStyleOptions,
    ): Promise<SectionStyleResult>;
    duplicateSection(
      pageSectionsId: string,
      collectionId: string,
      sectionSearch: number | string,
    ): Promise<SectionDuplicateResult>;
    reorderSections(
      pageSectionsId: string,
      collectionId: string,
      newOrder: number[],
    ): Promise<SectionReorderResult>;
    addBlankSection(
      pageSectionsId: string,
      collectionId: string,
      position?: number,
    ): Promise<AddBlankSectionResult>;
    addSectionWithBlocks(
      pageSectionsId: string,
      collectionId: string,
      blocks: InitialBlock[],
      options?: {
        position?: number;
        styles?: Record<string, unknown>;
      },
    ): Promise<AddSectionWithBlocksResult>;
    copyTemplateSection(
      sourceWebsiteId: string,
      sourceCollectionId: string,
      sourceSectionId: string,
      _isRetry?: boolean,
    ): Promise<CopyTemplateSectionResult>;
    verifySectionAdded(
      pageSectionsId: string,
      expectedCount: number,
    ): Promise<{ verified: boolean; actualCount: number; sections: PageSection[] }>;
    updateSectionDivider(
      pageSectionsId: string,
      collectionId: string,
      sectionIndex: number,
      dividerConfig: Record<string, unknown>,
    ): Promise<{ success: boolean; sectionId?: string; error?: string }>;
    removeSectionDivider(
      pageSectionsId: string,
      collectionId: string,
      sectionIndex: number,
    ): Promise<{ success: boolean; sectionId?: string; error?: string }>;
  }
}

// ── Prototype methods ───────────────────────────────────────────────────────

ContentSaveClient.prototype.moveSection = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  direction: 'up' | 'down',
): Promise<SectionMoveResult> {
  try {
    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    if (!sections || sections.length === 0) {
      return { success: false, error: 'Page has no sections' };
    }

    // Step 2: Find the section containing the searchText via findBlock()
    const match = this.findBlock(sections, searchText);
    if (!match) {
      return { success: false, error: `No section found containing text "${searchText}"` };
    }

    const sectionIndex = match.sectionIndex;
    const section = sections[sectionIndex];
    const sectionId = section.id;
    const sectionName = section.sectionName;

    // Step 3: Check boundary conditions
    if (sections.length === 1) {
      return {
        success: true,
        sectionId,
        sectionName,
        oldIndex: 0,
        newIndex: 0,
        error: 'Only one section on page — nothing to reorder',
      };
    }

    if (direction === 'up' && sectionIndex === 0) {
      return {
        success: true,
        sectionId,
        sectionName,
        oldIndex: 0,
        newIndex: 0,
      };
    }

    if (direction === 'down' && sectionIndex === sections.length - 1) {
      return {
        success: true,
        sectionId,
        sectionName,
        oldIndex: sectionIndex,
        newIndex: sectionIndex,
      };
    }

    // Step 4: Splice out and reinsert at new position
    const newIndex = direction === 'up' ? sectionIndex - 1 : sectionIndex + 1;
    sections.splice(sectionIndex, 1);
    sections.splice(newIndex, 0, section);

    logger.info(
      { sectionId, sectionName, direction, oldIndex: sectionIndex, newIndex },
      'Moving section via Content Save API',
    );

    // Step 5: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      sectionId,
      sectionName,
      oldIndex: sectionIndex,
      newIndex,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.editSectionStyle = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionSearch: number | string,
  styles: SectionStyleOptions,
): Promise<SectionStyleResult> {
  try {
    this.ensureCookies();

    // Validate that at least one style property was provided
    const styleKeys = Object.keys(styles).filter(
      (k) => styles[k as keyof SectionStyleOptions] !== undefined,
    );
    if (styleKeys.length === 0) {
      return { success: false, error: 'No style properties provided' };
    }

    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    if (!sections || sections.length === 0) {
      return { success: false, error: 'Page has no sections' };
    }

    // Step 2: Find the target section
    let sectionIndex: number;
    if (typeof sectionSearch === 'number') {
      if (sectionSearch < 0 || sectionSearch >= sections.length) {
        return {
          success: false,
          error: `Section index ${sectionSearch} out of range (0-${sections.length - 1})`,
        };
      }
      sectionIndex = sectionSearch;
    } else {
      const match = this.findBlock(sections, sectionSearch);
      if (!match) {
        return { success: false, error: `No section found containing text "${sectionSearch}"` };
      }
      sectionIndex = match.sectionIndex;
    }

    const section = sections[sectionIndex];
    const updatedFields: string[] = [];

    // Step 3: Apply style properties.
    //
    // Confirmed API structure (live capture, grey-yellow-hbxc, Mar 2026):
    // - sectionTheme, sectionHeight, contentWidth, verticalAlignment live in section.styles.*
    // - divider lives at section.divider (top-level)
    // - backgroundColor, paddingTop, paddingBottom, blockSpacing: NOT confirmed API fields;
    //   written to top-level as best-effort (browser agent handles these via UI)

    // Helper: add CSS class prefix if not already present
    const withPrefix = (prefix: string, v: string) =>
      v.startsWith(`${prefix}--`) ? v : `${prefix}--${v}`;

    // Ensure section.styles object exists
    const sec = section as Record<string, unknown>;
    if (!sec.styles || typeof sec.styles !== 'object') {
      sec.styles = {};
    }
    const sectionStyles = sec.styles as Record<string, unknown>;

    // ── Confirmed fields → write to section.styles.* ────────────────────
    if (styles.sectionTheme !== undefined) {
      sectionStyles.sectionTheme = styles.sectionTheme.toLowerCase();
      updatedFields.push('sectionTheme');
    }
    if (styles.sectionHeight !== undefined) {
      sectionStyles.sectionHeight = withPrefix('section-height', styles.sectionHeight);
      updatedFields.push('sectionHeight');
    }
    if (styles.contentWidth !== undefined) {
      sectionStyles.contentWidth = withPrefix('content-width', styles.contentWidth);
      updatedFields.push('contentWidth');
    }
    if (styles.verticalAlignment !== undefined) {
      sectionStyles.verticalAlignment = withPrefix('vertical-alignment', styles.verticalAlignment);
      updatedFields.push('verticalAlignment');
    }

    // ── Divider → section.divider (top-level) ───────────────────────────
    if (styles.divider !== undefined) {
      sec.divider = styles.divider === null ? { enabled: false } : styles.divider;
      updatedFields.push('divider');
    }

    // ── Legacy / unverified fields → top-level best-effort ──────────────
    if (styles.backgroundColor !== undefined) {
      sec.backgroundColor = styles.backgroundColor;
      updatedFields.push('backgroundColor');
    }
    if (styles.paddingTop !== undefined) {
      sec.paddingTop = styles.paddingTop;
      updatedFields.push('paddingTop');
    }
    if (styles.paddingBottom !== undefined) {
      sec.paddingBottom = styles.paddingBottom;
      updatedFields.push('paddingBottom');
    }
    if (styles.blockSpacing !== undefined) {
      sec.blockSpacing = styles.blockSpacing;
      updatedFields.push('blockSpacing');
    }

    logger.info(
      { sectionId: section.id, sectionIndex, updatedFields },
      'Editing section style via Content Save API',
    );

    // Step 4: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      sectionId: section.id,
      sectionIndex,
      updatedFields,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.duplicateSection = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionSearch: number | string,
): Promise<SectionDuplicateResult> {
  try {
    this.ensureCookies();

    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    if (!sections || sections.length === 0) {
      return { success: false, error: 'Page has no sections' };
    }

    // Step 2: Find the target section
    let sectionIndex: number;
    if (typeof sectionSearch === 'number') {
      if (sectionSearch < 0 || sectionSearch >= sections.length) {
        return {
          success: false,
          error: `Section index ${sectionSearch} out of range (0-${sections.length - 1})`,
        };
      }
      sectionIndex = sectionSearch;
    } else {
      const match = this.findBlock(sections, sectionSearch);
      if (!match) {
        return { success: false, error: `No section found containing text "${sectionSearch}"` };
      }
      sectionIndex = match.sectionIndex;
    }

    const originalSection = sections[sectionIndex];

    // Step 3: Deep clone the section
    const cloned: PageSection = JSON.parse(JSON.stringify(originalSection));

    // Step 4: Generate new section ID
    const newSectionId = ContentSaveClient.generateSectionId();
    cloned.id = newSectionId;

    // Step 5: Regenerate fluidEngineContext.id if present
    if (cloned.fluidEngineContext) {
      (cloned.fluidEngineContext as Record<string, unknown>).id = ContentSaveClient.generateSectionId();

      // Step 6: Regenerate ALL block IDs in the cloned section
      const gridContents = cloned.fluidEngineContext.gridContents;
      if (gridContents) {
        for (const gc of gridContents) {
          if (gc.content?.value?.id) {
            gc.content.value.id = ContentSaveClient.generateBlockId();
          }
        }
      }
    }

    // Step 7: Insert clone after original
    const newIndex = sectionIndex + 1;
    sections.splice(newIndex, 0, cloned);

    logger.info(
      { originalSectionId: originalSection.id, newSectionId, newIndex, totalSections: sections.length },
      'Duplicating section via Content Save API',
    );

    // Step 8: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      originalSectionId: originalSection.id,
      newSectionId,
      newSectionIndex: newIndex,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.reorderSections = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  newOrder: number[],
): Promise<SectionReorderResult> {
  try {
    this.ensureCookies();

    // Step 1: GET current sections
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    if (!sections || sections.length === 0) {
      return { success: false, error: 'Page has no sections' };
    }

    // Step 2: Validate newOrder
    if (newOrder.length !== sections.length) {
      return {
        success: false,
        error: `newOrder length (${newOrder.length}) does not match sections count (${sections.length})`,
      };
    }

    // Check for duplicates and out-of-range
    const seen = new Set<number>();
    for (const idx of newOrder) {
      if (idx < 0 || idx >= sections.length) {
        return { success: false, error: `Index ${idx} out of range (0-${sections.length - 1})` };
      }
      if (seen.has(idx)) {
        return { success: false, error: `Duplicate index ${idx} in newOrder` };
      }
      seen.add(idx);
    }

    // Step 3: Rearrange sections
    const reordered = newOrder.map((idx) => sections[idx]);
    data.sections = reordered;

    logger.info(
      { newOrder, sectionsCount: sections.length },
      'Reordering sections via Content Save API',
    );

    // Step 4: PUT the modified sections
    const saveResult = await this.savePageSections(pageSectionsId, collectionId, reordered);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      newOrder,
      sectionsCount: sections.length,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.addBlankSection = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  position?: number,
): Promise<AddBlankSectionResult> {
  try {
    this.ensureCookies();

    // GET current sections
    const data = await this.getPageSections(pageSectionsId);

    // Construct a blank Fluid Engine section matching what Squarespace creates
    // when "Add Blank" is clicked in the UI. Section IDs must be 24-char hex
    // (12-byte ObjectID format) — Squarespace returns 400 for shorter IDs.
    // The structure must include styles, sourceType, isCloneable, and full
    // gridSettings (with mobile breakpoint and rowSize/rowGap/columnGap).
    const newSectionId = ContentSaveClient.generateSectionId();
    const blankSection: PageSection = {
      id: newSectionId,
      sectionName: 'FLUID_ENGINE',
      isCloneable: false,
      styles: {
        backgroundWidth: 'background-width--full-bleed',
        imageOverlayOpacity: 0.15,
        sectionHeight: 'section-height--medium',
        customSectionHeight: 10,
        horizontalAlignment: 'horizontal-alignment--center',
        verticalAlignment: 'vertical-alignment--middle',
        contentWidth: 'content-width--wide',
        customContentWidth: 50,
        sectionTheme: '',
        sectionAnimation: 'none',
        backgroundMode: 'image',
      },
      sourceType: 'blank',
      fluidEngineContext: {
        id: ContentSaveClient.generateSectionId(),
        gridContents: [],
        gridSettings: {
          rowGap: { unit: 'px', value: 11 },
          columnGap: { unit: 'px', value: 11 },
          rowStretch: false,
          breakpointSettings: {
            mobile: { rows: 2, columns: 8, rowSize: { unit: 'vw', value: 6 } },
            desktop: { rows: 8, columns: 24, rowSize: { unit: 'vw', value: 2 } },
          },
        },
      },
    };

    // Insert at position or append
    const updatedSections = [...data.sections];
    let sectionIndex: number;
    if (position !== undefined && position >= 0 && position < updatedSections.length) {
      updatedSections.splice(position, 0, blankSection);
      sectionIndex = position;
    } else {
      updatedSections.push(blankSection);
      sectionIndex = updatedSections.length - 1;
    }

    logger.info({ pageSectionsId, newSectionId, sectionIndex, totalSections: updatedSections.length }, 'Adding blank section via PUT');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, updatedSections);

    if (!saveResult.success) {
      return { success: false, error: saveResult.error ?? 'savePageSections failed' };
    }

    logger.info({ newSectionId }, 'Blank section added via API');
    return { success: true, sectionId: newSectionId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.addSectionWithBlocks = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  blocks: InitialBlock[],
  options?: {
    position?: number;
    styles?: Record<string, unknown>;
  },
): Promise<AddSectionWithBlocksResult> {
  try {
    if (blocks.length === 0) {
      return { success: false, error: 'addSectionWithBlocks requires at least one block' };
    }

    this.ensureCookies();
    const data = await this.getPageSections(pageSectionsId);

    // Build blank section skeleton (same as addBlankSection)
    const newSectionId = ContentSaveClient.generateSectionId();
    const defaultStyles = {
      backgroundWidth: 'background-width--full-bleed',
      imageOverlayOpacity: 0.15,
      sectionHeight: 'section-height--medium',
      customSectionHeight: 10,
      horizontalAlignment: 'horizontal-alignment--center',
      verticalAlignment: 'vertical-alignment--middle',
      contentWidth: 'content-width--wide',
      customContentWidth: 50,
      sectionTheme: '',
      sectionAnimation: 'none',
      backgroundMode: 'image',
      ...(options?.styles ?? {}),
    };

    // Build gridContents from InitialBlock specs
    const gridContents: GridContent[] = [];
    const blockIds: string[] = [];
    const maxColumns = 24;
    let maxY = 0;
    let maxMobileY = 0;

    for (let i = 0; i < blocks.length; i++) {
      const spec = blocks[i];
      const blockId = ContentSaveClient.generateBlockId();
      blockIds.push(blockId);

      // Build content for this block type
      let content: GridContent['content'];
      let defaultCols: number;
      let defaultRowHeight: number;

      switch (spec.type) {
        case 'text':
          content = ContentSaveClient.buildTextBlockContent(blockId, spec.html, spec.formatting);
          defaultCols = maxColumns;
          defaultRowHeight = 3;
          break;
        case 'embed':
          content = ContentSaveClient.buildEmbedBlockContent(blockId, spec.html);
          defaultCols = 12;
          defaultRowHeight = 6;
          break;
        case 'button':
          content = ContentSaveClient.buildButtonBlockContent(blockId, spec.text, spec.url);
          defaultCols = 7;
          defaultRowHeight = 2;
          break;
        case 'image': {
          // Create content image record (required for Fluid Engine to render)
          const contentImg = await this.createContentImage(spec.assetUrl);
          if (!contentImg.imageId) {
            logger.warn({ error: contentImg.error }, 'Could not create content image — block may not render');
          }
          content = ContentSaveClient.buildImageBlockContent(blockId, spec.assetUrl, spec.altText, contentImg.imageId);
          defaultCols = 12;
          defaultRowHeight = 8;
          break;
        }
        case 'video':
          content = ContentSaveClient.buildVideoBlockContent(blockId, spec.videoUrl, spec.title, spec.description);
          defaultCols = maxColumns;
          defaultRowHeight = 8;
          break;
        default:
          return { success: false, error: `Unknown block type: ${(spec as any).type}` };
      }

      // Calculate layout
      const layout = spec.layout;
      const gapRows = layout?.gapRows ?? (i > 0 ? 2 : 0);
      const rowHeight = layout?.rowHeight ?? defaultRowHeight;
      let startX: number, endX: number, startY: number, endY: number;

      if (layout?.startX != null && layout?.endX != null) {
        startX = Math.max(1, layout.startX);
        endX = Math.min(maxColumns + 1, layout.endX);
      } else {
        const cols = layout?.columns ?? defaultCols;
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

      const mobileStartY = maxMobileY + gapRows;
      const mobileEndY = mobileStartY + rowHeight;

      const zIndex = i;

      gridContents.push({
        layout: {
          mobile: { start: { x: 1, y: mobileStartY }, end: { x: 9, y: mobileEndY }, visible: true, verticalAlignment: 'top', zIndex },
          desktop: { start: { x: startX, y: startY }, end: { x: endX, y: endY }, visible: true, verticalAlignment: 'top', zIndex },
        },
        content,
      });

      // Update maxY for next block
      maxY = endY;
      maxMobileY = mobileEndY;
    }

    const newSection: PageSection = {
      id: newSectionId,
      sectionName: 'FLUID_ENGINE',
      isCloneable: false,
      styles: defaultStyles,
      sourceType: 'blank',
      fluidEngineContext: {
        id: ContentSaveClient.generateSectionId(),
        gridContents,
        gridSettings: {
          rowGap: { unit: 'px', value: 11 },
          columnGap: { unit: 'px', value: 11 },
          rowStretch: false,
          breakpointSettings: {
            mobile: { rows: Math.max(2, maxMobileY + 1), columns: 8, rowSize: { unit: 'vw', value: 6 } },
            desktop: { rows: Math.max(8, maxY + 1), columns: 24, rowSize: { unit: 'vw', value: 2 } },
          },
        },
      },
    };

    // Insert at position or append
    const sections = [...data.sections];
    let sectionIndex: number;
    if (options?.position !== undefined && options.position >= 0 && options.position < sections.length) {
      sections.splice(options.position, 0, newSection);
      sectionIndex = options.position;
    } else {
      sections.push(newSection);
      sectionIndex = sections.length - 1;
    }

    logger.info({ pageSectionsId, newSectionId, blockCount: blocks.length, sectionIndex }, 'Adding section with blocks via PUT');

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error ?? 'savePageSections failed' };
    }

    return { success: true, sectionId: newSectionId, sectionIndex, blockIds };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.copyTemplateSection = async function (
  this: ContentSaveClient,
  sourceWebsiteId: string,
  sourceCollectionId: string,
  sourceSectionId: string,
  _isRetry = false,
): Promise<CopyTemplateSectionResult> {
  try {
    this.ensureCookies();

    const path = `/api/content/copy/section?sourceWebsiteId=${encodeURIComponent(sourceWebsiteId)}&sourceCollectionId=${encodeURIComponent(sourceCollectionId)}&sourceSectionId=${encodeURIComponent(sourceSectionId)}`;
    const url = this.buildApiUrl(path, true);

    logger.info(
      { sourceWebsiteId, sourceCollectionId, sourceSectionId },
      'Copying template section via API',
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([]),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, body, `Failed to copy template section: ${response.status}. ${body}`) };
    }

    const data = await response.json().catch(() => ({})) as Record<string, unknown>;

    // Handle crumb refresh if needed
    if (data.crumbFail) {
      if (!_isRetry && await this.handleCrumbFailure(JSON.stringify(data))) {
        logger.info('copyTemplateSection: retrying after crumb refresh');
        return this.copyTemplateSection(sourceWebsiteId, sourceCollectionId, sourceSectionId, true);
      }
      return { success: false, error: `Crumb validation failed. ${data.error || ''}` };
    }

    const sectionId = data.id as string | undefined;

    logger.info({ sectionId }, 'Template section copied via API');
    return { success: true, sectionId, sectionData: data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.verifySectionAdded = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  expectedCount: number,
): Promise<{ verified: boolean; actualCount: number; sections: PageSection[] }> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const actualCount = data.sections?.length ?? 0;
    const verified = actualCount >= expectedCount;
    if (!verified) {
      logger.warn(
        { pageSectionsId, expectedCount, actualCount },
        'verifySectionAdded: section count mismatch — section may not have persisted',
      );
    }
    return { verified, actualCount, sections: data.sections ?? [] };
  } catch (err) {
    logger.warn({ pageSectionsId, error: errMsg(err) }, 'verifySectionAdded: failed to re-fetch sections');
    return { verified: false, actualCount: -1, sections: [] };
  }
};

ContentSaveClient.prototype.updateSectionDivider = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
  dividerConfig: Record<string, unknown>,
): Promise<{ success: boolean; sectionId?: string; error?: string }> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    if (!sections || sectionIndex < 0 || sectionIndex >= sections.length) {
      return {
        success: false,
        error: `Section index ${sectionIndex} out of bounds (page has ${sections?.length ?? 0} sections)`,
      };
    }

    const section = sections[sectionIndex];
    // Merge onto existing divider (preserve fields not in dividerConfig)
    (section as Record<string, unknown>).divider = { ...((section as Record<string, unknown>).divider as Record<string, unknown> ?? {}), ...dividerConfig };

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    logger.info(
      { pageSectionsId, sectionIndex, sectionId: section.id, dividerType: dividerConfig.type },
      'Section divider updated',
    );

    return { success: true, sectionId: section.id };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.removeSectionDivider = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  sectionIndex: number,
): Promise<{ success: boolean; sectionId?: string; error?: string }> {
  try {
    const data = await this.getPageSections(pageSectionsId);
    const sections = data.sections;

    if (!sections || sectionIndex < 0 || sectionIndex >= sections.length) {
      return {
        success: false,
        error: `Section index ${sectionIndex} out of bounds (page has ${sections?.length ?? 0} sections)`,
      };
    }

    const section = sections[sectionIndex];
    (section as Record<string, unknown>).divider = { enabled: false };

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    logger.info(
      { pageSectionsId, sectionIndex, sectionId: section.id },
      'Section divider removed',
    );

    return { success: true, sectionId: section.id };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
