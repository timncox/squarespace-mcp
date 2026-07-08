import { ContentSaveClient, FETCH_TIMEOUT_MS } from './client.js';
import type {
  SiteIdentityData,
  SiteIdentityUpdateOptions,
  SiteIdentityResult,
  NavigationItem,
  NavigationData,
  NavigationResult,
  SiteSettings,
  SettingsResult,
  CodeInjectionData,
  UpdateNavigationRequest,
  UpdateNavigationItem,
  UpdateNavigationResult,
  SocialAccount,
  CssPatchOperation,
  CssPatchResult,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    getCustomCSS(): Promise<{ success: boolean; css: string; error?: string }>;
    saveCustomCSS(css: string, _isRetry?: boolean): Promise<{ success: boolean; error?: string }>;
    getSiteIdentity(): Promise<SiteIdentityResult>;
    updateSiteIdentity(updates: SiteIdentityUpdateOptions): Promise<SiteIdentityResult>;
    getSettings(): Promise<SettingsResult>;
    updateSettings(fields: Partial<SiteSettings>): Promise<SettingsResult>;
    getCodeInjection(): Promise<{ success: boolean; data?: CodeInjectionData; error?: string }>;
    saveCodeInjection(header?: string, footer?: string, _isRetry?: boolean): Promise<{ success: boolean; error?: string }>;
    getNavigation(): Promise<NavigationResult>;
    updateNavigation(fieldName: string, items: UpdateNavigationItem[]): Promise<UpdateNavigationResult>;
    resolveTemplateId(): Promise<string | null>;
    getSocialAccounts(): Promise<{ success: boolean; data?: SocialAccount[]; error?: string }>;
    addSocialAccount(serviceId: number, username: string, profileUrl: string): Promise<{ success: boolean; data?: SocialAccount; error?: string }>;
    removeSocialAccount(accountId: string): Promise<{ success: boolean; error?: string }>;
    patchCustomCSS(operations: CssPatchOperation[]): Promise<CssPatchResult>;
  }
}

// ── Custom CSS ───────────────────────────────────────────────────────────────

ContentSaveClient.prototype.getCustomCSS = async function (
  this: ContentSaveClient,
): Promise<{ success: boolean; css: string; error?: string }> {
  this.ensureCookies();

  const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
  const url = `${siteUrl}/api/template/GetTemplateCustomCss`;

  logger.info({ siteSubdomain: this.siteSubdomain }, 'Fetching custom CSS');

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, css: '', error: `${response.status} ${response.statusText}: ${body}` };
    }

    const data = await response.json() as Record<string, unknown>;
    // Response may be { customCss: "..." } or just the CSS string
    const css = typeof data === 'string'
      ? data
      : typeof data.customCss === 'string'
        ? data.customCss
        : '';

    logger.info({ cssLength: css.length }, 'Custom CSS fetched');
    return { success: true, css };
  } catch (err) {
    return { success: false, css: '', error: errMsg(err) };
  }
};

ContentSaveClient.prototype.saveCustomCSS = async function (
  this: ContentSaveClient,
  css: string,
  _isRetry = false,
): Promise<{ success: boolean; error?: string }> {
  this.ensureCookies();

  const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
  let url = `${siteUrl}/api/template/SaveTemplateCustomCss`;
  if (this.crumbToken) {
    url += `?crumb=${encodeURIComponent(this.crumbToken)}`;
  }

  logger.info({ siteSubdomain: this.siteSubdomain, cssLength: css.length }, 'Saving custom CSS');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ customCss: css }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const responseBody = await response.text().catch(() => '');

    if (!response.ok) {
      const baseError = `CSS save failed: ${response.status} ${response.statusText}. Body: ${responseBody}`;
      const error = this.enhanceError(response.status, responseBody, baseError);
      logger.error({ status: response.status }, error);
      return { success: false, error };
    }

    // Check for crumb failure — auto-refresh and retry once
    if (this.isCrumbFailure(responseBody) && !_isRetry && await this.handleCrumbFailure(responseBody)) {
      logger.info('saveCustomCSS: retrying after crumb refresh');
      return this.saveCustomCSS(css, true);
    }
    if (this.isCrumbFailure(responseBody)) {
      const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
      const error = `CSS save rejected: invalid or expired session crumb.${ageInfo} Run a browser session to refresh cookies.`;
      logger.error(error);
      return { success: false, error };
    }

    logger.info({ cssLength: css.length }, 'Custom CSS saved successfully');
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── CSS Patch ────────────────────────────────────────────────────────────────

