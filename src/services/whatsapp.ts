import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { storeWhatsAppMessage } from '../db/whatsapp-messages.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function getConfig() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const timNumber = process.env.TIM_WHATSAPP_NUMBER;

  if (!phoneNumberId || !accessToken || !timNumber) {
    throw new Error(
      'Missing WhatsApp config. Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, and TIM_WHATSAPP_NUMBER in .env',
    );
  }

  return { phoneNumberId, accessToken, timNumber };
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface WhatsAppApiResponse {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string }>;
}

interface InteractiveButton {
  type: 'reply';
  reply: {
    id: string;
    title: string; // max 20 chars
  };
}

// ─── Send Text Message ──────────────────────────────────────────────────────

export async function sendText(to: string, body: string, conversationId?: string): Promise<string> {
  const config = getConfig();

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  };

  const response = await callApi(config.phoneNumberId, config.accessToken, payload);
  const waMessageId = response.messages[0]?.id ?? 'unknown';

  // Store outbound message (with conversationId when available for chat history)
  storeWhatsAppMessage({
    conversationId,
    waMessageId,
    direction: 'outbound',
    fromNumber: config.phoneNumberId,
    toNumber: to,
    body,
    timestamp: new Date().toISOString(),
  });

  logger.info({ to, waMessageId, bodyLength: body.length }, 'WhatsApp text sent');
  return waMessageId;
}

/**
 * Send a text to Tim (convenience wrapper using TIM_WHATSAPP_NUMBER).
 * Also emits to the dashboard SSE event bus, and skips WhatsApp API
 * when the conversation originated from the dashboard.
 *
 * @param conversationId - If provided, uses this to determine source (dashboard vs WhatsApp).
 *                         Falls back to getActiveConversation() if omitted (legacy callers).
 */
export async function sendToTim(body: string, conversationId?: string): Promise<string> {
  // Emit to dashboard SSE clients (always, regardless of source)
  const { dashboardEvents } = await import('./dashboard-events.js');
  dashboardEvents.emit('dashboard', {
    type: 'message',
    data: { body, direction: 'outbound', conversationId },
    timestamp: new Date().toISOString(),
  });

  // Resolve conversation — prefer explicit ID, fall back to legacy lookup
  const { getConversation, getActiveConversation } = await import('../db/conversations.js');
  const conversation = conversationId ? getConversation(conversationId) : getActiveConversation();

  if (conversation?.source === 'dashboard') {
    const fakeId = `dash-${Date.now()}`;
    storeWhatsAppMessage({
      conversationId: conversation.id,
      waMessageId: fakeId,
      direction: 'outbound',
      fromNumber: 'system',
      toNumber: 'dashboard',
      body,
      timestamp: new Date().toISOString(),
    });
    logger.info({ bodyLength: body.length, conversationId: conversation.id }, 'Dashboard text sent (WhatsApp skipped)');
    return fakeId;
  }

  const config = getConfig();
  return sendText(config.timNumber, body, conversation?.id);
}

// ─── Send Interactive Buttons ───────────────────────────────────────────────

export async function sendButtons(
  to: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
  conversationId?: string,
): Promise<string> {
  const config = getConfig();

  if (buttons.length > 3) {
    throw new Error('WhatsApp interactive messages support max 3 buttons');
  }

  const interactiveButtons: InteractiveButton[] = buttons.map((b) => ({
    type: 'reply',
    reply: {
      id: b.id,
      title: b.title.substring(0, 20), // enforce 20 char max
    },
  }));

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: interactiveButtons,
      },
    },
  };

  const response = await callApi(config.phoneNumberId, config.accessToken, payload);
  const waMessageId = response.messages[0]?.id ?? 'unknown';

  storeWhatsAppMessage({
    conversationId,
    waMessageId,
    direction: 'outbound',
    fromNumber: config.phoneNumberId,
    toNumber: to,
    body: `[BUTTONS] ${body}`,
    timestamp: new Date().toISOString(),
  });

  logger.info({ to, waMessageId, buttonCount: buttons.length }, 'WhatsApp buttons sent');
  return waMessageId;
}

/**
 * Send interactive buttons to Tim.
 * Also emits to the dashboard SSE event bus, and skips WhatsApp API
 * when the conversation originated from the dashboard.
 *
 * When conversationId is provided, button IDs are encoded with the conversationId
 * (e.g., "confirm_yes::uuid") so replies route to the correct conversation.
 */
