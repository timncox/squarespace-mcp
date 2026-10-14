/**
 * MCP Tools — Promotional Pop-Up (Marketing > Pop-Up)
 *
 * sq_get_popup: Read pop-up state (on/off, triggers, layout, heading, body, image, buttons)
 * sq_update_popup: Toggle the pop-up, change triggers, and edit heading/body/buttons/image
 *
 * On/off + triggers live in site settings (`popupOverlaySettings`); content lives in the
 * pop-up slide's slices. The pop-up itself (layout, style) must be created once in the
 * Squarespace UI — style edits are not supported here.
 */

import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient } from '../session.js';
import type { PopupOverlaySettings, PopupSlice } from '../../services/content-save/types.js';

const SLICE_HEADING = 1;
const SLICE_BODY = 3;
const SLICE_GALLERY = 5;
const SLICE_ACTION = 20;

const IMAGE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
};

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain text → the editor's paragraph markup, one <p> per line. */
export function bodyTextToHtml(text: string): string {
  return text.split('\n')
    .map((line) => `<p style="white-space:pre-wrap;">${escapeHtml(line)}</p>`)
    .join('');
}

/** Editor paragraph markup → plain text (zero-width joiners and empty paragraphs dropped). */
export function bodyHtmlToText(html: string): string {
  return html
    .replace(/<\/p>\s*<p[^>]*>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/‍/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

export function summarizeSettings(s: PopupOverlaySettings) {
  return {
    enabled: s.style === 2,
    showOnAllPages: s.showOnAllPages ?? true,
    enableMobile: s.enableMobile ?? true,
    showOnTimer: s.showOnTimer ?? false,
    timerDelaySeconds: typeof s.timerDelay === 'number' ? s.timerDelay / 1000 : null,
    showOnScroll: s.showOnScroll ?? false,
    scrollPercentage: s.scrollPercentage ?? null,
    displayFrequencyDays: s.displayFrequency ?? null,
  };
}

function findSlice(slices: PopupSlice[], type: number) {
  return slices.find((s) => s.type === type);
}

export function registerPopupTools(server: McpServer) {
  // ── sq_get_popup ────────────────────────────────────────────────────────────
  server.registerTool('sq_get_popup', {
    description:
      'Read the promotional pop-up (Marketing > Pop-Up) for a site: whether it is on, its triggers ' +
      '(pages, mobile, timer, scroll, how many days before it re-shows), layout, heading, body text, ' +
      'image(s), and buttons. Errors if no pop-up has been created in the Squarespace UI yet.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const [settings, summary] = await Promise.all([client.getSettings(), client.getPopupSummary()]);
      if (!settings.success) return textResult(`Error: ${settings.error ?? 'Failed to get settings'}`, true);
      if (!summary.success) return textResult(`Error: ${summary.error}`, true);

      const slices = summary.slices ?? [];
      const heading = findSlice(slices, SLICE_HEADING)?.content?.text ?? '';
      const bodyHtml = findSlice(slices, SLICE_BODY)?.content?.body?.html ?? '';
      const action = findSlice(slices, SLICE_ACTION)?.content;
      const gallery = findSlice(slices, SLICE_GALLERY)?.content;

      let images: Array<{ itemId: string; filename?: string; url?: string }> = [];
      if (gallery?.contentCollectionId) {
        const items = await client.getGalleryItems(gallery.contentCollectionId);
        if (items.success) {
          images = (items.items ?? []).map((it: any) => ({
            itemId: it.id,
            filename: it.filename,
            url: it.assetUrl,
          }));
        }
      }

      const out = {
        ...summarizeSettings((settings.data?.popupOverlaySettings ?? {}) as PopupOverlaySettings),
        slideId: summary.slide!.id,
        layout: summary.slide!.layoutIdentifier ?? null,
        heading,
        body: bodyHtmlToText(bodyHtml),
        imageCollectionId: gallery?.contentCollectionId ?? null,
        images,
        actionType: action?.currentContent?._type ?? null,
        buttons: action?.currentContent?._type === 'Buttons'
          ? (action.currentContent.links ?? []).map((l: any) => ({
            text: l.text, url: l.clickthroughUrl?.url ?? '', newWindow: l.clickthroughUrl?.newWindow ?? false,
          }))
          : [],
      };
      return textResult(JSON.stringify(out, null, 2));
    } catch (err) {
      return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  // ── sq_update_popup ─────────────────────────────────────────────────────────
  server.registerTool('sq_update_popup', {
    description:
      'Update the promotional pop-up. All params optional — only provided fields change. ' +
      'enabled turns it on/off (Squarespace has no end date — schedule an enabled:false yourself). ' +
      'Triggers: showOnAllPages, enableMobile, timer/scroll, displayFrequencyDays. ' +
      'Content: heading and body are plain text (body: one paragraph per line, "" clears); ' +
      'buttons replaces the button list (max 2); imagePath replaces the pop-up image with a local file. ' +
      'The pop-up must already exist (create it once in Marketing > Pop-Up). Layout and style are not editable here. ' +
      'Note: some layouts hide the image on mobile — check sq_get_popup + the live site, or set enableMobile:false.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      enabled: z.boolean().optional().describe('Turn the pop-up on (true) or off (false)'),
      showOnAllPages: z.boolean().optional().describe('Show on every page'),
      enableMobile: z.boolean().optional().describe('Show on mobile devices'),
      showOnTimer: z.boolean().optional().describe('Open after a delay'),
      timerDelaySeconds: z.number().min(0).optional().describe('Delay before opening, in seconds'),
      showOnScroll: z.boolean().optional().describe('Open after scrolling'),
      scrollPercentage: z.number().min(0).max(100).optional().describe('Scroll depth (%) that opens it'),
      displayFrequencyDays: z.number().int().min(0).optional().describe('Days before a dismissed pop-up shows again'),
      heading: z.string().optional().describe('Heading text ("" clears)'),
      body: z.string().optional().describe('Body text, one paragraph per line ("" clears)'),
      buttons: z.array(z.object({
        text: z.string(),
        url: z.string(),
        newWindow: z.boolean().optional(),
      })).max(2).optional().describe('Replace the buttons (max 2; [] removes them)'),
      imagePath: z.string().optional().describe('Absolute path to a local image that replaces the pop-up image'),
    },
  }, async (params) => {
    const { siteId, enabled, showOnAllPages, enableMobile, showOnTimer, timerDelaySeconds,
      showOnScroll, scrollPercentage, displayFrequencyDays, heading, body, buttons, imagePath } = params;
    try {
      const client = getClient(siteId);
      const changed: string[] = [];

      // Validate everything that can fail before writing anything.
      let image: { buffer: Buffer; filename: string; contentType: string } | null = null;
      if (imagePath !== undefined) {
        const contentType = IMAGE_TYPES[extname(imagePath).toLowerCase()];
        if (!contentType) return textResult(`Error: unsupported image type for ${imagePath}`, true);
        image = { buffer: readFileSync(imagePath), filename: basename(imagePath), contentType };
      }

      const wantsContent = heading !== undefined || body !== undefined || buttons !== undefined || image !== null;
      const summary = wantsContent ? await client.getPopupSummary() : null;
      if (summary && !summary.success) return textResult(`Error: ${summary.error}`, true);

      // ── Content (slices) ──
      if (summary) {
        const slices = summary.slices ?? [];
        const updates: PopupSlice[] = [];

        if (heading !== undefined) {
          const s = findSlice(slices, SLICE_HEADING);
          if (!s) return textResult('Error: this pop-up layout has no heading', true);
          updates.push({ ...s, content: { ...s.content, text: heading } });
          changed.push('heading');
        }
        if (body !== undefined) {
          const s = findSlice(slices, SLICE_BODY);
          if (!s) return textResult('Error: this pop-up layout has no body text', true);
          updates.push({ ...s, content: { ...s.content, body: { ...s.content.body, html: bodyTextToHtml(body), raw: false } } });
          changed.push('body');
        }
        if (buttons !== undefined) {
          const s = findSlice(slices, SLICE_ACTION);
          if (!s || s.content.currentContent?._type !== 'Buttons') {
            return textResult('Error: this pop-up has no buttons (its action may be a newsletter form) — switch it to buttons in the UI first', true);
          }
          updates.push({
            ...s,
            content: {
              ...s.content,
              currentContent: {
                ...s.content.currentContent,
                links: buttons.map((b) => ({ text: b.text, clickthroughUrl: { url: b.url, newWindow: b.newWindow ?? false } })),
              },
            },
          });
          changed.push('buttons');
        }
        if (updates.length) {
          const saved = await client.savePopupSlices(summary.slide!.id, updates);
          if (!saved.success) return textResult(`Error: ${saved.error}`, true);
        }

        if (image) {
          const collectionId = findSlice(slices, SLICE_GALLERY)?.content?.contentCollectionId;
          if (!collectionId) return textResult(`Error: this pop-up layout has no image (changed so far: ${changed.join(', ') || 'nothing'})`, true);
          const before = await client.getGalleryItems(collectionId);
          if (!before.success) return textResult(`Error: ${before.error}`, true);
          const added = await client.addGalleryImageViaSaveMedia(collectionId, image.buffer, image.filename, image.contentType);
          if (!added.success) return textResult(`Error: image upload failed: ${added.error}`, true);
          // Only remove the old image(s) once the new one is in.
          for (const old of before.items ?? []) {
            const removed = await client.removeGalleryImage(collectionId, (old as any).id);
            if (!removed.success) return textResult(`Error: new image added but old image ${(old as any).id} was not removed: ${removed.error}`, true);
          }
          changed.push('image');
        }
      }

      // ── On/off + triggers (site settings) ──
      const settingsTouched = [enabled, showOnAllPages, enableMobile, showOnTimer, timerDelaySeconds,
        showOnScroll, scrollPercentage, displayFrequencyDays].some((v) => v !== undefined);
      let finalSettings: PopupOverlaySettings | null = null;
      if (settingsTouched) {
        const current = await client.getSettings();
        if (!current.success) return textResult(`Error: ${current.error ?? 'Failed to read settings'}`, true);
        const merged: PopupOverlaySettings = { ...((current.data?.popupOverlaySettings ?? {}) as PopupOverlaySettings) };
        if (enabled !== undefined) { merged.style = enabled ? 2 : 1; changed.push('enabled'); }
        if (showOnAllPages !== undefined) { merged.showOnAllPages = showOnAllPages; changed.push('showOnAllPages'); }
        if (enableMobile !== undefined) { merged.enableMobile = enableMobile; changed.push('enableMobile'); }
        if (showOnTimer !== undefined) { merged.showOnTimer = showOnTimer; changed.push('showOnTimer'); }
        if (timerDelaySeconds !== undefined) { merged.timerDelay = Math.round(timerDelaySeconds * 1000); changed.push('timerDelay'); }
        if (showOnScroll !== undefined) { merged.showOnScroll = showOnScroll; changed.push('showOnScroll'); }
        if (scrollPercentage !== undefined) { merged.scrollPercentage = scrollPercentage; changed.push('scrollPercentage'); }
        if (displayFrequencyDays !== undefined) { merged.displayFrequency = displayFrequencyDays; changed.push('displayFrequency'); }
        const result = await client.updateSettings({ popupOverlaySettings: merged });
        if (!result.success) return textResult(`Error: ${result.error ?? 'Failed to update pop-up settings'}`, true);
        finalSettings = merged;
      }

      if (!changed.length) return textResult('Nothing to change — pass at least one field.', true);
      return textResult(JSON.stringify({
        success: true,
        changed,
        ...(finalSettings ? { settings: summarizeSettings(finalSettings) } : {}),
      }, null, 2));
    } catch (err) {
      return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });
}
