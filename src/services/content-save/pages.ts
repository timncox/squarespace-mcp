import { ContentSaveClient, FETCH_TIMEOUT_MS } from './client.js';
import type {
  CollectionInfo,
  PageMetadata,
  CollectionItem,
  CollectionItemsOptions,
  CollectionItemsResult,
  PageCreateResult,
  BlogPostCreateResult,
  BlogPostUpdateOptions,
  BlogPostUpdateResult,
  BlogPostFeaturedImageResult,
  BlogPostDeleteResult,
  PageDeleteResult,
  PageMetadataUpdateOptions,
  PageMetadataUpdateResult,
  UpdateNavigationItem,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';
import { invalidateCacheByCollectionId, invalidateCacheBySlug, cachePageIds } from '../page-id-resolver.js';

declare module './index.js' {
  interface ContentSaveClient {
    getCollectionSettings(collectionId: string): Promise<{
      pageSectionsId: string;
      [key: string]: unknown;
    } | null>;
    getPageIds(slug: string): Promise<{
      collectionId: string;
      pageSectionsId?: string;
    } | null>;
    listCollections(): Promise<CollectionInfo[]>;
    getPageMetadata(slug: string): Promise<PageMetadata | null>;
    getCollectionItems(
      collectionId: string,
      options?: CollectionItemsOptions,
    ): Promise<CollectionItemsResult>;
    createPageViaApi(
      title: string,
      slug?: string,
      options?: {
        type?: number;
        navigation?: 'mainNav' | '_hidden';
      },
      _isRetry?: boolean,
    ): Promise<PageCreateResult>;
    resolveWebsiteId(): Promise<string | null>;
    addPageToNavigation(
      fieldName: string,
      newItem: Record<string, unknown>,
    ): Promise<{ success: boolean; error?: string }>;
    createBlogPost(
      collectionId: string,
      title: string,
      options?: {
        body?: string;
        slug?: string;
        tags?: string[];
        categories?: string[];
        excerpt?: string;
        draft?: boolean;
        publishDate?: string;
        coverImageUrl?: string;
      },
    ): Promise<BlogPostCreateResult>;
    updateBlogPost(
      collectionId: string,
      itemId: string,
      updates: BlogPostUpdateOptions,
      _isRetry?: boolean,
    ): Promise<BlogPostUpdateResult>;
    findBlogPostByTitle(
      collectionId: string,
      searchTitle: string,
    ): Promise<CollectionItem | null>;
    setBlogPostFeaturedImage(
      collectionId: string,
      itemId: string,
      imageBuffer: Buffer,
      filename: string,
      contentType?: string,
    ): Promise<BlogPostFeaturedImageResult>;
    deleteBlogPost(collectionId: string, postId: string, _isRetry?: boolean): Promise<BlogPostDeleteResult>;
    deletePageViaApi(collectionId: string, _isRetry?: boolean): Promise<PageDeleteResult>;
    tryHidePageFromNav(collectionId: string): Promise<PageDeleteResult | null>;
    updatePageMetadata(
      collectionId: string,
      updates: PageMetadataUpdateOptions,
      _isRetry?: boolean,
    ): Promise<PageMetadataUpdateResult>;
  }
}

// ── Prototype methods ───────────────────────────────────────────────────────

ContentSaveClient.prototype.getCollectionSettings = async function (
  this: ContentSaveClient,
  collectionId: string,
): Promise<{
  pageSectionsId: string;
  [key: string]: unknown;
} | null> {
  this.ensureCookies();

  try {
    const url = this.buildApiUrl(`/api/commondata/GetCollectionSettings?collectionId=${collectionId}`);
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    // The pageSectionsId is typically in the collection's mainContent or as a direct field
    const pageSectionsId = data.mainContent as string
      ?? data.pageSectionsId as string
      ?? data.pageId as string
      ?? null;

    if (!pageSectionsId) {
      // Log all top-level keys for debugging if we can't find it
      logger.warn({ collectionId, keys: Object.keys(data) }, 'GetCollectionSettings: could not find pageSectionsId');
      return null;
    }

    return { ...data, pageSectionsId };
  } catch (err) {
    logger.warn({ error: errMsg(err), collectionId }, 'GetCollectionSettings failed');
    return null;
  }
};

ContentSaveClient.prototype.getPageIds = async function (
  this: ContentSaveClient,
  slug: string,
): Promise<{
  collectionId: string;
  pageSectionsId?: string;
} | null> {
  this.ensureCookies();

  const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
  const normalizedSlug = this.normalizeSlug(slug);

  try {
    const response = await fetch(`${siteUrl}/api/commondata/GetCollections/`, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    const collections = (data.collections ?? data) as Record<string, unknown>[] | Record<string, unknown>;

    // Collections may be an array or keyed object
    const collList = Array.isArray(collections)
      ? collections
      : Object.values(collections);

    for (const c of collList) {
      const coll = c as Record<string, unknown>;
      const urlId = String(coll.urlId ?? '').toLowerCase();
      const targetSlug = normalizedSlug || 'home';

      if (urlId === targetSlug) {
        const collectionId = String(coll.id);

        // Try to resolve pageSectionsId via GetCollectionSettings
        const settings = await this.getCollectionSettings(collectionId);
        return {
          collectionId,
          pageSectionsId: settings?.pageSectionsId,
        };
      }
    }

    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err), slug }, 'Failed to get page IDs');
    return null;
  }
};

