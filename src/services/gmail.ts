/**
 * Gmail service — cookie-based attachment download.
 * Uses saved Playwright session cookies to fetch raw MIME messages
 * from Gmail's web interface and extract attachments.
 *
 * Search/read handled by Claude.ai Gmail MCP — we only fill the attachment gap.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const SESSION_PATH = join(PROJECT_ROOT, 'storage', 'auth', 'gmail-session.json');

export interface GmailCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  expires?: number;
}

interface MimeAttachment {
  filename: string;
  mimeType: string;
  encoding: string;
  body: string;
}

// ── Cookie management ────────────────────────────────────────────────────────

export function loadGmailCookies(): GmailCookie[] {
  if (!existsSync(SESSION_PATH)) {
    throw new Error(
      'Gmail session not found. Use sq_login_gmail to log into Gmail first.',
    );
  }

  const raw = readFileSync(SESSION_PATH, 'utf-8');
  const session = JSON.parse(raw);
  const cookies: GmailCookie[] = session.cookies ?? [];

  if (cookies.length === 0) {
    throw new Error('Gmail session has no cookies. Use sq_login_gmail to log in again.');
  }

  return cookies;
}

export function formatCookieHeader(cookies: GmailCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ── MIME parsing ─────────────────────────────────────────────────────────────

function parseMimeParts(body: string, boundary: string): MimeAttachment[] {
  const attachments: MimeAttachment[] = [];
  const parts = body.split(`--${boundary}`);

  for (const part of parts) {
    if (part.trim() === '' || part.trim() === '--') continue;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerSection = part.substring(0, headerEnd);
    const bodySection = part.substring(headerEnd + 4).trim();

    // Check for nested multipart
    const ctMatch = headerSection.match(/Content-Type:\s*multipart\/\S+;\s*boundary="?([^"\r\n]+)"?/i);
    if (ctMatch) {
      attachments.push(...parseMimeParts(part.substring(headerEnd + 4), ctMatch[1]));
      continue;
    }

    // Extract filename from Content-Disposition or Content-Type
    const cdMatch = headerSection.match(/filename="?([^"\r\n;]+)"?/i);
    if (!cdMatch) continue;

    const filename = cdMatch[1].trim();

    // Extract MIME type
    const mimeMatch = headerSection.match(/Content-Type:\s*([^\s;]+)/i);
    const mimeType = mimeMatch?.[1] ?? 'application/octet-stream';

    // Extract encoding
    const encMatch = headerSection.match(/Content-Transfer-Encoding:\s*(\S+)/i);
    const encoding = encMatch?.[1]?.toLowerCase() ?? '7bit';

    attachments.push({ filename, mimeType, encoding, body: bodySection });
  }

  return attachments;
}

// ── Attachment download ──────────────────────────────────────────────────────

export async function fetchAndExtractAttachment(
  messageId: string,
  targetFilename: string,
): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
  const cookies = loadGmailCookies();
  const cookieHeader = formatCookieHeader(cookies);

  // Fetch raw MIME message from Gmail web
  const url = `https://mail.google.com/mail/u/0/?ui=2&view=om&th=${messageId}`;
  const response = await fetch(url, {
    headers: {
      Cookie: cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    redirect: 'manual',
  });

  if (!response.ok) {
    const hint = response.status === 302 || response.status === 401
      ? ' Session may have expired — use sq_login_gmail to log in again.'
      : '';
    throw new Error(`Gmail request failed (${response.status}).${hint}`);
  }

  const rawMime = await response.text();

  // Extract boundary from top-level Content-Type
  const boundaryMatch = rawMime.match(/Content-Type:\s*multipart\/\S+;\s*boundary="?([^"\r\n]+)"?/i);
  if (!boundaryMatch) {
    throw new Error('Could not parse MIME message — no multipart boundary found.');
  }

  const attachments = parseMimeParts(rawMime, boundaryMatch[1]);

  // Find attachment by filename (case-insensitive)
  const match = attachments.find(
    (a) => a.filename.toLowerCase() === targetFilename.toLowerCase(),
  );

  if (!match) {
    const available = attachments.map((a) => a.filename).join(', ');
    throw new Error(
      `No attachment named "${targetFilename}" in message. Available: ${available || 'none'}`,
    );
  }

  // Decode body
  let buffer: Buffer;
  if (match.encoding === 'base64') {
    buffer = Buffer.from(match.body.replace(/\s/g, ''), 'base64');
  } else {
    buffer = Buffer.from(match.body, 'utf-8');
  }

  logger.info({ messageId, filename: match.filename, size: buffer.length }, 'Attachment extracted from MIME');

  return { buffer, filename: match.filename, mimeType: match.mimeType };
}

export async function downloadAttachment(messageId: string, filename: string): Promise<string> {
  const { buffer, filename: resolvedName } = await fetchAndExtractAttachment(messageId, filename);

  const uploadsDir = join(PROJECT_ROOT, 'storage', 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const timestamp = Date.now();
  const safeName = resolvedName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = join(uploadsDir, `${timestamp}-${safeName}`);

  writeFileSync(filePath, buffer);
  logger.info({ filePath, filename: resolvedName, size: buffer.length }, 'Attachment downloaded');

  return filePath;
}
