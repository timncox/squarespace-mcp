/**
 * Content Strategist Agent — drafts a specific content plan with exact copy,
 * placement, and block types based on research + site analysis + Tim's request.
 *
 * This is the most important agent in the pipeline. Its output (ContentPlan)
 * becomes the browser agent's precise instructions.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Task } from '../models/task.js';
import type {
  AgentResult,
  ContentPlan,
  ContentOperation,
  ResearchResult,
  SiteAnalysis,
  PageStructure,
} from './types.js';
import type { TemplateCatalog } from '../config/section-templates-types.js';
import type { TemplateDiscoveryResult } from '../services/template-discovery.js';
import { formatDiscoveredTemplatesForPrompt } from '../services/template-discovery.js';
import { formatPresetsForPrompt } from '../config/layout-presets.js';
import { getRelevantLearnings, type Learning } from '../db/learnings.js';
import { logger } from '../utils/logger.js';
import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_SONNET } from '../config/models.js';
import { errMsg } from '../utils/errors.js';

// ─── Template Catalog ────────────────────────────────────────────────────────

let _catalogCache: TemplateCatalog | null = null;

function loadCatalog(): TemplateCatalog {
  if (_catalogCache) return _catalogCache;
  const catalogPath = join(process.cwd(), 'src', 'config', 'section-templates.json');
  const raw = readFileSync(catalogPath, 'utf-8');
  _catalogCache = JSON.parse(raw) as TemplateCatalog;
  return _catalogCache;
}

/**
 * Choose the best template catalog source for the prompt.
 * Uses dynamically discovered templates when available, otherwise
 * falls back to the static section-templates.json catalog.
 */
function formatTemplateCatalogSection(discoveredTemplates?: TemplateDiscoveryResult): string {
  if (discoveredTemplates && discoveredTemplates.categories.length > 0) {
    logger.info(
      { categoryCount: discoveredTemplates.categories.length, discoveredAt: discoveredTemplates.discoveredAt },
      'Content strategist: using dynamically discovered templates',
    );
    return formatDiscoveredTemplatesForPrompt(discoveredTemplates);
  }

  // Fall back to static catalog
  logger.info('Content strategist: using static template catalog (no discovery data available)');
  return formatCatalogForPrompt();
}

/**
 * Render the template catalog as markdown tables for injection into the
 * content strategist prompt. Each category becomes its own sub-section with
 * a table showing template index, name, layout, placeholder texts, and buttons.
 */