/**
 * Find the full CSS rule block for a given selector.
 *
 * Returns the start and end indices (inclusive of the closing `}`) of the
 * outermost rule that begins with `selector {`, or `null` if not found.
 * Handles nested braces (e.g., media queries with rules inside).
 */
function findRuleBlock(css: string, selector: string): { start: number; end: number } | null {
  // Escape special regex characters in the selector
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the selector followed by optional whitespace and `{`
  const pattern = new RegExp(`(^|[\\n;{}])\\s*${escaped}\\s*\\{`, 'm');
  const match = pattern.exec(css);
  if (!match) return null;

  // Find the actual start of the selector (skip the leading delimiter)
  const leadingDelim = match[0].length - match[0].trimStart().length;
  // If the match starts with a delimiter char (newline, ;, {, }), skip it
  let start = match.index;
  const firstChar = css[start];
  if (firstChar === '\n' || firstChar === ';' || firstChar === '{' || firstChar === '}') {
    start += 1;
  }
  // Skip any whitespace before the selector
  while (start < css.length && (css[start] === ' ' || css[start] === '\t' || css[start] === '\n' || css[start] === '\r')) {
    start++;
  }

  // Find the opening brace
  const braceStart = css.indexOf('{', match.index + 1);
  if (braceStart === -1) return null;

  // Count brace depth to find the matching closing brace
  let depth = 1;
  let i = braceStart + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }

  if (depth !== 0) return null;

  return { start, end: i };  // end is exclusive (one past the closing `}`)
}

