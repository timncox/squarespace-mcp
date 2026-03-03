# Blog Post API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire Squarespace's internal blog post API into the simple edit fast path so "publish a blog post titled X" completes in ~1s via API instead of 5–10 min via browser automation.

**Architecture:** `ContentSaveClient` already has `createBlogPost()` and `getCollectionItems()` using the internal `/api/content-collections/{collectionId}/content-items` endpoint (marked speculative but pattern-matches all other working endpoints). We add `updateBlogPost()` + `findBlogPostByTitle()`, then wire two new `SimpleEditType` values (`blog_post_create`, `blog_post_update`) through classifier → executor → client. Finally, add an API fast path to the existing `handleCreateBlogPost` browser action as a fallback safety net. Scope: dictated content only — "write a creative post about X" stays complex (content strategist pipeline).

**Tech Stack:** TypeScript, vitest, Squarespace internal API (same session auth as existing ContentSaveClient), no new dependencies.

---

### Task 1: Add blog post update types

**Files:**
- Modify: `src/services/content-save-types.ts` (after `BlogPostCreateResult` around line 468)

**Step 1: Add types**

Find `BlogPostCreateResult` interface and add these two interfaces immediately after it:

```typescript
export interface BlogPostUpdateOptions {
  title?: string;
  body?: string;
  excerpt?: string;
  tags?: string[];
  categories?: string[];
  urlId?: string;
  draft?: boolean;
}

export interface BlogPostUpdateResult {
  success: boolean;
  itemId: string;
  updatedFields: string[];
  error?: string;
}
```

**Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | head -20
```
Expected: No new errors

**Step 3: Commit**

```bash
git add src/services/content-save-types.ts
git commit -m "feat: add BlogPostUpdateOptions and BlogPostUpdateResult types"
```

---

### Task 2: Add `updateBlogPost()` and `findBlogPostByTitle()` with tests

**Files:**
- Create: `src/services/__tests__/content-save-blog.test.ts`
- Modify: `src/services/content-save.ts` (after `createBlogPost`, around line 4253)

**Step 1: Write the failing tests**

Create `src/services/__tests__/content-save-blog.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before importing ContentSaveClient
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(
      JSON.stringify({
        cookies: [{ name: 'crumb', value: 'test-crumb' }],
        savedAt: new Date().toISOString(),
      }),
    ),
  };
});

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { ContentSaveClient } = await import('../content-save.js');

function makeClient() {
  return new ContentSaveClient('test-site');
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
```

**Step 2: Run tests to verify they fail**

```bash
npm run test -- content-save-blog
```
Expected: FAIL — `updateBlogPost` and `findBlogPostByTitle` are not defined

**Step 3: Implement `updateBlogPost()` in content-save.ts**

Find the closing `}` of `createBlogPost` at line 4252 and add these two methods after it (before the "Page Delete / Update" comment block):

```typescript
/**
 * Update an existing blog post by item ID.
 * PUT /api/content-collections/{collectionId}/content-items/{itemId}
 * Never throws.
 */
