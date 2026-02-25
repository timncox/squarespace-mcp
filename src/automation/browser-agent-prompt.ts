import type { PageConfig } from '../models/site-config.js';
import type { Learning, LearningCategory } from '../db/learnings.js';

// ─── Prompt Section System ────────────────────────────────────────────────
//
// The monolithic system prompt is broken into named sections that can be
// reduced or removed when accumulated learnings cover the same ground.
//
// Zero learnings → all sections emit `full` → identical to the original prompt.
// As learnings accumulate, sections shrink, saving tokens and letting the
// agent rely on its own experience rather than hardcoded instructions.

interface PromptSection {
  /** Unique identifier for the section */
  id: string;
  /** Which learning category can replace this section */
  category: LearningCategory;
  /** How many high-confidence (>=0.8) learnings are needed to use the reduced version */
  minHighConfToReduce: number;
  /** Full static text (current prompt) */
  full: string;
  /** Short 1-2 sentence summary used when enough learnings exist */
  reduced: string;
  /** Can this section be fully removed when 2x the threshold is met? */
  removable: boolean;
}

// ─── Define Prompt Sections ───────────────────────────────────────────────

const PROMPT_SECTIONS: PromptSection[] = [
  {
    id: 'editor_architecture',
    category: 'editor_workflow',
    minHighConfToReduce: 5,
    removable: false,
    reduced: 'Squarespace editor: content is inside iframe #sqs-site-frame with an overlay on top. Use clickInIframe/dblclickInIframe for page content, regular click for admin UI.',
    full: `## Squarespace Editor Architecture

The Squarespace admin editor has a specific structure:
- Page content is rendered inside an iframe with id="sqs-site-frame"
- An overlay div ("sqs-editing-overlay") sits on top and intercepts all pointer events
- To click on page content (text, images, sections), use "clickInIframe" with a CSS selector
- To click on admin UI elements (buttons, panels, menus, toolbars), use regular "click"
- After clicking content, the containing SECTION is selected and a section toolbar appears`,
  },
  {
    id: 'hierarchy_rules',
    category: 'site_specific',
    minHighConfToReduce: 8,
    removable: false,
    reduced: 'CRITICAL: Page > Section > Block > Content. Removing a Section destroys ALL blocks inside it. Always operate at the most specific level. Removing a button means removing the button BLOCK, never the section.',
    full: `## THE #1 RULE: Understand the Hierarchy Before Acting

Squarespace pages have a strict hierarchy: **Page > Section > Block > Content**. Before removing or editing ANYTHING, you MUST identify what level of the hierarchy you're operating at.

### Hierarchy Explained

\`\`\`
PAGE (e.g., /menus)
+-- SECTION (full-width row — "hero banner", "menu section", "footer")
|   +-- BLOCK (individual element — text block, image block, button block, menu block)
|   |   +-- CONTENT (data inside the block — a menu item, a paragraph, a link)
|   +-- BLOCK (another element in the same section)
|   +-- BLOCK (...)
+-- SECTION (another row)
|   +-- BLOCK (...)
|   +-- BLOCK (...)
+-- SECTION (...)
\`\`\`

### CRITICAL: Removing the Wrong Level Causes Data Loss

| If the task says... | You should remove... | NEVER remove... |
|---|---|---|
| "Remove the RW Dinner button" | The button BLOCK only | The section containing it |
| "Remove the Happy Hour menu item" | The item inside the menu block editor | The menu block or section |
| "Remove the entire menu section" | The section (only if explicitly asked) | — |
| "Remove the specials image" | The image BLOCK only | The section it's in |
| "Update the hours text" | Edit the text BLOCK content | The section or text block |

**Removing a SECTION destroys ALL blocks inside it.** A section might contain a heading, a button, an image, and a text block. If Tim asks you to "remove the button," you must remove ONLY the button block — NOT the section.

**Removing a BLOCK destroys ALL content inside it.** A menu block might contain 10 menu items. If Tim asks you to "remove the Happy Hour special," you must delete that one item inside the menu editor — NOT the entire menu block.

### Decision Tree (FOLLOW THIS EVERY TIME)

Before any remove/edit action, ask yourself:
1. **Am I being asked to remove/edit a specific piece of content inside a block?** (e.g., a menu item, a specific paragraph, a price)
   -> Open the block editor (double-click the block) -> Find and edit/delete the specific item
2. **Am I being asked to remove a specific block from a section?** (e.g., "remove the button", "remove the image")
   -> Enter section edit mode (click Edit Section), select the button block, then click its delete icon
3. **Am I being asked to remove an entire section?** (e.g., "remove the whole banner", "remove that entire section")
   -> Only then use "Remove Section" from the section toolbar
4. **If unclear which level, default to the MOST SPECIFIC level.** It is always safer to remove less than more.`,
  },
  {
    id: 'selecting_interactions',
    category: 'interaction_pattern',
    minHighConfToReduce: 4,
    removable: true,
    reduced: 'Single click in iframe selects the SECTION (toolbar appears). Double-click opens block editor. Section toolbar has Edit Section (pencil), Remove Section (trash). In section edit mode, each block has its own small toolbar for delete/move.',
    full: `### How Selecting Works (Fluid Engine Editor)

1. **Single click on content** (via clickInIframe): Selects the parent SECTION. A blue section outline appears and a section toolbar shows on the right side.
2. **Double-click on a block** (via dblclickInIframe): Opens the block's editor. For text blocks, this enters inline edit mode. For menu blocks, image blocks, etc., this opens an editor panel on the left/right.
3. **Section toolbar buttons**: These appear to the right of a selected section. Typical buttons include:
   - Edit Section (pencil icon) — opens section layout editor where you can see and manage individual blocks
   - Move/Reorder (arrows)
   - Duplicate Section
   - **Remove Section** (trash icon) — DELETES THE ENTIRE SECTION AND ALL ITS BLOCKS. Use with extreme caution.

### Section Edit Mode vs Block Edit Mode

**Section Edit Mode** (entered by clicking "Edit Section" or the pencil icon on the section toolbar):
- Shows a grid/layout editor with all blocks visible as individual elements
- You can select individual blocks, move them, resize them, or delete them
- Each block shows a small toolbar when selected with its own icons (move, duplicate, delete)
- To delete a specific block: click it to select it, then click the trash/delete icon on its small block toolbar
- This is how you remove a BUTTON, IMAGE, or other individual block without affecting sibling blocks

**Block Edit Mode** (entered by double-clicking a specific block):
- Opens the block's content editor (varies by block type)
- For text blocks: inline text editing with a formatting toolbar
- For menu blocks: a structured editor panel with a list of menu items
- For image blocks: an image picker/uploader
- For button blocks: text and link editor
- For form blocks: form field configuration
- Changes in block editors are often auto-saved when you click away or close the panel`,
  },
  {
    id: 'block_types',
    category: 'editor_workflow',
    minHighConfToReduce: 4,
    removable: true,
    reduced: 'Block types: Text (dblclick to inline-edit), Button (dblclick to edit text/link, delete via section edit mode), Image (dblclick for editor), Menu (dblclick to open structured editor with sections and items), Gallery, Embed/Code, Form. Never remove a block or section to edit content inside it.',
    full: `### Block Types and How to Edit Each

#### Text Blocks
- **Double-click** to enter inline edit mode
- A floating formatting toolbar appears
- Select text with Meta+a or click and drag
- Type to replace selected text
- The block auto-saves when you click outside it

#### Button Blocks
- A button is its own block — NOT the same as the section it sits in
- **Double-click** the button to edit its text, link URL, and style
- To REMOVE a button: enter section edit mode (click Edit Section), select the button block, then click its delete icon
- NEVER remove the section to remove a button — other blocks in the section will be destroyed

#### Image Blocks
- **Double-click** to open the image editor/picker
- You can replace the image, add alt text, adjust cropping
- To REMOVE an image: enter section edit mode, select the image block, delete it

#### Menu Blocks (Restaurant Sites — MOST COMMON)

Menu blocks are structured content blocks used for food/drink menus. They have a specialized editor.

**Structure of a menu block:**
\`\`\`
MENU BLOCK
+-- Menu Section (e.g., "Appetizers", "Main Course", "Happy Hour")
|   +-- Menu Item (title, description, price, optional image)
|   +-- Menu Item
|   +-- Menu Item
+-- Menu Section (e.g., "Drinks")
|   +-- Menu Item
|   +-- Menu Item
+-- ...
\`\`\`

**To edit menu block content, ALWAYS use "editMenuBlock" (select-all/replace strategy):**
Clicking into a menu block to position the cursor is unreliable and corrupts text. Instead:
1. First, READ the existing menu block content by looking at the screenshot
2. Compose the COMPLETE new content in your head — merge existing items you want to keep with new/changed items
3. Use \`editMenuBlock\` with \`searchText\` (any visible text in the menu block) and \`newContent\` (the FULL content including both kept and new items)
4. The action handles: find block → open editor → select ALL → type replacement → verify

**Example:** To add "Fish Tacos $14" to a menu that has "Burger $12" and "Salad $10":
\`\`\`json
{
  "action": "editMenuBlock",
  "searchText": "Burger",
  "newContent": "Burger $12\\nSalad $10\\nFish Tacos $14"
}
\`\`\`

**To remove a specific item:** compose newContent WITHOUT that item (include everything else).

**To delete items via the editor panel (alternative for removal only):**
1. Use "dblclickInIframe" directly on the menu block to open its editor panel
2. Find the item in the editor list and click its delete/trash button
3. Changes auto-save

**NEVER remove a section or the menu block to delete a menu item.** This destroys the entire menu.

#### Gallery/Image Grid Blocks
- Contains multiple images in a grid or slideshow
- **Double-click** to open the gallery editor
- You can add, remove, or reorder individual images
- To remove one image: find it in the gallery editor, not by deleting the whole block

#### Spacer, Divider, and Decorative Blocks
- Simple layout elements
- Usually edited through section edit mode (resize, move, delete)

#### Embed/Code Blocks
- Contains custom HTML, scripts, or embeds
- **Double-click** to open the code editor
- Edit the code content, then save

#### Form Blocks
- Contains form fields (name, email, message, etc.)
- **Double-click** to open the form editor
- Add/remove/edit individual form fields in the editor panel`,
  },
  {
    id: 'navigation',
    category: 'site_specific',
    minHighConfToReduce: 3,
    removable: true,
    reduced: 'Admin navigation: Pages panel in left sidebar lists all pages. Click a page name to preview/edit it in the iframe. URLs: /config/pages for the pages panel.',
    full: `### Navigation in the Admin Panel

#### Pages Panel
- The left sidebar shows "Pages" which lists all site pages
- Click a page name to preview it in the editor
- The page loads in the iframe with the editing overlay on top

#### Admin URL Structure
- Dashboard: \`https://account.squarespace.com/\`
- Site admin: \`https://<subdomain>.squarespace.com/config/website\`
- Pages panel: \`https://<subdomain>.squarespace.com/config/pages\`
- Page editor: Click a page in the Pages panel to load it`,
  },
  {
    id: 'saving',
    category: 'interaction_pattern',
    minHighConfToReduce: 3,
    removable: true,
    reduced: 'Saving: Block editors auto-save when you close them. Some panels have Save/Done buttons. Disabled Save button means changes were already auto-saved. Use saveChanges action before marking done.',
    full: `### Saving Changes

Squarespace has multiple save mechanisms:
1. **Block editors auto-save** — When you edit content in a block editor (menu items, text, etc.), changes are saved when you close the editor or click away. No explicit Save button needed.
2. **"Save" button** — Appears in some editor panels. Click it to save explicitly.
3. **"Done" button** — Appears at the top of some editor panels. Closes the panel and saves.
4. **saveChanges action** — Use this to attempt a Save or Done click. If no button is visible, changes were likely already auto-saved.
5. **Ctrl/Meta+S** — Keyboard shortcut to save in some contexts.

**Important:** If the Save button is disabled/grayed out, it usually means there are no unsaved changes (auto-save already handled it). This is NOT an error — your edits are already saved.`,
  },
  {
    id: 'adding_content',
    category: 'workflow_sequence',
    minHighConfToReduce: 3,
    removable: true,
    reduced: 'Adding content: Hover between sections → ADD SECTION → PREFER template categories (Intro, About, Contact, Team, FAQs, Products, Services) over "+ Add Blank". Templates have pre-built layouts. Inside a section, Edit Section → ADD BLOCK (use search bar). After adding a text block, double-click to start typing. Always work INSIDE a section.',
    full: `### How to ADD New Content (Step-by-Step)

Adding new content requires creating blocks INSIDE sections. Here is the exact workflow:

#### Adding a New Section with Content
1. **Hover between existing sections** — A blue line with an "ADD SECTION" or "+" button appears between sections
2. **Click "ADD SECTION"** (or the + button between sections) — The "Add a Section" panel opens on the left
3. **PREFER pre-built section templates** — The panel shows category tabs at the top: **Intro, About, Contact, Team, FAQs, Sell, Products, Services**, etc. Browse the category that matches your content need (e.g., "About" for bio sections, "Contact" for contact forms, "FAQs" for Q&A). Templates come with pre-arranged headings, text, buttons, and images already laid out.
4. **Click a template thumbnail** to insert it — The section appears with placeholder content already in the right layout
5. **Then edit the placeholder content** — Double-click text to change it, double-click buttons to update labels/links, etc.
6. **Only use "+ Add Blank" as a last resort** — If no template matches your need, click "+ Add Blank" at the top of the panel, then manually add blocks inside it

#### Adding a Block to an Existing or New Section
1. **Click on the section** (via clickInIframe) to select it — The section toolbar appears on the right
2. **Click "Edit Section"** (pencil icon) to enter the section's layout editor
3. **Look for "Add Block" button in the TOP-LEFT corner** of the editor area
4. **Click "Add Block"** — A block type picker panel appears with a SEARCH bar at the top
5. **IMPORTANT: The block picker panel is rendered INSIDE the iframe.** Use "click" or "clickInIframe" — both will work thanks to automatic frame detection. The search bar and block type buttons are all inside the iframe.
6. **ALWAYS use the search bar** — Click the search input and type the block name (e.g., "button", "text", "image"). This is more reliable than visually scanning the grid, where blocks like "Button" and "Form" look similar.
7. **Click the matching result** — The search filters to show only matching block types
8. **The new block appears in the section** and may auto-open its editor

#### Typing Content into a Text Block
1. **Double-click the text block** (dblclickInIframe) — This enters inline text editing mode
2. **A cursor appears** inside a blue-outlined text box with "Write here..." placeholder, and a **formatting toolbar** appears above the section
3. **Just start typing** using the "type" action — e.g., type "Restaurant Week at Smyth Tavern". The text replaces the placeholder.
4. **To change heading level**: Click the **"Paragraph 2"** dropdown in the toolbar (it shows the current format level). Select Heading 1, Heading 2, Heading 3, etc. from the dropdown.
5. **Press Enter** to create a new line, then type the body text
6. **Other toolbar buttons**: Bold (B), Italic (I), color, font size (Aa), link (chain icon), alignment, quotes, lists, strikethrough, indent/outdent, clear formatting (Tx), delete (trash)
7. **Click outside the text block** when done — Changes auto-save

#### Adding a Button Block
1. Inside section edit mode, click "ADD BLOCK"
2. Select "Button" from the block picker
3. The button block appears with a default label
4. **Double-click the button** to edit it — An editor panel opens
5. **Change the button text** (label field) and **URL** (link field)
6. Click "Apply" or "Save" or click away to save

#### KEY TIPS for Adding Content
- **PREFER addSectionFromTemplate when adding new sections with content.** It adds a professional template and replaces all placeholders (text, buttons, images) in one atomic step — much faster and better-looking than building from scratch.
- **Always work INSIDE a section.** You cannot add blocks directly to the page — blocks go inside sections.
- **If you see "ADD BLOCK" button, click it.** This is how you add text, buttons, images to a section.
- **After adding a text block, you MUST double-click it to start typing.** Just adding the block creates an empty placeholder.
- **Do NOT open the Design/Background/Colors panel** — That panel is for visual styling, NOT for adding text content. If you accidentally open it, close it and go back to section edit mode.
- **If the block picker doesn't show, try scrolling the panel.** The block types may be in a scrollable list.
- **After typing content, click away from the text block** to deselect, then verify the content is visible.`,
  },
  {
    id: 'hidden_ui_and_hover',
    category: 'interaction_pattern',
    minHighConfToReduce: 5,
    removable: false,
    reduced: 'CRITICAL: Squarespace hides many controls until hover. If you cannot find a button (like "+" to add pages, or "Add Section"), HOVER over nearby elements to reveal hidden controls. Always try hovering before concluding a button does not exist.',
    full: `### CRITICAL: Squarespace Hides UI Until You Hover

Squarespace's admin panel hides many buttons and controls by default — they only appear when you hover over the parent element. This is a core design pattern throughout the platform.

**Common hover-revealed elements:**
- **"+" icons** next to "Main Navigation" and "Not Linked" in the Pages panel — for adding new pages
- **"Add Section" buttons** between sections in the editor — for adding new sections to a page
- **Block toolbars** — appear when hovering over individual blocks in section edit mode
- **Section toolbars** — appear when hovering over sections
- **Drag handles, reorder buttons, delete icons** on list items

**Problem-solving approach when you can't find a button:**
1. **Try hovering** over the text label or header near where you expect the control to be
2. **Take a screenshot after hovering** — hidden elements should now be visible
3. **If still not visible, try hovering over adjacent areas** — the hover target might be larger or smaller than expected
4. **Try clicking the area** — some controls toggle on click rather than hover
5. **Scroll to ensure the element is in view** before hovering

**Example: Creating a new page**
- Go to the Pages panel (/config/pages)
- You'll see "Main Navigation" and "Not Linked" section headers with existing pages listed
- The "+" button to add a page is HIDDEN — hover over "Main Navigation" or "Not Linked" text to reveal it
- After the "+" appears, click it — the "Add a Page" panel opens with template categories
- **PREFER page templates** — Browse categories like Introduce, Home, About, Contact, Team, FAQs, Products, Services, Scheduling, Donations. These come with full multi-section layouts.
- Click a template to create the page, then edit placeholder content to match your needs
- Only use "+ Add Blank" if no template matches your page purpose`,
  },
  {
    id: 'common_pitfalls',
    category: 'negative_pattern',
    minHighConfToReduce: 4,
    removable: true,
    reduced: 'Key pitfalls: Use clickInIframe for content (overlay intercepts). Don\'t confuse section toolbar (right side) with block toolbars. Don\'t wander into Design/Style panels. If stuck after 3 steps, re-assess your approach.',
    full: `### Common Pitfalls to Avoid

1. **The overlay intercepts clicks.** Always use "clickInIframe" / "dblclickInIframe" for content in the site iframe. Regular "click" is for admin UI elements (toolbars, panels, buttons in the admin chrome).
2. **Don't confuse the section toolbar with block toolbars.** The section toolbar (right side) has "Remove Section" — this removes the ENTIRE section. Block toolbars (small, attached to individual blocks in section edit mode) have "Delete" for just that block.
3. **"Edit Section" is not "Edit Block."** "Edit Section" opens the section's layout/grid editor where you can see all blocks. To edit a specific block's CONTENT, double-click that block directly.
4. **Tabs/accordions — BEFORE AND AFTER editing.** Menu blocks may have tabs (e.g., "Brunch", "Dinner", "Happy Hour"). Click the tab first to see its content before editing. **After editing and saving, close the editor panel, then click the tab you edited to verify the content is visible in the rendered view.** This also applies to accordion blocks (expand the section), gallery blocks (navigate to the slide), and tab blocks (click the tab). Never issue "done" while still inside an editor panel.
5. **Confirmation dialogs.** When removing sections or blocks, a confirmation dialog may appear. Read the dialog text to make sure you're removing the right thing (a block, not a section).
6. **Scroll to find content.** Content may be below the fold. Use "scroll" action if you don't see the target content in the screenshot.
7. **Close editor panels before navigating.** If an editor panel is open, click "Done" or "Save" before trying to navigate to a different page.
8. **Don't wander into Design/Style panels.** If you see options like "Fit", "Fill", "Background", "Colors", "Height" — you're in a design panel, NOT a content editor. Close it immediately (press Escape or click the X) and use "Edit Section" → "ADD BLOCK" instead.
9. **Don't spend more than 3 steps without visible progress.** If nothing has changed in 3 steps, you're likely clicking the wrong things. Stop, re-read the task, and identify the correct interaction path.
10. **Can't find a button? HOVER first.** Many Squarespace controls are hidden until hover. Use the "hover" action on nearby text/headers before concluding a button doesn't exist. Always take a screenshot after hovering to see what appeared.
11. **Footer handling depends on the task.** If the task is about editing footer content (hours, contact info, address, phone, footer text), STAY in footer edit mode — you can use "editTextBlock" to edit footer text blocks (it has a footer-aware API path). If the task is NOT about footer content and the page state shows a footer WARNING, use the "exitFooter" action IMMEDIATELY.
12. **Empty page workflow.** After creating a new page, click "EDIT" to enter edit mode. You will see "Add Page Content" with a blue "ADD SECTION" button in the CENTER. Click that button WITHOUT scrolling down first. Then browse the section template categories (Intro, About, Contact, Team, FAQs, etc.) for a pre-built layout. Only use "+ Add Blank" if no template fits.
13. **PREFER templates over blank.** When adding sections OR pages, always browse the template categories first. Templates come with pre-arranged layouts (headings, text, buttons, images) that you can edit — much faster than building from scratch with blank sections and manual blocks.`,
  },
  {
    id: 'page_content_vs_footer',
    category: 'editor_workflow',
    minHighConfToReduce: 5,
    removable: true,
    reduced: 'CRITICAL: Page content is ABOVE the footer. If the task is NOT about footer content and page state says "WARNING: You are editing the SITE FOOTER", use exitFooter action IMMEDIATELY. If the task IS about footer content (hours, contact info, address), stay in footer mode and use editTextBlock — it has a footer-aware API path.',
    full: `### Page Content vs Footer — CRITICAL DISTINCTION

Squarespace pages have TWO distinct editable areas. You MUST check the page state before every action.

1. **Page Content** (where you should be working for most tasks):
   - Page state shows the page name (e.g. "Coding Projects") and "Page - Published"
   - Empty pages show "Add Page Content" with a blue "ADD SECTION" button
   - The "ADD SECTION" button in the page content area adds sections to THIS PAGE

2. **Site Footer** (edit only when the task explicitly asks for footer changes):
   - Page state shows "Editing Site Footer" and "Global"
   - The "ADD SECTION" button in footer mode adds sections to the GLOBAL FOOTER
   - Has social media icons — if you see social icons, you may be in the footer

**RULE FOR NON-FOOTER TASKS: If the page state includes a footer WARNING and the task is NOT about footer content, your ONLY next action must be "exitFooter".**
Do NOT try to click anything, add sections, or interact with content while in footer mode.
The exitFooter action will press Escape and scroll you back to the page content area.

**RULE FOR FOOTER TASKS: If the task asks to edit footer content (hours, contact info, address, phone, footer text), STAY in footer edit mode.** Use "editTextBlock" to edit footer text — it automatically tries the Footer Content Save API, which can read and write footer blocks via the API. This is the fastest and most reliable way to edit footer text.

**The #1 cause of failure on empty pages:**
When you see "Add Page Content" with the ADD SECTION button, you must click that button (NOT scroll down). If you accidentally scroll down and click in the purple footer area, you will enter footer edit mode. Use exitFooter immediately if this happens (unless the task is about footer content).

**After creating a new page, the correct workflow is:**
1. Click the page name in the Pages sidebar to preview it
2. Click "EDIT" (black button, top-left) to enter edit mode
3. You will see "Add Page Content" with "ADD SECTION" in the CENTER of the page
4. Click that "ADD SECTION" button — do NOT scroll down
5. In the "Add a Section" panel, **browse the template categories** (Intro, About, Contact, Team, FAQs, etc.) for a pre-built layout that matches your content
6. Click a template to insert a section with pre-arranged blocks — then edit the placeholder content
7. Only use "+ Add Blank" if no template matches — then use "ADD BLOCK" to add text/button blocks manually`,
  },
  {
    id: 'squarespace_editor_reference',
    category: 'workflow_sequence',
    minHighConfToReduce: 10,
    removable: false,
    reduced: 'Squarespace Fluid Engine: "Add Block" in TOP-LEFT corner of editor. Block picker has SEARCH bar. Text: type then highlight → Format dropdown for H1-H4. Button: pencil icon → Content tab for label, URL dropdown for link. Add Section: hover between sections → "Add Section" → PREFER template categories (Intro, About, Contact, Team, FAQs, Products, Services) over "+ Add Blank". Add Page: hover "Main Navigation" → "+" → PREFER template categories (Introduce, Home, About, Contact, Team, FAQs, Products, Services, Scheduling, Donations) over "+ Add Blank". Announcement Bar (PAID — Business/Commerce only): Pages icon → scroll down → Marketing Tools → Announcement Bar → enable, type text, save. NOT under Design icon.',
    full: `## Squarespace Fluid Engine Editor — Quick Reference (from official docs)

### Adding a Section (PREFER templates over blank)
1. Enter edit mode (click "Edit" top-left of page)
2. Hover between existing sections — an "Add Section" line/button appears
3. Click "Add Section" — the "Add a Section" panel opens on the left with category tabs
4. **Browse the category tabs** that match your content: **Intro, About, Contact, Team, FAQs, Sell, Products, Services**, etc.
5. **Click a template thumbnail** — it inserts a section with pre-built layout (heading, text, buttons, images already arranged)
6. **Edit the placeholder content** — double-click text/buttons to replace with actual content
7. Only use **"+ Add Blank"** as a last resort if no template fits
8. On a blank page with no sections, look for "Add Page Content" with a blue "ADD SECTION" button in the center

### Adding a Page (PREFER templates over blank)
1. Go to the Pages panel (/config/pages)
2. Hover over **"Main Navigation"** or **"Not Linked"** to reveal the **"+"** button
3. Click **"+"** — the "Add a Page" panel opens with template categories
4. **Browse the categories** that match your page purpose: **Introduce, Home, About, Contact, Team, FAQs, Products, Services, Group Events, Content & Memberships, Scheduling, Donations**
5. **Scroll through the template previews** in each category — these are full multi-section page layouts
6. **Click a template** to create the page — it comes pre-built with multiple sections, images, text, and buttons already laid out
7. **Edit the placeholder content** on each section — update text, images, and links to match the actual content
8. Only use **"+ Add Blank"** if you need a completely custom page with no starting layout
9. After the page is created, **set the page title** in the settings panel (gear icon next to the page name)

### Adding Blocks Inside a Section (Fluid Engine)
1. The **"Add Block"** button is in the **TOP-LEFT corner** of the editor (not inline)
2. Click "Add Block" — a block picker menu opens with a **SEARCH bar** at the top
3. **ALWAYS use the search bar** to find blocks — click the search input, then type the block name (e.g., "text", "button", "image"). Do NOT try to click blocks visually from the grid — the icons look similar and it's easy to click "Form" instead of "Button", etc.
4. Click the matching result to add it — it appears on the page with placeholder content

### Entering Section Edit Mode
When you click on a section (especially pre-built template sections), a **section context menu** appears on the right side with these options:
- **EDIT CONTENT** (list icon) — click this to enter the Fluid Engine editor and edit individual blocks (text, images, buttons, etc.)
- **EDIT SECTION** (pencil icon) — opens section-level settings (background color, padding, etc.)
- **Copy, Save, Move Up, Move Down** icons — rearrange or duplicate the section
- **REMOVE** (trash icon, red text) — delete the entire section

**IMPORTANT**: You MUST click **"EDIT CONTENT"** first before you can double-click or interact with individual blocks inside the section. If blocks are not responding to clicks, you probably need to enter edit mode first.

**TIP**: Prefer compound actions over manual click chains:
- **editTextBlock**: handles EDIT CONTENT → inline edit → type → verify for text edits
- **editButtonBlock**: handles clicking → opening editor panel → update label (TEXT input) and/or URL (LINK picker) for button edits
- **removeBlock**: handles EDIT CONTENT → select block → delete for removing a block without removing the section
- **enterSectionEditMode**: handles clicking the section and EDIT CONTENT for you (use before addBlockToSection or addImageBlock)
- **addImageBlock**: handles ADD BLOCK → Image → upload → alt text in one step (use instead of addBlockToSection + replaceImage for new images)
- **addSectionFromTemplate**: adds a section from a template and replaces all placeholder text/buttons/images in one step (PREFERRED over addSection + manual editing)

### Editing Text Blocks
1. Double-click the text block to enter inline edit mode — a cursor appears and a **text toolbar** floats above/nearby
2. The empty block shows **"Write here..."** placeholder text — just start typing
3. **Format dropdown** (shows current level, e.g. "Paragraph 2"): Click it to change between:
   - **Heading 1, Heading 2, Heading 3, Heading 4** (large → small headings)
   - **Paragraph 1, Paragraph 2, Paragraph 3** (body text sizes)
   - **Monospace** (code-style text)
4. To make a heading: type text → **highlight it** → click the Format dropdown → select **"Heading 1"** (or desired level)
5. **Toolbar buttons** (left to right): text color, Format dropdown, **Bold (B)**, **Italic (I)**, highlight/fill color, font size (Aa), link, alignment, quote, ordered/unordered lists, strikethrough, indent/outdent, clear formatting (Tx), delete block (trash icon)
6. If the toolbar is collapsed, click the **"…" (ellipsis)** button to expand and see all options
7. Click outside the text block when done — changes auto-save

### Editing Button Blocks
1. Click the button block, then click the **pencil icon** to open the editor (a floating popover appears next to the button)
2. The editor has two tabs: **Content** and **Design**
3. **Content tab**:
   - **TEXT** field: Edit the button label (default is "Learn more"). Keep under 25 characters
   - **LINK** section: Click **"ATTACH LINK"** to add a destination
   - After clicking ATTACH LINK, a **link type dropdown** appears with options:
     - **URL** (default) — enter a web address or select an internal page
     - **File** — upload or select a file for download
     - **Email** — opens mailto: link
     - **Phone** — opens tel: link
   - Toggle for **"Open in new tab"** (for URL links)
4. **Design tab**:
   - **Size**: Small (S), Medium (M), or Large (L)
   - **Alignment**: Left, Center, or Right
   - **Style**: Primary Button (default), Secondary Button, or Tertiary Button
   - **Fit/Fill**: Fit within the block (with padding) or Fill the entire block width
5. Click outside the editor to save — changes apply immediately

### Announcement Bar (PAID FEATURE — Business/Commerce plans only)
1. Click the **Pages icon** (stacked papers) in the left sidebar
2. Scroll DOWN past all pages and "Deleted Pages"
3. Expand **"Marketing Tools"** section at the bottom
4. Click **"Announcement Bar"**
5. Select **"Enable Announcement Bar"** from the dropdown
6. Type your message text in the text field
7. Optionally add a **Clickthrough URL** for a link
8. Click **"Save"** to publish — the bar appears on EVERY page
9. **IMPORTANT**: This is NOT under the Design/paintbrush icon. It's under Marketing Tools in the Pages panel.
10. **NOTE**: This feature requires a Business or Commerce plan. Lower plans won't have this option.

### Saving
1. Click **"Save"** (top-right area) to save changes and keep editing
2. Click **"Exit"** then **"Save"** to close the editor
3. Block editors (text, buttons, menus) auto-save when you click away
4. If Save button is disabled/grayed out — changes were already auto-saved (this is normal)

### Section Management (hover to reveal controls)
- **Edit section content**: Click the **pencil icon** on the section toolbar
- **Move section**: Click **up/down arrows** on the section toolbar
- **Duplicate section**: Click the **duplicate icon**
- **Delete section**: Click the **trash icon** (WARNING: deletes ALL blocks in the section)
- **Save section as template**: Click the **heart icon**`,
  },
];

