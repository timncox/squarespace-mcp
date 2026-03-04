# Blog Post MCP Tools Enhancement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance blog post MCP tools with missing fields (excerpt, categories, slug, publishDate), add list/find tools, and create a Playwright script to reverse-engineer the featured image write path.

**Architecture:** Wire existing `BlogPostUpdateOptions` fields through to MCP tool schemas. Add `publishDate` (ISO 8601 → Unix ms) conversion at both the tool and API layers. Two new discovery tools wrap existing `getCollectionItems()`/`findBlogPostByTitle()` methods. Create-then-update pattern for fields the POST endpoint ignores.

**Tech Stack:** TypeScript, Zod schemas, MCP SDK, vitest, Playwright

---

### Task 1: Add `publishDate` to `BlogPostUpdateOptions` type and `updateBlogPost()` API method

**Files:**
- Modify: `src/services/content-save-types.ts:549-557` (BlogPostUpdateOptions)
- Modify: `src/services/content-save.ts:6905-6978` (updateBlogPost method)
- Test: `src/services/__tests__/content-save-blog.test.ts`

**Step 1: Write the failing test**

Add to `src/services/__tests__/content-save-blog.test.ts` in the `updateBlogPost` describe block:

```typescript
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

  const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(init.body as string);
  expect(body.publishOn).toBe(new Date('2026-01-15T10:00:00Z').getTime());
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/__tests__/content-save-blog.test.ts -t "converts publishDate" --no-file-parallelism`
Expected: FAIL — `publishDate` not in `BlogPostUpdateOptions`, `publishOn` not set in body

**Step 3: Add `publishDate` to `BlogPostUpdateOptions`**

In `src/services/content-save-types.ts`, add after the `urlId` field (line ~556):

```typescript
export interface BlogPostUpdateOptions {
  title?: string;
  body?: string;
  excerpt?: string;
  tags?: string[];
  categories?: string[];
  urlId?: string;
  publishDate?: string;  // ISO 8601 string → converted to publishOn (Unix ms)
  draft?: boolean;
}
```

**Step 4: Wire `publishDate` into `updateBlogPost()`**

In `src/services/content-save.ts`, after the `set('urlId', ...)` line (~6937), add:

```typescript
if (updates.publishDate) {
  const ms = new Date(updates.publishDate).getTime();
  if (!isNaN(ms)) set('publishOn', ms, 'publishDate');
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/services/__tests__/content-save-blog.test.ts -t "converts publishDate" --no-file-parallelism`
Expected: PASS

**Step 6: Commit**

```
feat: add publishDate support to updateBlogPost API method
```

---

### Task 2: Wire `publishDate` into `createBlogPost()` and add create-then-update for extra fields

**Files:**
- Modify: `src/services/content-save.ts:6813-6898` (createBlogPost method)
- Test: `src/services/__tests__/content-save-blog.test.ts`

**Step 1: Write the failing tests**

Add to `src/services/__tests__/content-save-blog.test.ts`, new describe block:

```typescript
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
    // Second call: PUT update → success
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
    // Should have made 2 fetch calls: POST create + PUT update
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [updateUrl, updateInit] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(updateUrl).toContain('/text-posts/new-post-2');
    expect(updateInit.method).toBe('PUT');
    const updateBody = JSON.parse(updateInit.body as string);
    expect(updateBody.body).toEqual({ html: '<p>Hello</p>' });
    expect(updateBody.tags).toEqual(['news']);
    expect(updateBody.excerpt).toEqual({ html: 'A summary', raw: false });
    expect(updateBody.categories).toEqual(['updates']);
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/__tests__/content-save-blog.test.ts -t "createBlogPost" --no-file-parallelism`
Expected: FAIL — publishDate not accepted, no follow-up update call

**Step 3: Update `createBlogPost()` method**

In `src/services/content-save.ts`, modify the `createBlogPost` method:

1. Add `publishDate?: string` to the options type (line ~6816-6823):

```typescript
async createBlogPost(
  collectionId: string,
  title: string,
  options?: {
    body?: string;
    slug?: string;
    tags?: string[];
    categories?: string[];
    excerpt?: string;
    publishDate?: string;
    draft?: boolean;
  },
): Promise<BlogPostCreateResult> {
```

2. Replace the hardcoded `publishOn: now` with conditional logic (around line 6833):

```typescript
const publishOn = options?.publishDate
  ? new Date(options.publishDate).getTime() || now
  : now;

const postBody = JSON.stringify({
  addedOn: now,
  publishOn,
  // ... rest unchanged
```