ContentSaveClient.prototype.listCollections = async function (
  this: ContentSaveClient,
): Promise<CollectionInfo[]> {
  this.ensureCookies();

  try {
    const url = this.buildApiUrl('/api/commondata/GetCollections/');
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn({ status: response.status, body }, 'listCollections: API returned error');
      if (response.status === 401) {
        throw new Error(`401 Unauthorized: ${body || 'Session cookies may be expired or missing. Re-authenticate and refresh the session file.'}`);
      }
      return [];
    }

    const data = (await response.json()) as Record<string, unknown>;
    const collections = (data.collections ?? data) as Record<string, unknown>[] | Record<string, unknown>;
    const collList = Array.isArray(collections)
      ? collections
      : Object.values(collections);

    return collList.map((c) => {
      const coll = c as Record<string, unknown>;
      const typeNum = Number(coll.type ?? 0);
      return {
        id: String(coll.id ?? ''),
        urlId: String(coll.urlId ?? ''),
        title: String(coll.title ?? ''),
        type: typeNum,
        typeName: ContentSaveClient.TYPE_NAMES[typeNum] ?? 'unknown',
        ...(coll.itemCount != null ? { itemCount: Number(coll.itemCount) } : {}),
        ...(coll.enabled != null ? { enabled: Boolean(coll.enabled) } : {}),
        ...(coll.deleted != null ? { deleted: Boolean(coll.deleted) } : {}),
        ...(coll.ordering != null ? { ordering: Number(coll.ordering) } : {}),
        ...(coll.navigationTitle != null ? { navigationTitle: String(coll.navigationTitle) } : {}),
        ...(coll.description != null ? { description: String(coll.description) } : {}),
      };
    });
  } catch (err) {
    // Propagate auth errors so callers (e.g. sq_list_pages) report them
    // instead of silently returning empty results
    const msg = errMsg(err);
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('not logged in')) {
      throw err;
    }
    logger.warn({ error: msg }, 'listCollections: failed');
    return [];
  }
};

ContentSaveClient.prototype.getPageMetadata = async function (
  this: ContentSaveClient,
  slug: string,
): Promise<PageMetadata | null> {
  const normalizedSlug = this.normalizeSlug(slug);
  const targetSlug = normalizedSlug || 'home';

  try {
    const collections = await this.listCollections();

    for (const coll of collections) {
      if (coll.urlId.toLowerCase() === targetSlug.toLowerCase()) {
        return {
          collectionId: coll.id,
          urlId: coll.urlId,
          title: coll.title,
          type: coll.type,
          typeName: coll.typeName,
          ...(coll.enabled != null ? { enabled: coll.enabled } : {}),
          ...(coll.navigationTitle != null ? { navigationTitle: coll.navigationTitle } : {}),
        };
      }
    }

    return null;
  } catch (err) {
    logger.warn({ error: errMsg(err), slug }, 'getPageMetadata: failed');
    return null;
  }
};