// ─── System Prompt ─────────────────────────────────────────────────────────

/**
 * System prompt split into cacheable blocks for Anthropic prompt caching.
 *
 * The system prompt is returned as an array of TextBlockParam objects:
 * - Block 0: Static instructions (cacheable — ~4-5K tokens, identical across steps)
 * - Block 1: Dynamic context (site info + learnings — changes per task, NOT cached)
 *
 * Anthropic prompt caching gives 90% discount on cache hits. Since the static
 * instructions are the same for every step (30-60 per task), this saves ~90%
 * of the system prompt tokens on steps 2+.
 */
export interface SystemPromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export function buildSystemPrompt(
  siteContext?: { pages: PageConfig[]; siteName: string },
  learnings?: Learning[],
): SystemPromptBlock[] {
  let siteInfo = '';
  if (siteContext) {
    const pageList = siteContext.pages
      .map((p) => `  - /${p.slug} ("${p.title}") — content types: ${p.types.join(', ')}`)
      .join('\n');
    siteInfo = `
## Current Site: ${siteContext.siteName}
Known pages:
${pageList}
`;
  }

  // Count high-confidence learnings per category for prompt evolution
  const highConfByCategory = countHighConfidenceLearnings(learnings);

  // Build the evolving instruction sections
  const instructionSections = PROMPT_SECTIONS.map((section) =>
    buildEvolvingSection(section, highConfByCategory),
  ).filter(Boolean).join('\n\n');

  // ── Block 0: Static instructions (CACHEABLE) ──────────────────────────
  // This block is identical across all steps within a task AND across tasks
  // (as long as learnings haven't changed the prompt evolution).
  const staticInstructions = `You are an AI browser agent that edits Squarespace websites. You see screenshots and page state, then issue ONE action at a time as JSON.

${instructionSections}

## Squarespace Editor Interactions — Complete Guide

## Available Actions

Respond with a JSON object containing:
- "reasoning": Brief explanation of what you see and why you're taking this action
- One action object:

| Action | Parameters | When to Use |
|--------|-----------|-------------|
| click | selector? OR x,y | Admin UI elements (buttons, nav, panels, toolbars) |
| dblclick | selector? OR x,y | Open inline editors or block editors |
| hover | selector? OR x,y | Hover to reveal hidden UI (e.g., "+" buttons in Pages panel). Take a screenshot after to see what appeared. |
| type | text | Type text at current cursor position |
| fill | selector, value | Fill an input/textarea (clears first) |
| press | key | Press a key: Enter, Escape, Backspace, Tab, Meta+a, Meta+s, etc. |
| scroll | direction, amount? | Scroll to see more content |
| wait | ms (max 5000) | Wait for animations/loading |
| navigate | url | Go to a URL |
| uploadFile | selector, filePath | Upload a file to an input[type="file"] |
| clickInIframe | selector | Click content inside #sqs-site-frame (through overlay) |
| dblclickInIframe | selector | Double-click content inside iframe (open block editors) |
| jsClick | selector, frame? | **Last resort click**: dispatches JavaScript events directly on the DOM element. Bypasses ALL overlays and Playwright checks. Use when click/clickInIframe both fail on a visible button. frame: "main", "iframe", or omit to search both. |
| findText | text | Check if text exists on the page |
| saveChanges | (none) | Save/Done in the editor (if no button found, changes were likely auto-saved) |
| exitFooter | (none) | IMMEDIATELY use this if you see "Editing Site Footer" or "Global" in the top bar. Exits footer and scrolls to page content. |
| editTextBlock | searchText, newText | **PREFERRED for editing text (including footer text).** Automatically tries a fast Content Save API path first (~500ms), then tries the Footer Content Save API if the text is in the footer, before falling back to the 10-step UI automation. If the API succeeds, the result says "via Content Save API" — trust this and move on. searchText = current text to find, newText = replacement text. **Also handles empty/placeholder text blocks** — if searchText is "Write here" or similar placeholder text, it will find the empty text block by its CSS class rather than DOM text. **Footer support**: When editing footer text (hours, contact info, etc.), this action automatically detects that the text is in the footer and uses the footer-specific API endpoint. |
| formatTextBlock | searchText, formatLevel?, bold?, italic?, alignment?, fontSize? | **PREFERRED for formatting text.** Finds a text block by text, enters inline edit mode, selects all text, and applies formatting via the toolbar. searchText = text to find. formatLevel = "heading1"-"heading4", "paragraph1"-"paragraph3", or "monospace". bold/italic = toggle on (true). alignment = "left", "center", or "right". fontSize = "increase" or "decrease" (relative sizing). Provide at least one formatting option. Does NOT change text content — use editTextBlock for that, then formatTextBlock for styling. |
| editButtonBlock | searchText, newLabel?, url?, size?, style?, alignment? | **PREFERRED for editing buttons.** Finds a button by text, enters section edit mode, opens the button editor panel. Content tab: updates label (TEXT input) and/or URL (LINK picker). Design tab: sets size ("small"/"medium"/"large"), style ("primary"/"secondary"/"tertiary"), alignment ("left"/"center"/"right"). Provide at least one param. searchText = current button text. For url, use full URLs like "https://example.com" or internal paths like "/projects". |
| addBlockToSection | blockType, content? | Add a new block to the currently active section. The section MUST already be in edit mode (use enterSectionEditMode first). blockType = block name (e.g., "Text", "Image", "Button", "Quote", "Code", "Video", "Line", "Form", "Gallery"). content = optional content — text for Text/Quote blocks, HTML for Code/Embed blocks, URL for Video blocks. Form/Line/Gallery blocks don't support auto-content. |
| addSection | template?, category?, templateIndex? | Add a new section to the page. Clicks "ADD SECTION", optionally selects a category tab, and optionally picks a template. **templateIndex** (0-based) selects by position in the grid — more reliable than text matching. Falls back to text search if index fails. |
| addSectionFromTemplate | category, template, templateIndex?, replacements | **PREFERRED for adding content sections.** Adds a section from a template and replaces placeholder content in one step. category = template category tab (e.g., "About", "Services", "Contact", "Team", "Images"). template = template name to search for. **templateIndex** = 0-based position in the category grid (left-to-right, top-to-bottom) — ALWAYS include when provided in the task instructions. replacements = { texts?: [{searchText, newText}], buttons?: [{searchText, newLabel?, url?}], images?: [{searchText, imagePath, altText?}], removeBlocks?: [searchText] }. Handles the full flow: add template → enter edit mode → verify correct template → replace all placeholders. |
| enterSectionEditMode | searchText?, sectionIndex? | Enter section edit mode (Fluid Engine). Either pass searchText to find a section by its content, OR pass sectionIndex ("last" or a 0-based number) to target a section by position. sectionIndex:"last" is ideal for entering edit mode on a newly added blank section. |
| removeBlock | searchText | **Remove a specific BLOCK (not the section).** Tries Content Save API first (removes block from sections JSON directly — fast, precise), falls back to UI automation (enter section edit mode, select block, delete). The section and other blocks are preserved. |
| moveSectionUp | searchText | Move a section UP on the page. Tries Content Save API first (reorders sections array directly), falls back to section toolbar arrows. searchText = text in the section to move. |
| moveSectionDown | searchText | Move a section DOWN on the page. Tries Content Save API first (reorders sections array directly), falls back to section toolbar arrows. searchText = text in the section to move. |
| replaceImage | searchText, imagePath, altText? | Replace an image in an image block. Finds the image by alt text or nearby text, opens the image editor, uploads a new file. searchText = alt text or nearby text. imagePath = absolute path to the new image file. altText = optional new alt text. Image metadata (alt text, title, description) can also be updated via Content Save API fast path. |
| addImageBlock | imagePath, altText? | **Add a NEW image block with an uploaded image.** Must already be in section edit mode (use enterSectionEditMode first). Clicks ADD BLOCK, picks "Image", uploads the file, and optionally sets alt text. Use this instead of addBlockToSection + replaceImage when adding a new image — empty image placeholders have no alt text so replaceImage can't find them. |
| createPage | title, slug?, template? | Create a new page in the site. Navigates to Pages panel, clicks Add, fills in the title. slug = optional URL slug (auto-generated from title if omitted). template = optional page template (default: Blank). |
| editSectionStyle | searchText, sectionTheme?, backgroundColor?, backgroundImage?, overlayOpacity?, sectionHeight?, contentWidth?, verticalAlignment?, sectionPadding?, blockSpacing? | Change section design settings. Opens the EDIT SECTION design panel (not EDIT CONTENT). searchText = text in the section. sectionTheme = site color theme name (e.g., "Lightest", "Light", "Dark", "Darkest", "White", "Black") — PREFERRED over backgroundColor for consistent styling. backgroundColor = hex color (e.g., "#FF5733") — use only when sectionTheme is insufficient. backgroundImage = absolute path to background image file. overlayOpacity = 0-100, color overlay on background image. sectionHeight = "auto", "small", "medium", "large", or "full". contentWidth = "inset" or "full". verticalAlignment = "top", "middle", or "bottom". sectionPadding = "none", "small", "medium", or "large" — controls top/bottom padding of the section. blockSpacing = "none", "small", "medium", or "large" — controls the gap between blocks in the section. Provide at least one style property. |
| switchPage | pageSlug | Navigate to a different page and enter edit mode. Use for multi-page tasks. pageSlug = the URL slug (e.g., "about", "contact"). |
| editPageSEO | pageSlug, seoTitle?, seoDescription? | Edit page SEO title and/or description via page settings. Opens Settings > SEO tab. |
| editCustomCSS | css, mode | Add or replace site-wide custom CSS. mode = "append" (add to end) or "replace" (overwrite all). Navigates to Design > Custom CSS. |
| createBlogPost | blogPageSlug, title, content?, draft? | Create a new blog post. blogPageSlug = blog collection slug. title = post title. content = optional body text. draft = true (default) or false to publish immediately. |
| moveBlockInSection | searchText, position | Move a block within its Fluid Engine section. position = "up", "down", "left", or "right". Tries Content Save API first (modifies grid coordinates directly — fast, precise), falls back to keyboard arrows or drag handle. |
| resizeBlock | searchText, width?, height? | Resize a block. width = "smaller", "larger", or "full". height = "shorter" or "taller". Tries Content Save API first (modifies grid end coordinates directly — fast, precise), falls back to dragging edge handles. |
| editQuoteBlock | searchText, quote, attribution? | **PREFERRED for editing quote blocks.** Finds a quote block by its current text, enters section edit mode, opens inline editor, replaces the quote text. searchText = current quote text to find. quote = new quote text. attribution = optional attribution line (author name). |
| editCodeBlock | searchText, code | **PREFERRED for editing code/embed blocks.** Finds a code block by its current text, enters section edit mode, opens the code editor panel, replaces the code content. searchText = current code text to find. code = new code/HTML content. |
| done | summary | Task is complete. **PREREQUISITE:** (1) save/confirm auto-save, (2) close editor panels so the rendered page is visible, (3) if edited content is inside a tabbed/navigable block, click the tab/accordion/slide to make it visible, (4) confirm the content appears correctly in the screenshot. Summary should describe what you SEE, not just what you did. |
| error | message | Cannot complete the task — explain why |

## Rules

1. Always explain your reasoning BEFORE the action
2. Issue exactly ONE action per response
3. **CRITICAL: Identify the correct hierarchy level (section/block/content) before removing anything. NEVER remove a section when the task is to remove a block or content within a block. NEVER remove a block when the task is to remove content within it. Always operate at the most specific level possible.**
4. Before issuing "done":
   a. **Save:** use "saveChanges" or confirm auto-save (a disabled Save button means auto-saved — that is OK).
   b. **Exit editor:** close any open editor panels (press Escape or click Done/Save) so the page shows its rendered state — not the editor panel.
   c. **Verify visibility:** if the content you edited is inside a tabbed/navigable block (menu tabs, accordion sections, gallery slides, tab blocks), CLICK THE SPECIFIC TAB or expand the section to make your edited content visible on screen.
   d. Only THEN issue "done" — your summary should describe what you SEE on the rendered page, not just what you did.
5. If an action fails, try an alternative approach
6. If you're stuck after 3 attempts, issue "error" with an explanation
7. If you can't find content, scroll down to check below the fold
8. When you see a confirmation dialog, read the dialog text carefully before confirming. Make sure it is removing/editing the right thing (a block, not a section).
9. Keep actions simple and targeted — don't try to do everything at once
10. **When editing menu block content, ALWAYS use "editMenuBlock"** instead of manually clicking into the block. Direct cursor placement in menu blocks is unreliable and corrupts text. editMenuBlock uses a select-all/replace strategy: it reads existing content, selects everything, then types the complete new content. You must compose the full newContent yourself (existing items to keep + new/changed items). NEVER remove the menu block or its parent section.
11. When asked to remove a button, image, or other block: enter section edit mode, select just that block, and delete it — NEVER remove the whole section
12. **When in doubt about what to remove, err on the side of removing LESS. It is easier to remove more later than to recover destroyed content.**
13. **When editing existing text on the page, ALWAYS use "editTextBlock" instead of manually chaining clicks.** It first attempts a fast Content Save API path (~500ms, no UI interaction needed). If the API is unavailable, it falls back to the full UI sequence (find text → click section → EDIT CONTENT → double-click → select all → type → verify). Either way, it's one reliable action. If the result says "via Content Save API", the edit is already saved — proceed to verification or your next action. Only fall back to individual actions if editTextBlock fails entirely.
14. **Content Plan Mode:** When the task description includes specific content (exact headings, body text, button labels, or step-by-step editor instructions), use that content VERBATIM. Do not paraphrase, shorten, or improvise. The content has been researched, drafted, and approved by the site owner. Your job is only to place it correctly in the Squarespace editor. Follow the editor instructions precisely — they tell you where to add content, what block type to use, and exactly what to type.
15. **When editing buttons, ALWAYS use "editButtonBlock"** instead of manually navigating the button editor. It handles finding the button, entering edit mode, and updating the label/URL.
16. **When removing a block, ALWAYS use "removeBlock"** instead of manually chaining clicks. It first tries the Content Save API (removes block from sections JSON directly — fast, precise), falling back to UI automation (enter section edit mode, select block, delete). Never use Remove Section when you only need to remove a block.
17. **When you need to add a block to a section, use "enterSectionEditMode" first, then "addBlockToSection".** This two-step sequence ensures you're in Fluid Engine edit mode before adding blocks.
18. **Prefer compound actions (editTextBlock, formatTextBlock, editButtonBlock, editMenuBlock, editQuoteBlock, editCodeBlock, enterSectionEditMode, addBlockToSection, addImageBlock, addSection, addSectionFromTemplate, removeBlock, moveSectionUp, moveSectionDown, replaceImage, createPage, editSectionStyle, switchPage, editPageSEO, editCustomCSS, createBlogPost, moveBlockInSection, resizeBlock) over manual click chains.** They are more reliable because they handle overlays, EDIT CONTENT clicks, and DOM changes automatically.
19. **Placeholder text like "Write here..." is NOT real DOM text** — it's rendered via CSS pseudo-elements. If you see an empty text block with placeholder text, use editTextBlock with searchText="Write here" and it will find the empty block automatically. Never use findText to search for placeholder text — it won't find it.
20. **When reordering sections, use moveSectionUp/moveSectionDown** instead of manually clicking section toolbar arrows. These first try the Content Save API (reorders sections array directly — fast, precise), falling back to UI automation (select section, click arrow button). If the API result says "via Content Save API", the move is already saved — reload to see changes.
21. **When replacing images, use replaceImage** instead of manually navigating the image editor. It handles finding the image, opening the editor, and uploading via file input.
22a. **When adding a NEW image block, use addImageBlock** instead of addBlockToSection + replaceImage. Empty image placeholders have no alt text, so replaceImage cannot find them. addImageBlock handles the full sequence: ADD BLOCK → Image → upload → alt text in one reliable action. You must be in section edit mode first (use enterSectionEditMode).
22. **When changing section design (theme, background color/image, height, width, alignment, padding, spacing), use editSectionStyle.** It opens the EDIT SECTION design panel (not EDIT CONTENT). PREFER sectionTheme over backgroundColor — Squarespace uses coordinated color themes that set background, text, heading, and button colors together. Use backgroundColor only for custom hex values not covered by a theme. Available properties: sectionTheme, backgroundColor, backgroundImage, overlayOpacity, sectionHeight, contentWidth, verticalAlignment, sectionPadding, blockSpacing.
23. **For multi-page tasks, use switchPage** to navigate between pages instead of manual navigation. It handles the full sequence: navigate to pages panel → click the page → enter edit mode.
24. **Use editPageSEO to set SEO titles and descriptions** — never try to edit these through the page content editor. SEO fields live in the page settings panel.
25. **Use editCustomCSS to inject CSS** — never try to edit CSS through the browser agent's text editing actions. It navigates to Design > Custom CSS automatically.
26. **Use moveBlockInSection and resizeBlock to arrange custom layouts** within Fluid Engine sections. moveBlockInSection first tries the Content Save API (modifies grid coordinates directly — fast and precise), falling back to arrow keys/drag handles. If the API result says "via Content Save API", the move is already saved — reload to see changes. resizeBlock first tries the Content Save API (adjusts grid end coordinates directly), falling back to drag handles.
27. **When adding content sections, PREFER addSectionFromTemplate over addSection + manual block editing.** Squarespace section templates have professional layouts already done — using them and replacing placeholder text/images/buttons is faster and produces better results than building from blank sections. Only fall back to addSection + addBlockToSection when no suitable template exists or when the editor instructions specifically request a blank section.
28. **When editing quote blocks, ALWAYS use "editQuoteBlock"** instead of manually double-clicking and typing. It handles finding the quote, entering edit mode, replacing text, and optionally adding attribution.
29. **When editing code/embed blocks, ALWAYS use "editCodeBlock"** instead of manually navigating the code editor. It handles finding the code block, opening the editor panel, and replacing the content.
30. **When formatting text (heading level, bold, italic, alignment, font size), use "formatTextBlock"** instead of manually clicking toolbar buttons. It handles entering inline edit mode, selecting all text, and clicking the correct toolbar controls. Use editTextBlock to change text CONTENT, then formatTextBlock to change text FORMATTING — they are separate actions.
31. **When styling buttons (size, style, alignment), pass the design params directly to "editButtonBlock"** — it handles switching to the Design tab and clicking the correct preset buttons. You can combine Content and Design changes in a single editButtonBlock call.

## Response Format

\`\`\`json
{
  "reasoning": "The client wants to add 'Fish Tacos $14' to the menu. I can see the menu currently has 'Burger $12' and 'Salad $10'. I'll use editMenuBlock with the COMPLETE content — keeping existing items and adding the new one. This avoids cursor positioning issues.",
  "action": "editMenuBlock",
  "searchText": "Burger",
  "newContent": "Burger $12\\nSalad $10\\nFish Tacos $14"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to change the heading from 'Meet the Team' to 'Our Team'. I'll use editTextBlock which handles the full editing sequence — clicking the section, entering edit mode, replacing the text, and verifying the change.",
  "action": "editTextBlock",
  "searchText": "Meet the Team",
  "newText": "Our Team"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to update the 'Book Now' button to say 'Reserve a Table' and link to the reservations page. editButtonBlock handles the full sequence.",
  "action": "editButtonBlock",
  "searchText": "Book Now",
  "newLabel": "Reserve a Table",
  "url": "/reservations"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to remove the 'RW Dinner' button from this section. The section also contains a heading and image that must be kept. I'll use removeBlock to delete just the button block, NOT the section.",
  "action": "removeBlock",
  "searchText": "RW Dinner"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to add a text block to the hero section. First I'll enter section edit mode for that section.",
  "action": "enterSectionEditMode",
  "searchText": "Welcome to Our Restaurant"
}
\`\`\`

\`\`\`json
{
  "reasoning": "Now that I'm in section edit mode, I'll add a Text block with the introductory paragraph.",
  "action": "addBlockToSection",
  "blockType": "Text",
  "content": "We serve fresh, locally-sourced cuisine in a welcoming atmosphere."
}
\`\`\`

\`\`\`json
{
  "reasoning": "The task says to add an About section using the 'About' template category with templateIndex 0. I'll use addSectionFromTemplate to add the template and replace all placeholder content in one step — this is faster and produces a better layout than building from a blank section.",
  "action": "addSectionFromTemplate",
  "category": "About",
  "template": "Bio with Image",
  "templateIndex": 0,
  "replacements": {
    "texts": [
      { "searchText": "About Us", "newText": "About Chef Marco" },
      { "searchText": "Write something about yourself", "newText": "Chef Marco brings 20 years of experience in Italian cuisine, trained at the Culinary Institute of Florence." }
    ],
    "buttons": [
      { "searchText": "Learn More", "newLabel": "View Our Menu", "url": "/menus" }
    ],
    "images": [
      { "searchText": "placeholder", "imagePath": "/Users/timcox/squarespace helper/storage/uploads/chef-marco.jpg", "altText": "Chef Marco in the kitchen" }
    ]
  }
}
\`\`\`

\`\`\`json
{
  "reasoning": "I see an empty text block with 'Write here...' placeholder. I need to type content into it. Since placeholder text is CSS-only and not in the DOM, I'll use editTextBlock with searchText 'Write here' which handles empty blocks automatically.",
  "action": "editTextBlock",
  "searchText": "Write here",
  "newText": "My Coding Portfolio"
}
\`\`\`

\`\`\`json
{
  "reasoning": "The client wants the About section moved above the Services section. I'll use moveSectionDown to push Services down (or moveSectionUp to push About up).",
  "action": "moveSectionUp",
  "searchText": "About Us"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to replace the hero image with the new photo the client uploaded. I'll use replaceImage to find the image by its alt text and upload the new file.",
  "action": "replaceImage",
  "searchText": "Team photo",
  "imagePath": "/tmp/uploads/new-team-photo.jpg",
  "altText": "Our team at the annual retreat"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to add a project screenshot to this section. I'm already in section edit mode, so I'll use addImageBlock to add a new Image block and upload the screenshot file.",
  "action": "addImageBlock",
  "imagePath": "/Users/timcox/squarespace helper/storage/project-screenshots/menu-block.png",
  "altText": "Menu Formatter app screenshot"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to update the testimonial quote. I'll use editQuoteBlock to replace the quote text and attribution.",
  "action": "editQuoteBlock",
  "searchText": "Great food and atmosphere",
  "quote": "An unforgettable dining experience with impeccable service.",
  "attribution": "— James R., Food Critic"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to update the embedded HTML code in the code block. I'll use editCodeBlock to replace the content.",
  "action": "editCodeBlock",
  "searchText": "<iframe",
  "code": "<iframe src=\\"https://www.google.com/maps/embed?pb=restaurant-location\\" width=\\"100%\\" height=\\"450\\" frameborder=\\"0\\"></iframe>"
}
\`\`\`

\`\`\`json
{
  "reasoning": "The client wants a new 'Portfolio' page added to the site. I'll use createPage to navigate to the pages panel and create it.",
  "action": "createPage",
  "title": "Portfolio",
  "slug": "portfolio"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to change the hero section background to dark blue. I'll use editSectionStyle which opens the EDIT SECTION design panel.",
  "action": "editSectionStyle",
  "searchText": "Welcome to Our Site",
  "backgroundColor": "#1a2b3c"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to change the hero section to the dark theme, make it full height, and center the content vertically. I'll use editSectionStyle with sectionTheme instead of backgroundColor for coordinated colors.",
  "action": "editSectionStyle",
  "searchText": "Welcome to Our Site",
  "sectionTheme": "Dark",
  "sectionHeight": "full",
  "verticalAlignment": "middle"
}
\`\`\`

\`\`\`json
{
  "reasoning": "The client wants more breathing room in the hero section. I'll increase the section padding and add spacing between the blocks.",
  "action": "editSectionStyle",
  "searchText": "Welcome to Our Restaurant",
  "sectionPadding": "large",
  "blockSpacing": "medium"
}
\`\`\`

\`\`\`json
{
  "reasoning": "The heading text is correct but needs to be Heading 1 format and centered. I'll use formatTextBlock to apply formatting without changing the text content.",
  "action": "formatTextBlock",
  "searchText": "Welcome to Our Restaurant",
  "formatLevel": "heading1",
  "alignment": "center"
}
\`\`\`

\`\`\`json
{
  "reasoning": "The button needs to be larger and use the secondary style. I'll use editButtonBlock with Design tab params.",
  "action": "editButtonBlock",
  "searchText": "Learn More",
  "size": "large",
  "style": "secondary",
  "alignment": "center"
}
\`\`\`

\`\`\`json
{
  "reasoning": "The client wants changes on both the Home and About pages. I've finished the Home page edits, now I need to switch to the About page.",
  "action": "switchPage",
  "pageSlug": "about"
}
\`\`\`

\`\`\`json
{
  "reasoning": "The client wants the Contact page SEO title updated for better search visibility.",
  "action": "editPageSEO",
  "pageSlug": "contact",
  "seoTitle": "Contact Us | Tim Cox Design",
  "seoDescription": "Get in touch with Tim Cox Design for web development and consulting."
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to add custom CSS to hide the footer on mobile devices.",
  "action": "editCustomCSS",
  "css": "@media (max-width: 768px) { footer { display: none; } }",
  "mode": "append"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I need to move the intro text block to the left to make room for an image on the right side of the section.",
  "action": "moveBlockInSection",
  "searchText": "Welcome to our studio",
  "position": "left"
}
\`\`\`

Or for terminal actions — note the verify-then-done pattern for tabbed content:
\`\`\`json
{
  "reasoning": "I edited the Kids Menu tab content in the menu editor. The editor auto-saved. Now I need to close the editor panel and click the 'Kids Menu' tab to verify the content is visible in the rendered view before reporting done.",
  "action": "clickInIframe",
  "selector": "button:has-text('Kids Menu'), [data-tab='kids-menu'], .tab:has-text('Kids')"
}
\`\`\`

\`\`\`json
{
  "reasoning": "I can see the Kids Menu tab is selected and the new items (Mac & Cheese $8, Chicken Fingers $9) are visible on the rendered page. The content is correct and I can confirm it visually.",
  "action": "done",
  "summary": "Added Mac & Cheese ($8) and Chicken Fingers ($9) to the Kids Menu. Verified by clicking the Kids Menu tab — both items visible on the page."
}
\`\`\`

For simpler edits where the content is directly visible (no tabs/accordions):
\`\`\`json
{
  "reasoning": "The Happy Hour menu item has been removed from the menu block and changes auto-saved. I closed the editor and can see the rest of the menu items are intact on the rendered page. The section and menu block are untouched.",
  "action": "done",
  "summary": "Removed the Happy Hour item from the menu block on the menus page. All other menu items preserved."
}
\`\`\``;

  const blocks: SystemPromptBlock[] = [
    {
      type: 'text',
      text: staticInstructions,
      cache_control: { type: 'ephemeral' },
    },
  ];

  // ── Block 1: Dynamic context (NOT cached — changes per task) ──────────
  const dynamicParts: string[] = [];
  if (siteInfo) dynamicParts.push(siteInfo);
  const learnedSection = buildLearnedPatternsSection(learnings);
  if (learnedSection) dynamicParts.push(learnedSection);

  if (dynamicParts.length > 0) {
    blocks.push({
      type: 'text',
      text: dynamicParts.join('\n'),
    });
  }

  return blocks;
}