3. After the successful creation block (after line ~6889), add the follow-up update:

```typescript
// Follow-up: set fields the create endpoint doesn't accept
const needsUpdate = options?.body || options?.tags || options?.excerpt || options?.categories;
if (needsUpdate && data.id) {
  await this.updateBlogPost(collectionId, String(data.id), {
    ...(options.body ? { body: options.body } : {}),
    ...(options.tags ? { tags: options.tags } : {}),
    ...(options.excerpt ? { excerpt: options.excerpt } : {}),
    ...(options.categories ? { categories: options.categories } : {}),
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/__tests__/content-save-blog.test.ts --no-file-parallelism`
Expected: ALL PASS

**Step 5: Commit**

```
feat: add publishDate and create-then-update to createBlogPost
```

---

### Task 3: Add new fields to `sq_create_blog_post` and `sq_update_blog_post` MCP tool schemas

**Files:**
- Modify: `src/mcp-server/tools/content.ts:17-56` (sq_create_blog_post)
- Modify: `src/mcp-server/tools/content.ts:58-100` (sq_update_blog_post)
- Test: `src/mcp-server/__tests__/content-tools.test.ts`

**Step 1: Write the failing tests**

Add to `src/mcp-server/__tests__/content-tools.test.ts` in the `sq_create_blog_post` describe block:

```typescript
it('should pass excerpt, categories, slug, publishDate to createBlogPost', async () => {
  mockClient.createBlogPost.mockResolvedValue({
    success: true, endpointAvailable: true, itemId: 'post-456', urlId: 'custom-slug',
  });

  await server.callTool('sq_create_blog_post', {
    siteId: 'smyth-tavern',
    collectionId: 'blog-col-1',
    title: 'Full Post',
    body: '<p>Content</p>',
    excerpt: 'A brief summary',
    categories: ['food', 'nyc'],
    slug: 'custom-slug',
    publishDate: '2026-01-15T10:00:00Z',
    tags: ['review'],
    draft: false,
  });

  expect(mockClient.createBlogPost).toHaveBeenCalledWith('blog-col-1', 'Full Post', {
    body: '<p>Content</p>',
    excerpt: 'A brief summary',
    categories: ['food', 'nyc'],
    slug: 'custom-slug',
    publishDate: '2026-01-15T10:00:00Z',
    tags: ['review'],
    draft: false,
  });
});
```

Add in the `sq_update_blog_post` describe block:

```typescript
it('should pass excerpt, categories, slug, publishDate to updateBlogPost', async () => {
  mockClient.updateBlogPost.mockResolvedValue({
    success: true, itemId: 'post-789',
    updatedFields: ['excerpt', 'categories', 'urlId', 'publishDate'],
  });

  await server.callTool('sq_update_blog_post', {
    siteId: 'smyth-tavern',
    collectionId: 'blog-col-1',
    postId: 'post-789',
    excerpt: 'Updated summary',
    categories: ['travel'],
    slug: 'new-slug',
    publishDate: '2026-06-01T00:00:00Z',
  });

  expect(mockClient.updateBlogPost).toHaveBeenCalledWith('blog-col-1', 'post-789', {
    excerpt: 'Updated summary',
    categories: ['travel'],
    urlId: 'new-slug',
    publishDate: '2026-06-01T00:00:00Z',
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp-server/__tests__/content-tools.test.ts -t "should pass excerpt" --no-file-parallelism`
Expected: FAIL — schema doesn't accept these params, handler doesn't forward them

**Step 3: Update `sq_create_blog_post` tool in `content.ts`**

```typescript
server.registerTool('sq_create_blog_post', {
  description:
    'Create a new blog post on a Squarespace site. Requires the blog collectionId (get it from sq_list_pages). Returns the new post itemId and urlId. Body, tags, excerpt, and categories are set via a follow-up update after creation.',
  inputSchema: {
    siteId: z.string().describe('Site identifier (e.g. "my-site")'),
    collectionId: z.string().describe('Blog collection ID (from sq_list_pages)'),
    title: z.string().describe('Blog post title'),
    body: z.string().optional().describe('Blog post body HTML'),
    tags: z.array(z.string()).optional().describe('Tags for the post'),
    excerpt: z.string().optional().describe('Post excerpt / summary text'),
    categories: z.array(z.string()).optional().describe('Post categories'),
    slug: z.string().optional().describe('Custom URL slug (e.g. "my-post-title")'),
    publishDate: z.string().optional().describe('Publish date as ISO 8601 string (e.g. "2026-01-15T10:00:00Z"). Defaults to now.'),
    draft: z.boolean().optional().default(true).describe('Create as draft (default true)'),
  },
}, async ({ siteId, collectionId, title, body, tags, excerpt, categories, slug, publishDate, draft }) => {
  try {
    const client = getClient(siteId);
    const result = await client.createBlogPost(collectionId, title, {
      body, tags, excerpt, categories, slug, publishDate, draft,
    });

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Unknown error'}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});
```