function formatCatalogForPrompt(): string {
  const catalog = loadCatalog();
  const lines: string[] = [];

  lines.push('### Section Template Catalog (ALWAYS try templates first)');
  lines.push('');
  lines.push('Use the **addSectionFromTemplate** compound action to add a template AND replace its placeholder content in one step.');
  lines.push('');

  for (const category of catalog) {
    // Category heading with description
    const categoryDescriptions: Record<string, string> = {
      Intro: 'hero sections',
      About: 'bio/story sections',
      Team: 'member cards',
      Contact: 'forms + info',
      Services: 'service cards',
      Products: 'e-commerce',
      FAQs: 'Q&A sections',
      Images: 'image galleries',
    };
    const desc = categoryDescriptions[category.category] ?? '';
    lines.push(`#### ${category.category}${desc ? ` (${desc})` : ''}`);

    // Determine if any template in this category has buttons
    const hasButtons = category.templates.some(t => t.placeholders.buttons && t.placeholders.buttons.length > 0);
    const hasImages = category.templates.some(t => t.placeholders.images && t.placeholders.images.length > 0);

    // Table header
    const headers = ['Idx', 'Template', 'Layout', 'Placeholder Texts'];
    if (hasButtons) headers.push('Buttons');
    if (hasImages) headers.push('Images');
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

    for (const tmpl of category.templates) {
      const textsStr = tmpl.placeholders.texts
        .map(t => `"${t.default}" (${t.role})`)
        .join(', ');

      const cols: string[] = [
        String(tmpl.index),
        tmpl.name,
        tmpl.layout,
        textsStr,
      ];

      if (hasButtons) {
        const btns = tmpl.placeholders.buttons;
        cols.push(btns && btns.length > 0
          ? btns.map(b => `"${b.default}" (${b.role})`).join(', ')
          : '—');
      }

      if (hasImages) {
        const imgs = tmpl.placeholders.images;
        cols.push(imgs && imgs.length > 0
          ? imgs.map(i => `${i.role}${i.position ? ` [${i.position}]` : ''}`).join(', ')
          : '—');
      }

      lines.push(`| ${cols.join(' | ')} |`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Draft a content plan for one or more tasks.
 *
 * @param tasks — The tasks to plan content for
 * @param research — Research findings from the Research Agent
 * @param siteAnalysis — Site visual analysis from the Site Analyst Agent
 * @param revisionFeedback — Tim's feedback if this is a revision (optional)
 * @param previousPlan — The previous plan being revised (optional)
 * @param discoveredTemplates — Dynamic template discovery result (optional, falls back to static catalog)
 * @param pageStructures — Actual page section/block data from Content Save API (optional)
 */
export async function runContentStrategistAgent(
  tasks: Task[],
  research: ResearchResult | undefined,
  siteAnalysis: SiteAnalysis | undefined,
  revisionFeedback?: string,
  previousPlan?: ContentPlan,
  discoveredTemplates?: TemplateDiscoveryResult,
  pageStructures?: Record<string, PageStructure>,
): Promise<AgentResult<ContentPlan>> {
  const start = Date.now();

  try {
    // Fetch relevant learnings from past executions for the primary task's site/page
    const primaryTask = tasks[0];
    const learnings = getRelevantLearnings(primaryTask?.siteId, primaryTask?.targetPage);
    if (learnings.length > 0) {
      logger.info({ count: learnings.length, siteId: primaryTask?.siteId }, 'Content strategist: injecting learned patterns');
    }

    const prompt = buildStrategyPrompt(tasks, research, siteAnalysis, revisionFeedback, previousPlan, learnings, discoveredTemplates, pageStructures);

    const response = await getAnthropicClient().messages.create({
      model: MODEL_SONNET,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const plan = parsePlanResponse(text, tasks);

    logger.info(
      { operationCount: plan.operations.length, estimatedMinutes: plan.estimatedMinutes },
      'Content strategist: plan drafted',
    );

    return {
      success: true,
      data: plan,
      tokenUsage: { inputTokens, outputTokens },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error({ error: errorMessage }, 'Content strategist agent failed');
    return {
      success: false,
      error: errorMessage,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      durationMs: Date.now() - start,
    };
  }
}

// ─── Prompt Builder ─────────────────────────────────────────────────────────

function buildStrategyPrompt(
  tasks: Task[],
  research: ResearchResult | undefined,
  siteAnalysis: SiteAnalysis | undefined,
  revisionFeedback?: string,
  previousPlan?: ContentPlan,
  learnings?: Learning[],
  discoveredTemplates?: TemplateDiscoveryResult,
  pageStructures?: Record<string, PageStructure>,
): string {
  const parts: string[] = [];

  parts.push(`You are a content strategist for Squarespace websites. Your job is to draft a specific content plan with EXACT copy that will be placed on the website.

The content you write will be typed VERBATIM into the Squarespace website editor. It must be final, polished, publication-ready copy. Do not use placeholder text. Match the tone and style of the existing site.`);

  // Tasks
  parts.push('\n## Tasks from the Site Owner\n');
  for (const task of tasks) {
    parts.push(`- Site: ${task.clientName} (${task.siteId})`);
    parts.push(`  Page: ${task.targetPage ?? 'home'}`);
    parts.push(`  Request: ${task.description ?? task.contentToAdd ?? 'General edit'}`);
    if (task.imagePaths && task.imagePaths.length > 0) {
      parts.push(`  Image files provided (${task.imagePaths.length}):`);
      for (const imgPath of task.imagePaths) {
        parts.push(`    - ${imgPath}`);
      }
      parts.push('  Use these image paths in apiBlocks (type: "image" or type: "gallery") for the blank_api strategy.');
    }
    parts.push('');
  }

  // Research findings — prefer synthesis (structured) over raw findings
  if (research?.synthesis) {
    const syn = research.synthesis;

    parts.push('## Research Synthesis\n');

    if (syn.keyFacts.length > 0) {
      parts.push('### Key Facts (verified from sources)\n');
      for (const fact of syn.keyFacts) {
        parts.push(`- ${fact}`);
      }
      parts.push('');
    }

    if (syn.contentSuggestions.length > 0) {
      parts.push('### Content Suggestions\n');
      for (const suggestion of syn.contentSuggestions) {
        parts.push(`- ${suggestion}`);
      }
      parts.push('');
    }

    if (syn.toneGuidance) {
      parts.push(`### Tone Guidance\n${syn.toneGuidance}\n`);
    }

    if (syn.sources.length > 0) {
      parts.push('### Sources (ranked by relevance)\n');
      const highSources = syn.sources.filter(s => s.relevance === 'high');
      const medSources = syn.sources.filter(s => s.relevance === 'medium');
      if (highSources.length > 0) {
        for (const s of highSources) {
          parts.push(`- **[HIGH]** ${s.url} — ${s.summary}`);
        }
      }
      if (medSources.length > 0) {
        for (const s of medSources.slice(0, 3)) {
          parts.push(`- [medium] ${s.url} — ${s.summary}`);
        }
      }
      parts.push('');
    }
  } else if (research && research.findings.length > 0) {
    // Fallback: raw findings (no synthesis available)
    parts.push('## Research Findings\n');
    for (const finding of research.findings) {
      parts.push(`- ${finding}`);
    }
    if (research.sources.length > 0) {
      parts.push(`\nSources: ${research.sources.slice(0, 3).join(', ')}`);
    }
    parts.push('');
  }

  // Structured page data (from URL extraction)
  if (research?.structuredPages && research.structuredPages.length > 0) {
    parts.push('## Extracted Page Data\n');
    for (const page of research.structuredPages) {
      parts.push(`### ${page.title || page.url}\n`);
      if (page.headings.length > 0) {
        parts.push(`Headings: ${page.headings.slice(0, 5).join(' > ')}`);
      }
      if (page.keyContent.length > 0) {
        parts.push('Key content:');
        for (const content of page.keyContent.slice(0, 3)) {
          parts.push(`  - ${content.substring(0, 200)}`);
        }
      }
      if (page.lists.length > 0) {
        parts.push(`Lists found: ${page.lists.length} (items: ${page.lists.map(l => l.slice(0, 3).join(', ')).join(' | ')})`);
      }
      parts.push('');
    }
  }

  // Site analysis
  if (siteAnalysis) {
    parts.push('## Current Site Analysis\n');
    parts.push(`Style: ${siteAnalysis.styleDescription}`);
    parts.push(`Brand tone: ${siteAnalysis.brandTone}`);
    if (siteAnalysis.existingSections.length > 0) {
      parts.push(`Existing sections on page: ${siteAnalysis.existingSections.join(', ')}`);
    }
    if (siteAnalysis.visualNotes) {
      parts.push(`Visual notes: ${siteAnalysis.visualNotes}`);
    }
    parts.push('');
  }

  // Page structure data (from Content Save API — precise section/block info)
  if (pageStructures && Object.keys(pageStructures).length > 0) {
    parts.push('## Current Page Structure (from API — precise data)\n');
    parts.push('This is the EXACT structure of the page as returned by the Squarespace API. Use this data to:');
    parts.push('- Reference existing sections by their position and content when specifying placement');
    parts.push('- Know exactly how many sections exist and what they contain');
    parts.push('- Avoid duplicating content that already exists on the page');
    parts.push('- Make precise "add after section N" placement decisions\n');

    for (const [key, structure] of Object.entries(pageStructures)) {
      parts.push(`### Page: ${key}`);
      parts.push(`Total sections: ${structure.sectionCount}\n`);

      if (structure.sections.length === 0) {
        parts.push('*Page is empty — no sections found.*\n');
        continue;
      }

      for (const section of structure.sections) {
        parts.push(`**Section ${section.index + 1}** (id: ${section.id}, name: "${section.name}", ${section.blockCount} block${section.blockCount !== 1 ? 's' : ''})`);

        // Section design properties
        if (section.design) {
          const designParts: string[] = [];
          if (section.design.theme) designParts.push(`theme: ${section.design.theme}`);
          if (section.design.backgroundColor) designParts.push(`bg: ${section.design.backgroundColor}`);
          if (section.design.hasBackgroundImage) designParts.push('bg-image: yes');
          if (section.design.sectionHeight) designParts.push(`height: ${section.design.sectionHeight}`);
          if (section.design.contentWidth) designParts.push(`width: ${section.design.contentWidth}`);
          if (section.design.verticalAlignment) designParts.push(`vAlign: ${section.design.verticalAlignment}`);
          if (section.design.sectionPadding) designParts.push(`padding: ${section.design.sectionPadding}`);
          if (section.design.blockSpacing) designParts.push(`spacing: ${section.design.blockSpacing}`);
          if (designParts.length > 0) {
            parts.push(`  Design: ${designParts.join(' | ')}`);
          }
        }

        if (section.blocks.length > 0) {
          for (const block of section.blocks) {
            const details: string[] = [`  - [${block.type}]`];
            if (block.visible === false) details.push('[HIDDEN]');
            if (block.textSnippet) details.push(`"${block.textSnippet}"`);
            if (block.imageAlt) details.push(`alt="${block.imageAlt}"`);
            if (block.imageSubtitle) details.push(`subtitle="${block.imageSubtitle}"`);
            if (block.imageLinkTo) details.push(`linkTo="${block.imageLinkTo}"`);
            if (block.buttonLabel) details.push(`button="${block.buttonLabel}"`);
            if (block.buttonUrl) details.push(`url="${block.buttonUrl}"`);

            // Compact text style info
            if (block.textStyles) {
              const styleParts: string[] = [];
              if (block.textStyles.headingTag) styleParts.push(block.textStyles.headingTag);
              if (block.textStyles.alignment) styleParts.push(`align:${block.textStyles.alignment}`);
              if (block.textStyles.color) styleParts.push(`color:${block.textStyles.color}`);
              if (block.textStyles.fontSize) styleParts.push(`size:${block.textStyles.fontSize}`);
              if (block.textStyles.fontFamily) styleParts.push(`font:${block.textStyles.fontFamily}`);
              if (block.textStyles.fontWeight) styleParts.push(`weight:${block.textStyles.fontWeight}`);
              if (block.textStyles.textTransform) styleParts.push(`transform:${block.textStyles.textTransform}`);
              if (block.textStyles.letterSpacing) styleParts.push(`spacing:${block.textStyles.letterSpacing}`);
              if (block.textStyles.bold) styleParts.push('bold');
              if (block.textStyles.italic) styleParts.push('italic');
              if (styleParts.length > 0) {
                details.push(`style={${styleParts.join(', ')}}`);
              }
            }

            // Grid column count
            if (block.gridSpan) {
              details.push(`grid=${block.gridSpan.columns}cols`);
            }

            // Links
            if (block.links && block.links.length > 0) {
              const linkStrs = block.links.map(l => `"${l.text}"→${l.href}`);
              details.push(`links=[${linkStrs.join(', ')}]`);
            }

            parts.push(details.join(' '));
          }
        }
        parts.push('');
      }
    }
  }

  // Learned editor patterns (from past executions)
  if (learnings && learnings.length > 0) {
    parts.push('## Known Editor Patterns (from previous sessions)\n');
    parts.push('Use these proven patterns when writing editorInstruction fields:\n');
    for (const l of learnings) {
      const confidence = l.confidence >= 0.8 ? 'high' : l.confidence >= 0.5 ? 'medium' : 'low';
      const scope = l.siteId ? `[${l.siteId}]` : '[universal]';
      parts.push(`- ${scope} (${confidence}) ${l.promptTip}`);
    }
    parts.push('');
  }

  // Revision context
  if (revisionFeedback && previousPlan) {
    parts.push('## REVISION REQUEST\n');
    parts.push(`The owner reviewed the previous plan and said: "${revisionFeedback}"`);
    parts.push(`\nPrevious plan summary: ${previousPlan.summary}`);
    parts.push('Previous operations:');
    for (const op of previousPlan.operations) {
      parts.push(`- ${op.placement}: ${op.content.heading ?? ''} / ${op.content.bodyText?.substring(0, 80) ?? ''}`);
    }
    parts.push('\nPlease revise the plan according to the owner\'s feedback. Keep everything else the same unless the feedback specifically asks to change it.\n');
  }

  // Squarespace editor reference — so the strategist writes precise editorInstructions
  parts.push(`## Squarespace Fluid Engine Editor — Reference for Writing editorInstructions

Your editorInstruction fields are executed by a browser automation agent. Use these EXACT UI patterns:

### Adding a Section (PREFER templates — see catalog below)
1. Hover between existing sections to reveal "Add Section" button
2. Click "Add Section" — section picker panel opens on the left
3. Click a **category tab** (About, Services, Contact, Team, etc.) and pick a **template**
4. The template section loads with placeholder content already laid out professionally
5. Only use "+ Add Blank" when no template matches the content type
6. **templateIndex** (0-based): If provided in the instruction, pass it to addSection/addSectionFromTemplate for reliable position-based selection instead of text matching.

${formatTemplateCatalogSection(discoveredTemplates)}

**IMPORTANT:** Always include \`templateIndex\` (0-based position in the category grid, left-to-right, top-to-bottom) when you know it. The browser agent will click by position rather than name, avoiding mismatches.

**Template names are DESCRIPTIVE, not exact.** Always include \`templateIndex\` (0-based) when specified in the content plan. The browser agent tries index-based selection first, then falls back to text search.

**Template indices may change** as Squarespace updates their editor. If a template looks wrong after adding, the index may have shifted. The browser agent will verify the template after adding — if a product/store block is detected on a non-product section, it will fail fast and suggest retrying.

**After adding a template, placeholder content must be replaced:**
- Placeholder headings ("About Us", "Our Story", etc.) → replace with real headings
- Placeholder body text (Lorem ipsum, generic text) → replace with real copy
- Placeholder buttons ("Learn More", "Contact Us") → update label + URL, or remove
- Placeholder images → replace with real images if available

**Example editorInstruction using addSectionFromTemplate:**
"Use addSectionFromTemplate with category='About', template='Bio with Image', templateIndex=0, replacements: texts=[{searchText:'About Us', newText:'Meet Our Chef'}, {searchText:'Lorem ipsum', newText:'Chef Maria brings 20 years of experience...'}], images=[{searchText:'placeholder', imagePath:'/path/to/photo.jpg', altText:'Chef Maria'}], buttons=[{searchText:'Learn More', newLabel:'View Menu', url:'/menus'}]."

This is a SINGLE compound action — write it as ONE step, not separate steps.

### Adding Blocks Inside a Section (only for blank sections or adding extra blocks)
1. Click "Edit Section" (pencil icon) on the section toolbar to enter section edit mode
2. Click "Add Block" button in the TOP-LEFT corner of the editor
3. The block picker has a SEARCH bar — type "text", "button", "image" to find blocks
4. Click the block type to add it to the section

### Editing Text Blocks
1. Double-click the text block to enter inline edit mode
2. Type your content
3. To make a heading: highlight the text → click the "Format" dropdown in the floating toolbar → select H1, H2, H3, or H4
4. Press Enter to create a new paragraph, then type body text
5. Click outside the text block when done — changes auto-save
6. **To format text** (change heading level, bold, italic, alignment, font size): use the "formatTextBlock" compound action with searchText + formatting params (formatLevel, bold, italic, alignment, fontSize).
   Example editorInstruction: "Use formatTextBlock with searchText='Our Team', formatLevel='heading1', alignment='center'."

### Editing Button Blocks
1. Double-click the button to open its editor panel
2. Content tab: change button label text
3. Click the URL dropdown to set the link destination (paste external URL)
4. Design tab: set size (S/M/L), style (Primary/Secondary/Tertiary), and alignment (Left/Center/Right)
   These can be set directly via editButtonBlock: size='large', style='secondary', alignment='center'
5. Click outside to save

### Adding an Image Block with an Uploaded Image
1. Enter section edit mode (click "Edit Section" pencil icon)
2. Use the "addImageBlock" compound action with imagePath and optional altText
3. The browser agent handles: Add Block → search "Image" → click → upload file → set alt text
4. This is a SINGLE compound action — do NOT write it as separate steps
5. Example step in editorInstruction: "Use addImageBlock with imagePath='/path/to/screenshot.png' and altText='Project screenshot'."
6. IMPORTANT: Do NOT use addBlockToSection + replaceImage for new images — empty image placeholders have no alt text so replaceImage cannot find them.

### Changing Section Styling
1. Use the "editSectionStyle" compound action to change visual properties of an existing section
2. Available properties: sectionTheme (preferred), backgroundColor (hex), backgroundImage (file path), overlayOpacity (0-100), sectionHeight ("auto"/"small"/"medium"/"large"/"full"), contentWidth ("inset"/"full"), verticalAlignment ("top"/"middle"/"bottom"), sectionPadding ("none"/"small"/"medium"/"large"), blockSpacing ("none"/"small"/"medium"/"large")
3. PREFER sectionTheme over backgroundColor — themes apply coordinated colors (background, text, headings, buttons) for consistent design
4. Common themes: "Lightest", "Light", "Dark", "Darkest", "White", "Black"
5. Example editorInstruction: "Use editSectionStyle with searchText='About Our Team', sectionTheme='Dark', sectionHeight='large', verticalAlignment='middle', sectionPadding='large', blockSpacing='medium'."

### Adding Different Block Types
1. Use addBlockToSection to add any block type. Supported blockTypes with auto-content: "Text", "Button", "Quote", "Code", "Video"
2. blockTypes that are added but require manual configuration: "Form", "Gallery"
3. blockTypes with no editable content: "Line" (divider)
4. For Quote blocks: content = the quote text. Use editQuoteBlock to edit existing quotes (supports attribution).
5. For Code/Embed blocks: content = HTML or code. Use editCodeBlock to edit existing code blocks.
6. For Video blocks: content = the video URL (YouTube, Vimeo, etc.)

### Adding Image Blocks via API
For single image additions, use \`contentStrategy: "blank_api"\` with an apiBlock of type "image":
\`\`\`json
{ "type": "image", "imagePath": "/path/to/photo.jpg", "altText": "Description of the image", "title": "Image Title" }
\`\`\`
The execution pipeline uploads the image to Squarespace's media library and adds the image block via Content Save API (~2-5s).
The \`imagePath\` should reference a file from the task's \`imagePaths\` array or from \`storage/uploads/\`.

### Adding Gallery Sections (Multiple Images)
For gallery pages with multiple images, use \`contentStrategy: "blank_api"\` with apiBlocks containing \`{ type: "gallery" }\` objects:
\`\`\`json
{
  "type": "gallery",
  "images": [
    { "imagePath": "/path/to/photo1.jpg", "altText": "First image" },
    { "imagePath": "/path/to/photo2.jpg", "altText": "Second image" },
    { "imagePath": "/path/to/photo3.jpg", "altText": "Third image" }
  ],
  "galleryStyle": "grid",
  "columns": 3
}
\`\`\`
The execution pipeline batch-uploads all images in parallel and arranges them in a grid layout via Content Save API.

**Choosing gallery style:**
- **grid** — Equal-sized images in rows/columns. Best for: portfolio pages, product galleries, team photos. Most common choice.
- **slideshow** — Single image at a time, full-width. Best for: hero image rotations, feature showcases, before/after comparisons.
- **collage** — Mixed-size images in a mosaic layout. Best for: event photos, creative portfolios, mixed-aspect-ratio images.

**Column options:** 2 columns (large images, side-by-side), 3 columns (balanced grid, most common), 4 columns (compact grid, many images).

**imagePaths from the task** should be referenced directly in the gallery block's images array. Use \`imagePaths\` from the task when the user has uploaded images via WhatsApp or email.

You can combine gallery blocks with text blocks in the same section for captions or headings above the gallery.

### Announcement Bar (PAID FEATURE — Business/Commerce plans only)
- Path: Pages icon (stacked papers) in left sidebar → scroll down past all pages → expand "Marketing Tools" → click "Announcement Bar"
- Enable it via the dropdown, type the message text, optionally add a clickthrough URL
- Click "Save" to publish — it appears on EVERY page
- This is NOT under the Design/paintbrush icon. It's under Marketing Tools in the Pages panel.
- ⚠️ Requires Business or Commerce plan. If not available, inform the site owner.

### Saving
- Click "Save" in the top-right to save changes
- Block editors auto-save when you click away
`);

  // Layout presets for blank_api sections
  parts.push(`\n${formatPresetsForPrompt()}\n`);

  // Output format
  parts.push(`## Output Format

Respond with JSON matching this structure:
{
  "summary": "Brief summary of the content plan for the owner's review",
  "operations": [
    {
      "taskId": "${tasks[0]?.id ?? 'task-id'}",
      "siteId": "${tasks[0]?.siteId ?? 'site-id'}",
      "targetPage": "${tasks[0]?.targetPage ?? 'home'}",
      "operationType": "add_section",
      "placement": "Below the hero section, above the existing menu preview",
      "content": {
        "heading": "Restaurant Week at Smyth Tavern",
        "bodyText": "January 21 - February 9, 2026. Join us for a specially crafted three-course prix fixe dinner. $60 per person.",
        "button": { "label": "Reserve Now", "url": "https://resy.com/cities/ny/smyth-tavern" },
        "blockType": "text"
      },
      "editorInstruction": "1. Use addSectionFromTemplate with category='Intro', template='Text and Image', templateIndex=0, replacements: texts=[{searchText:'Heading', newText:'Restaurant Week at Smyth Tavern'}, {searchText:'Lorem ipsum', newText:'January 21 - February 9, 2026. Join us for a specially crafted three-course prix fixe dinner. $60 per person.'}], buttons=[{searchText:'Learn More', newLabel:'Reserve Now', url:'https://resy.com/cities/ny/smyth-tavern'}]. 2. Verify the section shows the correct content."
    }
  ],
  "sources": ["https://example.com/restaurant-week"],
  "estimatedMinutes": 3
}

Example with image (uses addSectionFromTemplate with image replacement):
{
  "operationType": "add_section",
  "placement": "Below existing project sections",
  "content": {
    "heading": "Menu Formatter",
    "bodyText": "A drag-and-drop menu builder for restaurants.",
    "button": { "label": "View Project", "url": "https://menu-block.lovable.app" },
    "imagePath": "/Users/timcox/squarespace helper/storage/project-screenshots/menu-block.png",
    "imageAltText": "Menu Formatter app screenshot",
    "templateCategory": "About",
    "templateName": "Bio with Image",
    "templateIndex": 0
  },
  "editorInstruction": "1. Use addSectionFromTemplate with category='About', template='Bio with Image', templateIndex=0, replacements: texts=[{searchText:'About Us', newText:'Menu Formatter'}, {searchText:'Lorem ipsum', newText:'A drag-and-drop menu builder for restaurants.'}], buttons=[{searchText:'Learn More', newLabel:'View Project', url:'https://menu-block.lovable.app'}], images=[{searchText:'placeholder', imagePath:'/Users/timcox/squarespace helper/storage/project-screenshots/menu-block.png', altText:'Menu Formatter app screenshot'}]. 2. Verify the section."
}

Blank+API example (text-heavy content — no browser agent needed):
{
  "operationType": "add_section",
  "placement": "New section for work experience",
  "content": {
    "heading": "Work Experience",
    "contentStrategy": "blank_api",
    "apiBlocks": [
      { "html": "Work Experience", "formatting": { "tag": "h2", "alignment": "center" } },
      { "html": "Senior Developer — Acme Corp (2020-2024)", "formatting": { "tag": "h3" } },
      { "html": "Led frontend architecture redesign, migrating from legacy jQuery to React.", "formatting": { "tag": "p" } },
      { "html": "Developer — StartupCo (2017-2020)", "formatting": { "tag": "h3" } },
      { "html": "Built React applications for e-commerce clients.", "formatting": { "tag": "p" } }
    ]
  },
  "editorInstruction": "Add a blank section, then populate with text blocks via API. This operation uses the blank_api strategy — the execution pipeline handles it automatically."
}

**apiBlocks formatting options** (for blank_api strategy):
Each apiBlock can include an optional \`formatting\` object to control HTML rendering:
- \`tag\`: HTML tag — "h1", "h2", "h3", "h4", or "p" (default: "p"). Use "h2" for section headings, "h3" for sub-headings.
- \`alignment\`: Text alignment — "left", "center", or "right". Adds \`text-align\` CSS to the block.
- \`bold\`: If true, wraps text content in \`<strong>\` tags.
- \`italic\`: If true, wraps text content in \`<em>\` tags.

When \`formatting\` is provided, pass PLAIN TEXT in the \`html\` field (no HTML tags). The formatting options will be applied automatically to produce the correct HTML.
When \`formatting\` is NOT provided, you can pass raw HTML directly in the \`html\` field (e.g., \`"<h2>Heading</h2>"\`) — it will be used as-is.

Blank+API example with layout preset (multi-column):
{
  "operationType": "add_section",
  "placement": "New section for skills overview",
  "content": {
    "heading": "Skills",
    "contentStrategy": "blank_api",
    "layoutPreset": "two-column",
    "apiBlocks": [
      { "html": "<h3>Technical Skills</h3><p>JavaScript, TypeScript, React, Node.js</p>" },
      { "html": "<h3>Soft Skills</h3><p>Leadership, Communication, Project Management</p>" }
    ]
  },
  "editorInstruction": "Add a blank section with two-column layout, then populate with text blocks via API. This operation uses the blank_api strategy with a layout preset — the execution pipeline handles it automatically."
}

Blank+API example with button (simple button section — no browser agent needed):
{
  "operationType": "add_section",
  "placement": "Below the hero section",
  "content": {
    "heading": "Get Started",
    "contentStrategy": "blank_api",
    "apiBlocks": [
      { "html": "Get Started", "formatting": { "tag": "h2", "alignment": "center" } },
      { "type": "button", "label": "Book a Call", "url": "https://calendly.com/example" }
    ]
  },
  "editorInstruction": "Add a blank section with a heading and button via API. This operation uses the blank_api strategy — the execution pipeline handles it automatically."
}

Blank+API example with standalone button (just a button, nothing else):
{
  "operationType": "add_section",
  "placement": "Below the contact info section",
  "content": {
    "contentStrategy": "blank_api",
    "apiBlocks": [
      { "type": "button", "label": "Howdy", "url": "https://timcox.co" }
    ]
  },
  "editorInstruction": "Add a blank section with a single button via API. This operation uses the blank_api strategy — the execution pipeline handles it automatically."
}

Blank+API example with image block:
{
  "operationType": "add_section",
  "placement": "Below the about section",
  "content": {
    "heading": "Our Work",
    "contentStrategy": "blank_api",
    "apiBlocks": [
      { "html": "Our Work", "formatting": { "tag": "h2", "alignment": "center" } },
      { "type": "image", "imagePath": "/Users/timcox/squarespace helper/storage/uploads/project-screenshot.png", "altText": "Project screenshot showing the dashboard" }
    ]
  },
  "editorInstruction": "Add a blank section with a heading and image via API. This operation uses the blank_api strategy — the execution pipeline handles it automatically."
}

Blank+API example with gallery (multiple images in a grid):
{
  "operationType": "add_section",
  "placement": "New portfolio gallery section",
  "content": {
    "heading": "Portfolio",
    "contentStrategy": "blank_api",
    "apiBlocks": [
      { "html": "Portfolio", "formatting": { "tag": "h2", "alignment": "center" } },
      {
        "type": "gallery",
        "images": [
          { "imagePath": "/path/to/project1.jpg", "altText": "Project One" },
          { "imagePath": "/path/to/project2.jpg", "altText": "Project Two" },
          { "imagePath": "/path/to/project3.jpg", "altText": "Project Three" }
        ],
        "galleryStyle": "grid",
        "columns": 3
      }
    ]
  },
  "editorInstruction": "Add a blank section with a heading and 3-column image gallery via API. This operation uses the blank_api strategy — the execution pipeline handles it automatically."
}

Fallback example (blank section when no template fits):
{
  "operationType": "add_section",
  "placement": "Custom layout section",
  "content": { "heading": "Custom Content", "bodyText": "..." },
  "editorInstruction": "1. Hover to reveal 'Add Section'. 2. Click '+ Add Blank', then 'Section'. 3. Enter section edit mode. 4. Add blocks manually..."
}

IMPORTANT:
- **Content Strategy Routing** — choose the right strategy per operation:
  - **template**: Use \`addSectionFromTemplate\` for standard layouts (About, Contact, Team, Services, FAQ). Best when: the template closely matches the desired layout, few text replacements needed, design/visual layout matters. Set \`contentStrategy: "template"\` and provide \`templateIndex\`.
  - **blank_api**: Use for content-heavy sections (CV, resume, long-form text, user-provided exact copy) OR simple button additions. Best when: 3+ text blocks per section, user provides exact text content, layout is simple (stacked text blocks), or it's just a button with optional heading. Set \`contentStrategy: "blank_api"\` and provide \`apiBlocks\` array. For text blocks use \`{ html: "..." }\`. For button blocks use \`{ type: "button", label: "Button Text", url: "https://..." }\`. The execution pipeline will add a blank section and populate via API (no browser agent needed — ~1 second vs ~60 seconds for browser agent).
  - **blank_api with buttons**: When the task is a simple button addition (one button, maybe a heading), use \`contentStrategy: "blank_api"\`. In \`apiBlocks\`, use the button format: \`{ type: "button", label: "Click Me", url: "https://example.com" }\`. You can mix text and button blocks in the same section. This gets routed to the API fast path.
  - **blank_api with images**: When the task provides image files (via \`imagePaths\`), use \`contentStrategy: "blank_api"\` with \`{ type: "image", imagePath: "/path/to/image.jpg", altText: "..." }\` apiBlocks. The pipeline uploads and adds images via API (~2-5s per image).
  - **blank_api with gallery**: For multiple images (portfolio, gallery page, photo grid), use \`contentStrategy: "blank_api"\` with a single \`{ type: "gallery", images: [...], galleryStyle: "grid", columns: 3 }\` apiBlock. All images are uploaded in parallel and arranged in a grid layout. This is far faster than UI automation for multi-image tasks.
  - **manual**: Use for custom layouts, code/embed blocks, interactive elements, or anything that doesn't fit the above. Set \`contentStrategy: "manual"\` and write detailed \`editorInstruction\`.
  - **Default to "template"** unless the content is clearly text-heavy (3+ paragraphs of user-provided text) or requires no visual template.
- The addSectionFromTemplate action handles: add template + replace all placeholder content in ONE step. Write it as a SINGLE instruction step, not separate steps.
- Write the EXACT heading and body text to use. No placeholders.
- The "editorInstruction" must be NUMBERED step-by-step instructions for a browser automation agent. Use the Squarespace editor reference above to write precise instructions with exact button names and locations.
- Match the tone and style of the existing site (${siteAnalysis?.brandTone ?? 'professional'}).
- Keep promotional text concise and compelling.
- If the task involves an image change but no image file is available, describe the ideal image and note that the owner should provide one, or suggest using a stock photo.
- When an image file path is provided in the content spec (imagePath), include it in the addSectionFromTemplate replacements.images array. If adding an image to a blank section, use the "addImageBlock" compound action.
- For button URLs, use a reasonable default (e.g., the business's booking platform) or note that the owner should confirm the URL.
- Each operation's editorInstruction should be self-contained — assume the agent starts in edit mode on the correct page.
- **When page structure data is available** (see "Current Page Structure" section above), use it to make precise placement decisions. Reference sections by their position number and content (e.g., "After section 3 which contains the About text" rather than "Below the about section"). This prevents misplacement.
- Match the existing design properties (theme, text alignment, heading levels, colors) when adding new sections
- Use the same section theme as adjacent sections unless the task specifies otherwise
- Preserve the heading hierarchy (if existing sections use h2 for headings, new sections should use h2 too)
- Match text alignment patterns (if the site uses center-aligned text, new text should be centered)
- Include formatting hints in apiBlocks when alignment or styling should match existing content`);

  return parts.join('\n');
}

// ─── Response Parser ────────────────────────────────────────────────────────

function parsePlanResponse(text: string, tasks: Task[]): ContentPlan {
  try {
    // Try fenced code block first, then naked JSON object
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON block found in response');
    }
    let jsonStr = (jsonMatch[1] ?? jsonMatch[0]).trim();
    logger.info({ jsonLength: jsonStr.length, responseLength: text.length }, 'Content strategist: parsing JSON response');

    // Attempt repair of truncated JSON (common when max_tokens is hit)
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch (firstErr) {
      logger.warn({ error: (firstErr as Error).message }, 'Content strategist: first JSON parse failed, attempting repair');
      // Try to repair: close open arrays/objects
      jsonStr = repairTruncatedJson(jsonStr);
      parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      logger.info('Content strategist: JSON repair succeeded');
    }

    const operations: ContentOperation[] = Array.isArray(parsed.operations)
      ? (parsed.operations as Record<string, unknown>[]).map((op) => ({
          taskId: (op.taskId as string) ?? tasks[0]?.id ?? 'unknown',
          siteId: (op.siteId as string) ?? tasks[0]?.siteId ?? 'unknown',
          targetPage: (op.targetPage as string) ?? tasks[0]?.targetPage ?? 'home',
          operationType: (op.operationType as ContentOperation['operationType']) ?? 'add_section',
          placement: (op.placement as string) ?? 'On the page',
          content: parseContentSpec(op.content as Record<string, unknown> | undefined),
          editorInstruction: (op.editorInstruction as string) ?? 'Edit the page content',
        }))
      : [];

    return {
      summary: (parsed.summary as string) ?? 'Content plan',
      operations,
      sources: Array.isArray(parsed.sources) ? (parsed.sources as string[]) : [],
      estimatedMinutes: (parsed.estimatedMinutes as number) ?? 5,
    };
  } catch (err) {
    logger.warn({ error: errMsg(err), responseLength: text.length, responseStart: text.substring(0, 200) }, 'Content strategist: could not parse plan response as JSON');
    // Fallback: create a single operation per task with a human-readable summary
    const taskSummary = tasks.length === 1
      ? (tasks[0]?.description ?? 'Update page content').substring(0, 200)
      : `${tasks.length} tasks on the ${tasks[0]?.targetPage ?? 'home'} page`;
    return {
      summary: taskSummary,
      operations: tasks.map((t) => ({
        taskId: t.id,
        siteId: t.siteId,
        targetPage: t.targetPage ?? 'home',
        operationType: 'add_section' as const,
        placement: 'On the page',
        content: { bodyText: (t.description ?? '').substring(0, 300) },
        editorInstruction: text,
      })),
      sources: [],
      estimatedMinutes: 5,
    };
  }
}

function parseContentSpec(raw: Record<string, unknown> | undefined): ContentOperation['content'] {
  if (!raw) return {};
  const button = raw.button as Record<string, unknown> | undefined;
  return {
    heading: (raw.heading as string) ?? undefined,
    bodyText: (raw.bodyText as string) ?? undefined,
    button: button ? { label: (button.label as string) ?? '', url: (button.url as string) ?? '' } : undefined,
    imageQuery: (raw.imageQuery as string) ?? undefined,
    imagePath: (raw.imagePath as string) ?? undefined,
    imageAltText: (raw.imageAltText as string) ?? undefined,
    blockType: (raw.blockType as ContentOperation['content']['blockType']) ?? undefined,
    sectionTheme: (raw.sectionTheme as string) ?? undefined,
    sectionHeight: (raw.sectionHeight as ContentOperation['content']['sectionHeight']) ?? undefined,
    contentWidth: (raw.contentWidth as ContentOperation['content']['contentWidth']) ?? undefined,
    verticalAlignment: (raw.verticalAlignment as ContentOperation['content']['verticalAlignment']) ?? undefined,
    overlayOpacity: (raw.overlayOpacity as number) ?? undefined,
    sectionPadding: (raw.sectionPadding as ContentOperation['content']['sectionPadding']) ?? undefined,
    blockSpacing: (raw.blockSpacing as ContentOperation['content']['blockSpacing']) ?? undefined,
    textFormatLevel: (raw.textFormatLevel as ContentOperation['content']['textFormatLevel']) ?? undefined,
    textBold: (raw.textBold as boolean) ?? undefined,
    textItalic: (raw.textItalic as boolean) ?? undefined,
    textAlignment: (raw.textAlignment as ContentOperation['content']['textAlignment']) ?? undefined,
    textFontSize: (raw.textFontSize as ContentOperation['content']['textFontSize']) ?? undefined,
    buttonSize: (raw.buttonSize as ContentOperation['content']['buttonSize']) ?? undefined,
    buttonStyle: (raw.buttonStyle as ContentOperation['content']['buttonStyle']) ?? undefined,
    buttonAlignment: (raw.buttonAlignment as ContentOperation['content']['buttonAlignment']) ?? undefined,
    templateCategory: (raw.templateCategory as string) ?? undefined,
    templateName: (raw.templateName as string) ?? undefined,
    contentStrategy: (raw.contentStrategy as ContentOperation['content']['contentStrategy']) ?? undefined,
    apiBlocks: Array.isArray(raw.apiBlocks) ? (raw.apiBlocks as ContentOperation['content']['apiBlocks']) : undefined,
    templateIndex: typeof raw.templateIndex === 'number' ? raw.templateIndex : undefined,
    layoutPreset: typeof raw.layoutPreset === 'string' ? raw.layoutPreset : undefined,
  };
}

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 * This handles the common case where Claude's output gets cut off at max_tokens.
 */
function repairTruncatedJson(json: string): string {
  // Remove trailing incomplete key-value pairs (e.g., `"key": "partial val`)
  // by trimming back to the last complete value
  let repaired = json;

  // If we're mid-string, close the string
  const quoteCount = (repaired.match(/(?<!\\)"/g) ?? []).length;
  if (quoteCount % 2 !== 0) {
    // We're inside an unclosed string — truncate back to last complete field or close it
    repaired += '"';
  }

  // Remove trailing comma if present (after closing quotes)
  repaired = repaired.replace(/,\s*$/, '');

  // Count open brackets/braces and close them
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (ch === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
      inString = !inString;
    }
    if (!inString) {
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }
  }

  // Close open arrays then objects
  for (let i = 0; i < openBrackets; i++) repaired += ']';
  for (let i = 0; i < openBraces; i++) repaired += '}';

  return repaired;
}
