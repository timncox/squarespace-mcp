/**
 * Blog Post Creation API Discovery Script
 *
 * Launches a browser, logs into Squarespace, and performs blog post lifecycle
 * operations (create draft, edit content, publish, update, delete) while
 * capturing all network traffic to catalog the internal API endpoints.
 *
 * Usage:
 *   npx tsx scripts/discover-blog-api.ts                           # Full discovery on default site
 *   npx tsx scripts/discover-blog-api.ts --site smyth-tavern       # Different site
 *   npx tsx scripts/discover-blog-api.ts --dry-run                 # Read-only (skip mutations)
 *   npx tsx scripts/discover-blog-api.ts --action createDraft      # Single action
 *   npx tsx scripts/discover-blog-api.ts --keep-post               # Don't delete the created post
 *   npx tsx scripts/discover-blog-api.ts --headless                # Run headless
 *   npx tsx scripts/discover-blog-api.ts --blog "News"             # Target a specific blog collection name
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { Page } from 'playwright';
import { join } from 'path';
import { writeFile } from 'fs/promises';
import { getBrowserManager } from '../src/automation/browser-manager.js';
import { ensureLoggedIn } from '../src/automation/squarespace-auth.js';
import { resolveSite, navigateToSite } from '../src/automation/site-navigator.js';
import { discoverSites } from '../src/automation/site-discovery.js';
import { NetworkCapture, type CapturedRequest } from '../src/automation/network-capture.js';
import { errMsg } from '../src/utils/errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface DiscoveryAction {
  name: string;
  label: string;
  mutating: boolean;
  execute: (page: Page, ctx: ActionContext) => Promise<void>;
}

interface ActionContext {
  siteSubdomain: string;
  blogCollectionName: string;
  /** Blog collection URL path (e.g. "blog") */
  blogCollectionSlug?: string;
  /** ID of the blog collection */
  blogCollectionId?: string;
  /** ID of the created blog post item */
  createdPostId?: string;
  /** URL slug of the created post */
  createdPostSlug?: string;
}

interface ActionReport {
  name: string;
  label: string;
  requests: CapturedRequest[];
  error?: string;
  durationMs: number;
}

interface EndpointEntry {
  method: string;
  path: string;
  seenInActions: string[];
  responseStatuses: number[];
  hasRequestBody: boolean;
  sampleRequestBody?: unknown;
  sampleResponseBody?: unknown;
  queryParamKeys: string[];
}

// ─── CLI Flags ────────────────────────────────────────────────────────────

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
      if (key === 'action' && flags[key]) {
        flags[key] += ',' + value;
      } else {
        flags[key] = value;
      }
      if (value !== 'true') i++;
    }
  }
  return flags;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Find a blog collection in the pages panel. Tries common names. */
async function findBlogCollection(
  page: Page,
  preferredName: string,
): Promise<{ name: string; element: ReturnType<Page['locator']> } | null> {
  const candidates = [preferredName, 'Blog', 'News', 'Posts', 'Journal', 'Articles'];
  const seen = new Set<string>();

  for (const name of candidates) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    const item = page.locator(
      `[data-test="pages-panel-item"]:has-text("${name}"), ` +
      `[data-test="pages-panel-collection"]:has-text("${name}")`
    ).first();

    if (await item.isVisible({ timeout: 1500 }).catch(() => false)) {
      return { name, element: item };
    }
  }

  return null;
}

