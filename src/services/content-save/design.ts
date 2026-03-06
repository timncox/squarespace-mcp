import { ContentSaveClient, FETCH_TIMEOUT_MS } from './client.js';
import type {
  WebsiteFontsData,
  WebsiteFontsResult,
  WebsiteFontsUpdateResult,
  WebsiteColorsData,
  WebsiteColorsResult,
  WebsiteColorsUpdateResult,
  AdvancedSettingsResult,
  AdvancedSettingsSaveResult,
  TemplateTweakSettings,
  TemplateTweakSettingsResult,
  TemplateTweakSettingsUpdateResult,
  FontUpdateResult,
  PaletteColorUpdateResult,
  FontValue,
  HSLValues,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    getWebsiteFonts(): Promise<WebsiteFontsResult>;
    updateWebsiteFonts(data: WebsiteFontsData): Promise<WebsiteFontsUpdateResult>;
    updateFont(fontName: string, updates: Partial<FontValue>): Promise<FontUpdateResult>;
    getWebsiteColors(): Promise<WebsiteColorsResult>;
    updateWebsiteColors(data: WebsiteColorsData): Promise<WebsiteColorsUpdateResult>;
    updatePaletteColor(colorId: string, hsl: HSLValues): Promise<PaletteColorUpdateResult>;
    getAdvancedSettings(): Promise<AdvancedSettingsResult>;
    saveAdvancedSettings(data: Record<string, string>): Promise<AdvancedSettingsSaveResult>;
    getTemplateTweakSettings(): Promise<TemplateTweakSettingsResult>;
    setTemplateTweakSettings(updates: Record<string, string>): Promise<TemplateTweakSettingsUpdateResult>;
  }
}

// ── Prototype methods ───────────────────────────────────────────────────────

ContentSaveClient.prototype.getWebsiteFonts = async function (
  this: ContentSaveClient,
): Promise<WebsiteFontsResult> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/website-fonts');

  try {
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `${response.status} ${response.statusText}: ${body}` };
    }

    const data = await response.json() as WebsiteFontsData;
    logger.info({ fontPack: data.name }, 'Website fonts fetched');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateWebsiteFonts = async function (
  this: ContentSaveClient,
  data: WebsiteFontsData,
): Promise<WebsiteFontsUpdateResult> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/website-fonts', true);

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: this.enhanceWriteError(response.status, body, `PUT /api/website-fonts failed: ${response.status} ${body}`) };
    }

    logger.info({ siteSubdomain: this.siteSubdomain, fontPack: data.name }, 'Website fonts updated');
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateFont = async function (
  this: ContentSaveClient,
  fontName: string,
  updates: Partial<FontValue>,
): Promise<FontUpdateResult> {
  const getResult = await this.getWebsiteFonts();
  if (!getResult.success || !getResult.data) {
    return { success: false, error: getResult.error ?? 'Failed to fetch current fonts' };
  }

  const data = getResult.data;
  const font = data.masterFonts.find(f => f.name === fontName);
  if (!font) {
    const available = data.masterFonts.map(f => f.name).join(', ');
    return { success: false, error: `Font "${fontName}" not found. Available: ${available}` };
  }

  const updatedFields: string[] = [];
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      (font.fontValue as Record<string, unknown>)[key] = val;
      updatedFields.push(key);
    }
  }

  if (updatedFields.length === 0) {
    return { success: false, error: 'No fields to update' };
  }

  const putResult = await this.updateWebsiteFonts(data);
  if (!putResult.success) {
    return { success: false, error: putResult.error };
  }

  logger.info({ fontName, updatedFields }, 'Font updated via convenience helper');
  return { success: true, fontName, updatedFields };
};

