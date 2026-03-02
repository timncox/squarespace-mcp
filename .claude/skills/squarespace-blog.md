---
name: squarespace-blog
description: >
  Use when creating or managing blog posts on a Squarespace site. Covers blog
  collection resolution, post CRUD, body HTML formatting, tags/categories,
  and draft vs published states.
---

# Squarespace Blog Post Management

## Overview

Blog posts live inside **blog collections** (type 2). Before creating or updating posts,
you must resolve the blog's `collectionId` via `listCollections()`.

All methods are on `ContentSaveClient` from `src/services/content-save.ts`.
Types are in `src/services/content-save-types.ts`.

---

## Step 1: Find the Blog Collection

```typescript
const client = createContentSaveClient(subdomain, cookiePath);
const collections = await client.listCollections();
const blog = collections.find(c => c.type === 2); // type 2 = blog
// blog.id is the collectionId you need
```

### Collection Types

| Type | Meaning |
|------|---------|
| 1 | Page |
| 2 | Blog |
| 5 | Store |
| 7 | Gallery |
| 11 | Folder |
| 12 | Index |

### listCollections()

```typescript
async listCollections(): Promise<CollectionInfo[]>
```

Returns all collections. Never throws — returns `[]` on error.

```typescript
interface CollectionInfo {
  id: string;
  urlId: string;        // URL slug
  title: string;
  type: number;          // 1=page, 2=blog, 5=store, etc.
  typeName: string;      // "page", "blog", "store", etc.
  itemCount?: number;
  enabled?: boolean;
  ordering?: number;
  navigationTitle?: string;
  description?: string;
}
```

---

## Step 2: Create / Read / Update Posts

### createBlogPost()

```typescript
async createBlogPost(
  collectionId: string,
  title: string,
  options?: {
    body?: string;         // HTML content
    slug?: string;         // URL slug (auto-generated if omitted)
    tags?: string[];
    categories?: string[];
    excerpt?: string;
    draft?: boolean;       // true = draft (default), false = published
  },
): Promise<BlogPostCreateResult>
```

Returns:
```typescript
interface BlogPostCreateResult {
  success: boolean;
  itemId?: string;       // Use this ID for updates
  urlId?: string;        // Generated URL slug
  endpointAvailable: boolean;
  error?: string;
}
```

**Key details:**
- Posts are **drafts by default** (`workflowState: 4`). Pass `draft: false` to publish immediately (`workflowState: 1`).
- Uses `POST /api/content/blogs/{collectionId}/text-posts` with `X-CSRF-Token` header.
- `endpointAvailable: false` means the blog API endpoint returned 404/405 (site may not support it).

### updateBlogPost()

```typescript
async updateBlogPost(
  collectionId: string,
  itemId: string,
  updates: BlogPostUpdateOptions,
): Promise<BlogPostUpdateResult>
```

```typescript
interface BlogPostUpdateOptions {
  title?: string;
  body?: string;           // HTML string (auto-wrapped to { html })
  excerpt?: string;        // Auto-wrapped to { html, raw: false }
  tags?: string[];
  categories?: string[];
  urlId?: string;          // Change the URL slug
  draft?: boolean;         // true = draft, false = published
}

interface BlogPostUpdateResult {
  success: boolean;
  itemId: string;
  updatedFields: string[];  // Which fields were actually sent
  error?: string;
}
```

**Key details:**
- Only sends fields with non-null/non-undefined values (partial update).
- `body` string is auto-wrapped to `{ html: bodyString }` for the API.
- Uses `PUT /api/content/blogs/{collectionId}/text-posts/{itemId}`.

### findBlogPostByTitle()

```typescript
async findBlogPostByTitle(
  collectionId: string,
  searchTitle: string,
): Promise<CollectionItem | null>
```

Case-insensitive partial title search. Returns the first matching post or `null`.

```typescript
interface CollectionItem {
  id: string;
  title: string;
  urlId?: string;
  body?: string;
  excerpt?: string;
  status?: string;
  publishOn?: number;
  updatedOn?: number;
  tags?: string[];
  categories?: string[];
  [key: string]: unknown;
}
```

