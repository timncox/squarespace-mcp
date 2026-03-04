/**
 * Squarespace MCP Server Entry Point
 *
 * Exposes Squarespace editing capabilities as MCP tools for autonomous
 * Claude CLI agents. Uses stdio transport for JSON-RPC communication.
 *
 * CRITICAL: Never use console.log — it corrupts JSON-RPC on stdout.
 * Use console.error for any debugging output.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerTextTools } from './tools/text.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { registerSectionTools } from './tools/section.js';
import { registerBlockTools } from './tools/blocks.js';
import { registerPageTools } from './tools/pages.js';
import { registerSiteTools } from './tools/site.js';
import { registerContentTools } from './tools/content.js';
import { registerWebSearchTools } from './tools/web-search.js';

// ── Server instructions — sent to Claude Desktop during MCP handshake ───────
const INSTRUCTIONS = `
# Squarespace MCP Server — Usage Guide

You have tools to edit Squarespace websites via the Content Save API. Here's how to use them effectively.

## Getting Started
1. Call sq_list_sites first to discover available sites and their IDs.
2. Call sq_list_pages to see all pages on a site.
3. Call sq_get_page_sections to inspect a page's current content before making changes.
4. Use sq_take_screenshot to visually verify the result after edits.

## Known Limitations & Workarounds

### Page Creation — sq_create_page often fails
The Squarespace API does not reliably support page creation. The endpoint returns 404 on most site templates/versions.
**Workaround:** Ask the user to create a blank page in the Squarespace editor (Pages → + → Blank Page), then use sq_add_section, sq_add_text_block, sq_add_button, sq_add_image, etc. to build out the content.

### Page Deletion — sq_delete_page is best-effort
The DELETE collections endpoint returns 404 on most sites. The tool falls back to hiding the page from navigation, but cannot fully delete it.
**Workaround:** Ask the user to delete the page manually in Squarespace.

### Sections — API-added sections can be wiped by the editor
If the user has the Squarespace editor open while you make API changes, their next save will overwrite your changes.
**Workaround:** Ask the user to close the Squarespace editor before you begin, or ask them to refresh after you finish.

### Blog Posts — body is set via a follow-up update
The blog creation endpoint ignores the body field. sq_create_blog_post handles this automatically via a create-then-update pattern, but if the follow-up update fails (e.g. session expired), the post will be created with an empty body. Check the result for errors.

### Session Cookies
All API calls require valid Squarespace editor session cookies. If you get 401 or "session expired" errors, the session needs to be refreshed. Ask the user to log into Squarespace and re-export their session.

## Content Editing Workflow
1. **Read first**: Always call sq_get_page_sections to see current content before editing.
2. **Edit specifically**: Use sq_update_text for text changes, sq_update_image for images, etc.
3. **Verify**: Call sq_take_screenshot after changes to confirm the result looks correct.

## Grid System
Squarespace uses a 24-column desktop grid. Coordinates: X ranges 1-24, start is inclusive, end is exclusive. Mobile layout auto-reflows from desktop — you only control desktop positioning.

## Building a New Page
When the user asks you to create a new page (contact, about, services, etc.):
1. Ask the user to create a blank page in Squarespace and tell you the page slug.
2. Use sq_add_section to add template sections (call sq_list_section_templates to see available templates).
3. Use sq_add_text_block, sq_add_button, sq_add_image, sq_add_video, sq_add_embed to add content blocks.
4. Use sq_update_text, sq_update_image to customize content.
5. Screenshot to verify.
`.trim();

const server = new McpServer(
  { name: 'squarespace', version: '1.0.0' },
  { instructions: INSTRUCTIONS },
);

registerTextTools(server);
registerScreenshotTools(server);
registerSectionTools(server);
registerBlockTools(server);
registerPageTools(server);
registerSiteTools(server);
registerContentTools(server);
registerWebSearchTools(server);

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
- sq_take_screenshot — visually verify changes

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
- sq_create_page — create a new page (⚠️ OFTEN FAILS — see workaround below)
- sq_delete_page — delete a page (⚠️ BEST-EFFORT)
- sq_update_page_metadata — update SEO title, description, nav title

### Blog Posts
- sq_create_blog_post — create post (body set via follow-up update)
- sq_update_blog_post — update post title, body, tags, excerpt, categories
- sq_list_blog_posts — list posts in a blog collection
- sq_find_blog_post — find post by title

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

## Key Workarounds

**Creating a new page:** sq_create_page usually fails (404). Instead, ask the user to create a blank page in Squarespace (Pages → + → Blank Page), then build it out with sq_add_section, sq_add_text_block, etc.

**Deleting a page:** sq_delete_page is best-effort. If it fails, ask the user to delete it manually.

**Blog post body:** The create endpoint ignores body — sq_create_blog_post handles this via create-then-update, but check the result for errors.

**Always read before writing:** Call sq_get_page_sections before making changes so you understand the current structure.

**Always verify:** Call sq_take_screenshot after changes to confirm the result.`,
      },
    }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Squarespace MCP server started');