export async function sendButtonsToTim(
  body: string,
  buttons: Array<{ id: string; title: string }>,
  conversationId?: string,
): Promise<string> {
  // Encode conversationId into button IDs for deterministic routing
  const encodedButtons = conversationId
    ? buttons.map((b) => ({ ...b, id: `${b.id}::${conversationId}` }))
    : buttons;

  // Emit to dashboard SSE clients (always) — use original button IDs for dashboard
  const { dashboardEvents } = await import('./dashboard-events.js');
  dashboardEvents.emit('dashboard', {
    type: 'buttons',
    data: { body, buttons: encodedButtons, direction: 'outbound', conversationId },
    timestamp: new Date().toISOString(),
  });

  // Resolve conversation — prefer explicit ID, fall back to legacy lookup
  const { getConversation, getActiveConversation } = await import('../db/conversations.js');
  const conversation = conversationId ? getConversation(conversationId) : getActiveConversation();

  if (conversation?.source === 'dashboard') {
    const fakeId = `dash-${Date.now()}`;
    storeWhatsAppMessage({
      conversationId: conversation.id,
      waMessageId: fakeId,
      direction: 'outbound',
      fromNumber: 'system',
      toNumber: 'dashboard',
      body: `[BUTTONS] ${body}`,
      timestamp: new Date().toISOString(),
    });
    logger.info({ buttonCount: buttons.length, conversationId: conversation.id }, 'Dashboard buttons sent (WhatsApp skipped)');
    return fakeId;
  }

  const config = getConfig();
  return sendButtons(config.timNumber, body, encodedButtons, conversation?.id);
}

// ─── Send Image ─────────────────────────────────────────────────────────────

/**
 * Upload a local image file and send it via WhatsApp.
 * Two-step process: upload media → send message referencing media_id.
 */
export async function sendImage(to: string, imagePath: string, caption?: string, conversationId?: string): Promise<string> {
  const config = getConfig();

  // Step 1: Upload media
  const mediaId = await uploadMedia(config.phoneNumberId, config.accessToken, imagePath);

  // Step 2: Send image message
  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: {
      id: mediaId,
      ...(caption ? { caption } : {}),
    },
  };

  const response = await callApi(config.phoneNumberId, config.accessToken, payload);
  const waMessageId = response.messages[0]?.id ?? 'unknown';

  storeWhatsAppMessage({
    conversationId,
    waMessageId,
    direction: 'outbound',
    fromNumber: config.phoneNumberId,
    toNumber: to,
    body: caption || '[image]',
    mediaUrl: imagePath,
    timestamp: new Date().toISOString(),
  });

  logger.info({ to, waMessageId, mediaId, imagePath }, 'WhatsApp image sent');
  return waMessageId;
}

/**
 * Send an image to Tim with optional caption.
 * Also emits to the dashboard SSE event bus, and skips WhatsApp API
 * when the conversation originated from the dashboard.
 */
export async function sendImageToTim(imagePath: string, caption?: string, conversationId?: string): Promise<string> {
  // Emit to dashboard SSE clients (always)
  const { dashboardEvents } = await import('./dashboard-events.js');
  const screenshotFilename = imagePath.split('/').pop() ?? '';
  dashboardEvents.emit('dashboard', {
    type: 'image',
    data: { imagePath: `/screenshots/${screenshotFilename}`, caption: caption ?? '', direction: 'outbound', conversationId },
    timestamp: new Date().toISOString(),
  });

  // Resolve conversation — prefer explicit ID, fall back to legacy lookup
  const { getConversation, getActiveConversation } = await import('../db/conversations.js');
  const conversation = conversationId ? getConversation(conversationId) : getActiveConversation();

  if (conversation?.source === 'dashboard') {
    const fakeId = `dash-${Date.now()}`;
    storeWhatsAppMessage({
      conversationId: conversation.id,
      waMessageId: fakeId,
      direction: 'outbound',
      fromNumber: 'system',
      toNumber: 'dashboard',
      body: caption || '[image]',
      mediaUrl: imagePath,
      timestamp: new Date().toISOString(),
    });
    logger.info({ imagePath, conversationId: conversation.id }, 'Dashboard image sent (WhatsApp skipped)');
    return fakeId;
  }

  const config = getConfig();
  return sendImage(config.timNumber, imagePath, caption, conversation?.id);
}

// ─── Media Upload ───────────────────────────────────────────────────────────

