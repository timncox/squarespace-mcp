/**
 * Squarespace MCP Server Entry Point
 *
 * Exposes Squarespace editing capabilities as MCP tools for autonomous
 * Claude CLI agents. Uses stdio transport for JSON-RPC communication.
 *
 * CRITICAL: Never use console.log — it corrupts JSON-RPC on stdout.
 * Use console.error for any debugging output.
 */

import { config } from 'dotenv';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

// Load .env from project root — works from both src/ and dist/
const __dirname = dirname(fileURLToPath(import.meta.url));
let projectRoot = __dirname;
while (projectRoot !== '/' && !existsSync(join(projectRoot, 'package.json'))) {
  projectRoot = dirname(projectRoot);
}
config({ path: join(projectRoot, '.env') });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerTextTools } from './tools/text.js';
import { registerSectionTools } from './tools/section.js';
import { registerBlockTools } from './tools/blocks.js';
import { registerPageTools } from './tools/pages.js';
import { registerSiteTools } from './tools/site.js';
import { registerContentTools } from './tools/content.js';
import { registerFormTools } from './tools/forms.js';
import { registerDividerTools } from './tools/divider.js';
import { registerLinkTools } from './tools/links.js';
import { registerAuthTools } from './tools/auth.js';
import { registerCommerceTools } from './tools/commerce.js';
import { registerAnnouncementBarTools } from './tools/announcement-bar.js';
import { registerPdfMenuTools } from './tools/pdf-menu.js';
import { registerGmailTools } from './tools/gmail.js';
import { registerSnapshotTools } from './tools/snapshot.js';
import { registerWaybackTools } from './tools/wayback.js';