/** Extract post/collection IDs from captured requests. */
function extractIdsFromCaptures(requests: CapturedRequest[], ctx: ActionContext): void {
  for (const req of requests) {
    // Look for POST to blog items (post creation)
    if (req.method === 'POST' && req.path.includes('/api/')) {
      const body = req.responseBody as Record<string, unknown> | null;
      if (body && typeof body === 'object') {
        // Check for item ID in response
        if ('id' in body && typeof body.id === 'string') {
          ctx.createdPostId = body.id;
          console.log(`    Extracted post ID: ${ctx.createdPostId}`);
        }
        if ('urlId' in body && typeof body.urlId === 'string') {
          ctx.createdPostSlug = body.urlId;
          console.log(`    Extracted post slug: ${ctx.createdPostSlug}`);
        }
        if ('collectionId' in body && typeof body.collectionId === 'string') {
          ctx.blogCollectionId = body.collectionId;
          console.log(`    Extracted collection ID: ${ctx.blogCollectionId}`);
        }
      }
    }

    // Also check GET responses that return collection data
    if (req.method === 'GET' && req.path.includes('GetCollections')) {
      const body = req.responseBody as Record<string, unknown>[] | null;
      if (Array.isArray(body)) {
        for (const coll of body) {
          const title = (coll as Record<string, unknown>).title as string | undefined;
          if (title && title.toLowerCase().includes(ctx.blogCollectionName.toLowerCase())) {
            ctx.blogCollectionId = (coll as Record<string, unknown>).id as string;
            ctx.blogCollectionSlug = (coll as Record<string, unknown>).fullUrl as string;
            console.log(`    Extracted blog collection ID: ${ctx.blogCollectionId}`);
          }
        }
      }
    }
  }
}

// ─── Discovery Actions ────────────────────────────────────────────────────

const ACTION_NAMES = [
  'listBlogPosts', 'createDraft', 'editPostContent', 'editPostSettings',
  'publishPost', 'unpublishPost', 'deletePost',
] as const;
type ActionName = typeof ACTION_NAMES[number];

