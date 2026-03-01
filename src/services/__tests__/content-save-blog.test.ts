import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSaveClient } from '../content-save.js';

// Mock fs before importing ContentSaveClient
const MOCK_SESSION = {
  cookies: [
    { name: 'SS_SESSION_ID', value: 'sess123', domain: '.squarespace.com', path: '/' },
    { name: 'crumb', value: 'crumb-token-abc', domain: '.test-site.squarespace.com', path: '/' },
  ],
  origins: [
    {
      origin: 'https://test-site.squarespace.com',
      localStorage: [
        {
          name: 'statsig.cached.evaluations.123',
          value: JSON.stringify({
            data: JSON.stringify({
              website_id: 'abcdef1234567890abcdef12',
              member_account_id: 'deadbeef1234567890abcdef',
            }),
          }),
        },
      ],
    },
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

  it('uses blogs/text-posts endpoint with X-CSRF-Token header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'item-123' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-123', { title: 'Updated' });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toContain('/api/content/blogs/col-1/text-posts/item-123');
    expect(url).not.toContain('crumb=');
    expect(init.headers['X-CSRF-Token']).toBeTruthy();
  });

  it('always includes id and authorId in body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'item-123' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-123', { title: 'Test' });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.id).toBe('item-123');
    expect(sentBody.authorId).toBe('deadbeef1234567890abcdef');
  });

  it('wraps string excerpt into { html, raw: false }', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'item-123' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-123', { excerpt: 'Plain text summary' });

    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentBody.excerpt).toEqual({ html: 'Plain text summary', raw: false });
  });

  it('maps draft boolean to workflowState number', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-1', { draft: true });
    await client.updateBlogPost('col-1', 'item-1', { draft: false });

    const body1 = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body1.workflowState).toBe(4); // draft
    expect(body2.workflowState).toBe(1); // published
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

  it('handles results key (blog API format) instead of items', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { id: 'post-r1', title: 'Blog Post from Results' },
          { id: 'post-r2', title: 'Other Post' },
        ],
      }),
    } as Response);

    const client = makeClient();
    const result = await client.findBlogPostByTitle('col-1', 'blog post from');
    expect(result?.id).toBe('post-r1');
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
