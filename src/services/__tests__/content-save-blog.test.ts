import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';

// Mock fs before importing ContentSaveClient
const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
};

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => JSON.stringify(MOCK_SESSION)),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 3600_000 })),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeClient() {
  const client = new ContentSaveClient('test-site');
  client.loadSessionCookies();
  return client;
}

// ─── updateBlogPost ───────────────────────────────────────────────────────

describe('updateBlogPost', () => {
  beforeEach(() => mockFetch.mockReset());

  it('updates specified fields and returns updatedFields list', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'item-123', title: 'New Title' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    const result = await client.updateBlogPost('col-1', 'item-123', { title: 'New Title', draft: false });

    expect(result.success).toBe(true);
    expect(result.itemId).toBe('item-123');
    expect(result.updatedFields).toContain('title');
    expect(result.updatedFields).toContain('draft');
  });

  it('returns error when no fields provided', async () => {
    const client = makeClient();
    const result = await client.updateBlogPost('col-1', 'item-123', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no fields/i);
  });

  it('returns error on 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' } as Response);
    const client = makeClient();
    const result = await client.updateBlogPost('col-1', 'item-123', { title: 'X' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('returns error on 401', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' } as Response);
    const client = makeClient();
    const result = await client.updateBlogPost('col-1', 'item-123', { title: 'X' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/session expired/i);
  });
});

// ─── findBlogPostByTitle ──────────────────────────────────────────────────

describe('findBlogPostByTitle', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns matching post by partial title (case-insensitive)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { id: 'post-1', title: 'My First Post' },
          { id: 'post-2', title: 'Another Post' },
        ],
      }),
    } as Response);

    const client = makeClient();
    const result = await client.findBlogPostByTitle('col-1', 'first post');
    expect(result?.id).toBe('post-1');
  });

  it('returns null when no match', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'post-1', title: 'My First Post' }] }),
    } as Response);

    const client = makeClient();
    const result = await client.findBlogPostByTitle('col-1', 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns null on getCollectionItems failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' } as Response);
    const client = makeClient();
    const result = await client.findBlogPostByTitle('col-1', 'any');
    expect(result).toBeNull();
  });
});