function buildDiscoveryActions(): DiscoveryAction[] {
  return [
    // ── Read-only ─────────────────────────────────────────────────────
    {
      name: 'listBlogPosts',
      label: 'Navigate to blog collection and list posts',
      mutating: false,
      execute: async (page, ctx) => {
        const pagesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
        console.log(`    Navigating to: ${pagesUrl}`);
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        const blog = await findBlogCollection(page, ctx.blogCollectionName);
        if (!blog) {
          console.log('    No blog collection found on this site');
          return;
        }

        console.log(`    Found blog collection: "${blog.name}"`);
        await blog.element.click();
        await page.waitForTimeout(4000);

        // Count posts in the collection panel
        const postItems = page.locator('[data-test="blog-item"], [data-test="collection-item"]');
        const postCount = await postItems.count();
        console.log(`    Found ${postCount} posts in collection`);

        // Also try the broader item list
        const allItems = page.locator('[class*="BlogItem"], [class*="CollectionItem"]');
        const allCount = await allItems.count();
        if (allCount > 0) {
          console.log(`    Alternative selector found ${allCount} items`);
        }
      },
    },

    // ── Mutating ──────────────────────────────────────────────────────
    {
      name: 'createDraft',
      label: 'Create a new blog post draft',
      mutating: true,
      execute: async (page, ctx) => {
        // Navigate to pages panel
        const pagesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Find and click blog collection
        const blog = await findBlogCollection(page, ctx.blogCollectionName);
        if (!blog) {
          console.log('    No blog collection found — skipping');
          return;
        }

        await blog.element.click();
        console.log(`    Opened blog collection: "${blog.name}"`);
        await page.waitForTimeout(3000);

        // Look for "+" or "Add" button to create new post
        const addBtn = page.locator(
          'button[aria-label*="Add"], ' +
          'button[data-test*="add"], ' +
          '[data-test="add-blog-item"], ' +
          'button:has-text("+")'
        ).first();

        if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await addBtn.click();
          console.log('    Clicked Add Post button');
          await page.waitForTimeout(5000);
        } else {
          // Fallback: try the floating action button
          const fab = page.locator('[class*="FloatingAction"], [class*="fab"]').first();
          if (await fab.isVisible({ timeout: 2000 }).catch(() => false)) {
            await fab.click();
            console.log('    Clicked floating Add button');
            await page.waitForTimeout(5000);
          } else {
            console.log('    No add button found');
            return;
          }
        }

        // We should now be in the blog post editor
        console.log(`    Post editor URL: ${page.url()}`);

        // Try to find a title input and set a title
        const titleInput = page.locator(
          '[data-test="blog-item-title"], ' +
          'textarea[placeholder*="Title" i], ' +
          'input[placeholder*="Title" i], ' +
          'h1[contenteditable="true"], ' +
          '[contenteditable="true"][data-placeholder*="Title" i]'
        ).first();

        if (await titleInput.isVisible({ timeout: 5000 }).catch(() => false)) {
          await titleInput.click();
          await page.waitForTimeout(500);
          await page.keyboard.type('Discovery Test Post');
          console.log('    Set post title: "Discovery Test Post"');
          await page.waitForTimeout(3000);
        } else {
          console.log('    Title input not found — post may have different editor layout');
        }

        // Extract the post URL from the current URL
        const currentUrl = page.url();
        const postMatch = currentUrl.match(/\/blog\/([^/?]+)/);
        if (postMatch) {
          ctx.createdPostSlug = postMatch[1];
          console.log(`    Post slug from URL: ${ctx.createdPostSlug}`);
        }

        // Wait for autosave to fire
        await page.waitForTimeout(5000);
      },
    },
    {
      name: 'editPostContent',
      label: 'Edit blog post body content',
      mutating: true,
      execute: async (page, ctx) => {
        // If we have a post slug, navigate to it
        if (ctx.createdPostSlug) {
          const postUrl = `https://${ctx.siteSubdomain}.squarespace.com/${ctx.blogCollectionSlug ?? 'blog'}/${ctx.createdPostSlug}`;
          console.log(`    Navigating to post: ${postUrl}`);
          await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(3000);
        }

        // Find the content area (blog post body)
        const siteFrame = page.frameLocator('#sqs-site-frame');
        const contentArea = siteFrame.locator(
          '[class*="blog-item-content"], ' +
          '[class*="BlogItem-content"], ' +
          '.sqs-layout .sqs-block, ' +
          'article .sqs-block-content'
        ).first();

        if (await contentArea.isVisible({ timeout: 5000 }).catch(() => false)) {
          const box = await contentArea.boundingBox();
          if (box) {
            // Click to enter edit mode on the content area
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(2000);

            // Look for "Edit Content" button
            const editBtn = page.locator(
              'button:has-text("Edit Content"), ' +
              'button:has-text("EDIT CONTENT")'
            ).first();

            if (await editBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await editBtn.click();
              console.log('    Entered content edit mode');
              await page.waitForTimeout(2000);
            }

            // Try to add text in the body
            const textBlock = siteFrame.locator(
              '.sqs-block-html, [class*="html-block"], p[contenteditable]'
            ).first();

            if (await textBlock.isVisible({ timeout: 3000 }).catch(() => false)) {
              const tBox = await textBlock.boundingBox();
              if (tBox) {
                await page.mouse.dblclick(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
                await page.waitForTimeout(1000);
                await page.keyboard.type('Discovery test blog content. This will be deleted.');
                console.log('    Typed test content in blog body');
                await page.waitForTimeout(5000); // Wait for autosave
              }
            }

            // Click outside to trigger save
            await page.mouse.click(50, 50);
            await page.waitForTimeout(3000);
          }
        } else {
          console.log('    Blog content area not found');

          // Fallback: try clicking anywhere in the main content area
          const mainContent = siteFrame.locator('main, article, .page-section').first();
          if (await mainContent.isVisible({ timeout: 3000 }).catch(() => false)) {
            const mBox = await mainContent.boundingBox();
            if (mBox) {
              await page.mouse.click(mBox.x + mBox.width / 2, mBox.y + mBox.height / 2);
              await page.waitForTimeout(3000);
            }
          }
        }

        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      },
    },
    {
      name: 'editPostSettings',
      label: 'Open and modify blog post settings (URL slug, excerpt, tags)',
      mutating: true,
      execute: async (page, ctx) => {
        // If we have a post, navigate to it first
        if (ctx.createdPostSlug) {
          const postUrl = `https://${ctx.siteSubdomain}.squarespace.com/${ctx.blogCollectionSlug ?? 'blog'}/${ctx.createdPostSlug}`;
          await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(3000);
        }

        // Look for the settings/gear icon in the blog post editor
        const settingsBtn = page.locator(
          'button[aria-label*="Settings" i], ' +
          'button[data-test="blog-item-settings"], ' +
          'button[data-test="item-settings"], ' +
          '[data-test="page-header-settings"]'
        ).first();

        if (await settingsBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await settingsBtn.click();
          console.log('    Opened post settings');
          await page.waitForTimeout(3000);

          // Explore all available settings tabs
          const tabs = page.locator('[role="tab"]');
          const tabCount = await tabs.count();
          console.log(`    Found ${tabCount} settings tabs`);

          for (let i = 0; i < tabCount; i++) {
            const tabText = await tabs.nth(i).innerText().catch(() => '');
            await tabs.nth(i).click();
            console.log(`    Clicked tab: "${tabText.trim()}"`);
            await page.waitForTimeout(2000);
          }

          // Try to find and modify the URL slug input
          const slugInput = page.locator(
            'input[data-test*="url" i], ' +
            'input[data-test*="slug" i], ' +
            'label:has-text("Post URL") + input, ' +
            'label:has-text("URL Slug") + input'
          ).first();

          if (await slugInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            const currentSlug = await slugInput.inputValue();
            console.log(`    Current URL slug: "${currentSlug}"`);
          }

          // Look for tags/categories input
          const tagsInput = page.locator(
            'input[data-test*="tag" i], ' +
            'input[placeholder*="tag" i], ' +
            'label:has-text("Tags") + input, ' +
            'label:has-text("Categories") + input'
          ).first();

          if (await tagsInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await tagsInput.fill('discovery-test');
            console.log('    Set tag: "discovery-test"');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(2000);
          }

          // Look for excerpt textarea
          const excerptInput = page.locator(
            'textarea[data-test*="excerpt" i], ' +
            'textarea[placeholder*="excerpt" i], ' +
            'label:has-text("Excerpt") + textarea'
          ).first();

          if (await excerptInput.isVisible({ timeout: 2000 }).catch(() => false)) {
            await excerptInput.fill('Discovery test excerpt');
            console.log('    Set excerpt');
            await page.waitForTimeout(1000);
          }

          // Save settings
          const saveBtn = page.locator(
            'button:has-text("Save"), button:has-text("Done"), button:has-text("Apply")'
          ).first();
          if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await saveBtn.click();
            console.log('    Saved post settings');
            await page.waitForTimeout(4000);
          } else {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(1000);
          }
        } else {
          console.log('    Post settings button not found');
        }
      },
    },
    {
      name: 'publishPost',
      label: 'Publish the blog post draft',
      mutating: true,
      execute: async (page, ctx) => {
        if (!ctx.createdPostSlug) {
          console.log('    No post created — skipping publish');
          return;
        }

        // Navigate to the post
        const postUrl = `https://${ctx.siteSubdomain}.squarespace.com/${ctx.blogCollectionSlug ?? 'blog'}/${ctx.createdPostSlug}`;
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Look for publish-related buttons or status toggles
        // Squarespace blog posts have a "Save & Publish" or status toggle
        const publishBtn = page.locator(
          'button:has-text("Publish"), ' +
          'button:has-text("Save & Publish"), ' +
          'button[data-test*="publish" i]'
        ).first();

        if (await publishBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await publishBtn.click();
          console.log('    Clicked Publish');
          await page.waitForTimeout(5000);

          // There may be a confirmation dialog
          const confirmBtn = page.locator(
            'button:has-text("Publish"), button:has-text("Confirm")'
          ).last();
          if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await confirmBtn.click();
            console.log('    Confirmed publish');
            await page.waitForTimeout(3000);
          }
        } else {
          // Try the status toggle approach (Draft → Published)
          const statusToggle = page.locator(
            '[data-test*="status" i], ' +
            'button:has-text("Draft"), ' +
            '[class*="PublishToggle"]'
          ).first();

          if (await statusToggle.isVisible({ timeout: 3000 }).catch(() => false)) {
            await statusToggle.click();
            console.log('    Clicked status toggle');
            await page.waitForTimeout(4000);
          } else {
            // Navigate to post settings and find publish option there
            const settingsBtn = page.locator(
              'button[aria-label*="Settings" i], [data-test*="settings"]'
            ).first();
            if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await settingsBtn.click();
              await page.waitForTimeout(2000);

              const statusOpt = page.locator(
                'button:has-text("Published"), ' +
                'input[value="published"], ' +
                '[data-test*="publish"]'
              ).first();
              if (await statusOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
                await statusOpt.click();
                console.log('    Set status to Published via settings');
                await page.waitForTimeout(3000);

                const saveBtn = page.locator('button:has-text("Save"), button:has-text("Done")').first();
                if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                  await saveBtn.click();
                  await page.waitForTimeout(3000);
                }
              }
            }
          }
        }
      },
    },
    {
      name: 'unpublishPost',
      label: 'Revert post to draft status',
      mutating: true,
      execute: async (page, ctx) => {
        if (!ctx.createdPostSlug) {
          console.log('    No post created — skipping unpublish');
          return;
        }

        const postUrl = `https://${ctx.siteSubdomain}.squarespace.com/${ctx.blogCollectionSlug ?? 'blog'}/${ctx.createdPostSlug}`;
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Try to find unpublish/draft button
        const unpublishBtn = page.locator(
          'button:has-text("Unpublish"), ' +
          'button:has-text("Revert to Draft"), ' +
          'button:has-text("Draft")'
        ).first();

        if (await unpublishBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await unpublishBtn.click();
          console.log('    Clicked Unpublish/Draft');
          await page.waitForTimeout(4000);
        } else {
          // Try via settings
          const settingsBtn = page.locator('button[aria-label*="Settings" i]').first();
          if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await settingsBtn.click();
            await page.waitForTimeout(2000);

            const draftOpt = page.locator(
              'button:has-text("Draft"), ' +
              'input[value="draft"], ' +
              '[data-test*="draft"]'
            ).first();
            if (await draftOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
              await draftOpt.click();
              console.log('    Set status to Draft via settings');
              await page.waitForTimeout(2000);

              const saveBtn = page.locator('button:has-text("Save"), button:has-text("Done")').first();
              if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await saveBtn.click();
                await page.waitForTimeout(3000);
              }
            }
          }
        }
      },
    },
    {
      name: 'deletePost',
      label: 'Delete the discovery test blog post',
      mutating: true,
      execute: async (page, ctx) => {
        if (!ctx.createdPostSlug) {
          console.log('    No post created — skipping delete');
          return;
        }

        // Navigate to blog collection in pages panel
        const pagesUrl = `https://${ctx.siteSubdomain}.squarespace.com/config/pages`;
        await page.goto(pagesUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Open blog collection
        const blog = await findBlogCollection(page, ctx.blogCollectionName);
        if (blog) {
          await blog.element.click();
          await page.waitForTimeout(3000);
        }

        // Find the test post
        const postItem = page.locator(
          '[data-test="blog-item"]:has-text("Discovery Test"), ' +
          '[data-test="collection-item"]:has-text("Discovery Test")'
        ).first();

        // If we can't find by data-test, try broader search
        let foundPost = await postItem.isVisible({ timeout: 2000 }).catch(() => false);
        let targetPost = postItem;

        if (!foundPost) {
          // Try any element containing "Discovery Test"
          const allItems = page.locator('a:has-text("Discovery Test"), div:has-text("Discovery Test")');
          const count = await allItems.count();
          if (count > 0) {
            targetPost = allItems.first();
            foundPost = true;
          }
        }

        if (!foundPost) {
          console.log('    Could not find "Discovery Test" post — trying delete via post editor');

          // Navigate directly to the post and delete from there
          const postUrl = `https://${ctx.siteSubdomain}.squarespace.com/${ctx.blogCollectionSlug ?? 'blog'}/${ctx.createdPostSlug}`;
          await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(3000);

          // Open settings
          const settingsBtn = page.locator('button[aria-label*="Settings" i]').first();
          if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await settingsBtn.click();
            await page.waitForTimeout(2000);

            // Scroll to bottom and find Delete
            const deleteBtn = page.locator(
              'button:has-text("Delete"), button:has-text("Delete Post")'
            ).first();
            if (await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await deleteBtn.click();
              console.log('    Clicked Delete Post');
              await page.waitForTimeout(2000);

              const confirmBtn = page.locator(
                'button:has-text("Confirm"), button:has-text("Delete")'
              ).last();
              if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await confirmBtn.click();
                console.log('    Confirmed deletion');
                await page.waitForTimeout(5000);
              }
            }
          }
          return;
        }

        // Try to delete via context menu or settings
        await targetPost.click({ button: 'right' });
        await page.waitForTimeout(1000);

        const ctxDelete = page.locator(
          '[role="menuitem"]:has-text("Delete"), ' +
          'button:has-text("Delete")'
        ).first();

        if (await ctxDelete.isVisible({ timeout: 2000 }).catch(() => false)) {
          await ctxDelete.click();
          console.log('    Clicked Delete from context menu');
          await page.waitForTimeout(2000);

          const confirmBtn = page.locator(
            'button:has-text("Confirm"), button:has-text("Delete")'
          ).last();
          if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await confirmBtn.click();
            console.log('    Confirmed post deletion');
            await page.waitForTimeout(5000);
          }
        } else {
          // Fallback: click the post to open it, then delete from settings
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);

          await targetPost.click();
          await page.waitForTimeout(3000);

          const settingsBtn = page.locator('button[aria-label*="Settings" i]').first();
          if (await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await settingsBtn.click();
            await page.waitForTimeout(2000);

            const deleteBtn = page.locator('button:has-text("Delete")').first();
            if (await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await deleteBtn.click();
              await page.waitForTimeout(2000);

              const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Delete")').last();
              if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await confirmBtn.click();
                console.log('    Deleted post via settings');
                await page.waitForTimeout(5000);
              }
            }
          }
        }
      },
    },
  ];
}