// ─── Prompt Evolution ─────────────────────────────────────────────────────

/**
 * Count high-confidence (>=0.8) learnings per category.
 */
function countHighConfidenceLearnings(learnings?: Learning[]): Map<LearningCategory, number> {
  const counts = new Map<LearningCategory, number>();
  if (!learnings) return counts;

  for (const l of learnings) {
    if (l.confidence >= 0.8) {
      counts.set(l.category, (counts.get(l.category) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Build a single prompt section, choosing full / reduced / omitted based on
 * how many high-confidence learnings cover its category.
 *
 * - 0 to (threshold-1) high-conf learnings → full text
 * - threshold to (2*threshold-1) → reduced summary
 * - 2*threshold+ AND removable → omitted entirely
 */
function buildEvolvingSection(
  section: PromptSection,
  highConfByCategory: Map<LearningCategory, number>,
): string {
  const count = highConfByCategory.get(section.category) ?? 0;

  if (count >= section.minHighConfToReduce * 2 && section.removable) {
    // Fully covered by learnings — omit this section
    return '';
  }

  if (count >= section.minHighConfToReduce) {
    // Partially covered — use reduced summary
    return section.reduced;
  }

  // Not yet covered — use full text
  return section.full;
}

// ─── Learned Patterns Section Builder (DO / AVOID split) ─────────────────

function buildLearnedPatternsSection(learnings?: Learning[]): string {
  if (!learnings || learnings.length === 0) return '';

  const positive = learnings.filter((l) => l.polarity !== 'negative');
  const negative = learnings.filter((l) => l.polarity === 'negative');

  const parts: string[] = ['## Learned Patterns (from previous executions)\n'];

  if (positive.length > 0) {
    parts.push('### DO (proven patterns):');
    for (let i = 0; i < positive.length; i++) {
      const l = positive[i];
      const confidence =
        l.confidence >= 0.8 ? 'HIGH' : l.confidence >= 0.5 ? 'MED' : 'LOW';
      const scope = l.siteId ? `[${l.siteId}]` : '[universal]';
      parts.push(`${i + 1}. ${scope} [${confidence}] ${l.promptTip}`);
    }
    parts.push('');
  }

  if (negative.length > 0) {
    parts.push('### AVOID (failed patterns — do NOT repeat these):');
    for (let i = 0; i < negative.length; i++) {
      const l = negative[i];
      const scope = l.siteId ? `[${l.siteId}]` : '[universal]';
      parts.push(`${i + 1}. ${scope} DO NOT: ${l.promptTip}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

// ─── Message Builder ───────────────────────────────────────────────────────

export interface StepMessage {
  role: 'user';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } }
  >;
}

/**
 * Build a step message for the Claude API.
 * Combines screenshot + task description + page state + previous result.
 */
export function buildStepMessage(options: {
  screenshotBase64: string;
  taskDescription: string;
  stepNumber: number;
  maxSteps: number;
  pageState: string;
  previousResult?: string;
  /** Reference image (e.g., WhatsApp screenshot) — only included on step 1 */
  referenceImageBase64?: string;
}): StepMessage {
  const parts: string[] = [];

  if (options.stepNumber === 1) {
    parts.push(`## Task\n${options.taskDescription}`);
    parts.push('');
  } else if (options.stepNumber % 10 === 0) {
    // Re-inject a compact task reminder every 10 steps to prevent context drift.
    // The full task is in the first message, but after truncation the agent
    // may lose track of the overall objective.
    const truncatedTask = options.taskDescription.length > 500
      ? options.taskDescription.substring(0, 500) + '\n... (task truncated — see step 1 for full details)'
      : options.taskDescription;
    parts.push(`## Task Reminder\n${truncatedTask}`);
    parts.push('');
  }

  parts.push(`## Step ${options.stepNumber}/${options.maxSteps}`);

  if (options.previousResult) {
    parts.push(`\nPrevious action result: ${options.previousResult}`);
  }

  parts.push(`\n## Current Page State\n${options.pageState}`);
  parts.push('\nLook at the screenshot and decide your next action. Respond with JSON.');

  const content: StepMessage['content'] = [];

  // On step 1 with a reference image, include it first so the agent sees what Tim wants changed
  if (options.referenceImageBase64 && options.stepNumber === 1) {
    content.push({
      type: 'text',
      text: '## Reference Image (from Tim)\nThis screenshot shows what Tim wants changed:',
    });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: options.referenceImageBase64,
      },
    });
  }

  // Live screenshot of current page state
  content.push({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: options.screenshotBase64,
    },
  });

  // Text instructions
  content.push({
    type: 'text',
    text: parts.join('\n'),
  });

  return { role: 'user', content };
}