ContentSaveClient.prototype.getWebsiteColors = async function (
  this: ContentSaveClient,
): Promise<WebsiteColorsResult> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/website-colors');

  try {
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `${response.status} ${response.statusText}: ${body}` };
    }

    const data = await response.json() as WebsiteColorsData;
    logger.info({ paletteCount: data.palette?.length, themeCount: data.colorThemes?.length }, 'Website colors fetched');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updateWebsiteColors = async function (
  this: ContentSaveClient,
  data: WebsiteColorsData,
): Promise<WebsiteColorsUpdateResult> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/website-colors', true);

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: this.enhanceWriteError(response.status, body, `PUT /api/website-colors failed: ${response.status} ${body}`) };
    }

    const responseData = await response.json().catch(() => null) as WebsiteColorsData | null;
    logger.info(
      { siteSubdomain: this.siteSubdomain, paletteCount: data.palette?.length },
      'Website colors updated',
    );
    return { success: true, data: responseData ?? undefined };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.updatePaletteColor = async function (
  this: ContentSaveClient,
  colorId: string,
  hsl: HSLValues,
): Promise<PaletteColorUpdateResult> {
  const getResult = await this.getWebsiteColors();
  if (!getResult.success || !getResult.data) {
    return { success: false, error: getResult.error ?? 'Failed to fetch current colors' };
  }

  const data = getResult.data;
  const color = data.palette.find(c => c.id === colorId);
  if (!color) {
    const available = data.palette.map(c => c.id).join(', ');
    return { success: false, error: `Color "${colorId}" not found. Available: ${available}` };
  }

  const oldValues = { ...color.value.values };
  color.value.values = { ...hsl };

  const putResult = await this.updateWebsiteColors(data);
  if (!putResult.success) {
    return { success: false, error: putResult.error };
  }

  logger.info({ colorId, oldValues, newValues: hsl }, 'Palette color updated via convenience helper');
  return { success: true, colorId, oldValues, newValues: hsl };
};

ContentSaveClient.prototype.getAdvancedSettings = async function (
  this: ContentSaveClient,
): Promise<AdvancedSettingsResult> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/config/GetAdvancedSettings');

  try {
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `${response.status} ${response.statusText}: ${body}` };
    }

    const data = await response.json() as Record<string, unknown>;
    logger.info('Advanced settings fetched');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.saveAdvancedSettings = async function (
  this: ContentSaveClient,
  data: Record<string, string>,
): Promise<AdvancedSettingsSaveResult> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/config/SaveAdvancedSettings', true);

  try {
    const formBody = new URLSearchParams(data).toString();

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
      return { success: false, error: this.enhanceWriteError(response.status, body, `POST /api/config/SaveAdvancedSettings failed: ${response.status} ${body}`) };
    }

    logger.info({ siteSubdomain: this.siteSubdomain }, 'Advanced settings saved');
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.getTemplateTweakSettings = async function (
  this: ContentSaveClient,
): Promise<TemplateTweakSettingsResult> {
  this.ensureCookies();

  const url = this.buildApiUrl('/api/template/GetTemplateTweakSettings?version=3');

  try {
    const response = await fetch(url, {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: `${response.status} ${response.statusText}: ${body}` };
    }

    const data = await response.json() as TemplateTweakSettings;
    logger.info({ tweakCount: Object.keys(data).length }, 'Template tweak settings fetched');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.setTemplateTweakSettings = async function (
  this: ContentSaveClient,
  updates: Record<string, string>,
): Promise<TemplateTweakSettingsUpdateResult> {
  this.ensureCookies();

  // Read current settings first
  const getResult = await this.getTemplateTweakSettings();
  if (!getResult.success || !getResult.data) {
    return { success: false, error: getResult.error ?? 'Failed to fetch current tweak settings' };
  }

  // Merge updates
  const merged = { ...getResult.data, ...updates };

  const url = this.buildApiUrl('/api/template/SetTemplateTweakSettings', true);

  try {
    const formBody = `tweakJson=${encodeURIComponent(JSON.stringify(merged))}`;

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
      return { success: false, error: this.enhanceWriteError(response.status, body, `POST /api/template/SetTemplateTweakSettings failed: ${response.status} ${body}`) };
    }

    logger.info(
      { siteSubdomain: this.siteSubdomain, updatedKeys: Object.keys(updates) },
      'Template tweak settings updated',
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