**Step 4: Update `sq_update_blog_post` tool in `content.ts`**

```typescript
server.registerTool('sq_update_blog_post', {
  description:
    'Update an existing blog post on a Squarespace site. Requires collectionId and the post itemId.',
  inputSchema: {
    siteId: z.string().describe('Site identifier'),
    collectionId: z.string().describe('Blog collection ID'),
    postId: z.string().describe('Blog post item ID to update'),
    title: z.string().optional().describe('New title'),
    body: z.string().optional().describe('New body HTML'),
    tags: z.array(z.string()).optional().describe('New tags'),
    excerpt: z.string().optional().describe('Post excerpt / summary text'),
    categories: z.array(z.string()).optional().describe('Post categories'),
    slug: z.string().optional().describe('Custom URL slug'),
    publishDate: z.string().optional().describe('Publish date as ISO 8601 string (e.g. "2026-01-15T10:00:00Z")'),
    draft: z.boolean().optional().describe('Set draft status (true=draft, false=published)'),
  },
}, async ({ siteId, collectionId, postId, title, body, tags, excerpt, categories, slug, publishDate, draft }) => {
  try {
    const client = getClient(siteId);
    const result = await client.updateBlogPost(collectionId, postId, {
      title, body, tags, excerpt, categories,
      urlId: slug,
      publishDate,
      draft,
    });

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Unknown error'}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/mcp-server/__tests__/content-tools.test.ts --no-file-parallelism`
Expected: ALL PASS

**Step 6: Update the tool count assertion**

The test `'should register all 5 content tools'` stays at 5 (we haven't added new tools yet, that's Task 4).

**Step 7: Commit**

```
feat: add excerpt, categories, slug, publishDate to blog post MCP tools
```

---

### Task 4: Add `sq_list_blog_posts` and `sq_find_blog_post` MCP tools

**Files:**
- Modify: `src/mcp-server/tools/content.ts` (add 2 new tool registrations)
- Modify: `src/mcp-server/__tests__/content-tools.test.ts` (add tests)
- Note: mock needs `getCollectionItems` and `findBlogPostByTitle` added

**Step 1: Write the failing tests**

Add to the mockClient at the top of `content-tools.test.ts`:

```typescript
const mockClient = {
  createBlogPost: vi.fn(),
  updateBlogPost: vi.fn(),
  getMenuBlock: vi.fn(),
  updateMenuBlock: vi.fn(),
  updateGallerySettings: vi.fn(),
  getCollectionItems: vi.fn(),
  findBlogPostByTitle: vi.fn(),
};
```

Update the tool count test:

```typescript
it('should register all 7 content tools', () => {
  expect(server.tools.has('sq_create_blog_post')).toBe(true);
  expect(server.tools.has('sq_update_blog_post')).toBe(true);
  expect(server.tools.has('sq_list_blog_posts')).toBe(true);
  expect(server.tools.has('sq_find_blog_post')).toBe(true);
  expect(server.tools.has('sq_get_menu')).toBe(true);
  expect(server.tools.has('sq_update_menu')).toBe(true);
  expect(server.tools.has('sq_update_gallery')).toBe(true);
});
```

Add new describe blocks:

```typescript
describe('sq_list_blog_posts', () => {
  it('should list blog posts with default options', async () => {
    mockClient.getCollectionItems.mockResolvedValue({
      success: true,
      items: [
        { id: 'post-1', title: 'First Post', urlId: 'first-post', tags: ['news'] },
        { id: 'post-2', title: 'Second Post', urlId: 'second-post', tags: [] },
      ],
      total: 2,
    });

    const result = await server.callTool('sq_list_blog_posts', {
      siteId: 'smyth-tavern',
      collectionId: 'blog-col-1',
    });

    expect(mockClient.getCollectionItems).toHaveBeenCalledWith('blog-col-1', {});
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.items).toHaveLength(2);
  });

  it('should pass filter and limit options', async () => {
    mockClient.getCollectionItems.mockResolvedValue({
      success: true, items: [], total: 0,
    });

    await server.callTool('sq_list_blog_posts', {
      siteId: 'smyth-tavern',
      collectionId: 'blog-col-1',
      filter: 'published',
      limit: 10,
    });

    expect(mockClient.getCollectionItems).toHaveBeenCalledWith('blog-col-1', {
      filter: 'published',
      limit: 10,
    });
  });

  it('should return error on failure', async () => {
    mockClient.getCollectionItems.mockResolvedValue({
      success: false, error: 'Collection not found',
    });

    const result = await server.callTool('sq_list_blog_posts', {
      siteId: 'smyth-tavern',
      collectionId: 'bad-col',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Collection not found');
  });
});

describe('sq_find_blog_post', () => {
  it('should find a blog post by title', async () => {
    mockClient.findBlogPostByTitle.mockResolvedValue({
      id: 'post-1', title: 'Vegan Restaurants in NYC', urlId: 'vegan-restaurants',
    });

    const result = await server.callTool('sq_find_blog_post', {
      siteId: 'smyth-tavern',
      collectionId: 'blog-col-1',
      title: 'vegan',
    });

    expect(mockClient.findBlogPostByTitle).toHaveBeenCalledWith('blog-col-1', 'vegan');
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe('post-1');
  });

  it('should return error when post not found', async () => {
    mockClient.findBlogPostByTitle.mockResolvedValue(null);

    const result = await server.callTool('sq_find_blog_post', {
      siteId: 'smyth-tavern',
      collectionId: 'blog-col-1',
      title: 'nonexistent',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No blog post found');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/mcp-server/__tests__/content-tools.test.ts -t "sq_list_blog_posts|sq_find_blog_post|should register all 7" --no-file-parallelism`
Expected: FAIL — tools not registered

**Step 3: Add `sq_list_blog_posts` tool to `content.ts`**

Add after the `sq_update_blog_post` registration (before the menu tools):

```typescript
// ── sq_list_blog_posts ────────────────────────────────────────────────────
server.registerTool('sq_list_blog_posts', {
  description:
    'List blog posts in a Squarespace blog collection. Returns post IDs, titles, URLs, tags, and status. Use this to discover post IDs for sq_update_blog_post.',
  inputSchema: {
    siteId: z.string().describe('Site identifier'),
    collectionId: z.string().describe('Blog collection ID (from sq_list_pages, type: 11)'),
    filter: z.enum(['published', 'draft', 'all']).optional().describe('Filter by status (default: all)'),
    limit: z.number().optional().describe('Max number of posts to return'),
  },
}, async ({ siteId, collectionId, filter, limit }) => {
  try {
    const client = getClient(siteId);
    const result = await client.getCollectionItems(collectionId, {
      ...(filter ? { filter } : {}),
      ...(limit ? { limit } : {}),
    });

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Unknown error'}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});
```

**Step 4: Add `sq_find_blog_post` tool to `content.ts`**

```typescript
// ── sq_find_blog_post ─────────────────────────────────────────────────────
server.registerTool('sq_find_blog_post', {
  description:
    'Find a blog post by title (case-insensitive substring match). Returns the first matching post with its ID, title, URL, and metadata.',
  inputSchema: {
    siteId: z.string().describe('Site identifier'),
    collectionId: z.string().describe('Blog collection ID'),
    title: z.string().describe('Title text to search for (case-insensitive substring match)'),
  },
}, async ({ siteId, collectionId, title }) => {
  try {
    const client = getClient(siteId);
    const post = await client.findBlogPostByTitle(collectionId, title);

    if (!post) {
      return {
        content: [{ type: 'text' as const, text: `No blog post found matching "${title}"` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(post, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/mcp-server/__tests__/content-tools.test.ts --no-file-parallelism`
Expected: ALL PASS

**Step 6: Commit**

```
feat: add sq_list_blog_posts and sq_find_blog_post MCP tools
```

---

### Task 5: Run full test suite and verify nothing is broken

**Step 1: Run all tests**

Run: `npx vitest run --exclude '.claude/**' --exclude 'dist/**' --exclude 'src/archive/**'`
Expected: ~1278+ tests passing, 0 failures

**Step 2: Build MCP server**

Run: `npx tsc --noCheck`
Expected: compiles without fatal errors (type warnings OK)

**Step 3: Commit if any fixups needed**

---

### Task 6: Create Playwright script to sniff featured image API write path

