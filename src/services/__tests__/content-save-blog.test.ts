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

const CURRENT_POST = {
  id: 'item-123',
  title: 'Original title',
  authorId: 'original-author',
  tags: ['original-tag'],
  categories: ['original-category'],
  shareStates: [{ connectedAccountId: 'account-1', pushEnabled: false }],
};

function currentPostResponse(id = CURRENT_POST.id) {
  return {
    ok: true, status: 200,
    json: async () => ({ ...CURRENT_POST, id }),
  } as Response;
}

// ─── updateBlogPost ───────────────────────────────────────────────────────

describe('updateBlogPost', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(currentPostResponse());
  });

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
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({ title: 'New Title', workflowState: 1 });
  });

  it('uses blogs/text-posts endpoint with X-CSRF-Token header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'item-123' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-123', { title: 'Updated' });

    const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toContain('/api/content/blogs/col-1/text-posts/item-123');
    expect(url).not.toContain('crumb=');
    expect(init.headers['X-CSRF-Token']).toBeTruthy();
  });

  it('preserves omitted metadata and the original author during a slug-only update', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'item-123' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-123', { urlId: 'new-slug' });

    const sentBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(sentBody).toEqual({ ...CURRENT_POST, urlId: 'new-slug' });
    expect(mockFetch.mock.calls[0][0]).toContain('/text-posts/item-123');
    expect(mockFetch.mock.calls[0][1].method).toBeUndefined();
  });

  it('allows explicit metadata replacements, including empty arrays', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response);

    const result = await makeClient().updateBlogPost('col-1', 'item-123', {
      title: 'New title', tags: [], categories: [],
    });

    expect(result.updatedFields).toEqual(['title', 'tags', 'categories']);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
      ...CURRENT_POST, title: 'New title', tags: [], categories: [],
    });
  });

  it.each([true, false])('preserves starred=%s during a body-only update', async (starred) => {
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...CURRENT_POST, starred }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);

    const result = await makeClient().updateBlogPost('col-1', 'item-123', { body: '<p>Updated</p>' });

    expect(result.success).toBe(true);
    expect(result.updatedFields).toEqual(['body']);
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
      ...CURRENT_POST, starred, body: { html: '<p>Updated</p>' },
    });
  });

  it.each([401, 404, 500])('does not write when reading the post returns %s', async (status) => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ ok: false, status, text: async () => 'Read failed' } as Response);

    const result = await makeClient().updateBlogPost('col-1', 'item-123', { urlId: 'new-slug' });

    expect(result.success).toBe(false);
    expect(result.error).toContain(`HTTP ${status}`);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].method).toBeUndefined();
  });

  it('does not write when the current metadata is incomplete', async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'item-123' }) } as Response);

    const result = await makeClient().updateBlogPost('col-1', 'item-123', { urlId: 'new-slug' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('incomplete current metadata');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('wraps string excerpt into { html, raw: false }', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'item-123' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-123', { excerpt: 'Plain text summary' });

    const sentBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(sentBody.excerpt).toEqual({ html: 'Plain text summary', raw: false });
  });

  it('maps draft boolean to workflowState number', async () => {
    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce(currentPostResponse('item-1'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response)
      .mockResolvedValueOnce(currentPostResponse('item-1'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-1', { draft: true });
    await client.updateBlogPost('col-1', 'item-1', { draft: false });

    const body1 = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    const body2 = JSON.parse(mockFetch.mock.calls[3][1].body as string);
    expect(body1.workflowState).toBe(4); // draft
    expect(body2.workflowState).toBe(1); // published
  });

  it('returns error when no fields provided', async () => {
    const client = makeClient();
    const result = await client.updateBlogPost('col-1', 'item-123', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no fields/i);
    expect(mockFetch).not.toHaveBeenCalled();
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

  it('converts publishDate ISO string to publishOn timestamp', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'item-123' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-123', {
      publishDate: '2026-01-15T10:00:00Z',
    });

    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.publishOn).toBe(new Date('2026-01-15T10:00:00Z').getTime());
  });

  it('sets coverImageUrl in PUT body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'item-123' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    await client.updateBlogPost('col-1', 'item-123', {
      coverImageUrl: 'https://images.squarespace-cdn.com/content/v1/site/img.jpg',
    });

    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.coverImageUrl).toBe('https://images.squarespace-cdn.com/content/v1/site/img.jpg');
  });
});

// ─── createBlogPost ───────────────────────────────────────────────────────

describe('createBlogPost', () => {
  beforeEach(() => mockFetch.mockReset());

  it('uses publishDate ISO string for publishOn in POST body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'new-post-1', urlId: 'my-post' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    const result = await client.createBlogPost('col-1', 'Test Post', {
      publishDate: '2026-01-15T10:00:00Z',
      draft: false,
    });

    expect(result.success).toBe(true);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.publishOn).toBe(new Date('2026-01-15T10:00:00Z').getTime());
  });

  it('calls updateBlogPost after create when body/tags/excerpt/categories provided', async () => {
    // First call: POST create → success
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'new-post-2', urlId: 'rich-post' }),
      text: async () => '',
    } as Response);
    // Read current post before the follow-up PUT.
    mockFetch.mockResolvedValueOnce(currentPostResponse('new-post-2'));
    // Third call: PUT update → success
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'new-post-2' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    const result = await client.createBlogPost('col-1', 'Rich Post', {
      body: '<p>Hello</p>',
      tags: ['news'],
      excerpt: 'A summary',
      categories: ['updates'],
    });

    expect(result.success).toBe(true);
    expect(result.itemId).toBe('new-post-2');
    // POST create, GET current post, PUT update
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const [updateUrl, updateInit] = mockFetch.mock.calls[2] as [string, RequestInit];
    expect(updateUrl).toContain('/text-posts/new-post-2');
    expect(updateInit.method).toBe('PUT');
    const updateBody = JSON.parse(updateInit.body as string);
    expect(updateBody.body).toEqual({ html: '<p>Hello</p>' });
    expect(updateBody.tags).toEqual(['news']);
    expect(updateBody.excerpt).toEqual({ html: 'A summary', raw: false });
    expect(updateBody.categories).toEqual(['updates']);
  });

  it('returns failure when follow-up update fails (e.g. session expired)', async () => {
    // First call: POST create → success
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'new-post-fail', urlId: 'fail-post' }),
      text: async () => '',
    } as Response);
    mockFetch.mockResolvedValueOnce(currentPostResponse('new-post-fail'));
    // Third call: PUT update → 401 session expired
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401,
      text: async () => '',
    } as Response);

    const client = makeClient();
    const result = await client.createBlogPost('col-1', 'Failing Post', {
      body: '<p>This should fail</p>',
    });

    expect(result.success).toBe(false);
    expect(result.itemId).toBe('new-post-fail');
    expect(result.error).toMatch(/follow-up update failed/i);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not call updateBlogPost when only title and draft provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'new-post-3', urlId: 'simple' }),
      text: async () => '',
    } as Response);

    const client = makeClient();
    await client.createBlogPost('col-1', 'Simple Post', { draft: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
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