ContentSaveClient.prototype.getCollectionItems = async function (
  this: ContentSaveClient,
  collectionId: string,
  options?: CollectionItemsOptions,
): Promise<CollectionItemsResult> {
  this.ensureCookies();

  try {
    const params = new URLSearchParams();
    if (options?.limit != null) params.set('limit', String(options.limit));
    if (options?.offset != null) params.set('offset', String(options.offset));

    const qs = params.toString();
    const path = `/api/content-collections/${collectionId}/content-items${qs ? `?${qs}` : ''}`;
    const url = this.buildApiUrl(path);

    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { success: false, error: `API returned ${response.status}` };
    }

    const data = (await response.json()) as Record<string, unknown>;
    // Squarespace may return items under 'items', 'results', or as a top-level array
    let items = (
      Array.isArray(data.items) ? data.items :
      Array.isArray(data.results) ? data.results :
      Array.isArray(data) ? data : []
    ) as CollectionItem[];

    // Apply status filter if requested (handles both status and workflowState fields)
    if (options?.filter === 'published') {
      items = items.filter((item) => {
        const i = item as Record<string, unknown>;
        return i.status === 1 || i.workflowState === 1;
      });
    } else if (options?.filter === 'draft') {
      items = items.filter((item) => {
        const i = item as Record<string, unknown>;
        return i.status === 0 || i.workflowState === 4;
      });
    }

    return {
      success: true,
      items,
      total: typeof data.total === 'number' ? data.total : items.length,
    };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.createPageViaApi = async function (
  this: ContentSaveClient,
  title: string,
  slug?: string,
  options?: {
    type?: number;
    navigation?: 'mainNav' | '_hidden';
  },
  _isRetry = false,
): Promise<PageCreateResult> {
  this.ensureCookies();

  // Resolve websiteId — required by SaveCollectionSettings
  const websiteId = await this.resolveWebsiteId();
  if (!websiteId) {
    return {
      success: false,
      endpointAvailable: true,
      error: 'Could not determine websiteId. Ensure session cookies are loaded.',
    };
  }

  // collectionType: 10 = page, 1 = blog
  const collectionType = options?.type === 1 ? 1 : 10;
  const typeName = collectionType === 1 ? 'blog-single-column' : 'page';

  const requestBody = {
    collectionData: {
      description: { html: '', raw: false },
      enabled: true,
      deleted: false,
      folder: false,
      regionName: 'default',
      dirty: false,
      body: null,
      collectionType,
      supported: true,
      supportsVideoBackgrounds: false,
      typeName,
      title,
      newTitle: title,
      ordering: 3,
      icon: typeName === 'page' ? 'page' : 'blog',
      addText: 'Add Block',
      navigationTitle: title,
      type: collectionType,
      websiteId,
    },
    memberAreaData: { memberAreaIds: [] },
  };

  try {
    logger.info({ title, collectionType, typeName }, 'createPageViaApi: creating page via SaveCollectionSettings');
    const url = this.buildApiUrl('/api/commondata/SaveCollectionSettings', true);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 401) {
      return {
        success: false,
        endpointAvailable: true,
        error: 'Session expired — call sq_login to check session health and re-authenticate.',
      };
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      const baseError = `SaveCollectionSettings returned ${response.status}: ${errBody.slice(0, 200)}`;
      return {
        success: false,
        endpointAvailable: true,
        error: this.enhanceError(response.status, errBody, baseError),
      };
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Check for crumb failure
    if ((data.crumbFail || (typeof data.error === 'string' && String(data.error).includes('Invalid session crumb')))) {
      if (!_isRetry && await this.handleCrumbFailure(JSON.stringify(data))) {
        logger.info('createPageViaApi: retrying after crumb refresh');
        return this.createPageViaApi(title, slug, options, true);
      }
      const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
      return {
        success: false,
        endpointAvailable: true,
        error: `createPageViaApi rejected: invalid or expired session crumb.${ageInfo} Call sq_login to check session health and re-authenticate.`,
      };
    }

    const pageId = data.id ? String(data.id) : undefined;
    const urlId = data.urlId ? String(data.urlId) : undefined;

    logger.info({ pageId, urlId, title }, 'createPageViaApi: page created');

    // Invalidate stale page ID cache for this slug (prevents stale hits from
    // a previously deleted page with the same slug)
    const effectiveSlug = urlId ?? slug ?? '';
    if (effectiveSlug && pageId) {
      invalidateCacheBySlug(this.siteSubdomain, effectiveSlug);
      // Also cache the new page's IDs immediately.
      // EMPIRICAL PATTERN: pageSectionsId is the collectionId with its last hex
      // digit incremented by 1 (wrapping at f→0). This has been observed
      // consistently across multiple sites but is not documented by Squarespace
      // and may need verification if page creation starts producing mismatches.
      const lastChar = pageId.slice(-1);
      const nextChar = ((parseInt(lastChar, 16) + 1) % 16).toString(16);
      const pageSectionsId = pageId.slice(0, -1) + nextChar;
      cachePageIds(this.siteSubdomain, effectiveSlug, pageSectionsId, pageId);
      logger.info({ subdomain: this.siteSubdomain, slug: effectiveSlug, pageId, pageSectionsId }, 'createPageViaApi: cached new page IDs');
    }

    // Add to navigation
    const navField = options?.navigation ?? '_hidden';
    const navResult = await this.addPageToNavigation(navField, {
      collectionId: pageId!,
      collectionType,
      enabled: true,
      isFolder: false,
      items: [],
      linkId: pageId!,
      linkType: 'collection',
      passwordProtected: false,
      title,
      typeName,
      urlId: urlId ?? slug ?? '',
      isDraft: false,
      isPending: false,
      pagePermissionType: 1,
      ordering: typeof data.ordering === 'number' ? data.ordering : 0,
      updatedOn: typeof data.updatedOn === 'number' ? data.updatedOn : Date.now(),
      id: pageId!,
    });

    if (!navResult.success) {
      logger.warn({ pageId, navField, error: navResult.error }, 'createPageViaApi: page created but navigation update failed');
      return {
        success: true,
        endpointAvailable: true,
        pageId,
        urlId,
        warning: `Page was created but could not be added to navigation (${navField}): ${navResult.error ?? 'unknown error'}. The page exists but is not visible in site navigation.`,
      };
    }

    return {
      success: true,
      endpointAvailable: true,
      pageId,
      urlId,
    };
  } catch (err) {
    logger.warn({ error: errMsg(err), title }, 'createPageViaApi: error');
    return {
      success: false,
      endpointAvailable: true,
      error: errMsg(err),
    };
  }
};

ContentSaveClient.prototype.resolveWebsiteId = async function (
  this: ContentSaveClient,
): Promise<string | null> {
  if (this.websiteIdCache) return this.websiteIdCache;

  try {
    const url = this.buildApiUrl('/api/commondata/GetCollections/');
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    // Collections response includes items with websiteId
    const raw = Array.isArray(data) ? data : (data.collections ?? data.items ?? []);
    const collections = Array.isArray(raw) ? raw : (typeof raw === 'object' && raw ? Object.values(raw) : []);
    for (const col of collections as Record<string, unknown>[]) {
      if (typeof col.websiteId === 'string') {
        this.websiteIdCache = col.websiteId;
        return col.websiteId;
      }
    }
  } catch {
    // Fall through
  }
  return null;
};

ContentSaveClient.prototype.addPageToNavigation = async function (
  this: ContentSaveClient,
  fieldName: string,
  newItem: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get current navigation to find existing items for this field
    const rawNavUrl = this.buildApiUrl('/api/navigation');
    const rawNavRes = await fetch(rawNavUrl, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!rawNavRes.ok) {
      return { success: false, error: `Failed to fetch navigation: ${rawNavRes.status}` };
    }

    const rawNav = await rawNavRes.json() as Record<string, unknown>;

    // Map fieldName to the navigation data key
    const navKey = fieldName === 'mainNav' ? 'mainNavigation' : 'notLinked';
    const existingItems = Array.isArray(rawNav[navKey])
      ? (rawNav[navKey] as Record<string, unknown>[])
      : [];

    // Build the items array: prepend new item for mainNav, prepend for _hidden
    const updatedItems = [newItem, ...existingItems];

    const result = await this.updateNavigation(
      fieldName,
      updatedItems as unknown as UpdateNavigationItem[],
    );

    return result;
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.createBlogPost = async function (
  this: ContentSaveClient,
  collectionId: string,
  title: string,
  options?: {
    body?: string;
    slug?: string;
    tags?: string[];
    categories?: string[];
    excerpt?: string;
    draft?: boolean;
    publishDate?: string;
    coverImageUrl?: string;
  },
): Promise<BlogPostCreateResult> {
  this.ensureCookies();

  try {
    // No crumb in URL — this endpoint uses X-CSRF-Token header
    const url = `https://${this.siteSubdomain}.squarespace.com/api/content/blogs/${collectionId}/text-posts`;
    const now = Date.now();
    const publishOn = options?.publishDate
      ? new Date(options.publishDate).getTime() || now
      : now;

    const postBody = JSON.stringify({
      addedOn: now,
      publishOn,
      ...(this.websiteIdCache ? { websiteId: this.websiteIdCache } : {}),
      ...(this.memberAccountIdCache ? { authorId: this.memberAccountIdCache } : {}),
      mediaFocalPoint: { x: 0.5, y: 0.5 },
      likeCount: 0,
      dislikeCount: 0,
      commentCount: 0,
      publicCommentCount: 0,
      workflowState: (options?.draft ?? true) ? 4 : 1,
      urlId: options?.slug ?? null,
      proxyForId: null,
      childType: null,
      updatedOn: null,
      unsaved: null,
      title: title || null,
      body: { raw: false, layout: { columns: 12, rows: [] } },
      excerpt: { html: '', raw: false },
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: postBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 404 || response.status === 405) {
      return {
        success: false,
        endpointAvailable: false,
        error: `Endpoint returned ${response.status}`,
      };
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      logger.warn({ collectionId, status: response.status, body: errBody }, 'createBlogPost: API error');

      // Detect slug collision: 400 with "This URL is already in use"
      if (response.status === 400 && errBody.includes('This URL is already in use')) {
        const requestedSlug = options?.slug;
        if (requestedSlug) {
          try {
            const itemsResult = await this.getCollectionItems(collectionId);
            if (itemsResult.success && itemsResult.items) {
              const existing = itemsResult.items.find(
                (item) => item.urlId?.toLowerCase() === requestedSlug.toLowerCase(),
              );
              if (existing) {
                return {
                  success: false,
                  endpointAvailable: true,
                  error: `Slug "${requestedSlug}" is already in use by post "${existing.title}" (${existing.id}). Use sq_update_blog_post to update it instead.`,
                  existingPostId: existing.id,
                  existingPostTitle: existing.title,
                };
              }
            }
          } catch (lookupErr) {
            logger.warn({ error: errMsg(lookupErr), collectionId, slug: requestedSlug },
              'createBlogPost: slug collision detected but failed to look up existing post');
          }
        }
        // Fallback if we couldn't find the exact post or no slug was provided
        return {
          success: false,
          endpointAvailable: true,
          error: `Slug "${requestedSlug ?? '(auto)'}" is already in use. Use sq_list_blog_posts to find the existing post, then sq_update_blog_post to update it.`,
        };
      }

      return {
        success: false,
        endpointAvailable: true,
        error: this.enhanceError(response.status, errBody, `API returned ${response.status}: ${errBody.slice(0, 200)}`),
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    logger.info({ collectionId, itemId: data.id, urlId: data.urlId }, 'createBlogPost: post created');

    // Follow-up: set fields the create endpoint doesn't accept
    const needsUpdate = options?.body || options?.tags || options?.excerpt || options?.categories || options?.coverImageUrl;
    if (needsUpdate && data.id) {
      const updateResult = await this.updateBlogPost(collectionId, String(data.id), {
        ...(options.body ? { body: options.body } : {}),
        ...(options.tags ? { tags: options.tags } : {}),
        ...(options.excerpt ? { excerpt: options.excerpt } : {}),
        ...(options.categories ? { categories: options.categories } : {}),
        ...(options.coverImageUrl ? { coverImageUrl: options.coverImageUrl } : {}),
      });
      if (!updateResult.success) {
        logger.warn({ collectionId, itemId: data.id, error: updateResult.error, fields: updateResult.updatedFields },
          'createBlogPost: post created but follow-up update failed — body/tags/excerpt may be missing');
        return {
          success: false,
          endpointAvailable: true,
          itemId: data.id ? String(data.id) : undefined,
          urlId: data.urlId ? String(data.urlId) : undefined,
          error: `Post created (${data.id}) but follow-up update failed: ${updateResult.error}`,
        };
      }
    }

    return {
      success: true,
      endpointAvailable: true,
      itemId: data.id ? String(data.id) : undefined,
      urlId: data.urlId ? String(data.urlId) : undefined,
    };
  } catch (err) {
    return {
      success: false,
      endpointAvailable: true,
      error: errMsg(err),
    };
  }
};

ContentSaveClient.prototype.updateBlogPost = async function (
  this: ContentSaveClient,
  collectionId: string,
  itemId: string,
  updates: BlogPostUpdateOptions,
  _isRetry = false,
): Promise<BlogPostUpdateResult> {
  this.ensureCookies();

  try {
    // Build partial body — always include id and authorId so the server can identify the author
    const body: Record<string, unknown> = {
      id: itemId,
      ...(this.memberAccountIdCache ? { authorId: this.memberAccountIdCache } : {}),
    };
    const updatedFields: string[] = [];
    // set() assigns a field and records it; null/undefined values are skipped.
    // label overrides the name pushed to updatedFields (for key aliases like workflowState→draft).
    const set = (key: string, value: unknown, label?: string) => {
      if (value != null) { body[key] = value; updatedFields.push(label ?? key); }
    };

    set('title', updates.title);
    // Squarespace blog body PUT format: { html: htmlString }
    // Note: createBlogPost uses { raw: false, layout: {...} } but PUT uses { html: "..." }
    set('body', updates.body != null
      ? (typeof updates.body === 'string' ? { html: updates.body } : updates.body)
      : undefined);
    // Squarespace expects excerpt as { html, raw: false }, not a plain string
    set('excerpt', updates.excerpt != null
      ? (typeof updates.excerpt === 'string' ? { html: updates.excerpt, raw: false } : updates.excerpt)
      : undefined);
    set('tags', updates.tags);
    set('categories', updates.categories);
    set('urlId', updates.urlId);
    if (updates.publishDate) {
      const ms = new Date(updates.publishDate).getTime();
      if (!isNaN(ms)) set('publishOn', ms, 'publishDate');
    }
    set('coverImageUrl', updates.coverImageUrl);
    set('workflowState', updates.draft != null ? (updates.draft ? 4 : 1) : undefined, 'draft');

    if (updatedFields.length === 0) {
      return { success: false, itemId, updatedFields: [], error: 'No fields provided to update' };
    }

    // Same endpoint pattern as create: PUT /api/content/blogs/{collectionId}/text-posts/{itemId}
    const url = `https://${this.siteSubdomain}.squarespace.com/api/content/blogs/${collectionId}/text-posts/${itemId}`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 401) {
      return { success: false, itemId, updatedFields: [], error: 'Session expired — call sq_login to check session health and re-authenticate.' };
    }
    if (response.status === 404) {
      return { success: false, itemId, updatedFields: [], error: 'Blog post not found' };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, itemId, updatedFields: [], error: this.enhanceError(response.status, text, `HTTP ${response.status}: ${text}`) };
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (data.crumbFail || (typeof data.error === 'string' && data.error.includes('Invalid session crumb'))) {
      if (!_isRetry && await this.handleCrumbFailure(JSON.stringify(data))) {
        logger.info('updateBlogPost: retrying after crumb refresh');
        return this.updateBlogPost(collectionId, itemId, updates, true);
      }
      return { success: false, itemId, updatedFields: [], error: 'Session crumb invalid — call sq_login to check session health and re-authenticate.' };
    }

    logger.info({ collectionId, itemId, updatedFields }, 'updateBlogPost: post updated');
    return { success: true, itemId, updatedFields };
  } catch (err) {
    return { success: false, itemId, updatedFields: [], error: errMsg(err) };
  }
};

ContentSaveClient.prototype.findBlogPostByTitle = async function (
  this: ContentSaveClient,
  collectionId: string,
  searchTitle: string,
): Promise<CollectionItem | null> {
  try {
    const result = await this.getCollectionItems(collectionId);
    if (!result.success || !result.items) return null;
    const lower = searchTitle.toLowerCase().trim();
    return result.items.find((item) => item.title?.toLowerCase().includes(lower)) ?? null;
  } catch (err) {
    logger.warn({ error: errMsg(err), collectionId, searchTitle }, 'findBlogPostByTitle: failed');
    return null;
  }
};

// ── Blog Post Delete ─────────────────────────────────────────────────────

ContentSaveClient.prototype.deleteBlogPost = async function (
  this: ContentSaveClient,
  collectionId: string,
  postId: string,
  _isRetry = false,
): Promise<BlogPostDeleteResult> {
  this.ensureCookies();

  try {
    const url = this.buildApiUrl('/api/commondata/RemoveItem');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: `itemId=${encodeURIComponent(postId)}`,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 401) {
      return { success: false, postId, error: 'Session expired — call sq_login to check session health and re-authenticate.' };
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { success: false, postId, error: `RemoveItem returned ${response.status}: ${errBody.slice(0, 200)}` };
    }

    let data: Record<string, unknown> = {};
    try { data = (await response.json()) as Record<string, unknown>; } catch { /* empty ok */ }

    if (data.crumbFail || (typeof data.error === 'string' && String(data.error).includes('Invalid session crumb'))) {
      if (!_isRetry && await this.handleCrumbFailure(JSON.stringify(data))) {
        logger.info('deleteBlogPost: retrying after crumb refresh');
        return this.deleteBlogPost(collectionId, postId, true);
      }
      return { success: false, postId, error: 'Session crumb invalid — call sq_login to check session health and re-authenticate.' };
    }

    logger.info({ collectionId, postId }, 'deleteBlogPost: post moved to trash');
    return { success: true, postId };
  } catch (err) {
    return { success: false, postId, error: errMsg(err) };
  }
};

// ── Page Delete / Update ────────────────────────────────────────────────

ContentSaveClient.prototype.deletePageViaApi = async function (
  this: ContentSaveClient,
  collectionId: string,
  _isRetry = false,
): Promise<PageDeleteResult> {
  this.ensureCookies();
  const errors: string[] = [];

  // Strategy 1: DELETE endpoint (works on some sites)
  try {
    const path = `/api/collections/${collectionId}`;
    const url = this.buildApiUrl(path, true);

    const response = await fetch(url, {
      method: 'DELETE',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.ok) {
      let data: Record<string, unknown> = {};
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        // Empty body on success is fine
      }

      if (!data.crumbFail && !(typeof data.error === 'string' && String(data.error).includes('Invalid session crumb'))) {
        logger.info({ collectionId }, 'deletePageViaApi: page deleted via DELETE');
        invalidateCacheByCollectionId(collectionId);
        return { success: true, collectionId, method: 'deleted' };
      }
      errors.push(`DELETE: crumb failure`);
    } else {
      const body = await response.text().catch(() => '');
      errors.push(`DELETE: ${response.status} ${body.slice(0, 100)}`);
    }
  } catch (err) {
    errors.push(`DELETE: ${errMsg(err)}`);
    logger.warn({ collectionId, error: errMsg(err) }, 'deletePageViaApi: DELETE endpoint failed');
  }

  // Strategy 2: RemoveCollection (moves to trash — the same endpoint the editor uses)
  try {
    const url = this.buildApiUrl('/api/commondata/RemoveCollection');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: `collectionId=${encodeURIComponent(collectionId)}`,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.ok) {
      let data: Record<string, unknown> = {};
      try { data = (await response.json()) as Record<string, unknown>; } catch { /* empty ok */ }
      if (!data.crumbFail && !(typeof data.error === 'string' && String(data.error).includes('Invalid session crumb'))) {
        logger.info({ collectionId }, 'deletePageViaApi: page moved to trash via RemoveCollection');
        invalidateCacheByCollectionId(collectionId);
        return { success: true, collectionId, method: 'deleted' };
      }
      errors.push(`RemoveCollection: crumb failure`);
    } else {
      const errBody = await response.text().catch(() => '');
      errors.push(`RemoveCollection: ${response.status} ${errBody.slice(0, 100)}`);
      logger.warn({ collectionId, status: response.status, body: errBody.slice(0, 300) }, 'deletePageViaApi: RemoveCollection failed');
    }
  } catch (err) {
    errors.push(`RemoveCollection: ${errMsg(err)}`);
    logger.warn({ collectionId, error: errMsg(err) }, 'deletePageViaApi: RemoveCollection failed');
  }

  // Retry once if any strategy failed due to crumb
  if (!_isRetry && errors.some(e => e.includes('crumb failure'))) {
    if (await this.handleCrumbFailure('{"crumbFail":true}')) {
      logger.info({ collectionId }, 'deletePageViaApi: retrying after crumb refresh');
      return this.deletePageViaApi(collectionId, true);
    }
  }

  // Strategy 3: Hide from navigation as fallback
  const fallback = await this.tryHidePageFromNav(collectionId);
  if (fallback) return fallback;

  return {
    success: false,
    collectionId,
    error: `All delete strategies failed: ${errors.join(' | ')}`,
  };
};

ContentSaveClient.prototype.tryHidePageFromNav = async function (
  this: ContentSaveClient,
  collectionId: string,
): Promise<PageDeleteResult | null> {
  try {
    logger.info({ collectionId }, 'deletePageViaApi: DELETE failed, trying nav-hiding fallback');

    const navResult = await this.getNavigation();
    if (!navResult.success || !navResult.data) {
      logger.warn({ collectionId }, 'Nav-hiding fallback: could not fetch navigation');
      return null;
    }

    const { mainNavigation } = navResult.data;
    const pageInNav = mainNavigation.some(
      (item) => item.collectionId === collectionId || item.id === collectionId,
    );

    if (!pageInNav) {
      logger.info({ collectionId }, 'Nav-hiding fallback: page not in main navigation, nothing to hide');
      return null;
    }

    // Filter out the page — use raw fetch to preserve all fields for updateNavigation
    const rawNavUrl = this.buildApiUrl('/api/navigation');
    const rawNavRes = await fetch(rawNavUrl, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!rawNavRes.ok) {
      logger.warn({ collectionId, status: rawNavRes.status }, 'Nav-hiding fallback: raw nav fetch failed');
      return null;
    }

    const rawNav = await rawNavRes.json() as Record<string, unknown>;
    const rawMainNav = Array.isArray(rawNav.mainNavigation)
      ? (rawNav.mainNavigation as Record<string, unknown>[])
      : [];

    const filtered = rawMainNav.filter(
      (item) => item.collectionId !== collectionId && item.id !== collectionId,
    );

    if (filtered.length === rawMainNav.length) {
      logger.info({ collectionId }, 'Nav-hiding fallback: page not found in raw mainNavigation');
      return null;
    }

    const updateResult = await this.updateNavigation(
      'mainNav',
      filtered as unknown as UpdateNavigationItem[],
    );

    if (!updateResult.success) {
      logger.warn({ collectionId, error: updateResult.error }, 'Nav-hiding fallback: updateNavigation failed');
      return null;
    }

    logger.info({ collectionId }, 'deletePageViaApi: page hidden from navigation (fallback)');

    return {
      success: true,
      collectionId,
      method: 'hidden_from_nav',
      note: 'Page could not be fully deleted via API. It has been removed from site navigation and is no longer visible to visitors, but the page data still exists in Squarespace.',
    };
  } catch (err) {
    logger.warn({ collectionId, error: errMsg(err) }, 'Nav-hiding fallback failed');
    return null;
  }
};

ContentSaveClient.prototype.updatePageMetadata = async function (
  this: ContentSaveClient,
  collectionId: string,
  updates: PageMetadataUpdateOptions,
  _isRetry = false,
): Promise<PageMetadataUpdateResult> {
  this.ensureCookies();

  try {
    const path = `/api/collections/${collectionId}`;
    const url = this.buildApiUrl(path, true);

    const body: Record<string, unknown> = {};
    const updatedFields: string[] = [];

    if (updates.title != null) { body.title = updates.title; updatedFields.push('title'); }
    if (updates.urlId != null) { body.urlId = updates.urlId; updatedFields.push('urlId'); }
    if (updates.description != null) { body.description = updates.description; updatedFields.push('description'); }
    if (updates.seoTitle != null) { body.seoTitle = updates.seoTitle; updatedFields.push('seoTitle'); }
    if (updates.seoDescription != null) { body.seoDescription = updates.seoDescription; updatedFields.push('seoDescription'); }
    if (updates.navigationTitle != null) { body.navigationTitle = updates.navigationTitle; updatedFields.push('navigationTitle'); }
    if (updates.enabled != null) { body.enabled = updates.enabled; updatedFields.push('enabled'); }
    if (updates.deleted != null) { body.deleted = updates.deleted; updatedFields.push('deleted'); }

    if (updatedFields.length === 0) {
      return {
        success: false,
        collectionId,
        updatedFields: [],
        error: 'No fields provided for update',
      };
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 401) {
      return {
        success: false,
        collectionId,
        updatedFields: [],
        error: 'Session expired — call sq_login to check session health and re-authenticate.',
      };
    }

    if (!response.ok) {
      return {
        success: false,
        collectionId,
        updatedFields: [],
        error: `API returned ${response.status}`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (data.crumbFail || (typeof data.error === 'string' && String(data.error).includes('Invalid session crumb'))) {
      if (!_isRetry && await this.handleCrumbFailure(JSON.stringify(data))) {
        logger.info('updatePageMetadata: retrying after crumb refresh');
        return this.updatePageMetadata(collectionId, updates, true);
      }
      const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
      return {
        success: false,
        collectionId,
        updatedFields: [],
        error: `updatePageMetadata rejected: invalid or expired session crumb.${ageInfo} Call sq_login to check session health and re-authenticate.`,
      };
    }

    logger.info({ collectionId, updatedFields }, 'updatePageMetadata: metadata updated');

    return {
      success: true,
      collectionId,
      updatedFields,
    };
  } catch (err) {
    return {
      success: false,
      collectionId,
      updatedFields: [],
      error: errMsg(err),
    };
  }
};

// ── Blog Post Featured Image ────────────────────────────────────────────

ContentSaveClient.prototype.setBlogPostFeaturedImage = async function (
  this: ContentSaveClient,
  collectionId: string,
  itemId: string,
  imageBuffer: Buffer,
  filename: string,
  contentType = 'image/jpeg',
): Promise<BlogPostFeaturedImageResult> {
  this.ensureCookies();

  try {
    const url = this.buildApiUrl('/api/commondata/SaveMedia');
    const fd = new FormData();
    fd.append('process', 'true');
    fd.append('contentType', contentType);
    fd.append('isWordpressXmlFile', 'false');
    fd.append('recordType', '2');
    fd.append('collectionId', collectionId);
    fd.append('replaceItemId', itemId);
    fd.append('imageDestination', 'content-item-main-image');
    fd.append('fileName', filename);
    fd.append('fileSize', String(imageBuffer.length));
    fd.append('Filedata', new Blob([new Uint8Array(imageBuffer)], { type: contentType }), filename);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, itemId, error: `SaveMedia returned ${response.status}: ${text.slice(0, 200)}` };
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Poll the job until complete
    const job = data.job as Record<string, unknown> | undefined;
    const jobId = job?.id as string | undefined;
    if (jobId) {
      const jobUrl = this.buildApiUrl(`/api/rest/jobs?id=${encodeURIComponent(jobId)}`);
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const jobResp = await fetch(jobUrl, {
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!jobResp.ok) continue;
        const jobData = (await jobResp.json()) as Record<string, unknown>;
        if (jobData.completed || jobData.percentComplete === 100) break;
        if (jobData.error) {
          return { success: false, itemId, error: `Job failed: ${JSON.stringify(jobData).slice(0, 200)}` };
        }
      }
    }

    // Verify the image was linked by checking the blog post
    const checkUrl = this.buildApiUrl(`/api/content/blogs/${collectionId}/text-posts/${itemId}`);
    const checkResp = await fetch(checkUrl, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (checkResp.ok) {
      const post = (await checkResp.json()) as Record<string, unknown>;
      if (post.hasFileData) {
        logger.info({ collectionId, itemId, coverImageUrl: String(post.coverImageUrl ?? '').slice(0, 80) },
          'setBlogPostFeaturedImage: image set successfully');
        return {
          success: true,
          itemId,
          coverImageUrl: post.coverImageUrl as string | undefined,
        };
      }
    }

    // SaveMedia returned OK but post doesn't show the image yet — still report success
    // as the job may still be processing
    logger.warn({ collectionId, itemId }, 'setBlogPostFeaturedImage: SaveMedia OK but post verification inconclusive');
    return { success: true, itemId };
  } catch (err) {
    return { success: false, itemId, error: errMsg(err) };
  }
};
