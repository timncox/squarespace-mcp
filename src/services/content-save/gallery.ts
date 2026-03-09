import { ContentSaveClient, BLOCK_TYPE_GALLERY, FETCH_TIMEOUT_MS } from './client.js';
import type {
  GallerySettings,
  GallerySettingsUpdateResult,
  GalleryItem,
  AddGalleryImageResult,
  RemoveGalleryImageResult,
  ReorderGalleryImagesResult,
  SectionCatalogEntry,
  SectionCatalogResponse,
  GridContent,
  PageSection,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    updateGallerySettings(
      pageSectionsId: string,
      collectionId: string,
      searchText: string,
      settings: GallerySettings,
    ): Promise<GallerySettingsUpdateResult>;
    findGalleryBlock(
      sections: PageSection[],
      searchText?: string,
    ): { gridContent: GridContent; sectionIndex: number; blockIndex: number; galleryCollectionId: string } | null;
    getGalleryItems(
      galleryCollectionId: string,
    ): Promise<{ success: boolean; items?: GalleryItem[]; hasMore?: boolean; error?: string }>;
    getGalleryItemCount(
      galleryCollectionId: string,
    ): Promise<{ success: boolean; count?: number; error?: string }>;
    addGalleryImage(
      galleryCollectionId: string,
      assetId: string,
      metadata?: { title?: string; description?: string },
    ): Promise<AddGalleryImageResult>;
    removeGalleryImage(
      galleryCollectionId: string,
      itemId: string,
    ): Promise<RemoveGalleryImageResult>;
    reorderGalleryImages(
      galleryCollectionId: string,
      itemIds: string[],
    ): Promise<ReorderGalleryImagesResult>;
    uploadImageToSite(
      imageUrl: string,
    ): Promise<{ success: boolean; assetId?: string; contentItemId?: string; error?: string }>;
    getSectionCatalog(): Promise<SectionCatalogResponse>;
  }
}

// ── Module-scoped helper (was private instance method) ──────────────────────

/**
 * Poll a Squarespace job until it completes.
 * Used for image uploads and other async operations.
 */
async function pollJob(
  jobUrl: string,
  headers: Record<string, string>,
  maxAttempts = 15,
  intervalMs = 2000,
): Promise<{ success: boolean; assetId?: string; contentItemId?: string; error?: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const response = await fetch(jobUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) continue;

    const data = await response.json() as Record<string, unknown>;
    const status = data.status as string | undefined;

    if (status === 'COMPLETED' || status === 'completed') {
      return {
        success: true,
        assetId: data.assetId as string | undefined,
        contentItemId: data.contentItemId as string | undefined,
      };
    }

    if (status === 'FAILED' || status === 'failed') {
      return { success: false, error: `Job failed: ${JSON.stringify(data)}` };
    }

    logger.debug({ attempt, status }, 'Polling job...');
  }

  return { success: false, error: `Job timed out after ${maxAttempts} attempts` };
}

// ── Prototype methods ───────────────────────────────────────────────────────

ContentSaveClient.prototype.updateGallerySettings = async function (
  this: ContentSaveClient,
  pageSectionsId: string,
  collectionId: string,
  searchText: string,
  settings: GallerySettings,
): Promise<GallerySettingsUpdateResult> {
  try {
    this.ensureCookies();

    const data = await this.getPageSections(pageSectionsId);

    // Find gallery block (type 8) — search by collectionId or block ID prefix
    let found: { gridContent: GridContent; sectionIndex: number; blockIndex: number } | null = null;
    const needle = searchText.toLowerCase();

    for (let si = 0; si < data.sections.length; si++) {
      const section = data.sections[si];
      const gridContents = section.fluidEngineContext?.gridContents;
      if (!gridContents) continue;

      for (let bi = 0; bi < gridContents.length; bi++) {
        const gc = gridContents[bi];
        const bv = gc.content?.value;
        if (!bv || bv.type !== BLOCK_TYPE_GALLERY) continue;

        // Match by collectionId, transientGalleryId, or block ID prefix
        const val = bv.value ?? {};
        if (
          val.collectionId === searchText ||
          val.transientGalleryId === searchText ||
          bv.id.toLowerCase().startsWith(needle)
        ) {
          found = { gridContent: gc, sectionIndex: si, blockIndex: bi };
          break;
        }
      }
      if (found) break;
    }

    // Fallback: if only one gallery block exists, use it
    if (!found) {
      for (let si = 0; si < data.sections.length; si++) {
        const section = data.sections[si];
        const gridContents = section.fluidEngineContext?.gridContents;
        if (!gridContents) continue;
        for (let bi = 0; bi < gridContents.length; bi++) {
          const gc = gridContents[bi];
          if (gc.content?.value?.type === BLOCK_TYPE_GALLERY) {
            found = { gridContent: gc, sectionIndex: si, blockIndex: bi };
            break;
          }
        }
        if (found) break;
      }
    }

    if (!found) {
      return { success: false, error: `No gallery block found matching: ${searchText}` };
    }

    const blockValue = found.gridContent.content.value;
    if (!blockValue.value) blockValue.value = {};

    const updatedFields: string[] = [];
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) {
        (blockValue.value as Record<string, unknown>)[key] = value;
        updatedFields.push(key);
      }
    }

    logger.info(
      { blockId: blockValue.id, updatedFields },
      'Updating gallery settings',
    );

    const saveResult = await this.savePageSections(pageSectionsId, collectionId, data.sections);
    if (!saveResult.success) {
      return { success: false, error: saveResult.error };
    }

    return { success: true, blockId: blockValue.id, updatedFields };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/**
 * Find a gallery block (type 8) in sections and return its collection ID.
 */
