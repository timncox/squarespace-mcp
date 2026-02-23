import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import type { WhatsAppMessage, WhatsAppDirection } from '../models/conversation.js';
import { logger } from '../utils/logger.js';

export interface CreateWhatsAppMessageInput {
  conversationId?: string;
  waMessageId?: string;
  direction: WhatsAppDirection;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrl?: string;
  timestamp: string;
}

export function storeWhatsAppMessage(input: CreateWhatsAppMessageInput): WhatsAppMessage {
  const db = getDb();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO whatsapp_messages (
      id, conversation_id, wa_message_id, direction,
      from_number, to_number, body, media_url, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.conversationId ?? null,
    input.waMessageId ?? null,
    input.direction,
    input.fromNumber,
    input.toNumber,
    input.body,
    input.mediaUrl ?? null,
    input.timestamp,
  );

  logger.debug(
    { messageId: id, direction: input.direction, waMessageId: input.waMessageId },
    'WhatsApp message stored',
  );

  return getMessage(id)!;
}

export function getMessage(id: string): WhatsAppMessage | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM whatsapp_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToMessage(row);
}

export function getMessagesByConversation(conversationId: string): WhatsAppMessage[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM whatsapp_messages WHERE conversation_id = ? ORDER BY timestamp ASC',
  ).all(conversationId) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function getRecentMessages(limit = 20): WhatsAppMessage[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM whatsapp_messages ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

/** Check if we've already processed this WhatsApp message (dedup) */
export function messageExists(waMessageId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 FROM whatsapp_messages WHERE wa_message_id = ?',
  ).get(waMessageId);
  return !!row;
}

function rowToMessage(row: Record<string, unknown>): WhatsAppMessage {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string | undefined,
    waMessageId: row.wa_message_id as string | undefined,
    direction: row.direction as WhatsAppDirection,
    fromNumber: row.from_number as string,
    toNumber: row.to_number as string,
    body: row.body as string,
    mediaUrl: row.media_url as string | undefined,
    timestamp: row.timestamp as string,
    createdAt: row.created_at as string,
  };
}