// ── Server instructions — sent to Claude Desktop during MCP handshake ───────
const INSTRUCTIONS = `
# Squarespace MCP Server — Usage Guide

You have tools to edit Squarespace websites via the Content Save API. Here's how to use them effectively.

## Getting Started
1. Call sq_list_sites first to discover available sites and their IDs.
2. Call sq_list_pages to see all pages on a site.
3. Call sq_get_page_sections to inspect a page's current content before making changes.

## Known Limitations & Workarounds

### Page Creation — sq_create_page
Creates a new page and adds it to site navigation. Supports page type ("page" or "blog") and navigation placement ("mainNav" for visible, "_hidden" for not linked). After creation, use sq_add_section and content tools to build out the page.

### Page Deletion — sq_delete_page
Moves the page to the trash (~30 day retention) via the RemoveCollection API. Use sq_list_pages to find the collection ID, then call sq_delete_page with it.

### Sections — API-added sections can be wiped by the editor
If the user has the Squarespace editor open while you make API changes, their next save will overwrite your changes.
**Workaround:** Ask the user to close the Squarespace editor before you begin, or ask them to refresh after you finish.

### Adding new sections — use sq_add_section (not sq_add_blank_section)
Blank sections created via API may reject subsequent block insertions (500 errors). Use sq_add_section to create sections with initial content blocks atomically. This is the preferred approach for building new pages.

### Blog Posts — body is set via a follow-up update
The blog creation endpoint ignores the body field. sq_create_blog_post handles this automatically via a create-then-update pattern, but if the follow-up update fails (e.g. session expired), the post will be created with an empty body. Check the result for errors.

### Session Cookies
All API calls require valid Squarespace editor session cookies. If you get 401 or "session expired" errors, call sq_login to check session health. Use sq_login_browser to launch a visible Chromium browser — the user logs in manually and the tool automatically captures all cookies (including HTTP-only member-session) and saves the session.

## Content Editing Workflow
1. **Read first**: Always call sq_get_page_sections to see current content before editing.
2. **Edit specifically**: Use sq_update_text for text changes, sq_update_image for images, etc.
3. **Verify**: Call sq_get_page_sections after changes to confirm the result looks correct.

## Grid System
Squarespace uses a 24-column desktop grid. Coordinates: X ranges 1-24, start is inclusive, end is exclusive. Mobile layout auto-reflows from desktop — you only control desktop positioning.

## Forms & Contact Pages
When the user wants a contact form, inquiry form, or any form that collects user input:
1. Call sq_list_forms to discover available forms on the site.
2. **If NO forms exist:** Use sq_create_form to create a default contact form (Name, Email, Message). It returns a formId.
3. Use sq_add_form_block with the formId to add the form to a page section.
4. Use offsetColumns and columns to center the form (e.g. offsetColumns: 4, columns: 16 for a centered form).
5. Customize the submit button with buttonVariant (primary/secondary/tertiary) and buttonAlignment (left/center/right).
6. Tell the user to set the recipient email in Squarespace Settings → Forms → Email Notification.

**Form CRUD tools:** sq_create_form (create), sq_get_form (read details), sq_update_form (update name/fields/button text).

**IMPORTANT:** Always use native Squarespace forms. Do NOT use sq_add_embed with third-party form services (FormSubmit, Typeform, Google Forms, etc.) — native forms match the site's design and handle email delivery automatically.

## Building a New Page
When the user asks you to create a new page (contact, about, services, etc.):
1. Use sq_create_page to create the page, or ask the user for the page slug if it already exists.
2. Use sq_add_section to create sections with initial content blocks (text, embed, button, image, video). This is preferred over sq_add_blank_section + separate block adds.
3. Use sq_add_template_section to add pre-designed template sections (call sq_list_section_templates to see available templates).
4. For contact pages, use sq_add_form_block to add a native Squarespace form (see "Forms & Contact Pages" above).
5. Use sq_update_text, sq_update_image to customize content after creation.
6. Call sq_get_page_sections to verify.

## Announcement Bar
- sq_get_announcement_bar — read current announcement bar state (enabled, text, URL)
- sq_update_announcement_bar — toggle visibility, change text, set click-through URL (all params optional, only provided fields change)
Note: Announcement bars are a paid feature (Business/Commerce plans).

## Map Blocks
- sq_add_map — add a map block by street address (auto-geocodes via OpenStreetMap). Supports zoom, style, labels, terrain options.
- sq_update_map — update an existing map block (new address, zoom, style, labels, terrain). Re-geocodes if address changes.

## Commerce (Products, Store Pages, Images)
Commerce tools use session cookies (same auth as all other tools — no separate API key needed).

### Store & Products
- sq_create_store_page — create a new store page on the site
- sq_list_products — list products in the store
- sq_get_product — get product details by ID
- sq_create_product — create a product (shell → images → update with details)
- sq_update_product — update product name, description, variants, visibility
- sq_delete_product — delete a product

### Product Images
- sq_attach_product_image — attach uploaded image to a product (use sq_upload_image first)
- sq_set_product_thumbnail — set a product's thumbnail image

## Image Uploads
sq_upload_image runs on the user's LOCAL machine. It accepts local file paths, HTTP/HTTPS URLs, and base64-encoded image data.

### Claude Desktop (default)
The MCP server runs on the same machine as the user. ALWAYS use local file paths or URLs — never base64.
Ask for the full path (e.g. /Users/tim/Downloads/photo.jpg) and pass directly via the imageUrl parameter.

### Claude.ai web (only)
Files uploaded to the conversation live at /mnt/user-data/ in a cloud container the MCP server cannot access.
ONLY in this case: read the file, base64 encode it, and pass to sq_upload_image via the imageData parameter.
Do NOT ask the user for help — handle the bridging silently.

### NEVER do
- Use base64 in Claude Desktop — always use file paths or URLs
- Ask the user to re-upload, save locally, or provide a URL when you already have the file
`.trim();

const server = new McpServer(
  { name: 'squarespace', version: '1.0.0' },
  { instructions: INSTRUCTIONS },
);

registerTextTools(server);
registerSectionTools(server);
registerBlockTools(server);
registerPageTools(server);
registerSiteTools(server);
registerContentTools(server);
registerFormTools(server);
registerDividerTools(server);
registerLinkTools(server);
registerAuthTools(server);
registerCommerceTools(server);
registerAnnouncementBarTools(server);
registerPdfMenuTools(server);
registerGmailTools(server);
registerSnapshotTools(server);
registerWaybackTools(server);

