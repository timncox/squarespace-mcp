import { ContentSaveClient, FETCH_TIMEOUT_MS } from './client.js';
import type { FooterTextUpdateResult, HeaderFooterConfig, PageSection } from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    getHeaderFooter(): Promise<{ success: boolean; config?: HeaderFooterConfig; error?: string }>;
    getFooterSections(): Promise<{
      success: boolean;
      sections?: PageSection[];
      pageSectionsId?: string;
      collectionId?: string;
      error?: string;
    }>;
    updateFooterTextBlock(
      searchText: string,
      newText: string,
    ): Promise<FooterTextUpdateResult>;
    patchFooterTextBlock(
      searchText: string,
      newText: string,
    ): Promise<FooterTextUpdateResult>;
    getHeaderSections(): Promise<{
      success: boolean;
      sections?: PageSection[];
      pageSectionsId?: string;
      collectionId?: string;
      error?: string;
    }>;
    patchHeaderTextBlock(
      searchText: string,
      newText: string,
    ): Promise<FooterTextUpdateResult>;
    saveHeaderFooter(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  }
}

// ── Prototype methods ───────────────────────────────────────────────────────

ContentSaveClient.prototype.getHeaderFooter = async function (
  this: ContentSaveClient,
): Promise<{ success: boolean; config?: HeaderFooterConfig; error?: string }> {
  this.ensureCookies();

  const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
  const url = `${siteUrl}/api/site-header-footer`;

  logger.info({ siteSubdomain: this.siteSubdomain }, 'Fetching site header/footer config');

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        success: false,
        error: `${response.status} ${response.statusText}: ${body}`,
      };
    }

    const data = (await response.json()) as HeaderFooterConfig;
    logger.info(
      {
        hasFooter: !!data.footer,
        hasHeader: !!data.header,
        footerPageSectionsId: data.footer?.pageSectionsId,
        topLevelKeys: Object.keys(data),
      },
      'Site header/footer config fetched',
    );

    return { success: true, config: data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.getFooterSections = async function (
  this: ContentSaveClient,
): Promise<{
  success: boolean;
  sections?: PageSection[];
  pageSectionsId?: string;
  collectionId?: string;
  error?: string;
}> {
  try {
    // Step 1: Get footer config to find pageSectionsId
    const configResult = await this.getHeaderFooter();
    if (!configResult.success || !configResult.config) {
      return { success: false, error: configResult.error ?? 'Failed to get header/footer config' };
    }

    const config = configResult.config;

    // The footer's pageSectionsId may be at:
    // - config.footer.pageSectionsId (most likely)
    // - config.footerPageSectionsId (alternate)
    // - config.footer.id (alternate)
    const footerPsId =
      config.footer?.pageSectionsId ??
      (config as Record<string, unknown>).footerPageSectionsId as string | undefined ??
      config.footer?.id as string | undefined;

    if (!footerPsId || typeof footerPsId !== 'string') {
      // If no pageSectionsId found, the footer config itself might contain
      // sections directly (some Squarespace versions embed them)
      const embeddedSections = config.footer?.sections as PageSection[] | undefined;
      if (embeddedSections && Array.isArray(embeddedSections)) {
        logger.info(
          { sectionsCount: embeddedSections.length },
          'Found embedded footer sections in header-footer config',
        );
        return { success: true, sections: embeddedSections };
      }

      return {
        success: false,
        error: 'Footer pageSectionsId not found in header-footer config. ' +
          `Available keys: ${JSON.stringify(Object.keys(config))}` +
          (config.footer ? `, footer keys: ${JSON.stringify(Object.keys(config.footer))}` : ''),
      };
    }

    logger.info({ footerPsId }, 'Found footer pageSectionsId — fetching sections');

    // Step 2: Fetch the actual footer sections using the page-sections API
    const data = await this.getPageSections(footerPsId);

    // Try to extract collectionId from the response
    const collectionId = data.collectionId ?? (data as Record<string, unknown>).websiteId as string | undefined;

    return {
      success: true,
      sections: data.sections,
      pageSectionsId: footerPsId,
      collectionId: collectionId ?? undefined,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateFooterTextBlock = async function (
  this: ContentSaveClient,
  searchText: string,
  newText: string,
): Promise<FooterTextUpdateResult> {
  try {
    // Step 1: Get footer sections + IDs
    const footerResult = await this.getFooterSections();
    if (!footerResult.success || !footerResult.sections) {
      return { success: false, error: footerResult.error ?? 'Failed to get footer sections' };
    }

    const { sections, pageSectionsId, collectionId } = footerResult;

    // Step 2: Find the text block
    const match = this.findTextBlock(sections, searchText);
    if (!match) {
      return {
        success: false,
        error: `No text block found in the footer containing "${searchText}"`,
      };
    }

    const { gridContent, sectionIndex, blockIndex } = match;
    const blockValue = gridContent.content.value;
    const oldHtml = blockValue.value?.html ?? '';
    const blockId = blockValue.id;

    logger.info(
      { blockId, sectionIndex, blockIndex, searchText },
      'Found footer text block, updating content',
    );

    // Step 3: Replace the HTML
    const newHtml = newText.includes('<') ? newText : `<p class="" style="white-space:pre-wrap;">${newText}</p>`;
    if (blockValue.value) {
      blockValue.value.html = newHtml;
      blockValue.value.source = newHtml;
    }

    // Step 4: Save
    if (!pageSectionsId) {
      // Embedded footer path: sections live inside the header-footer config.
      // Must re-fetch config, update footer.sections in-place, and PUT it back.
      const configResult = await this.getHeaderFooter();
      if (!configResult.success || !configResult.config) {
        return { success: false, error: configResult.error ?? 'Failed to get header-footer config for save' };
      }
      const config = configResult.config as Record<string, unknown>;
      if (config.footer && typeof config.footer === 'object') {
        (config.footer as Record<string, unknown>).sections = sections;
      }
      const saveResult = await this.saveHeaderFooter(config);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }
      return { success: true, blockId, oldText: this.stripHtml(oldHtml), newHtml };
    }

    // Regular path: save via page-sections API
    // We need collectionId for the save endpoint.
    let saveCollectionId = collectionId;
    if (!saveCollectionId) {
      // For footer, the collectionId might not be needed — try using the websiteId
      // or fall back to getting it from the GetCollections API
      const configResult = await this.getHeaderFooter();
      if (configResult.config) {
        saveCollectionId = (configResult.config as Record<string, unknown>).websiteId as string | undefined;
      }
    }

    if (!saveCollectionId) {
      // Last resort: use a dummy collection ID — some Squarespace endpoints
      // accept the pageSectionsId as collectionId for footer saves
      saveCollectionId = pageSectionsId;
    }

    const saveResult = await this.savePageSections(pageSectionsId, saveCollectionId, sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      blockId,
      oldText: this.stripHtml(oldHtml),
      newHtml,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.patchFooterTextBlock = async function (
  this: ContentSaveClient,
  searchText: string,
  newText: string,
): Promise<FooterTextUpdateResult> {
  try {
    // Step 1: Get footer sections + IDs
    const footerResult = await this.getFooterSections();
    if (!footerResult.success || !footerResult.sections) {
      return { success: false, error: footerResult.error ?? 'Failed to get footer sections' };
    }

    const { sections, pageSectionsId, collectionId } = footerResult;

    // Step 2: Find the text block containing the search text
    const match = this.findTextBlock(sections, searchText);
    if (!match) {
      return {
        success: false,
        error: `No text block found in the footer containing "${searchText}"`,
      };
    }

    const { gridContent, sectionIndex, blockIndex } = match;
    const blockValue = gridContent.content.value;
    const oldHtml = blockValue.value?.html ?? '';
    const blockId = blockValue.id;

    // Step 3: Do a surgical replacement in the HTML
    // Find the searchText in the stripped HTML to confirm it exists
    const strippedOld = this.stripHtml(oldHtml).toLowerCase();
    const needle = searchText.toLowerCase();
    if (!strippedOld.includes(needle)) {
      return {
        success: false,
        error: `Text "${searchText}" found in block ${blockId} metadata but not in stripped HTML`,
      };
    }

    // Replace in the raw HTML — try exact match first, then case-insensitive
    let patchedHtml = oldHtml;
    if (patchedHtml.includes(searchText)) {
      patchedHtml = patchedHtml.replace(searchText, newText);
    } else {
      // Case-insensitive replacement in HTML (careful to preserve tags)
      const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      patchedHtml = patchedHtml.replace(regex, newText);
    }

    if (patchedHtml === oldHtml) {
      return {
        success: false,
        error: `Could not replace "${searchText}" in HTML of block ${blockId}. The text may span HTML tags.`,
      };
    }

    logger.info(
      { blockId, sectionIndex, blockIndex, searchText, newText },
      'Patching footer text block (surgical replacement)',
    );

    if (blockValue.value) {
      blockValue.value.html = patchedHtml;
      blockValue.value.source = patchedHtml;
    }

    // Step 4: Save
    if (!pageSectionsId) {
      // Embedded footer path: sections live inside the header-footer config.
      // Must re-fetch config, update footer.sections in-place, and PUT it back.
      const configResult = await this.getHeaderFooter();
      if (!configResult.success || !configResult.config) {
        return { success: false, error: configResult.error ?? 'Failed to get header-footer config for save' };
      }
      const config = configResult.config as Record<string, unknown>;
      if (config.footer && typeof config.footer === 'object') {
        (config.footer as Record<string, unknown>).sections = sections;
      }
      const saveResult = await this.saveHeaderFooter(config);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }
      return { success: true, blockId, oldText: this.stripHtml(oldHtml), newHtml: patchedHtml };
    }

    // Regular path: save via page-sections API
    let saveCollectionId = collectionId;
    if (!saveCollectionId) {
      const configResult = await this.getHeaderFooter();
      if (configResult.config) {
        saveCollectionId = (configResult.config as Record<string, unknown>).websiteId as string | undefined;
      }
    }
    if (!saveCollectionId) {
      saveCollectionId = pageSectionsId;
    }

    const saveResult = await this.savePageSections(pageSectionsId, saveCollectionId, sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      blockId,
      oldText: this.stripHtml(oldHtml),
      newHtml: patchedHtml,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.getHeaderSections = async function (
  this: ContentSaveClient,
): Promise<{
  success: boolean;
  sections?: PageSection[];
  pageSectionsId?: string;
  collectionId?: string;
  error?: string;
}> {
  try {
    const configResult = await this.getHeaderFooter();
    if (!configResult.success || !configResult.config) {
      return { success: false, error: configResult.error ?? 'Failed to get header/footer config' };
    }

    const config = configResult.config;

    const headerPsId =
      config.header?.pageSectionsId as string | undefined ??
      (config as Record<string, unknown>).headerPageSectionsId as string | undefined ??
      config.header?.id as string | undefined;

    if (!headerPsId || typeof headerPsId !== 'string') {
      const embeddedSections = config.header?.sections as PageSection[] | undefined;
      if (embeddedSections && Array.isArray(embeddedSections)) {
        logger.info(
          { sectionsCount: embeddedSections.length },
          'Found embedded header sections in header-footer config',
        );
        return { success: true, sections: embeddedSections };
      }

      return {
        success: false,
        error: 'Header pageSectionsId not found in header-footer config. ' +
          `Available keys: ${JSON.stringify(Object.keys(config))}` +
          (config.header ? `, header keys: ${JSON.stringify(Object.keys(config.header))}` : ''),
      };
    }

    logger.info({ headerPsId }, 'Found header pageSectionsId — fetching sections');

    const data = await this.getPageSections(headerPsId);
    const collectionId = data.collectionId ?? (data as Record<string, unknown>).websiteId as string | undefined;

    return {
      success: true,
      sections: data.sections,
      pageSectionsId: headerPsId,
      collectionId: collectionId ?? undefined,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.patchHeaderTextBlock = async function (
  this: ContentSaveClient,
  searchText: string,
  newText: string,
): Promise<FooterTextUpdateResult> {
  try {
    const headerResult = await this.getHeaderSections();
    if (!headerResult.success || !headerResult.sections) {
      return { success: false, error: headerResult.error ?? 'Failed to get header sections' };
    }

    const { sections, pageSectionsId, collectionId } = headerResult;

    const match = this.findTextBlock(sections, searchText);
    if (!match) {
      return {
        success: false,
        error: `No text block found in the header containing "${searchText}"`,
      };
    }

    const { gridContent, sectionIndex, blockIndex } = match;
    const blockValue = gridContent.content.value;
    const oldHtml = blockValue.value?.html ?? '';
    const blockId = blockValue.id;

    // Surgical replacement in HTML
    const strippedOld = this.stripHtml(oldHtml).toLowerCase();
    const needle = searchText.toLowerCase();
    if (!strippedOld.includes(needle)) {
      return {
        success: false,
        error: `Text "${searchText}" found in block ${blockId} metadata but not in stripped HTML`,
      };
    }

    let patchedHtml = oldHtml;
    if (patchedHtml.includes(searchText)) {
      patchedHtml = patchedHtml.replace(searchText, newText);
    } else {
      const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      patchedHtml = patchedHtml.replace(regex, newText);
    }

    if (patchedHtml === oldHtml) {
      return {
        success: false,
        error: `Could not replace "${searchText}" in HTML of block ${blockId}. The text may span HTML tags.`,
      };
    }

    logger.info(
      { blockId, sectionIndex, blockIndex, searchText, newText },
      'Patching header text block (surgical replacement)',
    );

    if (blockValue.value) {
      blockValue.value.html = patchedHtml;
      blockValue.value.source = patchedHtml;
    }

    // Save
    if (!pageSectionsId) {
      // Embedded header path
      const configResult = await this.getHeaderFooter();
      if (!configResult.success || !configResult.config) {
        return { success: false, error: configResult.error ?? 'Failed to get header-footer config for save' };
      }
      const config = configResult.config as Record<string, unknown>;
      if (config.header && typeof config.header === 'object') {
        (config.header as Record<string, unknown>).sections = sections;
      }
      const saveResult = await this.saveHeaderFooter(config);
      if (!saveResult.success) {
        return { success: false, error: saveResult.error };
      }
      return { success: true, blockId, oldText: this.stripHtml(oldHtml), newHtml: patchedHtml };
    }

    // Regular path
    let saveCollectionId = collectionId;
    if (!saveCollectionId) {
      const configResult = await this.getHeaderFooter();
      if (configResult.config) {
        saveCollectionId = (configResult.config as Record<string, unknown>).websiteId as string | undefined;
      }
    }
    if (!saveCollectionId) {
      saveCollectionId = pageSectionsId;
    }

    const saveResult = await this.savePageSections(pageSectionsId, saveCollectionId, sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return {
      success: true,
      blockId,
      oldText: this.stripHtml(oldHtml),
      newHtml: patchedHtml,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.saveHeaderFooter = async function (
  this: ContentSaveClient,
  config: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  this.ensureCookies();

  const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
  let url = `${siteUrl}/api/site-header-footer`;
  if (this.crumbToken) {
    url += `?crumb=${encodeURIComponent(this.crumbToken)}`;
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      ...this.buildHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { success: false, error: this.enhanceError(response.status, body, `${response.status} ${response.statusText}: ${body}`) };
  }

  return { success: true };
};
