# Blog Post MCP Tools Enhancement

**Date**: 2026-03-03
**Trigger**: Claude Desktop field report — blog post tools missing key fields

## Problem

The `sq_create_blog_post` and `sq_update_blog_post` MCP tools expose only title, body, tags, and draft. Key fields supported by the underlying API are not wired through:
- excerpt, categories, slug (urlId), publishDate
- `createBlogPost()` silently drops body/tags/excerpt/categories from the POST body
- No tools to list or find existing blog posts (agents can't look up post IDs)
- Featured image/thumbnail write path is unknown

## Changes

### 1. Enhance `sq_create_blog_post` tool

Add parameters: `excerpt`, `categories`, `slug`, `publishDate` (ISO 8601 string).

Update `createBlogPost()` in content-save.ts:
- Accept `publishDate` option, convert ISO→ms for `publishOn` field
- After successful creation, if body/tags/excerpt/categories are provided, immediately call `updateBlogPost()` to set them (Squarespace's create endpoint is picky about fields; the two-step pattern is more reliable)

### 2. Enhance `sq_update_blog_post` tool

Add parameters: `excerpt`, `categories`, `slug`, `publishDate` (ISO 8601 string).

Update `updateBlogPost()` in content-save.ts:
- Accept `publishDate` in options, convert ISO→ms, set as `publishOn`

### 3. Add `sq_list_blog_posts` tool

Wraps existing `getCollectionItems()`. Parameters: siteId, collectionId, filter?, limit?.
Returns array of `{ id, title, urlId, excerpt, tags, publishOn, workflowState }`.

### 4. Add `sq_find_blog_post` tool

Wraps existing `findBlogPostByTitle()`. Parameters: siteId, collectionId, title.
Returns matching post or error.

### 5. Playwright featured image sniffer script

Script at `scripts/sniff-featured-image.ts`:
- Opens blog post editor in Squarespace
- Sets featured image via UI interaction
- Captures network PUT/POST request body
- Logs the field name and structure used for the thumbnail

## Files Modified

- `src/mcp-server/tools/content.ts` — add params to existing tools, add 2 new tools
- `src/services/content-save.ts` — wire publishDate into create/update, add create→update follow-up
- `src/services/content-save-types.ts` — add publishDate to BlogPostUpdateOptions
- `scripts/sniff-featured-image.ts` — new Playwright script
- `src/mcp-server/__tests__/content-tools.test.ts` — tests for new/enhanced tools

## Non-Goals

- SEO fields (seoTitle, seoDescription) — defer until API write path confirmed
- Featured image on create/update — blocked on Playwright investigation
