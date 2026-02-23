import { existsSync, mkdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { getDb } from '../db/database.js';
import { logger } from '../utils/logger.js';

const UPLOADS_DIR = join(process.cwd(), 'storage', 'uploads');

export interface StoredAttachment {
  id: string;
  emailId: string;
  filename: string;
  mimeType?: string;
  filePath: string;
  sizeBytes?: number;
}

/**
 * Ensure the uploads directory exists.
 */
export function ensureUploadsDir(): void {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

/**
 * Record an attachment in the database after it's been downloaded.
 */
export function recordAttachment(
  emailId: string,
  filename: string,
  filePath: string,
  mimeType?: string,
): StoredAttachment {
  const db = getDb();
  const id = randomUUID();

  let sizeBytes: number | undefined;
  try {
    const stat = statSync(filePath);
    sizeBytes = stat.size;
  } catch {
    // File might not exist yet
  }

  db.prepare(`
    INSERT INTO attachments (id, email_id, filename, mime_type, file_path, size_bytes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, emailId, filename, mimeType ?? null, filePath, sizeBytes ?? null);

  logger.info({ id, emailId, filename, filePath }, 'Attachment recorded');

  return { id, emailId, filename, mimeType, filePath, sizeBytes };
}

/**
 * Get all attachments for an email.
 */
export function getAttachmentsForEmail(emailId: string): StoredAttachment[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM attachments WHERE email_id = ? ORDER BY created_at ASC',
  ).all(emailId) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    emailId: row.email_id as string,
    filename: row.filename as string,
    mimeType: row.mime_type as string | undefined,
    filePath: row.file_path as string,
    sizeBytes: row.size_bytes as number | undefined,
  }));
}

/**
 * Get the uploads directory path.
 */
export function getUploadsDir(): string {
  ensureUploadsDir();
  return UPLOADS_DIR;
}

/**
 * Resolve the file path for a task's attachment.
 * Looks up the attachment in the database by emailId + filename,
 * then verifies the file exists on disk.
 */
export function resolveAttachmentPath(emailId: string | undefined, filename: string): string | undefined {
  if (!emailId) return undefined;

  // Strategy 1: Look up in attachments table
  const attachments = getAttachmentsForEmail(emailId);
  const match = attachments.find(
    (a) => a.filename.toLowerCase() === filename.toLowerCase(),
  );

  if (match && existsSync(match.filePath)) {
    logger.info({ emailId, filename, filePath: match.filePath }, 'Resolved attachment path from database');
    return match.filePath;
  }

  // Strategy 2: Scan uploads directory for the filename
  const uploadsDir = getUploadsDir();
  const directPath = join(uploadsDir, filename);
  if (existsSync(directPath)) {
    logger.info({ filename, filePath: directPath }, 'Resolved attachment path from uploads directory');
    return directPath;
  }

  logger.warn({ emailId, filename }, 'Could not resolve attachment path');
  return undefined;
}