ContentSaveClient.prototype.patchCustomCSS = async function (
  this: ContentSaveClient,
  operations: CssPatchOperation[],
): Promise<CssPatchResult> {
  if (!operations || operations.length === 0) {
    return { success: false, error: 'No operations provided' };
  }

  try {
    // Read current CSS
    const getResult = await this.getCustomCSS();
    if (!getResult.success) {
      return { success: false, error: `Failed to read current CSS: ${getResult.error}` };
    }

    let css = getResult.css;
    let appliedOps = 0;

    for (const op of operations) {
      switch (op.action) {
        case 'add': {
          if (!op.css) {
            return { success: false, appliedOps, error: `Add operation requires "css" field` };
          }
          // Append with a newline separator if CSS is non-empty
          if (css.length > 0 && !css.endsWith('\n')) {
            css += '\n';
          }
          css += op.css;
          appliedOps++;
          break;
        }

        case 'remove': {
          if (!op.selector) {
            return { success: false, appliedOps, error: `Remove operation requires "selector" field` };
          }
          const block = findRuleBlock(css, op.selector);
          if (!block) {
            return { success: false, appliedOps, error: `Selector not found: ${op.selector}` };
          }
          // Remove the block and any trailing newline
          let end = block.end;
          while (end < css.length && (css[end] === '\n' || css[end] === '\r')) {
            end++;
          }
          css = css.slice(0, block.start) + css.slice(end);
          appliedOps++;
          break;
        }

        case 'replace': {
          if (!op.selector) {
            return { success: false, appliedOps, error: `Replace operation requires "selector" field` };
          }
          if (!op.css) {
            return { success: false, appliedOps, error: `Replace operation requires "css" field` };
          }
          const replaceBlock = findRuleBlock(css, op.selector);
          if (!replaceBlock) {
            return { success: false, appliedOps, error: `Selector not found: ${op.selector}` };
          }
          css = css.slice(0, replaceBlock.start) + op.css + css.slice(replaceBlock.end);
          appliedOps++;
          break;
        }

        default:
          return { success: false, appliedOps, error: `Unknown action: ${(op as any).action}` };
      }
    }

    // Write back
    const saveResult = await this.saveCustomCSS(css);
    if (!saveResult.success) {
      return { success: false, appliedOps, error: `Failed to save CSS: ${saveResult.error}` };
    }

    logger.info({ appliedOps }, 'CSS patched successfully');
    return { success: true, appliedOps };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Site Identity ────────────────────────────────────────────────────────────

ContentSaveClient.prototype.getSiteIdentity = async function (
  this: ContentSaveClient,
): Promise<SiteIdentityResult> {
  this.ensureCookies();

  const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;

  try {
    // Fetch both endpoints in parallel
    const [websiteRes, settingsRes] = await Promise.all([
      fetch(`${siteUrl}/api/rest/websites/mine`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
      fetch(`${siteUrl}/api/settings`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
    ]);

    if (!websiteRes.ok) {
      const body = await websiteRes.text().catch(() => '');
      return { success: false, error: `GET /api/rest/websites/mine failed: ${websiteRes.status} ${body}` };
    }
    if (!settingsRes.ok) {
      const body = await settingsRes.text().catch(() => '');
      return { success: false, error: `GET /api/settings failed: ${settingsRes.status} ${body}` };
    }

    const websiteData = await websiteRes.json() as Record<string, unknown>;
    const settingsData = await settingsRes.json() as Record<string, unknown>;

    const location = websiteData.location as Record<string, string> | undefined;

    const data: SiteIdentityData = {
      businessName: location?.addressTitle,
      address: location?.addressLine1,
      address2: location?.addressLine2,
      siteTitle: typeof websiteData.siteTitle === 'string' ? websiteData.siteTitle : undefined,
      phone: typeof settingsData.internalContactPhoneNumber === 'string' ? settingsData.internalContactPhoneNumber : undefined,
      email: typeof settingsData.internalContactEmail === 'string' ? settingsData.internalContactEmail : undefined,
    };

    logger.info({ siteSubdomain: this.siteSubdomain, fields: Object.keys(data).filter(k => data[k as keyof SiteIdentityData] != null) }, 'Site identity fetched');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateSiteIdentity = async function (
  this: ContentSaveClient,
  updates: SiteIdentityUpdateOptions,
): Promise<SiteIdentityResult> {
  this.ensureCookies();

  const siteUrl = `https://${this.siteSubdomain}.squarespace.com`;
  const updatedFields: string[] = [];

  const needsWebsite = updates.businessName !== undefined || updates.address !== undefined || updates.address2 !== undefined || updates.siteTitle !== undefined;
  const needsSettings = updates.phone !== undefined || updates.email !== undefined;

  if (!needsWebsite && !needsSettings) {
    return { success: false, error: 'No fields to update' };
  }

  try {
    // ── Website endpoint (business name, address, siteTitle) ──────────────
    if (needsWebsite) {
      const getRes = await fetch(`${siteUrl}/api/rest/websites/mine`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!getRes.ok) {
        const body = await getRes.text().catch(() => '');
        return { success: false, error: `GET /api/rest/websites/mine failed: ${getRes.status} ${body}` };
      }
      const websiteData = await getRes.json() as Record<string, unknown>;

      // Modify in-place
      const location = (websiteData.location ?? {}) as Record<string, string>;
      if (updates.businessName !== undefined) { location.addressTitle = updates.businessName; updatedFields.push('businessName'); }
      if (updates.address !== undefined) { location.addressLine1 = updates.address; updatedFields.push('address'); }
      if (updates.address2 !== undefined) { location.addressLine2 = updates.address2; updatedFields.push('address2'); }
      websiteData.location = location;
      if (updates.siteTitle !== undefined) { websiteData.siteTitle = updates.siteTitle; updatedFields.push('siteTitle'); }

      let putUrl = `${siteUrl}/api/rest/websites/mine`;
      if (this.crumbToken) putUrl += `?crumb=${encodeURIComponent(this.crumbToken)}`;

      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(websiteData),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!putRes.ok) {
        const body = await putRes.text().catch(() => '');
        return { success: false, error: this.enhanceError(putRes.status, body, `PUT /api/rest/websites/mine failed: ${putRes.status} ${body}`) };
      }
    }

    // ── Settings endpoint (phone, email) ──────────────────────────────────
    if (needsSettings) {
      const getRes = await fetch(`${siteUrl}/api/settings`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!getRes.ok) {
        const body = await getRes.text().catch(() => '');
        return { success: false, error: `GET /api/settings failed: ${getRes.status} ${body}` };
      }
      const settingsData = await getRes.json() as Record<string, unknown>;

      if (updates.phone !== undefined) { settingsData.internalContactPhoneNumber = updates.phone; updatedFields.push('phone'); }
      if (updates.email !== undefined) { settingsData.internalContactEmail = updates.email; updatedFields.push('email'); }

      let putUrl = `${siteUrl}/api/settings`;
      if (this.crumbToken) putUrl += `?crumb=${encodeURIComponent(this.crumbToken)}`;

      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsData),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!putRes.ok) {
        const body = await putRes.text().catch(() => '');
        return { success: false, error: this.enhanceError(putRes.status, body, `PUT /api/settings failed: ${putRes.status} ${body}`) };
      }
    }

    logger.info({ siteSubdomain: this.siteSubdomain, updatedFields }, 'Site identity updated');
    return { success: true, updatedFields };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Settings ─────────────────────────────────────────────────────────────────

ContentSaveClient.prototype.getSettings = async function (
  this: ContentSaveClient,
): Promise<SettingsResult> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/settings');

  logger.info({ siteSubdomain: this.siteSubdomain }, 'Fetching site settings');

  try {
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `${response.status} ${response.statusText}: ${body}` };
    }

    const data = await response.json() as SiteSettings;
    logger.info('Site settings fetched');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateSettings = async function (
  this: ContentSaveClient,
  fields: Partial<SiteSettings>,
): Promise<SettingsResult> {
  this.ensureCookies();

  const fieldKeys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (fieldKeys.length === 0) {
    return { success: false, error: 'No fields to update' };
  }

  try {
    const url = this.buildApiUrl('/api/settings');

    // GET current settings
    const getRes = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!getRes.ok) {
      const body = await getRes.text().catch(() => '');
      return { success: false, error: `GET /api/settings failed: ${getRes.status} ${body}` };
    }
    const current = await getRes.json() as Record<string, unknown>;

    // Merge updated fields
    for (const key of fieldKeys) {
      current[key] = fields[key as keyof SiteSettings];
    }

    // PUT merged settings
    let putUrl = url;
    if (this.crumbToken) putUrl += `?crumb=${encodeURIComponent(this.crumbToken)}`;

    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(current),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!putRes.ok) {
      const body = await putRes.text().catch(() => '');
      return { success: false, error: this.enhanceError(putRes.status, body, `PUT /api/settings failed: ${putRes.status} ${body}`) };
    }

    logger.info({ siteSubdomain: this.siteSubdomain, updatedFields: fieldKeys }, 'Settings updated');
    return { success: true, updatedFields: fieldKeys };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Code Injection ───────────────────────────────────────────────────────────

ContentSaveClient.prototype.getCodeInjection = async function (
  this: ContentSaveClient,
): Promise<{ success: boolean; data?: CodeInjectionData; error?: string }> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/settings');

  logger.info({ siteSubdomain: this.siteSubdomain }, 'Fetching code injection settings');

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `${response.status} ${response.statusText}: ${body}` };
    }

    const settings = await response.json() as Record<string, unknown>;
    const injection = settings.codeInjection as Record<string, string> | undefined;

    const data: CodeInjectionData = {
      header: injection?.header ?? (settings.injectHeader as string | undefined) ?? '',
      footer: injection?.footer ?? (settings.injectFooter as string | undefined) ?? '',
    };

    logger.info(
      { headerLength: data.header.length, footerLength: data.footer.length },
      'Code injection fetched',
    );
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.saveCodeInjection = async function (
  this: ContentSaveClient,
  header?: string,
  footer?: string,
  _isRetry = false,
): Promise<{ success: boolean; error?: string }> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/config/SaveInjectionSettings', true);

  // Legacy config RPC — rejects JSON with 415 and wants form encoding, with
  // field names `header`/`footer` (`injectHeader`/`injectFooter` are accepted
  // but silently ignored). Verified against the config UI's own save request.
  const body = new URLSearchParams();
  if (header !== undefined) body.set('header', header);
  if (footer !== undefined) body.set('footer', footer);

  logger.info(
    { siteSubdomain: this.siteSubdomain, headerLength: header?.length, footerLength: footer?.length },
    'Saving code injection',
  );

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const responseBody = await response.text().catch(() => '');

    if (!response.ok) {
      const baseError = `Code injection save failed: ${response.status} ${response.statusText}. Body: ${responseBody}`;
      const error = this.enhanceError(response.status, responseBody, baseError);
      logger.error({ status: response.status }, error);
      return { success: false, error };
    }

    // Check for crumb failure — auto-refresh and retry once
    if (this.isCrumbFailure(responseBody) && !_isRetry && await this.handleCrumbFailure(responseBody)) {
      logger.info('saveCodeInjection: retrying after crumb refresh');
      return this.saveCodeInjection(header, footer, true);
    }
    if (this.isCrumbFailure(responseBody)) {
      const ageInfo = this.sessionAgeHours !== null ? ` Session age: ${Math.round(this.sessionAgeHours)}h.` : '';
      const error = `Code injection save rejected: invalid or expired session crumb.${ageInfo} Run a browser session to refresh cookies.`;
      logger.error(error);
      return { success: false, error };
    }

    logger.info('Code injection saved successfully');
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

// ── Navigation ───────────────────────────────────────────────────────────────

ContentSaveClient.prototype.getNavigation = async function (
  this: ContentSaveClient,
): Promise<NavigationResult> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/navigation');

  logger.info({ siteSubdomain: this.siteSubdomain }, 'Fetching navigation');

  try {
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `${response.status} ${response.statusText}: ${body}` };
    }

    const raw = await response.json() as Record<string, unknown>;

    const parseItem = (item: Record<string, unknown>): NavigationItem => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? item.navigationTitle ?? ''),
      urlSlug: String(item.urlId ?? item.urlSlug ?? ''),
      collectionId: typeof item.collectionId === 'string' ? item.collectionId : undefined,
      collectionType: typeof item.collectionType === 'number' ? item.collectionType : undefined,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : undefined,
      isDraft: typeof item.draft === 'boolean' ? item.draft : undefined,
      isFolder: typeof item.folder === 'boolean' ? item.folder : undefined,
      ordering: typeof item.ordering === 'number' ? item.ordering : undefined,
      type: typeof item.type === 'string' ? item.type : undefined,
      children: Array.isArray(item.children)
        ? (item.children as Record<string, unknown>[]).map(parseItem)
        : undefined,
    });

    const mainNavigation = Array.isArray(raw.mainNavigation)
      ? (raw.mainNavigation as Record<string, unknown>[]).map(parseItem)
      : [];
    const notLinked = Array.isArray(raw.notLinked)
      ? (raw.notLinked as Record<string, unknown>[]).map(parseItem)
      : [];

    const data: NavigationData = { mainNavigation, notLinked };
    logger.info(
      { mainCount: mainNavigation.length, notLinkedCount: notLinked.length },
      'Navigation fetched',
    );
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateNavigation = async function (
  this: ContentSaveClient,
  fieldName: string,
  items: UpdateNavigationItem[],
): Promise<UpdateNavigationResult> {
  this.ensureCookies();

  try {
    // Resolve templateId (cached per-site — it doesn't change)
    const templateId = await this.resolveTemplateId();
    if (!templateId) {
      return { success: false, error: 'Could not determine templateId for navigation update. Tried /api/rest/websites/mine and /api/navigation.' };
    }

    const requestBody: UpdateNavigationRequest = {
      fieldName,
      templateId,
      navigation: { items },
    };

    const url = this.buildApiUrl('/api/widget/UpdateNavigation', true);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `UpdateNavigation failed: ${response.status} ${body}` };
    }

    logger.info({ fieldName, itemCount: items.length }, 'Navigation updated');
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

