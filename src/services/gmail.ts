/**
 * Gmail API client — minimal: attachment download only.
 * Search/read handled by Claude.ai Gmail MCP.
 */

import { google, gmail_v1 } from 'googleapis';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  messageId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  fromName?: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  attachments: GmailAttachment[];
}

let gmailClient: gmail_v1.Gmail | null = null;

export function resetClient(): void {
  gmailClient = null;
}

export function getGmailClient(): gmail_v1.Gmail {
  if (gmailClient) return gmailClient;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Gmail API not configured. Use sq_setup_gmail to connect your Gmail account, ' +
      'or set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in .env.',
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
  logger.info('Gmail API client initialized');
  return gmailClient;
}

export async function fetchMessage(messageId: string): Promise<GmailMessage | null> {
  const gmail = getGmailClient();

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const message = response.data;
  if (!message.payload) return null;

  const headers = message.payload.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  const from = getHeader('From');
  const subject = getHeader('Subject');
  const date = getHeader('Date');

  const fromMatch = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
  const fromName = fromMatch?.[1]?.trim();

  const { text: bodyText, html: bodyHtml } = extractBody(message.payload);
  const attachments = extractAttachments(message.payload, messageId);

  return { id: messageId, threadId: message.threadId ?? messageId, from, fromName, subject, date, bodyText, bodyHtml, attachments };
}

export async function resolveAttachment(messageId: string, filename: string): Promise<GmailAttachment> {
  const message = await fetchMessage(messageId);
  if (!message) throw new Error(`Email with messageId ${messageId} not found`);

  const match = message.attachments.find(
    (a) => a.filename.toLowerCase() === filename.toLowerCase(),
  );
  if (!match) {
    const available = message.attachments.map((a) => a.filename).join(', ');
    throw new Error(`No attachment named "${filename}" in message. Available: ${available || 'none'}`);
  }

  return match;
}

export async function downloadAttachment(messageId: string, attachmentId: string, filename: string): Promise<string> {
  const gmail = getGmailClient();

  const response = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  const data = response.data.data;
  if (!data) throw new Error(`No data in attachment ${attachmentId}`);

  const buffer = Buffer.from(data, 'base64url');

  const uploadsDir = join(PROJECT_ROOT, 'storage', 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const timestamp = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(uploadsDir, `${timestamp}-${safeName}`);

  writeFileSync(filePath, buffer);
  logger.info({ filePath, filename, size: buffer.length }, 'Attachment downloaded');

  return filePath;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractBody(payload: gmail_v1.Schema$MessagePart): { text: string; html: string } {
  let text = '';
  let html = '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    text = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  } else if (payload.mimeType === 'text/html' && payload.body?.data) {
    html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const sub = extractBody(part);
      if (sub.text && !text) text = sub.text;
      if (sub.html && !html) html = sub.html;
    }
  }

  return { text, html };
}

function extractAttachments(payload: gmail_v1.Schema$MessagePart, messageId: string): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];

  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) {
    attachments.push({
      filename: payload.filename,
      mimeType: payload.mimeType ?? 'application/octet-stream',
      size: payload.body.size ?? 0,
      attachmentId: payload.body.attachmentId,
      messageId,
    });
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part, messageId));
    }
  }

  return attachments;
}
