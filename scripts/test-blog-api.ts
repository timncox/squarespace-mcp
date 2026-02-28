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