/**
 * Resolve the site's templateId, caching the result.
 * Tries /api/rest/websites/mine first (most reliable), then falls back
 * to parsing it from the /api/navigation response.
 */
ContentSaveClient.prototype.resolveTemplateId = async function (
  this: ContentSaveClient,
): Promise<string | null> {
  if (this.templateIdCache) return this.templateIdCache;

  // Strategy 1: GET /api/rest/websites/mine — returns { templateId: "..." }
  try {
    const websiteUrl = this.buildApiUrl('/api/rest/websites/mine');
    const websiteRes = await fetch(websiteUrl, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (websiteRes.ok) {
      const data = await websiteRes.json() as Record<string, unknown>;
      const tmplObj = typeof data.template === 'object' && data.template !== null
        ? data.template as Record<string, unknown>
        : undefined;
      const tid = data.templateId ?? tmplObj?.id ?? tmplObj?.templateId;
      if (typeof tid === 'string' && tid) {
        this.templateIdCache = tid;
        logger.info({ templateId: tid }, 'Resolved templateId from /api/rest/websites/mine');
        return tid;
      }
    }
  } catch {
    // Fall through to next strategy
  }

  // Strategy 2: GET /api/navigation — the response JSON has a "website" or "templateId" field
  try {
    const navUrl = this.buildApiUrl('/api/navigation');
    const navRes = await fetch(navUrl, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (navRes.ok) {
      const navData = await navRes.json() as Record<string, unknown>;
      // Check top-level templateId
      if (typeof navData.templateId === 'string' && navData.templateId) {
        this.templateIdCache = navData.templateId;
        logger.info({ templateId: navData.templateId }, 'Resolved templateId from /api/navigation');
        return navData.templateId;
      }
      // Check nested website object
      const website = navData.website as Record<string, unknown> | undefined;
      if (website) {
        const tid = website.templateId ?? website.id;
        if (typeof tid === 'string' && tid) {
          this.templateIdCache = tid;
          logger.info({ templateId: tid }, 'Resolved templateId from navigation.website');
          return tid;
        }
      }
    }
  } catch {
    // Fall through
  }

  // Strategy 3: GET /api/commondata/GetCollections — collections have websiteId and sometimes templateId
  try {
    const collectionsUrl = this.buildApiUrl('/api/commondata/GetCollections/');
    const collectionsRes = await fetch(collectionsUrl, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (collectionsRes.ok) {
      const data = await collectionsRes.json() as Record<string, unknown>;
      // The response may have a top-level website object or templateId
      if (typeof data.templateId === 'string' && data.templateId) {
        this.templateIdCache = data.templateId;
        logger.info({ templateId: data.templateId }, 'Resolved templateId from GetCollections');
        return data.templateId;
      }
      const website = data.website as Record<string, unknown> | undefined;
      if (website) {
        const tid = website.templateId ?? website.id;
        if (typeof tid === 'string' && tid) {
          this.templateIdCache = tid;
          logger.info({ templateId: tid }, 'Resolved templateId from GetCollections.website');
          return tid;
        }
      }
    }
  } catch {
    // Fall through
  }

  logger.warn({ siteSubdomain: this.siteSubdomain }, 'Could not resolve templateId from any endpoint');
  return null;
};

// ── Social Accounts ──────────────────────────────────────────────────────────

ContentSaveClient.prototype.getSocialAccounts = async function (
  this: ContentSaveClient,
): Promise<{ success: boolean; data?: SocialAccount[]; error?: string }> {
  this.ensureCookies();
  const url = this.buildApiUrl('/api/rest/social-accounts');

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `GET /api/rest/social-accounts failed: ${response.status} ${body}` };
    }

    const raw = (await response.json()) as { results?: SocialAccount[] };
    const accounts = (raw.results ?? []).map((a) => ({
      id: a.id,
      serviceId: a.serviceId,
      screenname: a.screenname,
      profileUrl: a.profileUrl,
      iconEnabled: a.iconEnabled,
      serviceName: a.serviceName,
    }));

    logger.info({ siteSubdomain: this.siteSubdomain, count: accounts.length }, 'Fetched social accounts');
    return { success: true, data: accounts };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.addSocialAccount = async function (
  this: ContentSaveClient,
  serviceId: number,
  username: string,
  profileUrl: string,
): Promise<{ success: boolean; data?: SocialAccount; error?: string }> {
  this.ensureCookies();
  const url = this.buildApiUrl('/api/config/CreateNonOAuthAccount');

  try {
    const formBody = `service=${encodeURIComponent(serviceId)}&username=${encodeURIComponent(username)}&profileUrl=${encodeURIComponent(profileUrl)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      body: formBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, body, `POST CreateNonOAuthAccount failed: ${response.status} ${body}`) };
    }

    const raw = (await response.json()) as { account?: SocialAccount };
    if (!raw.account) {
      return { success: false, error: 'CreateNonOAuthAccount returned no account object' };
    }

    const account: SocialAccount = {
      id: raw.account.id,
      serviceId: raw.account.serviceId,
      screenname: raw.account.screenname,
      profileUrl: raw.account.profileUrl,
      iconEnabled: raw.account.iconEnabled,
      serviceName: raw.account.serviceName,
    };

    logger.info(
      { siteSubdomain: this.siteSubdomain, accountId: account.id, serviceName: account.serviceName, profileUrl },
      'Social account added',
    );
    return { success: true, data: account };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.removeSocialAccount = async function (
  this: ContentSaveClient,
  accountId: string,
): Promise<{ success: boolean; error?: string }> {
  this.ensureCookies();
  const url = this.buildApiUrl(`/api/rest/social-accounts/${accountId}`);

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        ...this.buildHeaders(),
        ...(this.crumbToken ? { 'X-CSRF-Token': this.crumbToken } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `DELETE /api/rest/social-accounts/${accountId} failed: ${response.status} ${body}` };
    }

    logger.info({ siteSubdomain: this.siteSubdomain, accountId }, 'Social account removed');
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