ContentSaveClient.prototype.findGalleryBlock = function (
  this: ContentSaveClient,
  sections: PageSection[],
  searchText?: string,
): { gridContent: GridContent; sectionIndex: number; blockIndex: number; galleryCollectionId: string } | null {
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const gridContents = section.fluidEngineContext?.gridContents;
    if (!gridContents) continue;

    for (let bi = 0; bi < gridContents.length; bi++) {
      const gc = gridContents[bi];
      const bv = gc.content?.value;
      if (!bv || bv.type !== BLOCK_TYPE_GALLERY) continue;

      const val = bv.value ?? {};
      const galleryCollectionId = (val.collectionId ?? val.transientGalleryId ?? '') as string;

      if (!searchText) {
        return { gridContent: gc, sectionIndex: si, blockIndex: bi, galleryCollectionId };
      }

      const needle = searchText.toLowerCase();
      if (
        galleryCollectionId === searchText ||
        bv.id.toLowerCase().startsWith(needle)
      ) {
        return { gridContent: gc, sectionIndex: si, blockIndex: bi, galleryCollectionId };
      }
    }
  }
  return null;
};

ContentSaveClient.prototype.getGalleryItems = async function (
  this: ContentSaveClient,
  galleryCollectionId: string,
): Promise<{ success: boolean; items?: GalleryItem[]; hasMore?: boolean; error?: string }> {
  try {
    this.ensureCookies();

    const path = `/api/content-collections/${encodeURIComponent(galleryCollectionId)}/content-items?limit=250`;
    const url = this.buildApiUrl(path, true);

    logger.info({ galleryCollectionId }, 'Fetching gallery items');

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `Failed to fetch gallery items: ${response.status}. ${body}` };
    }

    const data = await response.json() as Record<string, unknown>;

    // Response shape: { results: [...], hasPreviousPage: bool, hasNextPage: bool }
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data.results)
        ? data.results
        : [];

    const hasMore = data.hasNextPage === true;

    logger.info(
      { galleryCollectionId, count: items.length, hasMore },
      'Gallery items fetched',
    );
    return { success: true, items: items as GalleryItem[], hasMore };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.getGalleryItemCount = async function (
  this: ContentSaveClient,
  galleryCollectionId: string,
): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    this.ensureCookies();

    const path = `/api/content-collections/${encodeURIComponent(galleryCollectionId)}/item-count`;
    const url = this.buildApiUrl(path, true);

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `Failed to fetch gallery item count: ${response.status}. ${body}` };
    }

    const data = await response.json();
    const count = typeof data === 'number' ? data : (data as Record<string, unknown>).count as number;

    return { success: true, count };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.addGalleryImage = async function (
  this: ContentSaveClient,
  galleryCollectionId: string,
  assetId: string,
  metadata?: { title?: string; description?: string },
): Promise<AddGalleryImageResult> {
  try {
    this.ensureCookies();

    const path = `/api/galleries/${encodeURIComponent(galleryCollectionId)}/images`;
    const url = this.buildApiUrl(path, true);

    const body: Record<string, unknown> = { assetId };
    if (metadata?.title) body.title = metadata.title;
    if (metadata?.description) body.description = metadata.description;

    logger.info(
      { galleryCollectionId, assetId, hasTitle: !!metadata?.title },
      'Adding image to gallery',
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const respBody = await response.text().catch(() => '');
      return { success: false, error: `Failed to add gallery image: ${response.status}. ${respBody}` };
    }

    const data = await response.json().catch(() => ({}));
    const itemId = (data as Record<string, unknown>).id as string | undefined;

    logger.info({ galleryCollectionId, itemId }, 'Gallery image added');
    return { success: true, itemId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.removeGalleryImage = async function (
  this: ContentSaveClient,
  galleryCollectionId: string,
  itemId: string,
): Promise<RemoveGalleryImageResult> {
  try {
    this.ensureCookies();

    const path = `/api/content-items/${encodeURIComponent(itemId)}`;
    const url = this.buildApiUrl(path, true);

    logger.info({ galleryCollectionId, itemId }, 'Removing gallery image');

    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `Failed to remove gallery image: ${response.status}. ${body}` };
    }

    logger.info({ galleryCollectionId, itemId }, 'Gallery image removed');
    return { success: true, itemId };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.reorderGalleryImages = async function (
  this: ContentSaveClient,
  galleryCollectionId: string,
  itemIds: string[],
): Promise<ReorderGalleryImagesResult> {
  try {
    this.ensureCookies();

    const path = '/api/commondata/ReorderItems';
    const url = this.buildApiUrl(path, true);

    const formBody = `collectionId=${encodeURIComponent(galleryCollectionId)}&itemIds=${encodeURIComponent(JSON.stringify(itemIds))}`;

    logger.info(
      { galleryCollectionId, itemCount: itemIds.length },
      'Reordering gallery images',
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `Failed to reorder gallery images: ${response.status}. ${body}` };
    }

    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const items = Array.isArray(data.items) ? data.items as GalleryItem[] : undefined;

    logger.info(
      { galleryCollectionId, itemCount: items?.length },
      'Gallery images reordered',
    );
    return { success: true, items };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.uploadImageToSite = async function (
  this: ContentSaveClient,
  imageUrl: string,
): Promise<{ success: boolean; assetId?: string; contentItemId?: string; error?: string }> {
  try {
    this.ensureCookies();

    const url = this.buildApiUrl('/api/uploads/images', true);

    logger.info({ imageUrl: imageUrl.substring(0, 100) }, 'Uploading image to site');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: imageUrl }),
      signal: AbortSignal.timeout(30_000), // Longer timeout for uploads
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `Image upload failed: ${response.status}. ${body}` };
    }

    const data = await response.json() as Record<string, unknown>;

    // Poll the job if we got a job ID
    const jobId = data.id as string | undefined;
    if (jobId) {
      const jobUrl = this.buildApiUrl(`/api/rest/jobs/?id=${encodeURIComponent(jobId)}`);
      const jobResult = await pollJob(jobUrl, this.buildHeaders());
      if (!jobResult.success) {
        return { success: false, error: jobResult.error };
      }
      return {
        success: true,
        assetId: jobResult.assetId,
        contentItemId: jobResult.contentItemId,
      };
    }

    return {
      success: true,
      assetId: data.assetId as string | undefined,
      contentItemId: data.contentItemId as string | undefined,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.getSectionCatalog = async function (
  this: ContentSaveClient,
): Promise<SectionCatalogResponse> {
  try {
    this.ensureCookies();

    const url = this.buildApiUrl('/api/section-catalog/sections?engine=FLUID');
    logger.info('Fetching section catalog');

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 401) {
      return { success: false, error: 'Session expired — re-authenticate via browser to refresh cookies' };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, body, `Failed to fetch section catalog: ${response.status}. ${body}`) };
    }

    const data = await response.json() as Record<string, unknown>;

    // Check for crumb failure
    if (data.crumbFail || (typeof data.error === 'string' && String(data.error).includes('Invalid session crumb'))) {
      const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
      return { success: false, error: `getSectionCatalog rejected: invalid or expired session crumb.${ageInfo}` };
    }

    // Response is an object keyed by category: { "CONTACT": [...], "MENUS": [...], ... }
    // Each value is an array of SectionCatalogEntry objects
    const catalog: Record<string, SectionCatalogEntry[]> = {};
    const allSections: SectionCatalogEntry[] = [];
    const categories: string[] = [];

    for (const [category, entries] of Object.entries(data)) {
      if (Array.isArray(entries)) {
        categories.push(category);
        const typed = entries as SectionCatalogEntry[];
        catalog[category] = typed;
        allSections.push(...typed);
      }
    }

    logger.info(
      { categories: categories.length, totalSections: allSections.length },
      'Section catalog fetched',
    );
    return { success: true, catalog, sections: allSections, categories };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