async function uploadMedia(
  phoneNumberId: string,
  accessToken: string,
  filePath: string,
): Promise<string> {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/media`;

  const fileBuffer = readFileSync(filePath);
  const filename = filePath.split('/').pop() ?? 'image.png';

  // Determine MIME type from extension
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeType =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : 'image/png';

  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename);
  formData.append('type', mimeType);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Media upload failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { id: string };
  logger.info({ mediaId: data.id, filename }, 'Media uploaded to WhatsApp');
  return data.id;
}

// ─── Media Helpers ──────────────────────────────────────────────────────────

/** Map a MIME type to a file extension for downloaded WhatsApp media. */
function mimeToExt(mime: string): string {
  if (mime.startsWith('audio/')) {
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mpeg')) return 'mp3';
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('aac') || mime.includes('mp4')) return 'm4a';
    return 'ogg';
  }
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

// ─── Download Inbound Media ─────────────────────────────────────────────────

/**
 * Download an inbound media file from WhatsApp.
 * Two-step: GET media metadata → GET the temporary URL → save to disk.
 */
export async function downloadMedia(mediaId: string): Promise<string> {
  const config = getConfig();

  // Step 1: Get the media download URL
  const metaResponse = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });

  if (!metaResponse.ok) {
    const text = await metaResponse.text();
    throw new Error(`Media metadata fetch failed (${metaResponse.status}): ${text}`);
  }

  const metadata = (await metaResponse.json()) as { url: string; mime_type?: string };

  // Step 2: Download the actual file
  const fileResponse = await fetch(metadata.url, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });

  if (!fileResponse.ok) {
    const text = await fileResponse.text();
    throw new Error(`Media download failed (${fileResponse.status}): ${text}`);
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer());

  // Determine extension from mime type
  const mimeType = metadata.mime_type ?? 'image/jpeg';
  const ext = mimeToExt(mimeType);

  // Save to uploads directory
  const { ensureUploadsDir, getUploadsDir } = await import('./file-manager.js');
  ensureUploadsDir();
  const filename = `wa-media-${Date.now()}.${ext}`;
  const filePath = join(getUploadsDir(), filename);
  writeFileSync(filePath, buffer);

  logger.info({ mediaId, filePath, mimeType, sizeBytes: buffer.length }, 'WhatsApp media downloaded');
  return filePath;
}

// ─── Graph API Call ─────────────────────────────────────────────────────────

async function callApi(
  phoneNumberId: string,
  accessToken: string,
  payload: Record<string, unknown>,
): Promise<WhatsAppApiResponse> {
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  const doRequest = async (): Promise<WhatsAppApiResponse> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text }, 'WhatsApp API error');
      throw new Error(`WhatsApp API error (${response.status}): ${text}`);
    }

    return (await response.json()) as WhatsAppApiResponse;
  };

  return withRetry(doRequest, {
    maxRetries: 3,
    delayMs: 1000,
    backoffMultiplier: 2,
    onRetry: (error, attempt) => {
      logger.warn({ attempt, error: error.message }, 'Retrying WhatsApp API call');
    },
  });
}

// ─── Webhook Payload Parsing ────────────────────────────────────────────────

export interface IncomingWhatsAppMessage {
  waMessageId: string;
  from: string;
  timestamp: string;
  type: 'text' | 'button' | 'interactive' | 'image' | 'audio' | 'unknown';
  body: string;
  /** For button replies — the button ID */
  buttonId?: string;
  /** For image messages — the WhatsApp media ID (used to download the image) */
  mediaId?: string;
}

/**
 * Parse the Meta webhook payload to extract incoming messages.
 * Returns an array of messages (usually 1).
 */
export function parseWebhookPayload(payload: unknown): IncomingWhatsAppMessage[] {
  const messages: IncomingWhatsAppMessage[] = [];

  try {
    const data = payload as Record<string, unknown>;
    const entries = (data.entry as Array<Record<string, unknown>>) ?? [];

    for (const entry of entries) {
      const changes = (entry.changes as Array<Record<string, unknown>>) ?? [];

      for (const change of changes) {
        const value = change.value as Record<string, unknown>;
        if (!value) continue;

        const rawMessages = (value.messages as Array<Record<string, unknown>>) ?? [];

        for (const msg of rawMessages) {
          const waMessageId = msg.id as string;
          const from = msg.from as string;
          const timestamp = msg.timestamp as string;
          const msgType = msg.type as string;

          let body = '';
          let buttonId: string | undefined;
          let mediaId: string | undefined;
          let type: IncomingWhatsAppMessage['type'] = 'unknown';

          if (msgType === 'text') {
            type = 'text';
            body = ((msg.text as Record<string, unknown>)?.body as string) ?? '';
          } else if (msgType === 'image') {
            type = 'image';
            const image = msg.image as Record<string, unknown>;
            mediaId = image?.id as string | undefined;
            body = (image?.caption as string) ?? '';
          } else if (msgType === 'audio') {
            type = 'audio';
            const audio = msg.audio as Record<string, unknown>;
            mediaId = audio?.id as string | undefined;
          } else if (msgType === 'interactive') {
            const interactive = msg.interactive as Record<string, unknown>;
            const interactiveType = interactive?.type as string;

            if (interactiveType === 'button_reply') {
              type = 'button';
              const reply = interactive.button_reply as Record<string, unknown>;
              buttonId = reply?.id as string;
              body = reply?.title as string ?? '';
            } else {
              type = 'interactive';
              body = JSON.stringify(interactive);
            }
          } else if (msgType === 'button') {
            // Quick reply button (template)
            type = 'button';
            const button = msg.button as Record<string, unknown>;
            body = button?.text as string ?? '';
            buttonId = button?.payload as string;
          }

          messages.push({ waMessageId, from, timestamp, type, body, buttonId, mediaId });
        }
      }
    }
  } catch (err) {
    logger.error({ error: err, payload }, 'Failed to parse WhatsApp webhook payload');
  }

  return messages;
}
