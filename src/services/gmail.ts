import { google, gmail_v1 } from 'googleapis';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../utils/logger.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = join(process.cwd(), 'storage', 'auth', 'gmail-token.json');

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

export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
  messageId: string;
}

let gmailClient: gmail_v1.Gmail | null = null;

/**
 * Initialize the Gmail API client with OAuth2 credentials.
 * Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in .env.
 */
export function getGmailClient(): gmail_v1.Gmail {
  if (gmailClient) return gmailClient;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Gmail API not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in .env. ' +
      'Run "npx tsx scripts/setup-gmail.ts" to complete OAuth setup.',
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2Client });
  logger.info('Gmail API client initialized');
  return gmailClient;
}

/**
 * Fetch new unread messages from the inbox.
 * Uses a query to find unread messages, optionally after a specific date.
 */
export async function fetchNewMessages(afterDate?: Date): Promise<GmailMessage[]> {
  const gmail = getGmailClient();

  // Build search query
  let query = 'is:unread in:inbox';
  if (afterDate) {
    const dateStr = afterDate.toISOString().split('T')[0]; // YYYY-MM-DD
    query += ` after:${dateStr}`;
  }

  logger.info({ query }, 'Fetching Gmail messages');

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 20,
  });

  const messageIds = listResponse.data.messages ?? [];
  if (messageIds.length === 0) {
    logger.info('No new messages found');
    return [];
  }

  logger.info({ count: messageIds.length }, 'Found new messages');

  const messages: GmailMessage[] = [];
  for (const msg of messageIds) {
    if (!msg.id) continue;
    try {
      const fullMessage = await fetchMessage(msg.id);
      if (fullMessage) messages.push(fullMessage);
    } catch (err) {
      logger.error({ messageId: msg.id, error: err }, 'Failed to fetch message');
    }
  }

  return messages;
}

/**
 * Fetch a single message by ID with full content.
 */
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

  // Extract name from "Name <email>" format
  const fromMatch = from.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
  const fromName = fromMatch?.[1]?.trim();

  // Extract body text and HTML
  const { text: bodyText, html: bodyHtml } = extractBody(message.payload);

  // Extract attachments metadata
  const attachments = extractAttachments(message.payload, messageId);

  return {
    id: messageId,
    threadId: message.threadId ?? messageId,
    from,
    fromName,
    subject,
    date,
    bodyText,
    bodyHtml,
    attachments,
  };
}

/**
 * Download an attachment and save it to disk.
 */
export async function downloadAttachment(
  messageId: string,
  attachmentId: string,
  filename: string,
): Promise<string> {
  const gmail = getGmailClient();

  const response = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  const data = response.data.data;
  if (!data) throw new Error(`No data in attachment ${attachmentId}`);

  // Decode base64url-encoded data
  const buffer = Buffer.from(data, 'base64url');

  // Save to uploads directory
  const uploadsDir = join(process.cwd(), 'storage', 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  // Add timestamp to filename to avoid collisions
  const timestamp = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(uploadsDir, `${timestamp}-${safeName}`);

  writeFileSync(filePath, buffer);
  logger.info({ filePath, filename, size: buffer.length }, 'Attachment downloaded');

  return filePath;
}

/**
 * Mark a message as read.
 */
export async function markAsRead(messageId: string): Promise<void> {
  const gmail = getGmailClient();
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD'],
    },
  });
  logger.debug({ messageId }, 'Message marked as read');
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

  // Recurse into parts (multipart emails)
  if (payload.parts) {
    for (const part of payload.parts) {
      const sub = extractBody(part);
      if (sub.text && !text) text = sub.text;
      if (sub.html && !html) html = sub.html;
    }
  }

  return { text, html };
}

function extractAttachments(
  payload: gmail_v1.Schema$MessagePart,
  messageId: string,
): GmailAttachment[] {
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
