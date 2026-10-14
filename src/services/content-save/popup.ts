/**
 * Promotional pop-up (Marketing > Pop-Up) — read the pop-up slide and save its slices.
 *
 * Endpoints captured from the config UI's own saves on bmco, 2026-10-13:
 *   GET /api/popup-overlay/slide-summary   → { slide, slices, tweaks }
 *   PUT /api/slides/{slideId}/slices       → { slices: [...] } upserts the given slices
 *                                            (by id; a slice without id is created)
 * The on/off switch and triggers are NOT on the slide — they live in site settings
 * (`popupOverlaySettings`, style 1 = off / 2 = on) and go through updateSettings().
 * Style (`PUT /api/slides/{id}/tweaks`) is deliberately unsupported: the editor sends
 * compiled LESS alongside the values, which we can't reproduce.
 */

import { ContentSaveClient, FETCH_TIMEOUT_MS } from './client.js';
import type { PopupSlide, PopupSlice, PopupSummaryResult, PopupSlicesSaveResult } from './types.js';
import { logger } from '../../utils/logger.js';
import { errMsg } from '../../utils/errors.js';

declare module './index.js' {
  interface ContentSaveClient {
    getPopupSummary(): Promise<PopupSummaryResult>;
    savePopupSlices(slideId: string, slices: PopupSlice[]): Promise<PopupSlicesSaveResult>;
  }
}

ContentSaveClient.prototype.getPopupSummary = async function (
  this: ContentSaveClient,
): Promise<PopupSummaryResult> {
  this.ensureCookies();
  try {
    const response = await fetch(this.buildApiUrl('/api/popup-overlay/slide-summary', true), {
      headers: this.buildHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, body, `GET slide-summary failed: ${response.status} ${body}`) };
    }
    const data = await response.json() as { slide?: PopupSlide; slices?: PopupSlice[]; tweaks?: { tweakValues?: Record<string, string> } };
    if (!data.slide?.id) {
      return { success: false, error: 'No pop-up has been set up on this site yet (create one once in Marketing > Pop-Up)' };
    }
    return { success: true, slide: data.slide, slices: data.slices ?? [], tweakValues: data.tweaks?.tweakValues ?? {} };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};

ContentSaveClient.prototype.savePopupSlices = async function (
  this: ContentSaveClient,
  slideId: string,
  slices: PopupSlice[],
): Promise<PopupSlicesSaveResult> {
  this.ensureCookies();
  try {
    const path = `/api/slides/${encodeURIComponent(slideId)}/slices`;
    const response = await fetch(this.buildApiUrl(path, true), {
      method: 'PUT',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
        ...(this.crumbToken ? { 'x-csrf-token': this.crumbToken } : {}),
      },
      body: JSON.stringify({ slices }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { success: false, error: this.enhanceError(response.status, body, `PUT ${path} failed: ${response.status} ${body}`) };
    }
    logger.info({ siteSubdomain: this.siteSubdomain, slideId, count: slices.length }, 'Pop-up slices saved');
    return { success: true, savedCount: slices.length };
  } catch (err) {
    return { success: false, error: errMsg(err) };
  }
};