async updateBlogPost(
  collectionId: string,
  itemId: string,
  updates: BlogPostUpdateOptions,
): Promise<BlogPostUpdateResult> {
  this.ensureCookies();

  try {
    const body: Record<string, unknown> = {};
    const updatedFields: string[] = [];

    if (updates.title != null) { body.title = updates.title; updatedFields.push('title'); }
    if (updates.body != null) { body.body = updates.body; updatedFields.push('body'); }
    if (updates.excerpt != null) { body.excerpt = updates.excerpt; updatedFields.push('excerpt'); }
    if (updates.tags != null) { body.tags = updates.tags; updatedFields.push('tags'); }
    if (updates.categories != null) { body.categories = updates.categories; updatedFields.push('categories'); }
    if (updates.urlId != null) { body.urlId = updates.urlId; updatedFields.push('urlId'); }
    if (updates.draft != null) { body.draft = updates.draft; updatedFields.push('draft'); }

    if (updatedFields.length === 0) {
      return { success: false, itemId, updatedFields: [], error: 'No fields provided to update' };
    }

    const path = `/api/content-collections/${collectionId}/content-items/${itemId}`;
    const url = this.buildApiUrl(path, true);

    const response = await fetch(url, {
      method: 'PUT',
      headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 401) {
      return { success: false, itemId, updatedFields: [], error: 'Session expired' };
    }
    if (response.status === 404) {
      return { success: false, itemId, updatedFields: [], error: 'Blog post not found' };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, itemId, updatedFields: [], error: `HTTP ${response.status}: ${text}` };
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (data.crumbFail || (typeof data.error === 'string' && data.error.includes('Invalid session crumb'))) {
      return { success: false, itemId, updatedFields: [], error: 'Session crumb invalid — re-authenticate' };
    }

    logger.info({ collectionId, itemId, updatedFields }, 'updateBlogPost: post updated');
    return { success: true, itemId, updatedFields };
  } catch (err) {
    return { success: false, itemId, updatedFields: [], error: errMsg(err) };
  }
}

/**
 * Find a blog post by partial title match (case-insensitive).
 * Returns the first matching CollectionItem, or null.
 * Never throws.
 */
async findBlogPostByTitle(
  collectionId: string,
  searchTitle: string,
): Promise<CollectionItem | null> {
  try {
    const result = await this.getCollectionItems(collectionId);
    if (!result.success || !result.items) return null;
    const lower = searchTitle.toLowerCase().trim();
    return result.items.find((item) => item.title?.toLowerCase().includes(lower)) ?? null;
  } catch (err) {
    logger.warn({ error: errMsg(err), collectionId, searchTitle }, 'findBlogPostByTitle: failed');
    return null;
  }
}
```

**Step 4: Add new types to the import from content-save-types.ts**

Find the import line in `content-save.ts` that imports from `./content-save-types.js` and add `BlogPostUpdateOptions, BlogPostUpdateResult` to it.

**Step 5: Run tests to verify they pass**

```bash
npm run test -- content-save-blog
```
Expected: PASS (all 7 tests)

**Step 6: Run full test suite**

```bash
npm run test
```
Expected: All existing tests still pass

**Step 7: Commit**

```bash
git add src/services/content-save.ts src/services/__tests__/content-save-blog.test.ts
git commit -m "feat: add updateBlogPost and findBlogPostByTitle to ContentSaveClient"
```

---

### Task 3: Add blog post types to classifier

**Files:**
- Modify: `src/services/simple-edit-classifier.ts`

**Background:** The complexity gate (around line 66) has `/\bwrite\s+(an?\s+)?/i` in `COMPLEX_PATTERNS` which would catch "write a blog post about X" and short-circuit before LLM classification. We need a pre-LLM check that routes blog post tasks before the complexity gate runs. Scope: only handle tasks where the user provides specific title + body content (dictated posts). Generative requests ("write something creative about my photography") should stay complex.

**Step 1: Update `SimpleEditType` union (line 32)**

Add two values at the end:

```typescript
export type SimpleEditType =
  // ... existing values ...
  | 'page_seo'
  | 'blog_post_create'
  | 'blog_post_update';
```

**Step 2: Add blog post params to the `params` interface (line 38–60)**

Add at the end of the params object inside `SimpleEditClassification`:

```typescript
// Blog post params
postTitle?: string;
postBody?: string;         // HTML or plain text body content
postExcerpt?: string;
postTags?: string[];
postCategories?: string[];
postDraft?: boolean;       // true = save as draft, false = publish immediately
postSearchTitle?: string;  // for blog_post_update: find existing post by this title
```

**Step 3: Add pre-LLM check to `tryPreLlmClassification`**

The function body is around line 84. Blog post tasks look like: description contains "blog post" AND a recognizable title OR explicit publish/draft intent. Add as case 4 at the end of `tryPreLlmClassification`:

```typescript
// 4. Blog post create — description contains "blog post" with a clear title marker
// This runs before the complexity gate, bypassing the /\bwrite\b/ COMPLEX_PATTERN.
// Requires an explicit title ("titled X" or "called X"). Generative-only requests
// ("write something about...") will not match and fall through to full complexity check.
const blogPostTitleMatch = task.description?.match(
  /\bblog\s+post\b.+\b(?:titled?|called|named?)\s+["']?(.+?)["']?\s*(?:,|$|\.|\bwith\b|\babout\b)/i,
);
if (blogPostTitleMatch) {
  const isDraft =
    /\b(?:draft|don'?t\s+publish|save\s+as\s+draft|not\s+live)\b/i.test(task.description ?? '') ||
    !/\b(?:publish|live|go\s+live)\b/i.test(task.description ?? '');
  return {
    isSimpleEdit: true,
    editType: 'blog_post_create',
    confidence: 'medium',
    params: {
      postTitle: blogPostTitleMatch[1].trim(),
      postDraft: isDraft,
    },
    reason: 'Blog post creation with explicit title detected',
  };
}
```

**Step 4: Update the LLM prompt to handle blog post classification**

Find the LLM prompt string (around line 150–280). Add blog post types to the "Edit Types" section. They should appear before the catch-all:

```
- blog_post_create: Create a new blog post. Required: targetPage (blog page slug, e.g. "blog" or "news"), postTitle. Optional: postBody (HTML), postExcerpt, postTags (array), postCategories (array), postDraft (true=draft, false=publish immediately — default true).
- blog_post_update: Edit or update an existing blog post. Required: targetPage (blog page slug), postSearchTitle (current title to find the post). Optional: postTitle (new title), postBody (new body HTML), postExcerpt, postTags, postCategories, postDraft.
```

Also add extraction guidance to the params section:

```
- postTitle: title of the blog post (for create) or new title (for update)
- postBody: body content as HTML — only extract if explicitly provided by the user, not AI-generated
- postSearchTitle: for blog_post_update only — the existing post title to search for
- postDraft: true if "save as draft", "don't publish", or timing is unclear; false if "publish now" or "make live"
- postTags: array of tag strings extracted from "tag with X, Y, Z" or "tags: X, Y"
- postExcerpt: short summary if user provides one explicitly
```

**Step 5: Run existing classifier tests**

```bash
npm run test -- simple-edit-classifier
```
Expected: All existing tests still pass

**Step 6: Commit**

```bash
git add src/services/simple-edit-classifier.ts
git commit -m "feat: add blog_post_create and blog_post_update to simple edit classifier"
```

---

### Task 4: Wire blog post types into the executor with tests

**Files:**
- Create: `src/services/__tests__/simple-edit-executor-blog.test.ts`
- Modify: `src/services/simple-edit-executor.ts`

**Step 1: Write failing tests**

Create `src/services/__tests__/simple-edit-executor-blog.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../../models/task.js';
import type { SimpleEditClassification } from '../simple-edit-classifier.js';

const mockCreateBlogPost = vi.fn();
const mockGetCollectionItems = vi.fn();
const mockUpdateBlogPost = vi.fn();
const mockGetPageMetadata = vi.fn();
const mockFindBlogPostByTitle = vi.fn();

vi.mock('../content-save.js', () => ({
  createContentSaveClient: vi.fn(() => ({
    createBlogPost: mockCreateBlogPost,
    getCollectionItems: mockGetCollectionItems,
    updateBlogPost: mockUpdateBlogPost,
    getPageMetadata: mockGetPageMetadata,
    findBlogPostByTitle: mockFindBlogPostByTitle,
    loadCookies: vi.fn().mockResolvedValue(undefined),
  })),
  ContentSaveClient: {
    checkSessionHealth: vi.fn().mockReturnValue({ exists: true, hasCrumb: true, isStale: false }),
  },
}));

// Mock page ID resolver — returns blog collection ID as collectionId
vi.mock('../page-id-resolver.js', () => ({
  resolvePageIds: vi.fn().mockResolvedValue({ pageSectionsId: 'ps-abc', collectionId: 'col-abc' }),
}));

const { executeSimpleEdit } = await import('../simple-edit-executor.js');

const baseTask = {
  id: 1,
  siteId: 'test-site',
  targetPage: 'blog',
  description: 'test task',
  status: 'pending',
} as unknown as Task;

// ─── blog_post_create ───────────────────────────────────────────────────────

describe('executeSimpleEdit — blog_post_create', () => {
  beforeEach(() => {
    mockCreateBlogPost.mockReset();
  });

  it('creates a draft blog post with title and body', async () => {
    mockCreateBlogPost.mockResolvedValue({ success: true, itemId: 'item-1', endpointAvailable: true });

    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_create',
      confidence: 'high',
      params: { postTitle: 'My New Post', postBody: '<p>Hello world</p>', postDraft: true },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('My New Post');
    expect(mockCreateBlogPost).toHaveBeenCalledWith('col-abc', 'My New Post', {
      body: '<p>Hello world</p>',
      excerpt: undefined,
      tags: undefined,
      categories: undefined,
      draft: true,
    });
  });

  it('returns failure when postTitle is missing', async () => {
    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_create',
      confidence: 'high',
      params: {},
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/postTitle required/i);
  });

  it('returns failure when API endpoint not available', async () => {
    mockCreateBlogPost.mockResolvedValue({
      success: false,
      endpointAvailable: false,
      error: 'Endpoint returned 404',
    });

    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_create',
      confidence: 'high',
      params: { postTitle: 'Test' },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(false);
  });
});

// ─── blog_post_update ───────────────────────────────────────────────────────

describe('executeSimpleEdit — blog_post_update', () => {
  beforeEach(() => {
    mockFindBlogPostByTitle.mockReset();
    mockUpdateBlogPost.mockReset();
  });

  it('finds post by search title and updates requested fields', async () => {
    mockFindBlogPostByTitle.mockResolvedValue({ id: 'item-1', title: 'My Old Post' });
    mockUpdateBlogPost.mockResolvedValue({ success: true, itemId: 'item-1', updatedFields: ['title', 'body'] });

    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_update',
      confidence: 'high',
      params: {
        postSearchTitle: 'My Old Post',
        postTitle: 'My Updated Post',
        postBody: '<p>New content</p>',
      },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(true);
    expect(mockUpdateBlogPost).toHaveBeenCalledWith('col-abc', 'item-1', {
      title: 'My Updated Post',
      body: '<p>New content</p>',
      excerpt: undefined,
      tags: undefined,
      categories: undefined,
      draft: undefined,
    });
  });

  it('returns failure when postSearchTitle is missing', async () => {
    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_update',
      confidence: 'high',
      params: { postTitle: 'New Title' },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/postSearchTitle required/i);
  });

  it('returns failure when no matching post found', async () => {
    mockFindBlogPostByTitle.mockResolvedValue(null);

    const classification: SimpleEditClassification = {
      isSimpleEdit: true,
      editType: 'blog_post_update',
      confidence: 'high',
      params: { postSearchTitle: 'Nonexistent Post' },
      reason: '',
    };

    const result = await executeSimpleEdit(baseTask, classification);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run test -- simple-edit-executor-blog
```
Expected: FAIL — `blog_post_create`/`blog_post_update` cases not dispatched

**Step 3: Add executor functions to simple-edit-executor.ts**

Find where other `exec*` functions are defined (around line 47). Add these two after the last existing `exec*` function:

```typescript
async function execBlogPostCreate(
  client: ContentSaveClient,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.postTitle) throw new Error('postTitle required for blog_post_create');
  const result = await client.createBlogPost(collectionId, params.postTitle, {
    body: params.postBody,
    excerpt: params.postExcerpt,
    tags: params.postTags,
    categories: params.postCategories,
    draft: params.postDraft ?? true,
  });
  if (!result.success) throw new Error(result.error ?? 'createBlogPost failed');
  if (!result.endpointAvailable) throw new Error('Blog post API not available on this site');
  const status = (params.postDraft ?? true) ? 'draft' : 'published';
  return `Created ${status} blog post "${params.postTitle}"`;
}

async function execBlogPostUpdate(
  client: ContentSaveClient,
  collectionId: string,
  params: SimpleEditClassification['params'],
): Promise<string> {
  if (!params.postSearchTitle) throw new Error('postSearchTitle required for blog_post_update');
  const existing = await client.findBlogPostByTitle(collectionId, params.postSearchTitle);
  if (!existing) throw new Error(`No blog post found matching "${params.postSearchTitle}"`);
  const result = await client.updateBlogPost(collectionId, existing.id, {
    title: params.postTitle,
    body: params.postBody,
    excerpt: params.postExcerpt,
    tags: params.postTags,
    categories: params.postCategories,
    draft: params.postDraft,
  });
  if (!result.success) throw new Error(result.error ?? 'updateBlogPost failed');
  return `Updated blog post "${existing.title}": ${result.updatedFields.join(', ')}`;
}
```

**Step 4: Add dispatch cases to the main switch/dispatch in `executeSimpleEdit`**

Find the switch/dispatch block and add these cases (blog post types use `collectionId` of the target page — the blog page's collection ID, resolved the same way as all other types):

```typescript
case 'blog_post_create':
  summary = await execBlogPostCreate(client, collectionId, classification.params);
  break;
case 'blog_post_update':
  summary = await execBlogPostUpdate(client, collectionId, classification.params);
  break;
```

**Step 5: Run executor tests**

```bash
npm run test -- simple-edit-executor-blog
```
Expected: PASS

**Step 6: Run full test suite**

```bash
npm run test
```
Expected: All existing tests still pass

**Step 7: Commit**

```bash
git add src/services/simple-edit-executor.ts src/services/__tests__/simple-edit-executor-blog.test.ts
git commit -m "feat: wire blog_post_create and blog_post_update into simple edit executor"
```

---

### Task 5: Add API fast path to `handleCreateBlogPost`

**Files:**
- Modify: `src/automation/actions/page-management-handlers.ts` (around line 980)

**Step 1: Locate the function**

Find `handleCreateBlogPost` (around line 980). It currently goes straight into Playwright UI automation. We'll try the API first before touching the browser.

**Step 2: Check imports at top of file**

Verify that `ContentSaveClient` and `createContentSaveClient` are already imported. Other handlers in this file use them for API fast paths. If not, add:

```typescript
import { ContentSaveClient, createContentSaveClient } from '../../services/content-save.js';
```

**Step 3: Add API fast path at the top of `handleCreateBlogPost`**

Insert this block at the very beginning of the function body, before any existing code:

```typescript
// API fast path — try creating the post via ContentSaveClient (~1s vs ~5-10min UI)
const sessionHealth = ContentSaveClient.checkSessionHealth();
if (sessionHealth.exists && sessionHealth.hasCrumb && !sessionHealth.isStale) {
  try {
    const subdomain = new URL(page.url()).hostname.replace('.squarespace.com', '');
    const client = createContentSaveClient(subdomain);
    const meta = await client.getPageMetadata(action.blogPageSlug);
    if (meta?.collectionId) {
      const result = await client.createBlogPost(meta.collectionId, action.title, {
        body: action.content,
        draft: action.draft ?? true,
      });
      if (result.success) {
        logger.info({ itemId: result.itemId }, 'handleCreateBlogPost: created via API fast path');
        return {
          success: true,
          summary: `Created blog post "${action.title}" via API`,
          details: `Post ID: ${result.itemId}`,
        };
      }
      if (result.endpointAvailable === false) {
        logger.debug('handleCreateBlogPost: blog post API endpoint not available, falling back to UI');
      } else {
        logger.warn({ error: result.error }, 'handleCreateBlogPost: API failed, falling back to UI');
      }
    }
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'handleCreateBlogPost: API fast path error, falling back to UI');
  }
}
// ↓ Existing UI automation continues below
```

**Step 4: Run full test suite**

```bash
npm run test
```
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/automation/actions/page-management-handlers.ts
git commit -m "feat: add API fast path to handleCreateBlogPost"
```

---

### Task 6: Live endpoint verification

**Files:**
- Create: `scripts/test-blog-api.ts`

**Step 1: Create verification script**

```typescript
#!/usr/bin/env tsx
/**
 * Verify blog post API endpoints on a live site.
 * Usage: npx tsx scripts/test-blog-api.ts [subdomain] [blog-page-slug]
 * Example: npx tsx scripts/test-blog-api.ts grey-yellow-hbxc blog
 *
 * Creates a test draft post, updates it, then lists posts.
 * Clean up the test post manually in Squarespace after running.
 */
import { createContentSaveClient } from '../src/services/content-save.js';

const subdomain = process.argv[2] ?? 'grey-yellow-hbxc';
const blogSlug = process.argv[3] ?? 'blog';

console.log(`Testing blog API on ${subdomain}, blog slug: "${blogSlug}"`);

const client = createContentSaveClient(subdomain);

// 1. Resolve blog collection ID
const meta = await client.getPageMetadata(blogSlug);
console.log('\n1. Blog collection metadata:', meta);
if (!meta?.collectionId) {
  console.error('ERROR: Could not find blog collection. Check slug and session.');
  process.exit(1);
}

// 2. List existing posts
const items = await client.getCollectionItems(meta.collectionId, { limit: 5 });
console.log(`\n2. Existing posts (first ${items.items?.length ?? 0}):`, items.items?.map((i) => i.title));

// 3. Create a test post
const created = await client.createBlogPost(meta.collectionId, 'API Test Post (safe to delete)', {
  body: '<p>This post was created via the ContentSaveClient API. Please delete it.</p>',
  excerpt: 'Test excerpt',
  tags: ['api-test'],
  draft: true,
});
console.log('\n3. Create result:', created);

if (created.success && created.itemId) {
  // 4. Update it
  const updated = await client.updateBlogPost(meta.collectionId, created.itemId, {
    title: 'API Test Post — Updated (safe to delete)',
    excerpt: 'Updated excerpt',
  });
  console.log('\n4. Update result:', updated);

  // 5. Find it by title
  const found = await client.findBlogPostByTitle(meta.collectionId, 'API Test Post');
  console.log('\n5. findBlogPostByTitle result:', found?.title, '(id:', found?.id, ')');
}

console.log('\n✅ Done. Remember to delete the test draft post in Squarespace.');
```

**Step 2: Run the script**

```bash
npx tsx scripts/test-blog-api.ts grey-yellow-hbxc blog
```

Expected output:
- Blog collection metadata shows a `collectionId`
- Create result: `{ success: true, itemId: '...', endpointAvailable: true }`
- Update result: `{ success: true, updatedFields: ['title', 'excerpt'] }`
- findBlogPostByTitle finds the created post

**If create returns `endpointAvailable: false`:** The endpoint path is wrong. Try the URL slug `news`, `journal`, or `updates` — or inspect the network tab in Chrome while creating a blog post manually to find the real endpoint.

**Step 3: Clean up test post**

Log into Squarespace, go to the blog page, delete the "API Test Post" draft.

**Step 4: Commit script**

```bash
git add scripts/test-blog-api.ts
git commit -m "chore: add blog API verification script"
```

---

## What This Doesn't Cover (Future Work)

- **AI-generated blog posts** ("write a creative post about X") — these should stay in the content strategist pipeline for now. Adding a generation step to the executor is possible but out of scope here.
- **Blog post deletion** — `DELETE /api/content-collections/{collectionId}/content-items/{itemId}` — straightforward to add following the same pattern.
- **Publish scheduling** — `publishOn` timestamp field in the update body.
- **Adding blog posts to ContentOperation plans** — would add a `create_blog_post` operation type to `src/agents/types.ts` and wire it into `api-executor.ts`, enabling the content strategist to plan blog post creation as part of a multi-op plan.