// ─── Report Generation ────────────────────────────────────────────────────

function buildEndpointCatalog(reports: ActionReport[]): EndpointEntry[] {
  const endpointMap = new Map<string, EndpointEntry>();

  for (const report of reports) {
    for (const req of report.requests) {
      const key = `${req.method} ${req.path}`;
      let entry = endpointMap.get(key);
      if (!entry) {
        entry = {
          method: req.method,
          path: req.path,
          seenInActions: [],
          responseStatuses: [],
          hasRequestBody: false,
          queryParamKeys: [],
        };
        endpointMap.set(key, entry);
      }

      if (!entry.seenInActions.includes(report.name)) {
        entry.seenInActions.push(report.name);
      }
      if (req.responseStatus !== null && !entry.responseStatuses.includes(req.responseStatus)) {
        entry.responseStatuses.push(req.responseStatus);
      }
      if (req.requestBody) {
        entry.hasRequestBody = true;
        if (!entry.sampleRequestBody) entry.sampleRequestBody = req.requestBody;
      }
      if (req.responseBody && !entry.sampleResponseBody) {
        entry.sampleResponseBody = req.responseBody;
      }
      for (const k of Object.keys(req.queryParams)) {
        if (!entry.queryParamKeys.includes(k)) {
          entry.queryParamKeys.push(k);
        }
      }
    }
  }

  const methodOrder: Record<string, number> = { POST: 0, PUT: 1, PATCH: 2, DELETE: 3, GET: 4 };
  return Array.from(endpointMap.values()).sort((a, b) => {
    const orderA = methodOrder[a.method] ?? 5;
    const orderB = methodOrder[b.method] ?? 5;
    if (orderA !== orderB) return orderA - orderB;
    return a.path.localeCompare(b.path);
  });
}