**Files:**
- Create: `scripts/sniff-featured-image.ts`

**Step 1: Write the script**

Create `scripts/sniff-featured-image.ts`:

```typescript
/**
 * Playwright script to capture the network request when setting a featured image
 * on a Squarespace blog post. This reveals the API field name for the thumbnail.
 *
 * Usage:
 *   npx tsx scripts/sniff-featured-image.ts [siteSubdomain] [blogPostUrlId]
 *
 * Prerequisites:
 *   - Session cookies in storage/state.json (from refresh-session.ts)
 *   - A blog post that already exists on the site
 *
 * What it does:
 *   1. Opens the blog post editor
 *   2. Listens for all PUT/POST requests to /api/content/
 *   3. Clicks the "Add thumbnail" / featured image area
 *   4. Waits for you to manually select an image (or uploads one)
 *   5. Captures and logs the full request body
 */

import { chromium, type Page, type Request } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SITE = process.argv[2] || 'grey-yellow-hbxc';
const STORAGE_STATE = path.resolve('storage/state.json');

async function main() {
  if (!fs.existsSync(STORAGE_STATE)) {
    console.error('No storage state found at', STORAGE_STATE);
    console.error('Run: npm run refresh-session first');
    process.exit(1);
  }

  console.log(`Opening ${SITE}.squarespace.com editor...`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = context.newPage();

  // Capture ALL API requests
  const captured: Array<{ url: string; method: string; body: string; timestamp: number }> = [];

  (await page).on('request', (req: Request) => {
    const url = req.url();
    if (url.includes('/api/') && ['PUT', 'POST', 'PATCH'].includes(req.method())) {
      const postData = req.postData();
      captured.push({
        url,
        method: req.method(),
        body: postData || '',
        timestamp: Date.now(),
      });
      console.log(`\n=== ${req.method()} ${url} ===`);
      if (postData) {
        try {
          const parsed = JSON.parse(postData);
          // Look for image-related fields
          const imageFields = ['mainImage', 'thumbnailImage', 'leadImage', 'mediaFocalPoint',
            'assetUrl', 'systemDataId', 'mediaId', 'imageId', 'featuredImage'];
          const found = imageFields.filter(f => f in parsed);
          if (found.length > 0) {
            console.log('*** FOUND IMAGE FIELDS:', found.join(', '), '***');
          }
          console.log(JSON.stringify(parsed, null, 2));
        } catch {
          console.log(postData.slice(0, 500));
        }
      }
    }
  });

  // Navigate to the blog posts list in config
  const configUrl = `https://${SITE}.squarespace.com/config/pages`;
  await (await page).goto(configUrl, { waitUntil: 'networkidle' });

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  MANUAL STEPS:                                                ║');
  console.log('║  1. Navigate to a blog post in the editor                     ║');
  console.log('║  2. Click the thumbnail/featured image area                   ║');
  console.log('║  3. Select or upload an image                                 ║');
  console.log('║  4. Save the post                                             ║');
  console.log('║  5. Check this terminal for captured API requests              ║');
  console.log('║  6. Press Ctrl+C when done — captured data saved to file      ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  // Keep alive until Ctrl+C
  process.on('SIGINT', () => {
    const outPath = path.resolve('data/featured-image-capture.json');
    fs.writeFileSync(outPath, JSON.stringify(captured, null, 2));
    console.log(`\nCaptured ${captured.length} API requests → ${outPath}`);
    browser.close().then(() => process.exit(0));
  });

  // Keep the script running
  await new Promise(() => {});
}

main().catch(console.error);
```

**Step 2: Verify it runs (syntax check only)**

Run: `npx tsx --eval "import('./scripts/sniff-featured-image.ts')" 2>&1 | head -5`
Expected: starts running or exits with "No storage state" if state.json is missing (both are fine)

**Step 3: Commit**

```
feat: add Playwright script to capture featured image API write path
```

---

### Task 7: Update CLAUDE.md with new tools

**Files:**
- Modify: `CLAUDE.md` (Key Files table, MCP Tool Development Pattern section)

**Step 1: Add the new tools to CLAUDE.md**

In the `### Content Save API` section, add after the blog post description:

Add to the MCP tool list or Key Files table that `sq_list_blog_posts` and `sq_find_blog_post` are now available, and that `sq_create_blog_post` / `sq_update_blog_post` accept excerpt, categories, slug, and publishDate.

**Step 2: Commit**

```
docs: document enhanced blog post MCP tools in CLAUDE.md
```