// ── MCP Prompts — on-demand guidance Claude Desktop can invoke ───────────────
server.registerPrompt('squarespace-guide', {
  description: 'Get guidance on how to accomplish common Squarespace editing tasks using the available tools.',
  argsSchema: {
    task: z.string().describe('What you want to do (e.g. "create a contact page", "add a blog post", "update the menu")'),
  },
}, async ({ task }) => {
  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `You are using the Squarespace MCP server. Here is guidance for the task: "${task}"

## Available Tool Categories

### Discovery (always start here)
- sq_list_sites — discover available sites
- sq_list_pages — list all pages on a site
- sq_get_page_sections — read a page's current sections and blocks
- sq_list_section_templates — browse available section templates

### Text & Content
- sq_update_text — update text block HTML content (find block by text search)
- sq_add_text_block — add a new text block with grid positioning

### Images
- sq_update_image — update image block (title, description, altText, assetUrl)
- sq_add_image — add a new image block
- sq_upload_image — upload an image file, returns CDN URL

### Buttons
- sq_update_button — update button text and link
- sq_add_button — add a new button block

### Video & Embeds
- sq_add_video — add a video block (YouTube, Vimeo URL). Supports layout with offsetColumns for positioning.
- sq_update_video — update video URL, title, or description
- sq_add_embed — add raw HTML embed block (iframes, Google Maps, Calendly, scripts)
- sq_update_embed — update embed block HTML content

### Sections
- sq_add_section — add a template section to a page
- sq_move_section — reorder sections on a page
- sq_remove_section — remove a section

### Pages
- sq_create_page — create a new page or blog collection
- sq_delete_page — delete a page (⚠️ BEST-EFFORT)
- sq_update_page_metadata — update SEO title, description, nav title

### Blog Posts
- sq_create_blog_post — create post (body set via follow-up update)
- sq_update_blog_post — update post title, body, tags, excerpt, categories
- sq_list_blog_posts — list posts in a blog collection
- sq_find_blog_post — find post by title

### Forms & Contact Pages
- sq_list_forms — discover available forms on a site (call first to get formId)
- sq_create_form — create a new form (default: contact form with Name, Email, Message)
- sq_get_form — get full form details by ID (fields, connected backends)
- sq_update_form — update form name, fields, or submit button text
- sq_add_form_block — add a native Squarespace form block to a section (contact forms, inquiry forms, etc.)
- sq_update_form_block — update form button appearance or lightbox setting
**IMPORTANT:** Always use these native form tools instead of sq_add_embed for contact/inquiry forms. Native forms match the site design and handle email delivery automatically.

### Menus
- sq_get_menu — read menu block data
- sq_update_menu — update menu block (full MenuTab[] JSON)

### Navigation & Site Settings
- sq_get_navigation — get site nav structure
- sq_update_navigation — reorder nav items
- sq_get_site_settings — read site settings
- sq_get_code_injection — read header/footer code injection
- sq_save_code_injection — update code injection

### Layout
- sq_move_block — move a block's grid position
- sq_resize_block — resize a block
- sq_swap_blocks — swap two blocks' positions
- sq_remove_block — remove a block
- sq_duplicate_block — duplicate a block
- sq_duplicate_section — duplicate a section

### Announcement Bar
- sq_get_announcement_bar — read announcement bar state
- sq_update_announcement_bar — toggle, change text, set URL

### Map Blocks
- sq_add_map — add map block by street address (auto-geocodes)
- sq_update_map — update map block (address, zoom, style, labels, terrain)

### Commerce (Products, Store Pages, Images)
Uses session cookies (same auth as all other tools — no separate API key needed).

- sq_create_store_page — create a new store page
- sq_list_products — list products in the store
- sq_get_product — get product details by ID
- sq_create_product — create product (shell → images → update with details)
- sq_update_product — update product name, description, variants, visibility
- sq_delete_product — delete a product
- sq_attach_product_image — attach uploaded image to product
- sq_set_product_thumbnail — set product thumbnail image

## Key Workarounds

**Creating a new page:** sq_create_page usually fails (404). Instead, ask the user to create a blank page in Squarespace (Pages → + → Blank Page), then build it out with sq_add_section, sq_add_text_block, etc.

**Deleting a page:** sq_delete_page moves the page to trash. Use sq_list_pages to get the collection ID.

**Blog post body:** The create endpoint ignores body — sq_create_blog_post handles this via create-then-update, but check the result for errors.

**Adding a contact form:** Use sq_list_forms → if no forms exist, sq_create_form → sq_add_form_block. The full flow is automated — no need to ask the user to create forms manually. NEVER use sq_add_embed with third-party form services as a workaround.

**Always read before writing:** Call sq_get_page_sections before making changes so you understand the current structure.

**Always verify:** Call sq_get_page_sections after changes to confirm the result.`,
      },
    }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Squarespace MCP server started');