function printReport(reports: ActionReport[], catalog: EndpointEntry[], siteId: string, blogName: string, dryRun: boolean): void {
  const totalRequests = reports.reduce((sum, r) => sum + r.requests.length, 0);

  console.log('\n' + '='.repeat(70));
  console.log('  BLOG API DISCOVERY REPORT');
  console.log('='.repeat(70));
  console.log(`  Site:       ${siteId}`);
  console.log(`  Blog:       ${blogName}`);
  console.log(`  Dry run:    ${dryRun}`);
  console.log(`  Actions:    ${reports.length}`);
  console.log(`  Total API requests captured: ${totalRequests}`);

  console.log('\n' + '-'.repeat(70));
  console.log('  PER-ACTION CAPTURES');
  console.log('-'.repeat(70));

  for (const report of reports) {
    const status = report.error ? `ERROR: ${report.error}` : `${report.requests.length} requests`;
    console.log(`\n  ${report.label} [${report.name}] (${(report.durationMs / 1000).toFixed(1)}s) — ${status}`);

    const interesting = report.requests.filter(
      (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) || r.path.includes('/api/'),
    );
    for (const req of interesting) {
      const statusStr = req.responseStatus !== null ? `[${req.responseStatus}]` : '';
      const durStr = req.durationMs !== null ? `(${req.durationMs}ms)` : '';
      const bodyStr = req.requestBody ? ' [body]' : '';
      console.log(`    ${req.method.padEnd(7)} ${req.path} ${statusStr} ${durStr}${bodyStr}`);
    }
  }

  // Write operations summary
  const writeOps = catalog.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method));
  if (writeOps.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('  WRITE ENDPOINTS (most interesting for blog API implementation)');
    console.log('-'.repeat(70));

    for (const entry of writeOps) {
      const statuses = entry.responseStatuses.join(',');
      const params = entry.queryParamKeys.length > 0 ? ` ?${entry.queryParamKeys.join('&')}` : '';
      const actions = entry.seenInActions.join(', ');
      console.log(`\n    ${entry.method.padEnd(7)} ${entry.path}${params}`);
      console.log(`            status: ${statuses}  from: ${actions}`);

      if (entry.sampleRequestBody) {
        const bodyStr = JSON.stringify(entry.sampleRequestBody, null, 2);
        const truncated = bodyStr.length > 500 ? bodyStr.substring(0, 500) + '\n            ...' : bodyStr;
        console.log(`            request body:\n${truncated.split('\n').map((l) => '              ' + l).join('\n')}`);
      }
    }
  }

  console.log(`\n  Unique endpoints: ${catalog.length}`);
  console.log(`  Write endpoints: ${writeOps.length}`);
  console.log('='.repeat(70));
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const siteId = flags.site ?? 'tim-cox';
  const blogName = flags.blog ?? 'Blog';
  const dryRun = flags['dry-run'] === 'true';
  const headless = flags.headless === 'true';
  const keepPost = flags['keep-post'] === 'true';
  const actionFilter = flags.action ? flags.action.split(',') : null;

  if (actionFilter) {
    const invalid = actionFilter.filter((a) => !ACTION_NAMES.includes(a as ActionName));
    if (invalid.length > 0) {
      console.error(`Unknown action(s): ${invalid.join(', ')}`);
      console.error(`Available: ${ACTION_NAMES.join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`\n  Squarespace Blog API Discovery`);
  console.log(`  Site: ${siteId} | Blog: ${blogName} | Dry run: ${dryRun} | Keep post: ${keepPost}`);
  if (actionFilter) console.log(`  Actions: ${actionFilter.join(', ')}`);
  console.log('');

  const browserManager = getBrowserManager({ headless });

  try {
    await browserManager.initialize();
    await ensureLoggedIn(browserManager);
    const page = await browserManager.getPage();

    await discoverSites(page);
    const client = await resolveSite(siteId, page);
    console.log(`  Resolved site: ${client.name} (${client.site.adminUrl})\n`);

    await navigateToSite(page, client);

    const capture = new NetworkCapture(page, {
      includePatterns: [/.*/],
    });

    const actions = buildDiscoveryActions();
    const reports: ActionReport[] = [];
    const ctx: ActionContext = {
      siteSubdomain: client.site.adminUrl.match(/https:\/\/([^.]+)/)?.[1] ?? siteId,
      blogCollectionName: blogName,
    };

    for (const action of actions) {
      if (actionFilter && !actionFilter.includes(action.name)) continue;
      if (dryRun && action.mutating) {
        console.log(`  [SKIP] ${action.label} (mutating — dry-run mode)`);
        continue;
      }
      if (action.name === 'deletePost' && keepPost) {
        console.log(`  [SKIP] ${action.label} (--keep-post flag)`);
        continue;
      }

      console.log(`  [RUN]  ${action.label}`);
      capture.clear();
      await capture.start();
      const startMs = Date.now();

      try {
        await action.execute(page, ctx);
        capture.stop();
        const requests = capture.getCapturedRequests();
        const durationMs = Date.now() - startMs;

        // Try to extract IDs from captured requests
        extractIdsFromCaptures(requests, ctx);

        reports.push({ name: action.name, label: action.label, requests, durationMs });
        console.log(`         Captured ${requests.length} request(s) (${(durationMs / 1000).toFixed(1)}s)`);
      } catch (err) {
        capture.stop();
        const error = errMsg(err);
        const durationMs = Date.now() - startMs;

        // Still try to extract IDs
        extractIdsFromCaptures(capture.getCapturedRequests(), ctx);

        reports.push({
          name: action.name,
          label: action.label,
          requests: capture.getCapturedRequests(),
          error,
          durationMs,
        });
        console.log(`         ERROR: ${error}`);
      }
    }

    const catalog = buildEndpointCatalog(reports);

    // Save full capture to JSON
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = join(process.cwd(), 'data', `blog-api-discovery-${timestamp}.json`);

    const output = {
      capturedAt: new Date().toISOString(),
      siteId,
      blogName,
      dryRun,
      keepPost,
      crumbToken: capture.getCrumbToken(),
      context: {
        blogCollectionId: ctx.blogCollectionId ?? null,
        blogCollectionSlug: ctx.blogCollectionSlug ?? null,
        createdPostId: ctx.createdPostId ?? null,
        createdPostSlug: ctx.createdPostSlug ?? null,
      },
      summary: {
        totalActions: reports.length,
        totalRequests: reports.reduce((s, r) => s + r.requests.length, 0),
        uniqueEndpoints: catalog.length,
        writeEndpoints: catalog.filter((e) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method)).length,
        actionsWithErrors: reports.filter((r) => r.error).length,
      },
      endpointCatalog: catalog,
      actionReports: reports.map((r) => ({
        name: r.name,
        label: r.label,
        error: r.error ?? null,
        durationMs: r.durationMs,
        requestCount: r.requests.length,
        requests: r.requests,
      })),
    };

    await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\n  Full capture saved to: ${outputPath}`);

    printReport(reports, catalog, siteId, blogName, dryRun);

    await browserManager.saveSession();

    if (!headless) {
      console.log('\n  Browser is still open for inspection. Press Ctrl+C to close.\n');
      await new Promise(() => {});
    } else {
      await browserManager.close();
    }
  } catch (err) {
    console.error(`\n  Fatal error: ${errMsg(err)}\n`);
    await browserManager.close();
    process.exit(1);
  }
}

main();