### getCollectionItems()

```typescript
async getCollectionItems(
  collectionId: string,
  options?: {
    limit?: number;
    offset?: number;
    filter?: 'published' | 'draft' | 'all';
  },
): Promise<CollectionItemsResult>
```

Returns:
```typescript
interface CollectionItemsResult {
  success: boolean;
  items?: CollectionItem[];
  total?: number;
  error?: string;
}
```

Supports pagination via `limit`/`offset` and status filtering.

---

## Body HTML Formatting

Use `ContentSaveClient.buildRichHtml()` (static method) for structured content:

```typescript
static buildRichHtml(elements: RichHtmlElement[]): string
```

```typescript
interface RichHtmlElement {
  text: string;
  tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'li';  // default: 'p'
  bold?: boolean;
  italic?: boolean;
  link?: { href: string; target?: string };
  style?: Record<string, string>;
  className?: string;
}
```

Consecutive `li` elements are auto-grouped into a `<ul>`.

### Example: Rich post body

```typescript
const body = ContentSaveClient.buildRichHtml([
  { text: 'Welcome to Our Blog', tag: 'h2' },
  { text: 'We are excited to share our latest updates.', tag: 'p' },
  { text: 'Read more on our website', tag: 'p', link: { href: '/about' } },
  { text: 'Feature one', tag: 'li' },
  { text: 'Feature two', tag: 'li' },
  { text: 'Feature three', tag: 'li' },
]);
```

Or pass raw HTML directly:

```typescript
const body = '<h2>My Post</h2><p>Content here with <strong>bold</strong> text.</p>';
```

---

## CLI Commands

### Existing

The `sq.ts` CLI does not yet have blog-specific commands. Use the API directly.

### Coming Soon

| Command | Usage |
|---------|-------|
| `create-post` | `tsx scripts/sq.ts create-post --site <id> --blog <slug> --title <str> [--body <html>] [--draft]` |
| `update-post` | `tsx scripts/sq.ts update-post --site <id> --blog <slug> --post <title> --body <html>` |
| `list-posts` | `tsx scripts/sq.ts list-posts --site <id> --blog <slug> [--filter published\|draft\|all]` |

---

## Examples

### Example 1: Create a basic blog post

```typescript
import { createContentSaveClient } from '../src/services/content-save.js';

const client = createContentSaveClient('my-site', cookiePath);

// Find the blog collection
const collections = await client.listCollections();
const blog = collections.find(c => c.type === 2);
if (!blog) throw new Error('No blog collection found');

// Create a draft post
const result = await client.createBlogPost(blog.id, 'My First Post', {
  body: '<h2>Hello World</h2><p>This is my first blog post.</p>',
  tags: ['announcement', 'welcome'],
  draft: true,
});
console.log(`Created post: ${result.itemId} at /${result.urlId}`);
```

### Example 2: Update an existing post

```typescript
// Find the post by title
const post = await client.findBlogPostByTitle(blog.id, 'My First Post');
if (!post) throw new Error('Post not found');

// Update it
await client.updateBlogPost(blog.id, post.id, {
  body: '<h2>Updated Title</h2><p>New content here.</p>',
  tags: ['announcement', 'updated'],
  draft: false, // Publish it
});
```

### Example 3: List all published posts

```typescript
const { items, total } = await client.getCollectionItems(blog.id, {
  filter: 'published',
  limit: 50,
});
console.log(`Found ${total} published posts`);
for (const post of items ?? []) {
  console.log(`- ${post.title} (/${post.urlId})`);
}
```

---

## Important Notes

- **All methods never throw** — they return error results with `success: false` and `error` message.
- **Session required** — needs authenticated session cookies (see squarespace-setup skill).
- **Blog endpoints use X-CSRF-Token** header, not URL crumb parameter.
- **Draft is default** — posts are created as drafts unless `draft: false` is passed.
- **Endpoint availability** — `createBlogPost` returns `endpointAvailable: false` if the site doesn't support the blog API endpoint. In that case, fall back to browser automation via `createBlogPost` compound action.
