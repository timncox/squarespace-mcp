/**
 * Gmail service — OAuth2-based attachment download.
 * Uses Google OAuth2 tokens to call the Gmail API for downloading
 * email attachments.
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const AUTH_DIR = join(PROJECT_ROOT, 'storage', 'auth');
const CREDENTIALS_PATH = join(AUTH_DIR, 'gmail-credentials.json');
const TOKENS_PATH = join(AUTH_DIR, 'gmail-oauth.json');

const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// ── Credentials ──────────────────────────────────────────────────────────────

export interface GmailCredentials {
  client_id: string;
  client_secret: string;
}

export interface GmailTokens {
  access_token: string;
  refresh_token: string;
  expiry: number;
}

export function loadCredentials(): GmailCredentials {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      'Gmail credentials not found. Save your Google OAuth client_id and client_secret ' +
      'to storage/auth/gmail-credentials.json as { "client_id": "...", "client_secret": "..." }',
    );
  }

  const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
  const creds = JSON.parse(raw);

  if (!creds.client_id || !creds.client_secret) {
    throw new Error(
      'Gmail credentials must contain both client_id and client_secret.',
    );
  }

  return { client_id: creds.client_id, client_secret: creds.client_secret };
}

// ── Token management ─────────────────────────────────────────────────────────

export function loadTokens(): GmailTokens {
  if (!existsSync(TOKENS_PATH)) {
    throw new Error(
      'Gmail not authorized. Run sq_login_gmail to complete OAuth2 authorization.',
    );
  }

  const raw = readFileSync(TOKENS_PATH, 'utf-8');
  return JSON.parse(raw);
}

export function saveTokens(tokens: GmailTokens): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
}

export async function refreshAccessToken(): Promise<string> {
  const creds = loadCredentials();
  const tokens = loadTokens();

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };

  const updated: GmailTokens = {
    access_token: data.access_token,
    refresh_token: tokens.refresh_token,
    expiry: Date.now() + data.expires_in * 1000,
  };

  saveTokens(updated);
  logger.info('Gmail access token refreshed');

  return data.access_token;
}

async function getAccessToken(): Promise<string> {
  const creds = loadCredentials(); // validate credentials exist
  const tokens = loadTokens();

  // Refresh if expired or expiring within 5 minutes
  if (tokens.expiry < Date.now() + 300_000) {
    return refreshAccessToken();
  }

  return tokens.access_token;
}

// ── Gmail API ────────────────────────────────────────────────────────────────

interface GmailPart {
  filename?: string;
  mimeType: string;
  body: { attachmentId?: string; size: number; data?: string };
  parts?: GmailPart[];
}

function findAttachmentPart(
  parts: GmailPart[],
  targetFilename: string,
): GmailPart | undefined {
  for (const part of parts) {
    if (
      part.filename &&
      part.filename.toLowerCase() === targetFilename.toLowerCase() &&
      part.body.attachmentId
    ) {
      return part;
    }
    if (part.parts) {
      const nested = findAttachmentPart(part.parts, targetFilename);
      if (nested) return nested;
    }
  }
  return undefined;
}

function collectFilenames(parts: GmailPart[]): string[] {
  const filenames: string[] = [];
  for (const part of parts) {
    if (part.filename && part.body.attachmentId) {
      filenames.push(part.filename);
    }
    if (part.parts) {
      filenames.push(...collectFilenames(part.parts));
    }
  }
  return filenames;
}

export async function downloadAttachment(
  messageId: string,
  targetFilename: string,
): Promise<string> {
  const accessToken = await getAccessToken();

  const headers = { Authorization: `Bearer ${accessToken}` };

  // 1. Get message to find attachment ID
  const msgResponse = await fetch(
    `${GMAIL_API_BASE}/messages/${messageId}`,
    { headers },
  );

  if (!msgResponse.ok) {
    throw new Error(`Gmail API messages.get failed (${msgResponse.status})`);
  }

  const message = await msgResponse.json() as { payload: GmailPart };
  const parts = message.payload.parts ?? [message.payload];

  const attachmentPart = findAttachmentPart(parts, targetFilename);

  if (!attachmentPart) {
    const available = collectFilenames(parts).join(', ');
    throw new Error(
      `No attachment named "${targetFilename}" in message. Available: ${available || 'none'}`,
    );
  }

  // 2. Download attachment data
  const attResponse = await fetch(
    `${GMAIL_API_BASE}/messages/${messageId}/attachments/${attachmentPart.body.attachmentId}`,
    { headers },
  );

  if (!attResponse.ok) {
    throw new Error(`Gmail API attachments.get failed (${attResponse.status})`);
  }

  const attData = await attResponse.json() as { data: string };
  const buffer = Buffer.from(attData.data, 'base64url');

  // 3. Save to disk
  const uploadsDir = join(PROJECT_ROOT, 'storage', 'uploads');
  mkdirSync(uploadsDir, { recursive: true });

  const timestamp = Date.now();
  const safeName = attachmentPart.filename!.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(uploadsDir, `${timestamp}-${safeName}`);

  writeFileSync(filePath, buffer);
  logger.info(
    { messageId, filename: attachmentPart.filename, size: buffer.length },
    'Attachment downloaded via Gmail API',
  );

  return filePath;
}
