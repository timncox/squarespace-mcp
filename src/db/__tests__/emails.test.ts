import { describe, it, expect, beforeEach } from 'vitest';
import { storeEmail, listEmails } from '../emails.js';
import { getDb } from '../database.js';

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM emails');
});

function createTestEmail(overrides: { subject?: string; receivedAt?: string; processed?: boolean } = {}) {
  const email = storeEmail({
    gmailMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fromAddress: 'test@example.com',
    subject: overrides.subject ?? 'Test email',
    receivedAt: overrides.receivedAt ?? new Date().toISOString(),
  });
  if (overrides.processed) {
    const db = getDb();
    db.prepare('UPDATE emails SET processed_at = ? WHERE id = ?').run(new Date().toISOString(), email.id);
  }
  return email;
}

describe('listEmails', () => {
  it('returns all emails with default limit of 20', () => {
    for (let i = 0; i < 3; i++) {
      createTestEmail({ subject: `Email ${i}` });
    }
    const result = listEmails();
    expect(result).toHaveLength(3);
  });

  it('orders by received_at DESC (newest first)', () => {
    createTestEmail({ subject: 'Old', receivedAt: '2024-01-01T00:00:00Z' });
    createTestEmail({ subject: 'New', receivedAt: '2024-06-01T00:00:00Z' });
    const result = listEmails();
    expect(result[0].subject).toBe('New');
    expect(result[1].subject).toBe('Old');
  });

  it('filters by processed status', () => {
    createTestEmail({ subject: 'Processed', processed: true });
    createTestEmail({ subject: 'Unprocessed', processed: false });
    const result = listEmails({ status: 'processed' });
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('Processed');
  });

  it('filters by unprocessed status', () => {
    createTestEmail({ subject: 'Processed', processed: true });
    createTestEmail({ subject: 'Unprocessed', processed: false });
    const result = listEmails({ status: 'unprocessed' });
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('Unprocessed');
  });

  it('returns all statuses when status is "all"', () => {
    createTestEmail({ subject: 'Processed', processed: true });
    createTestEmail({ subject: 'Unprocessed', processed: false });
    const result = listEmails({ status: 'all' });
    expect(result).toHaveLength(2);
  });

  it('respects custom limit', () => {
    for (let i = 0; i < 5; i++) {
      createTestEmail({ subject: `Email ${i}` });
    }
    const result = listEmails({ limit: 2 });
    expect(result).toHaveLength(2);
  });

  it('returns empty array when no emails exist', () => {
    const result = listEmails();
    expect(result).toEqual([]);
  });
});
