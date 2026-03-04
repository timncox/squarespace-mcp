import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import { logger } from '../utils/logger.js';

export interface StoredEmail {
  id: string;
  gmailMessageId: string;
  gmailThreadId?: string;
  fromAddress: string;
  fromName?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  originalSenderEmail?: string;
  originalSenderName?: string;
  receivedAt: string;
  processedAt?: string;
  createdAt: string;
}

export interface CreateEmailInput {
  gmailMessageId: string;
  gmailThreadId?: string;
  fromAddress: string;
  fromName?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  originalSenderEmail?: string;
  originalSenderName?: string;
  receivedAt: string;
}

export function storeEmail(input: CreateEmailInput): StoredEmail {
  const db = getDb();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO emails (
      id, gmail_message_id, gmail_thread_id, from_address, from_name,
      subject, body_text, body_html, original_sender_email, original_sender_name,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.gmailMessageId,
    input.gmailThreadId ?? null,
    input.fromAddress,
    input.fromName ?? null,
    input.subject ?? null,
    input.bodyText ?? null,
    input.bodyHtml ?? null,
    input.originalSenderEmail ?? null,
    input.originalSenderName ?? null,
    input.receivedAt,
  );

  logger.info({ emailId: id, subject: input.subject, from: input.fromAddress }, 'Email stored');
  return getEmail(id)!;
}

export function getEmail(id: string): StoredEmail | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToEmail(row);
}

export function getEmailByGmailId(gmailMessageId: string): StoredEmail | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM emails WHERE gmail_message_id = ?').get(gmailMessageId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToEmail(row);
}

export function markEmailProcessed(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE emails SET processed_at = ? WHERE id = ?').run(now, id);
}

export function listEmails(options?: { limit?: number; status?: 'processed' | 'unprocessed' | 'all' }): StoredEmail[] {
  const db = getDb();
  const limit = options?.limit ?? 20;
  const status = options?.status ?? 'all';

  let whereClause = '';
  if (status === 'processed') whereClause = 'WHERE processed_at IS NOT NULL';
  else if (status === 'unprocessed') whereClause = 'WHERE processed_at IS NULL';

  const rows = db.prepare(
    `SELECT * FROM emails ${whereClause} ORDER BY received_at DESC LIMIT ?`,
  ).all(limit) as Record<string, unknown>[];
  return rows.map(rowToEmail);
}

export function getUnprocessedEmails(): StoredEmail[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM emails WHERE processed_at IS NULL ORDER BY received_at ASC',
  ).all() as Record<string, unknown>[];
  return rows.map(rowToEmail);
}

function rowToEmail(row: Record<string, unknown>): StoredEmail {
  return {
    id: row.id as string,
    gmailMessageId: row.gmail_message_id as string,
    gmailThreadId: row.gmail_thread_id as string | undefined,
    fromAddress: row.from_address as string,
    fromName: row.from_name as string | undefined,
    subject: row.subject as string | undefined,
    bodyText: row.body_text as string | undefined,
    bodyHtml: row.body_html as string | undefined,
    originalSenderEmail: row.original_sender_email as string | undefined,
    originalSenderName: row.original_sender_name as string | undefined,
    receivedAt: row.received_at as string,
    processedAt: row.processed_at as string | undefined,
    createdAt: row.created_at as string,
  };
}
