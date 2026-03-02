# MCP Phase 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add ~35 MCP tools, 6 agent prompts, and an orchestrator to complete the MCP autonomous agents system.

**Architecture:** Worktree agents implement tools (wave 1) and prompts+orchestrator (wave 2) in parallel. Each tool wraps ContentSaveClient methods behind Zod-validated MCP interfaces. The orchestrator chains 6 Claude CLI agents in a pipeline, gated by `USE_MCP_AGENTS` env flag.

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, Zod, vitest, Claude CLI

---

## Wave 1: MCP Tools (4 parallel worktree agents)

### Task 1: Text & Section Tools (Agent 1)

**Files:**
- Modify: `src/mcp-server/tools/text.ts` (add 6 tools)
- Modify: `src/mcp-server/tools/section.ts` (add 3 tools)
- Create: `src/mcp-server/__tests__/text-tools.test.ts`
- Create: `src/mcp-server/__tests__/section-tools.test.ts`

**Pattern:** Follow existing `sq_update_text` in `tools/text.ts`. Every tool:
1. Zod schema for inputs
2. Try/catch wrapper
3. Resolve page IDs via `resolvePageIds(siteId, pageSlug)` (null check → isError)
4. Get client via `getClient(siteId)`
5. Call ContentSaveClient method
6. Return JSON result or `{ isError: true }`

**Tools to add to `text.ts`:**

```typescript
// sq_update_html — raw HTML replacement
// Params: siteId, pageSlug, searchText, html
// Method: client.updateTextBlockHtml(psId, colId, searchText, html)

// sq_patch_text — surgical substring replacement (alias for sq_update_text mode=patch but simpler API)
// Params: siteId, pageSlug, searchText, newText
// Method: client.patchTextBlock(psId, colId, searchText, newText)

// sq_format_text — apply formatting to existing text
// Params: siteId, pageSlug, searchText, format: { tag?: 'h1'|'h2'|'h3'|'h4'|'p', alignment?: 'left'|'center'|'right', bold?: boolean, italic?: boolean }
// Method: 1. getPageSections → findBlock → get current HTML
//         2. client.formatHtml(currentHtml, format)
//         3. client.updateTextBlockHtml(psId, colId, searchText, formattedHtml)

// sq_add_text — add new text block to section
// Params: siteId, pageSlug, sectionIndex, html, layout?: { columns?, gapRows?, rowHeight? }
// Method: client.addTextBlock(psId, colId, sectionIndex, html, layout)

// sq_update_footer_text — edit footer text
// Params: siteId, searchText, newText
// Method: client.patchFooterTextBlock(searchText, newText)
// NOTE: No pageSlug needed — footer is site-wide. Only needs getClient(siteId).

// sq_update_header_text — edit header text
// Params: siteId, searchText, newText
// Method: client.patchHeaderTextBlock(searchText, newText)
// NOTE: No pageSlug needed — header is site-wide.
```

**Tools to add to `section.ts`:**

```typescript
// sq_edit_section_style — change section theme/height/width/alignment
// Params: siteId, pageSlug, sectionSearch (text or "section 0"), styles: { sectionTheme?, sectionHeight?, contentWidth?, verticalAlignment? }
// Method: client.editSectionStyle(psId, colId, sectionSearch, styles)

// sq_move_section — reorder section up or down
// Params: siteId, pageSlug, sectionSearch, direction: 'up'|'down'
// Method: client.moveSection(psId, colId, sectionSearch, direction)

// sq_duplicate_section — duplicate a section
// Params: siteId, pageSlug, sectionSearch
// Method: client.duplicateSection(psId, colId, sectionSearch)
```

**Test pattern** (from existing `tools.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock session before importing tools
vi.mock('../session.js', () => ({
  getClient: vi.fn(),
  getMediaClient: vi.fn(),
  resolvePageIds: vi.fn(),
}));

import { getClient, resolvePageIds } from '../session.js';

// Create a mock server that captures tool registrations
function createMockServer() {
  const tools = new Map<string, { schema: any; handler: Function }>();
  return {
    registerTool: (name: string, opts: any, handler: Function) => {
      tools.set(name, { schema: opts, handler });
    },
    callTool: async (name: string, params: any) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(params);
    },
    tools,
  };
}

// Test each tool for success + error cases
describe('sq_update_html', () => {
  it('updates text block with raw HTML', async () => {
    const mockClient = { updateTextBlockHtml: vi.fn().mockResolvedValue({ success: true, blockId: 'block-1' }) };
    (getClient as any).mockReturnValue(mockClient);
    (resolvePageIds as any).mockResolvedValue({ pageSectionsId: 'ps1', collectionId: 'col1' });

    const server = createMockServer();
    registerTextTools(server as any);
    const result = await server.callTool('sq_update_html', { siteId: 'test', pageSlug: 'home', searchText: 'old', html: '<h1>New</h1>' });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).success).toBe(true);
    expect(mockClient.updateTextBlockHtml).toHaveBeenCalledWith('ps1', 'col1', 'old', '<h1>New</h1>');
  });

  it('returns error when page not found', async () => {
    (resolvePageIds as any).mockResolvedValue(null);
    const server = createMockServer();
    registerTextTools(server as any);
    const result = await server.callTool('sq_update_html', { siteId: 'test', pageSlug: 'missing', searchText: 'x', html: 'y' });
    expect(result.isError).toBe(true);
  });
});
```

**Step 1:** Add 6 tools to `text.ts` following the pattern above.
**Step 2:** Add 3 tools to `section.ts` following the pattern above.
**Step 3:** Write tests for all 9 new tools (success + error per tool = 18 tests minimum).
**Step 4:** Run `npx vitest run src/mcp-server/__tests__/text-tools.test.ts src/mcp-server/__tests__/section-tools.test.ts`.
**Step 5:** Commit: `feat(mcp): add text and section tools (9 tools)`

---

### Task 2: Block Management Tools (Agent 2)

**Files:**
- Create: `src/mcp-server/tools/blocks.ts`
- Create: `src/mcp-server/__tests__/block-tools.test.ts`

**Tools (10):**

```typescript
// sq_add_button — add button block
// Params: siteId, pageSlug, sectionIndex: number, label: string, url: string,
//         design?: { size?: 'small'|'medium'|'large', style?: 'primary'|'secondary'|'tertiary',
//                    alignment?: 'left'|'center'|'right', variant?: 'solid'|'outline' }
// Method: client.addButtonBlock(psId, colId, sectionIndex, label, url, undefined, design)

// sq_update_button — update existing button
// Params: siteId, pageSlug, searchText: string,
//         label?: string, url?: string,
//         design?: { size?, style?, alignment?, variant? }
// Method: client.updateButtonBlock(psId, colId, searchText, { label, url, ...design })

// sq_add_image — add image block to section
// Params: siteId, pageSlug, sectionIndex: number, assetUrl: string, altText?: string, layout?: { columns? }
// Method: client.addImageBlock(psId, colId, sectionIndex, assetUrl, { altText, layout })

// sq_update_image — update image block metadata or asset
// Params: siteId, pageSlug, searchText: string, assetUrl?: string, altText?: string, title?: string
// Method: client.updateImageBlock(psId, colId, searchText, { assetUrl, altText, title })

// sq_upload_image — upload image from URL, returns assetUrl for use with sq_add_image
// Params: siteId, imageUrl: string
// Method: const mediaClient = getMediaClient(siteId);
//         mediaClient.uploadImage(imageUrl)
// NOTE: No pageSlug needed. Returns { assetUrl } on success.

// sq_remove_block — remove a block by search text
// Params: siteId, pageSlug, searchText
// Method: client.removeBlock(psId, colId, searchText)

// sq_move_block — move block in grid
// Params: siteId, pageSlug, searchText, direction: 'up'|'down'|'left'|'right', gridSteps?: number
// Method: client.moveBlock(psId, colId, searchText, direction, gridSteps)

// sq_resize_block — resize block in grid
// Params: siteId, pageSlug, searchText, width?: 'smaller'|'larger'|'full', height?: 'shorter'|'taller'
// Method: client.resizeBlock(psId, colId, searchText, width, height)

// sq_swap_blocks — swap positions of two blocks
// Params: siteId, pageSlug, searchText1, searchText2
// Method: client.swapBlocks(psId, colId, searchText1, searchText2)

// sq_duplicate_block — duplicate a block
// Params: siteId, pageSlug, searchText
// Method: client.duplicateBlock(psId, colId, searchText)
```

**Registration function:** `export function registerBlockTools(server: McpServer)`

**Step 1:** Create `blocks.ts` with all 10 tools.
**Step 2:** Write tests (20+ tests: success + error per tool).
**Step 3:** Run tests.
**Step 4:** Commit: `feat(mcp): add block management tools (10 tools)`

---

### Task 3: Pages & Site-wide Tools (Agent 3)

**Files:**
- Create: `src/mcp-server/tools/pages.ts`
- Create: `src/mcp-server/tools/site.ts`
- Create: `src/mcp-server/__tests__/page-tools.test.ts`
- Create: `src/mcp-server/__tests__/site-tools.test.ts`

**Page tools (6):**

```typescript
// sq_create_page — create new page
// Params: siteId, title: string, slug?: string, pageType?: 'page'|'blog'
// Method: client.createPageViaApi(title, slug, { pageType })
// NOTE: No pageSlug needed for resolvePageIds — this creates a new page.
//       Only needs getClient(siteId).

// sq_delete_page — delete page by collectionId
// Params: siteId, collectionId: string
// Method: client.deletePageViaApi(collectionId)
// NOTE: No pageSlug/resolvePageIds needed.

// sq_list_pages — list all pages/collections
// Params: siteId
// Method: client.listCollections()
// Returns: array of { id, urlId, title, type, typeName, itemCount }

// sq_get_navigation — get navigation structure
// Params: siteId
// Method: client.getNavigation()

// sq_update_navigation — reorder/update navigation
// Params: siteId, fieldName: string ('mainNav' or '_hidden'), items: array
// Method: client.updateNavigation(fieldName, items)

// sq_update_page_metadata — update SEO title/description/keywords
// Params: siteId, pageSlug, seoTitle?: string, seoDescription?: string, keywords?: string
// Method: First resolve collectionId via resolvePageIds, then
//         client.updatePageMetadata(collectionId, { seoTitle, seoDescription, keywords })
// NOTE: updatePageMetadata takes collectionId, not pageSectionsId
```

**Site-wide tools (7):**

```typescript
// sq_get_settings — read site settings
// Params: siteId
// Method: client.getSettings()

// sq_update_settings — write site settings (partial update)
// Params: siteId, updates: Record<string, unknown>
// Method: client.updateSettings(updates)

// sq_get_design — read fonts + colors + tweaks (combined read)
// Params: siteId
// Method: Promise.all([client.getWebsiteFonts(), client.getWebsiteColors(), client.getTemplateTweakSettings()])
// Returns combined { fonts, colors, tweaks }

// sq_update_design — update fonts, colors, and/or tweaks
// Params: siteId,
//         font?: { fontName: string, updates: { fontFamily?, fontWeight?, fontStyle?, textTransform?, letterSpacing?, lineHeight? } },
//         color?: { colorId: string, hsl: { hue: number, saturation: number, lightness: number } },
//         tweaks?: Record<string, unknown>
// Method: Sequential calls to updateFont/updatePaletteColor/setTemplateTweakSettings for each present field

// sq_get_code_injection — read header/footer code injection
// Params: siteId
// Method: client.getCodeInjection()

// sq_update_code_injection — save header/footer scripts
// Params: siteId, header?: string, footer?: string
// Method: client.saveCodeInjection(header, footer)

// sq_update_css — update custom CSS
// Params: siteId, css: string
// Method: client.saveCustomCSS(css)
```

**Step 1:** Create `pages.ts` with 6 tools.
**Step 2:** Create `site.ts` with 7 tools.
**Step 3:** Write tests for both files.
**Step 4:** Run tests.
**Step 5:** Commit: `feat(mcp): add page and site-wide tools (13 tools)`

---

### Task 4: Blog, Menu & Gallery Tools (Agent 4)

**Files:**
- Create: `src/mcp-server/tools/content.ts`
- Create: `src/mcp-server/__tests__/content-tools.test.ts`

**Tools (5):**

```typescript
// sq_create_blog_post — create a new blog post
// Params: siteId, collectionId: string, title: string, body?: string, tags?: string[], draft?: boolean
// Method: client.createBlogPost(collectionId, title, { content: body, tags, draft })
// NOTE: No pageSlug needed. collectionId identifies the blog collection.
//       Agent gets collectionId from sq_list_pages output (type 2 = blog).

// sq_update_blog_post — update existing blog post
// Params: siteId, collectionId: string, postId: string, title?: string, body?: string, tags?: string[], draft?: boolean
// Method: client.updateBlogPost(collectionId, postId, { title, content: body, tags, draft })

// sq_get_menu — read menu block data
// Params: siteId, pageSlug, searchText: string
// Method: client.getMenuBlock(psId, searchText)
// Returns: { menus: MenuTab[], menuStyle, currencySymbol }
// NOTE: getMenuBlock only takes pageSectionsId (not collectionId)

// sq_update_menu — update menu block
// Params: siteId, pageSlug, searchText: string, menus: MenuTab[] (JSON array), preserveRaw?: boolean
// Method: client.updateMenuBlock(psId, colId, searchText, menus, { preserveRaw })
// NOTE: menus is the full MenuTab[] structure. The agent builds this from sq_get_menu output.

// sq_update_gallery — update gallery display settings
// Params: siteId, pageSlug, searchText: string, settings: { thumbnailsPerRow?, aspectRatio?, lightbox?, design?, padding? }
// Method: client.updateGallerySettings(psId, colId, searchText, settings)
```

**Step 1:** Create `content.ts` with 5 tools.
**Step 2:** Write tests.
**Step 3:** Run tests.
**Step 4:** Commit: `feat(mcp): add blog, menu, and gallery tools (5 tools)`

---

### Task 5: Merge Wave 1 + Update index.ts

**Files:**
- Modify: `src/mcp-server/index.ts` (add 4 new import + register calls)

After all 4 agents complete, merge their changes and update `index.ts`:

```typescript
import { registerTextTools } from './tools/text.js';
import { registerBlockTools } from './tools/blocks.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { registerSectionTools } from './tools/section.js';
import { registerPageTools } from './tools/pages.js';
import { registerSiteTools } from './tools/site.js';
import { registerContentTools } from './tools/content.js';

registerTextTools(server);
registerBlockTools(server);
registerScreenshotTools(server);
registerSectionTools(server);
registerPageTools(server);
registerSiteTools(server);
registerContentTools(server);
```

**Step 1:** Copy files from worktrees to main.
**Step 2:** Update `index.ts` with new imports/registrations.
**Step 3:** Run full test suite: `npm run test`.
**Step 4:** Commit: `feat(mcp): register all Phase 2 tools in MCP server`

---

## Wave 2: Prompts & Orchestrator (3 parallel worktree agents)

### Task 6: Executor & Supervisor Prompts (Agent 5)

**Files:**
- Create: `src/orchestrator/prompts/executor.md`
- Create: `src/orchestrator/prompts/supervisor.md`

**executor.md (~500 lines):**

Structure:
```markdown
# Squarespace Executor Agent

You execute content operations on Squarespace websites using MCP tools.
You receive a plan (list of operations) and execute them in order using the available tools.

## Your Tools

You have access to ~40 MCP tools prefixed with `sq_`. Here is the complete reference:

### Reading
- `sq_read_page(siteId, pageSlug)` — read all sections/blocks from a page
- `sq_list_pages(siteId)` — list all pages/collections
- `sq_get_navigation(siteId)` — get navigation structure
- `sq_get_settings(siteId)` — read site settings
- `sq_get_design(siteId)` — read fonts, colors, and tweaks
- `sq_get_code_injection(siteId)` — read header/footer scripts
- `sq_get_menu(siteId, pageSlug, searchText)` — read menu block

### Text Editing
- `sq_update_text(siteId, pageSlug, searchText, newText, mode)` — update text (mode: patch or replace)
- `sq_update_html(siteId, pageSlug, searchText, html)` — update with raw HTML
- `sq_patch_text(siteId, pageSlug, searchText, newText)` — surgical substring replacement
- `sq_format_text(siteId, pageSlug, searchText, format)` — apply formatting (h1-h4, bold, italic, alignment)
- `sq_add_text(siteId, pageSlug, sectionIndex, html, layout?)` — add new text block
- `sq_update_footer_text(siteId, searchText, newText)` — edit footer text
- `sq_update_header_text(siteId, searchText, newText)` — edit header text

### Block Management
- `sq_add_button(siteId, pageSlug, sectionIndex, label, url, design?)` — add button block
- `sq_update_button(siteId, pageSlug, searchText, label?, url?, design?)` — update button
- `sq_add_image(siteId, pageSlug, sectionIndex, assetUrl, altText?, layout?)` — add image block
- `sq_update_image(siteId, pageSlug, searchText, assetUrl?, altText?, title?)` — update image
- `sq_upload_image(siteId, imageUrl)` — upload image, returns assetUrl
- `sq_remove_block(siteId, pageSlug, searchText)` — remove block
- `sq_move_block(siteId, pageSlug, searchText, direction, gridSteps?)` — move block in grid
- `sq_resize_block(siteId, pageSlug, searchText, width?, height?)` — resize block
- `sq_swap_blocks(siteId, pageSlug, searchText1, searchText2)` — swap two blocks
- `sq_duplicate_block(siteId, pageSlug, searchText)` — duplicate block

### Sections
- `sq_add_blank_section(siteId, pageSlug, position?)` — add blank section
- `sq_add_template_section(siteId, pageSlug, category, templateIndex, replacements?)` — add template section
- `sq_edit_section_style(siteId, pageSlug, sectionSearch, styles)` — change section styling
- `sq_move_section(siteId, pageSlug, sectionSearch, direction)` — reorder section
- `sq_duplicate_section(siteId, pageSlug, sectionSearch)` — duplicate section

### Pages & Navigation
- `sq_create_page(siteId, title, slug?, pageType?)` — create page
- `sq_delete_page(siteId, collectionId)` — delete page
- `sq_update_navigation(siteId, fieldName, items)` — reorder navigation
- `sq_update_page_metadata(siteId, pageSlug, seoTitle?, seoDescription?, keywords?)` — update SEO

### Site-wide
- `sq_update_settings(siteId, updates)` — update site settings
- `sq_update_design(siteId, font?, color?, tweaks?)` — update design
- `sq_update_code_injection(siteId, header?, footer?)` — update code injection
- `sq_update_css(siteId, css)` — update custom CSS

### Blog & Content
- `sq_create_blog_post(siteId, collectionId, title, body?, tags?, draft?)` — create blog post
- `sq_update_blog_post(siteId, collectionId, postId, title?, body?, tags?, draft?)` — update blog post
- `sq_update_menu(siteId, pageSlug, searchText, menus, preserveRaw?)` — update menu block
- `sq_update_gallery(siteId, pageSlug, searchText, settings)` — update gallery settings

## Execution Rules

1. **Read before write.** Always `sq_read_page` first to understand current state.
2. **Structural operations first.** Create pages, add sections, then fill content.
3. **Use patch mode for text.** Prefer `sq_patch_text` (surgical) over `sq_update_text mode=replace` (destructive).
4. **Upload before add.** To add an image: first `sq_upload_image` → get assetUrl → then `sq_add_image`.
5. **One operation at a time.** Execute each plan operation sequentially. Verify success before moving on.

## Grid System

Squarespace uses a 24-column desktop grid. Key rules:
- Blocks have `start` (inclusive) and `end` (exclusive) column positions
- Full width = columns 1-24 (start=1, end=25)
- Half width = 12 columns (e.g., start=1 end=13 for left, start=13 end=25 for right)
- Use `sq_move_block` and `sq_resize_block` to adjust layout after adding blocks

## Block Types Reference

| Type | Name | Search by |
|------|------|-----------|
| 2 | Text | text content (stripped HTML) |
| 18 | Menu | raw text, tab/section/item titles |
| 31 | Quote | text content |
| 46 | Button (legacy) | label text |
| 53 | Code | code content |
| 1337 | Multi (button/image/etc) | buttonText, buttonLink, altText, assetUrl |

## Critical Gotchas

1. **patchTextBlock is surgical, updateTextBlock is destructive.** Use patch unless you need full replacement.
2. **Buttons have TWO formats.** Type 46 (legacy: label/url) and type 1337 (new: buttonText/buttonLink + design fields). The update/add tools handle both transparently.
3. **Menu blocks are type 18.** Raw text must be regenerated when menus change — the `sq_update_menu` tool handles this automatically.
4. **Footer/header are site-wide.** Use `sq_update_footer_text`/`sq_update_header_text` — no page slug needed.
5. **Blog posts need collectionId.** Get it from `sq_list_pages` output (type 2 = blog collection).
6. **Section styling values get mapped.** Pass simplified values: "dark" not "dark-theme", "large" not "section-height--large". The tool maps them.
7. **Image upload returns assetUrl.** Always upload first, then use the returned assetUrl with sq_add_image or sq_update_image.

## BROWSER_FALLBACK Protocol

If a tool fails or the task requires something tools can't handle (interactive widgets, drag-and-drop, visual layout fine-tuning), emit a fallback marker:

```
BROWSER_FALLBACK: {"intent": "what you were trying to do", "actions": ["ui steps needed"], "reason": "why API tools failed"}
```

Then continue with the rest of the plan. The orchestrator will log these for future tool expansion.

## Output Format

After executing all operations, output a JSON summary:

```json
{
  "completed": ["operation descriptions..."],
  "failed": ["operation descriptions with error..."],
  "fallbacks": ["BROWSER_FALLBACK markers if any"]
}
```
```

**supervisor.md (~150 lines):**

Structure:
```markdown
# Squarespace Supervisor Agent

You verify that content operations were executed correctly on a Squarespace website.

## Your Tools

- `sq_read_page(siteId, pageSlug)` — read all sections/blocks from a page
- `sq_list_pages(siteId)` — list all pages/collections
- `sq_get_navigation(siteId)` — get navigation structure
- `sq_get_settings(siteId)` — read site settings
- `sq_get_design(siteId)` — read design settings

## Verification Process

1. Read the task description to understand what was requested.
2. Read the executor's result to understand what was attempted.
3. Use `sq_read_page` to check the current state of affected pages.
4. For each operation, verify the expected content/structure exists.
5. Output a verdict.

## Verification Checks

- **Text changes:** Read the page, find the block, verify text matches expected value.
- **New sections:** Count sections, verify new section exists at expected position.
- **New blocks:** Read section blocks, verify new block exists with correct content.
- **Removed blocks:** Verify block no longer appears in section.
- **Page creation:** Use `sq_list_pages` to verify new page exists.
- **Style changes:** Read section styles, verify theme/height/width match.
- **Navigation:** Use `sq_get_navigation` to verify page order.
- **Design:** Use `sq_get_design` to verify font/color changes.

## Output Format

Output a JSON verdict:

```json
{
  "verdict": "pass" | "fail" | "partial",
  "operationsVerified": 5,
  "operationsPassed": 4,
  "issues": ["Section 2 text still shows old content"],
  "suggestions": ["Retry sq_update_text for section 2 with exact HTML"]
}
```

## Rules

1. Be thorough — check every operation in the plan.
2. Be precise — compare actual content against expected, not just existence.
3. "partial" means some operations succeeded but not all.
4. Include specific, actionable suggestions for any failures.
```

**Step 1:** Write `executor.md` (~500 lines, full tool reference + rules + gotchas).
**Step 2:** Write `supervisor.md` (~150 lines, verification checklist + verdict format).
**Step 3:** Commit: `feat(mcp): add executor and supervisor agent prompts`

---

### Task 7: Classifier, Researcher, Analyst & Strategist Prompts (Agent 6)

**Files:**
- Create: `src/orchestrator/prompts/classifier.md`
- Create: `src/orchestrator/prompts/researcher.md`
- Create: `src/orchestrator/prompts/analyst.md`
- Create: `src/orchestrator/prompts/strategist.md`

**classifier.md (~100 lines):**

```markdown
# Squarespace Task Classifier

Classify incoming tasks as "simple" (direct API, ~2-3s) or "pipeline" (multi-agent, ~30-120s).

## Simple Edit Types (route: "simple")

These can be handled with a single API call:
1. text_replace — change specific text on a page
2. button_update — change button label or URL
3. menu_update — modify menu items
4. footer_edit — change footer text
5. header_edit — change header text
6. blog_post_create — create a new blog post
7. blog_post_update — update blog post content
8. image_replace — swap one image for another
9. code_injection — add/change header or footer scripts
10. css_edit — modify custom CSS
11. page_metadata — change SEO title/description
12. business_hours_update — update business hours
13. text_format — change heading level or text formatting
14. settings_update — update site identity (name, phone, etc.)

## Pipeline Tasks (route: "pipeline")

These need the full agent pipeline:
- Adding new sections or pages
- Multi-step content creation (research → write → add)
- Design changes (fonts, colors, layout)
- Complex restructuring (reorder pages, move sections)
- Tasks mentioning multiple pages
- Tasks requiring content generation ("write an about page")

## Output Format

```json
{
  "route": "simple" | "pipeline",
  "simpleEditType": "text_replace",  // only if route=simple
  "confidence": "high" | "medium" | "low",
  "reasoning": "Single text change on one page"
}
```

## Rules

1. When in doubt, classify as "pipeline" — it's safer to over-process than under-process.
2. Confidence "low" with route "simple" → treat as "pipeline".
3. If the task mentions more than one page → "pipeline".
4. If the task requires content generation → "pipeline".
```

**researcher.md (~50 lines):**

```markdown
# Squarespace Research Agent

Gather external information needed for content creation tasks.

## When You're Called

You receive a research query derived from a Squarespace editing task. The task may need:
- Business information (hours, location, services)
- Content from external URLs
- Industry-specific content (menu items, team bios, etc.)

## Process

1. Search the web for relevant information.
2. If URLs are provided, fetch and extract content.
3. Synthesize findings into structured output.

## Output Format

```json
{
  "findings": [
    { "topic": "business hours", "content": "Mon-Fri 9am-5pm", "source": "Google Business" },
    { "topic": "menu items", "content": "...", "source": "https://..." }
  ],
  "summary": "Brief synthesis of all findings",
  "confidence": "high" | "medium" | "low"
}
```

## Rules

1. Only report verifiable information with sources.
2. If you can't find reliable information, say so — don't fabricate content.
3. Keep findings concise and structured for downstream agents.
```

**analyst.md (~200 lines):**

Adapted from `squarespace-snapshot.md` + agent reference. Uses `sq_read_page`, `sq_list_pages`, `sq_get_navigation`, `sq_get_settings`, `sq_get_design` to understand current site state.

```markdown
# Squarespace Site Analyst

Analyze the current state of a Squarespace website before planning changes.

## Your Tools

- `sq_read_page(siteId, pageSlug)` — read page structure
- `sq_list_pages(siteId)` — list all pages
- `sq_get_navigation(siteId)` — get navigation order
- `sq_get_settings(siteId)` — read site settings
- `sq_get_design(siteId)` — read fonts/colors/tweaks

## Process

1. List all pages with `sq_list_pages` to understand site structure.
2. Read the target page(s) with `sq_read_page`.
3. If task involves navigation or site-wide changes, read navigation and settings.
4. If task involves design, read current design settings.

## Block Type Reference

[Include block type table from squarespace-snapshot.md]

## Output Format

```json
{
  "siteStructure": {
    "pages": [{ "slug": "home", "title": "Home", "type": "page", "sectionCount": 3 }],
    "navigation": ["home", "about", "contact"]
  },
  "targetPages": {
    "home": {
      "sections": [
        {
          "index": 0,
          "name": "Intro",
          "theme": "dark",
          "blocks": [
            { "type": 2, "text": "Welcome to Our Site" },
            { "type": 1337, "buttonText": "Learn More", "buttonLink": "/about" }
          ]
        }
      ]
    }
  },
  "currentDesign": { ... },  // if relevant
  "currentSettings": { ... }  // if relevant
}
```

## Rules

1. Only read pages relevant to the task — don't read every page.
2. Report block types and content accurately.
3. Note existing content that the task might conflict with or build upon.
```

**strategist.md (~400 lines):**

Adapted from `squarespace-create.md`, `squarespace-edit.md`, agent reference. Plans operations using the 23 operation types.

```markdown
# Squarespace Content Strategist

Generate an execution plan for modifying a Squarespace website.

## Your Tools (read-only)

- `sq_read_page(siteId, pageSlug)` — read page for planning
- `sq_list_pages(siteId)` — list pages
- `sq_get_navigation(siteId)` — check navigation
- `sq_get_design(siteId)` — check design state

## Input

You receive:
1. Task description (what the user wants)
2. Analyst output (current site state)
3. Research findings (external content, if any)

## Operation Types

[Include all 23 operation types with required fields — from formatOperationTypeReference()]

## Template Catalog

8 categories, 27 templates: Intro, About, Team, Contact, Services, Products, FAQs, Images.
Use `category` + `templateIndex` to reference templates.

## Content Strategy Routing

For each operation, choose one strategy:
- **template**: Use when a catalog template matches the content type. Preferred for standard layouts.
- **blank_api**: Use for text-heavy custom content. Add blank section, fill via API.
- **manual**: Use for interactive elements or complex layouts only.

## Output Format

```json
{
  "operations": [
    {
      "operationType": "add_section",
      "targetPage": "home",
      "contentStrategy": "template",
      "templateCategory": "About",
      "templateIndex": 0,
      "replacements": {
        "texts": [{ "searchText": "About Us", "newText": "Our Story" }],
        "removeBlocks": ["Learn More"]
      }
    }
  ]
}
```

## CRITICAL RULES

1. **ONLY do what was explicitly requested.** Do not add extra sections or content.
2. Structural operations first (create page, add sections), then content operations.
3. Reference existing sections by position/content — don't duplicate existing content.
4. For multi-section tasks (3+), the executor handles structural ops first, then content.
```

**Step 1:** Write all 4 prompt files.
**Step 2:** Commit: `feat(mcp): add classifier, researcher, analyst, and strategist prompts`

---

### Task 8: Orchestrator + Integration (Agent 7)

**Files:**
- Create: `src/orchestrator/orchestrator.ts`
- Modify: `src/services/conversation/execution.ts` (add MCP gate)
- Create: `src/orchestrator/__tests__/orchestrator.test.ts`

**`orchestrator.ts`:**

```typescript
import { runAgent, type AgentConfig, type AgentResult } from './cli-runner.js';
import { parseBrowserFallbacks, logBrowserFallback, type BrowserFallback } from './fallback-tracker.js';
import { dashboardEvents } from '../services/dashboard-events.js';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import type { Task } from '../models/task.js';
import type { Conversation } from '../models/conversation.js';
import { join } from 'path';

// ── Agent Configs ───────────────────────────────────────────────────────────

const MCP_CONFIG = join(process.cwd(), 'mcp-config.json');
const PROMPTS_DIR = join(process.cwd(), 'src', 'orchestrator', 'prompts');

const AGENT_CONFIGS: Record<string, Omit<AgentConfig, 'mcpConfig'>> = {
  classifier: {
    name: 'classifier',
    model: 'haiku',
    maxTurns: 1,
    systemPromptFile: join(PROMPTS_DIR, 'classifier.md'),
  },
  researcher: {
    name: 'researcher',
    model: 'haiku',
    maxTurns: 5,
    systemPromptFile: join(PROMPTS_DIR, 'researcher.md'),
  },
  analyst: {
    name: 'analyst',
    model: 'sonnet',
    maxTurns: 3,
    systemPromptFile: join(PROMPTS_DIR, 'analyst.md'),
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_list_pages',
      'mcp__squarespace__sq_get_navigation',
      'mcp__squarespace__sq_get_settings',
      'mcp__squarespace__sq_get_design',
      'mcp__squarespace__sq_take_screenshot',
    ],
  },
  strategist: {
    name: 'strategist',
    model: 'sonnet',
    maxTurns: 3,
    systemPromptFile: join(PROMPTS_DIR, 'strategist.md'),
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_list_pages',
      'mcp__squarespace__sq_get_navigation',
      'mcp__squarespace__sq_get_design',
    ],
  },
  executor: {
    name: 'executor',
    model: 'sonnet',
    maxTurns: 30,
    systemPromptFile: join(PROMPTS_DIR, 'executor.md'),
    allowedTools: ['mcp__squarespace__sq_*'],
  },
  supervisor: {
    name: 'supervisor',
    model: 'sonnet',
    maxTurns: 5,
    systemPromptFile: join(PROMPTS_DIR, 'supervisor.md'),
    allowedTools: [
      'mcp__squarespace__sq_read_page',
      'mcp__squarespace__sq_list_pages',
      'mcp__squarespace__sq_get_navigation',
      'mcp__squarespace__sq_get_settings',
      'mcp__squarespace__sq_get_design',
      'mcp__squarespace__sq_take_screenshot',
    ],
  },
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface OrchestratorResult {
  success: boolean;
  verdict?: { verdict: string; issues: string[]; suggestions: string[] };
  fallbacks: BrowserFallback[];
  agentCosts: Record<string, number>;
  totalCost: number;
}

// ── Helper ──────────────────────────────────────────────────────────────────

function agentConfig(name: string): AgentConfig {
  const base = AGENT_CONFIGS[name];
  if (!base) throw new Error(`Unknown agent: ${name}`);
  return { ...base, mcpConfig: MCP_CONFIG };
}

function emitActivity(taskId: string, agent: string, status: string) {
  dashboardEvents.emit('agent_activity', {
    taskId,
    agent,
    status,
    timestamp: new Date().toISOString(),
  });
}

// ── Classify ────────────────────────────────────────────────────────────────

async function classifyTask(task: Task): Promise<{ route: 'simple' | 'pipeline'; simpleEditType?: string }> {
  const input = `Classify this Squarespace editing task:\n\nSite: ${task.siteId}\nTask: ${task.description}`;

  try {
    const result = await runAgent(agentConfig('classifier'), input, { timeout: 30_000 });
    const parsed = JSON.parse(result.text);

    if (parsed.route === 'simple' && parsed.confidence !== 'low') {
      return { route: 'simple', simpleEditType: parsed.simpleEditType };
    }
    return { route: 'pipeline' };
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Classifier failed, defaulting to pipeline');
    return { route: 'pipeline' };
  }
}

// ── Pipeline ────────────────────────────────────────────────────────────────

export async function orchestrateTask(
  task: Task,
  conversation: Conversation,
): Promise<OrchestratorResult> {
  const agentCosts: Record<string, number> = {};
  const taskId = task.id;

  // 1. Classify
  emitActivity(taskId, 'classifier', 'started');
  const classification = await classifyTask(task);
  emitActivity(taskId, 'classifier', 'completed');

  if (classification.route === 'simple') {
    // TODO: Wire to existing simple-edit fast path
    // For now, fall through to pipeline
    logger.info({ taskId, type: classification.simpleEditType }, 'Simple edit detected (MCP pipeline not yet wired to fast path)');
  }

  // 2. Research (if task mentions URLs or needs external content)
  let research = '';
  const needsResearch = /https?:\/\/|research|look up|find out|what are/i.test(task.description);
  if (needsResearch) {
    emitActivity(taskId, 'researcher', 'started');
    try {
      const result = await runAgent(agentConfig('researcher'), task.description, {
        timeout: 60_000,
        onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
      });
      research = result.text;
      agentCosts.researcher = result.cost;
    } catch (err) {
      logger.warn({ error: errMsg(err) }, 'Researcher failed, continuing without research');
    }
    emitActivity(taskId, 'researcher', 'completed');
  }

  // 3. Analyze
  emitActivity(taskId, 'analyst', 'started');
  let analysis = '';
  try {
    const input = `Analyze site "${task.siteId}" for this task: ${task.description}\nTarget page: ${task.targetPage ?? 'home'}`;
    const result = await runAgent(agentConfig('analyst'), input, {
      timeout: 120_000,
      onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
    });
    analysis = result.text;
    agentCosts.analyst = result.cost;
  } catch (err) {
    logger.error({ error: errMsg(err) }, 'Analyst failed');
    return { success: false, fallbacks: [], agentCosts, totalCost: Object.values(agentCosts).reduce((a, b) => a + b, 0) };
  }
  emitActivity(taskId, 'analyst', 'completed');

  // 4. Strategize
  emitActivity(taskId, 'strategist', 'started');
  let plan = '';
  try {
    const input = [
      `Task: ${task.description}`,
      `Site: ${task.siteId}`,
      `Target page: ${task.targetPage ?? 'home'}`,
      `\n## Current Site Analysis\n${analysis}`,
      research ? `\n## Research Findings\n${research}` : '',
    ].join('\n');
    const result = await runAgent(agentConfig('strategist'), input, {
      timeout: 120_000,
      onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
    });
    plan = result.text;
    agentCosts.strategist = result.cost;
  } catch (err) {
    logger.error({ error: errMsg(err) }, 'Strategist failed');
    return { success: false, fallbacks: [], agentCosts, totalCost: Object.values(agentCosts).reduce((a, b) => a + b, 0) };
  }
  emitActivity(taskId, 'strategist', 'completed');

  // 5. Execute
  emitActivity(taskId, 'executor', 'started');
  let executorOutput = '';
  try {
    const input = [
      `Site: ${task.siteId}`,
      `\n## Plan\n${plan}`,
    ].join('\n');
    const result = await runAgent(agentConfig('executor'), input, {
      timeout: 300_000,
      onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
    });
    executorOutput = result.text;
    agentCosts.executor = result.cost;
  } catch (err) {
    logger.error({ error: errMsg(err) }, 'Executor failed');
    return { success: false, fallbacks: [], agentCosts, totalCost: Object.values(agentCosts).reduce((a, b) => a + b, 0) };
  }
  emitActivity(taskId, 'executor', 'completed');

  // 6. Track browser fallbacks
  const fallbacks = parseBrowserFallbacks(executorOutput);
  for (const fb of fallbacks) {
    logBrowserFallback(task.siteId, task.targetPage ?? null, fb, taskId);
  }

  // 7. Supervise
  emitActivity(taskId, 'supervisor', 'started');
  let verdict: OrchestratorResult['verdict'] | undefined;
  try {
    const input = [
      `Task: ${task.description}`,
      `Site: ${task.siteId}`,
      `Target page: ${task.targetPage ?? 'home'}`,
      `\n## Executor Result\n${executorOutput}`,
    ].join('\n');
    const result = await runAgent(agentConfig('supervisor'), input, {
      timeout: 120_000,
      onStep: (step) => dashboardEvents.emit('agent_step', { taskId, ...step }),
    });
    try {
      verdict = JSON.parse(result.text);
    } catch {
      verdict = { verdict: 'unknown', issues: ['Could not parse supervisor output'], suggestions: [] };
    }
    agentCosts.supervisor = result.cost;
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Supervisor failed, treating as unverified');
  }
  emitActivity(taskId, 'supervisor', 'completed');

  const totalCost = Object.values(agentCosts).reduce((a, b) => a + b, 0);
  const success = verdict?.verdict === 'pass' || verdict?.verdict === 'partial';

  logger.info({
    taskId,
    verdict: verdict?.verdict,
    fallbackCount: fallbacks.length,
    totalCost,
    agentCosts,
  }, 'MCP orchestration complete');

  return { success, verdict, fallbacks, agentCosts, totalCost };
}
```

**Integration in `execution.ts`:**

At the top of `executeTasks()`, before the existing execution logic:

```typescript
// MCP Agent Pipeline gate
if (process.env.USE_MCP_AGENTS === 'true') {
  const { orchestrateTask } = await import('../../orchestrator/orchestrator.js');
  // Run MCP pipeline for each task
  for (const taskId of expandedTaskIds) {
    const task = getTask(taskId);
    if (!task) continue;
    updateTaskStatus(taskId, 'executing');
    try {
      const result = await orchestrateTask(task, conversation);
      updateTaskStatus(taskId, result.success ? 'done' : 'failed');
      if (conversation.source !== 'dashboard') {
        await sendToTim(conversation.phoneNumber!,
          result.success
            ? `✅ Task completed: ${task.description}`
            : `❌ Task failed: ${result.verdict?.issues?.join(', ') ?? 'Unknown error'}`
        );
      }
    } catch (err) {
      updateTaskStatus(taskId, 'failed');
      logger.error({ taskId, error: errMsg(err) }, 'MCP orchestration error');
    }
  }
  return;
}
```

**Tests (`orchestrator.test.ts`):**

```typescript
// Mock runAgent, parseBrowserFallbacks, logBrowserFallback, dashboardEvents
// Test: classifyTask routes simple tasks correctly
// Test: orchestrateTask runs full pipeline for pipeline tasks
// Test: research is skipped when not needed
// Test: analyst failure aborts pipeline
// Test: executor fallbacks are logged
// Test: supervisor verdict is parsed
// Test: costs are aggregated
```

**Step 1:** Create `orchestrator.ts` with the full pipeline.
**Step 2:** Add the `USE_MCP_AGENTS` gate to `execution.ts`.
**Step 3:** Write orchestrator tests (mock all agent calls).
**Step 4:** Run tests.
**Step 5:** Commit: `feat(mcp): add orchestrator pipeline with USE_MCP_AGENTS gate`

---

### Task 9: Final Merge + Full Test

After all wave 2 agents complete:

**Step 1:** Copy all files from worktrees to main working directory.
**Step 2:** Update `index.ts` with tool registrations (if not done in Task 5).
**Step 3:** Run `npm run build` to verify TypeScript compilation.
**Step 4:** Run `npm run test` to verify all tests pass.
**Step 5:** Commit: `feat(mcp): complete Phase 2 — tools, prompts, orchestrator`
