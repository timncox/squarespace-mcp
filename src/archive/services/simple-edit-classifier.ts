/**
 * Simple Edit Classifier
 *
 * Classifies tasks as "simple edits" that can bypass the full content planning
 * pipeline and go straight to Content Save API fast paths. Uses pre-LLM heuristics
 * for obvious cases and Claude Haiku for ambiguous ones.
 */

import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_HAIKU } from '../config/models.js';
import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';
import type { Task } from '../models/task.js';
import type { PageStructure } from '../agents/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SimpleEditType =
  | 'text_replace'
  | 'text_add'
  | 'button_edit'
  | 'image_metadata'
  | 'block_remove'
  | 'menu_update'
  | 'footer_edit'
  | 'header_edit'
  | 'css_change'
  | 'section_style'
  | 'image_replace'
  | 'button_add'
  | 'section_reorder'
  | 'block_move'
  | 'page_seo'
  | 'blog_post_create'
  | 'blog_post_update'
  | 'site_identity'
  | 'business_hours_update';

export interface SimpleEditClassification {
  isSimpleEdit: boolean;
  editType?: SimpleEditType;
  confidence: 'high' | 'medium' | 'low';
  params: {
    searchText?: string;
    newContent?: string;
    blockType?: 'heading' | 'text';
    headingLevel?: 1 | 2 | 3 | 4;
    buttonLabel?: string;
    buttonUrl?: string;
    cssContent?: string;
    cssMode?: 'append' | 'replace';
    menuItems?: string;
    imageFields?: { title?: string; description?: string; altText?: string };
    sectionSearch?: string | number;
    sectionStyles?: { sectionTheme?: string; sectionHeight?: string; contentWidth?: string; backgroundColor?: string };
    imagePath?: string;
    imageAltText?: string;
    newButtonLabel?: string;
    newButtonUrl?: string;
    moveDirection?: 'up' | 'down';
    moveSteps?: number;
    seoTitle?: string;
    seoDescription?: string;
    navigationTitle?: string;
    urlId?: string;
    enabled?: boolean;
    // Blog post params
    postTitle?: string;
    postBody?: string;         // HTML or plain text body content
    postExcerpt?: string;
    postTags?: string[];
    postCategories?: string[];
    postDraft?: boolean;       // true = save as draft, false = publish immediately
    postSearchTitle?: string;  // for blog_post_update: find existing post by this title
    // Site identity params
    businessName?: string;
    businessAddress?: string;
    businessPhone?: string;
    businessEmail?: string;
    // Business hours params
    businessHours?: Record<string, string>;
  };
  reason: string;
}

// ─── Creative / Complex Patterns ────────────────────────────────────────────

const COMPLEX_PATTERNS = [
  /\bcreate\s+(a\s+)?new\s+page\b/i,
  /\bgallery\b/i,
  /\badd\s+(a\s+)?(new\s+)?section/i,
  /\bmulti(ple)?\s+section/i,
  /\bwrite\s+(an?\s+)?/i,
  /\bcome\s+up\s+with\b/i,
  /\bsuggest\b/i,
  /\bdesign\b/i,
  /\blayout\b/i,
  /\btemplate\b/i,
  /\bresearch\b/i,
  /\bcreate\s+(a\s+)?portfolio\b/i,
  /\bbuild\b/i,
];

// ─── Pre-LLM Fast Checks ───────────────────────────────────────────────────

function tryPreLlmClassification(task: Task): SimpleEditClassification | null {
  // 1. remove_content with contentToFind → block_remove
  if (task.taskType === 'remove_content' && task.contentToFind) {
    return {
      isSimpleEdit: true,
      editType: 'block_remove',
      confidence: 'high',
      params: { searchText: task.contentToFind },
      reason: 'Task type is remove_content with contentToFind specified',
    };
  }

  // 2. contentToFind + contentToAdd both present → text_replace
  if (task.contentToFind && task.contentToAdd) {
    return {
      isSimpleEdit: true,
      editType: 'text_replace',
      confidence: 'high',
      params: { searchText: task.contentToFind, newContent: task.contentToAdd },
      reason: 'Both contentToFind and contentToAdd are specified',
    };
  }

  // 3. update_menu_block with contentToAdd → menu_update
  if (task.taskType === 'update_menu_block' && task.contentToAdd) {
    return {
      isSimpleEdit: true,
      editType: 'menu_update',
      confidence: 'high',
      params: {
        searchText: task.contentToFind || task.contentToAdd.split('\n')[0].trim(),
        menuItems: task.contentToAdd,
      },
      reason: 'Task type is update_menu_block with contentToAdd specified',
    };
  }

  // 4. Blog post create — description contains "blog post" with a clear title marker
  // This runs before the complexity gate, bypassing the /\bwrite\b/ COMPLEX_PATTERN.
  // Requires an explicit title ("titled X" or "called X"). Generative-only requests
  // ("write something about...") will not match and fall through to full complexity check.
  // Skip if the description also mentions creating a blog PAGE (needs full pipeline).
  const mentionsBlogPageCreation = /\b(?:create|add|set\s*up|make)\s+(?:a\s+)?(?:new\s+)?blog\s+page\b/i.test(task.description ?? '');
  const blogPostTitleMatch = task.description?.match(
    /\bblog\s+post\b.+\b(?:titled?|called|named?)\s+["']?(.+?)["']?\s*(?:,|$|\.|\bwith\b|\babout\b)/i,
  );
  if (blogPostTitleMatch && !mentionsBlogPageCreation) {
    const isDraft =
      /\b(?:draft|don'?t\s+publish|save\s+as\s+draft|not\s+live)\b/i.test(task.description ?? '') ||
      !/\b(?:publish|live|go\s+live)\b/i.test(task.description ?? '');
    return {
      isSimpleEdit: true,
      editType: 'blog_post_create',
      confidence: 'high',
      params: {
        postTitle: blogPostTitleMatch[1].trim(),
        postDraft: isDraft,
      },
      reason: 'Blog post creation with explicit title detected',
    };
  }

  // 5. Business hours update — DON'T return here. The pre-LLM check can detect the
  // intent but can't extract the actual hours data from the description. Let the LLM
  // classifier handle it so it can extract params AND return high confidence.

  return null;
}

// ─── Complexity Gate ────────────────────────────────────────────────────────

function isObviouslyComplex(task: Task): SimpleEditClassification | null {
  const desc = task.description || '';

  // Reference image means visual context needed — not simple
  if (task.referenceImagePath) {
    return {
      isSimpleEdit: false,
      confidence: 'high',
      params: {},
      reason: 'Task has a reference image requiring visual interpretation',
    };
  }

  // Multiple images attached → gallery/complex
  if (task.imagePaths && task.imagePaths.length > 0) {
    return {
      isSimpleEdit: false,
      confidence: 'high',
      params: {},
      reason: 'Task has attached images suggesting gallery or complex operation',
    };
  }

  // Check for complex patterns in description
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(desc)) {
      return {
        isSimpleEdit: false,
        confidence: 'high',
        params: {},
        reason: `Description matches complex pattern: ${pattern.source}`,
      };
    }
  }

  return null;
}

// ─── LLM Classification ────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are a task classifier for a Squarespace website editor. Classify whether a task is a "simple edit" that can be done via a single API call, or a complex task requiring full content planning.

## Simple Edit Types

1. **text_replace** — Find existing text and replace it with new text
   Examples: "Change the phone number from 555-1234 to 555-5678", "Update the address to 123 Main St", "Change the main heading to Welcome"
   Params: searchText (existing text to find — set null if user refers to element by role like "the heading"), newContent (replacement text), blockType (optional: "heading" if targeting a heading/h1/h2/h3 element), headingLevel (1-4, required when blockType is "heading" — h1 for main/page heading, h2 for section titles, h3 for sub-sections, h4 for minor headings)

2. **text_add** — Add a line of text to an existing block
   Examples: "Add 'Now open Sundays' below the hours section"
   Params: searchText (nearby text to find the right block), newContent (text to add)

3. **button_edit** — Change a button's label or URL
   Examples: "Change the 'Book Now' button to link to opentable.com", "Rename 'Contact' button to 'Get in Touch'"
   Params: buttonLabel (current or new label), buttonUrl (new URL if changing)

4. **image_metadata** — Change image alt text, title, or description
   Examples: "Update the hero image alt text to 'Restaurant dining room'"
   Params: searchText (to find the image), imageFields (title/description/altText)

5. **block_remove** — Remove a specific block or section
   Examples: "Remove the 'Happy Hour' section", "Delete the old specials block"
   Params: searchText (text in the block to remove)

6. **menu_update** — Update menu items, prices, or descriptions
   Examples: "Change the burger price to $18", "Add a new dessert: Tiramisu $12"
   Params: menuItems (new menu text for merge)

7. **footer_edit** — Edit footer text (address, phone, hours, copyright)
   Examples: "Update the footer phone number to 555-9999"
   Params: searchText (existing footer text), newContent (new text)

8. **header_edit** — Edit site header text (announcement bar, header button text, tagline)
   Examples: "Change the header announcement to 'Now Open!'", "Update the header tagline"
   Params: searchText (existing header text), newContent (new text)

9. **css_change** — Add or modify custom CSS
   Examples: "Make the header font larger", "Add CSS to hide the announcement bar"
   Params: cssContent (the CSS code), cssMode ("append" or "replace")

9. **section_style** — Change section visual properties (theme, height, background)
   Examples: "Make the hero section full width", "Change the contact section to dark theme"
   Params: sectionSearch (text in the section or section index to find it), sectionStyles (theme/height/width/backgroundColor)

10. **image_replace** — Replace an existing image with a new uploaded image
    Examples: "Replace the logo with this image", "Update the hero photo"
    Params: searchText (alt text or nearby text to find the image), imagePath (provided file path)

11. **button_add** — Add a new button to a section
    Examples: "Add a Book Now button linking to calendly.com"
    Params: newButtonLabel (button text), newButtonUrl (destination URL), searchText (optional: nearby text for placement)

12. **section_reorder** — Move a section up or down on the page
    Examples: "Move the contact section above the about section"
    Params: sectionSearch (text to find section), moveDirection ("up" or "down")

13. **block_move** — Move a block within its section
    Examples: "Move the phone number below the address"
    Params: searchText (text in the block), moveDirection ("up" or "down")

14. **page_seo** — Update page SEO settings (title, meta description, URL slug, navigation title, visibility)
    Examples: "Update the about page title to 'About Our Team'", "Change the meta description for the homepage", "Set the SEO title to 'Best Restaurant in NYC'", "Rename the page URL to /our-story", "Disable the contact page"
    Params: seoTitle (new page/SEO title), seoDescription (meta description), navigationTitle (nav menu label), urlId (URL slug), enabled (true/false for visibility)

15. **blog_post_create** — Create a new blog post. Required: targetPage (blog page slug, e.g. "blog" or "news"), postTitle. Optional: postBody (HTML), postExcerpt, postTags (array), postCategories (array), postDraft (true=draft, false=publish immediately — default true).

16. **blog_post_update** — Edit or update an existing blog post. Required: targetPage (blog page slug), postSearchTitle (current title to find the post). Optional: postTitle (new title), postBody (new body HTML), postExcerpt, postTags, postCategories, postDraft.

17. **site_identity** — Update site business information (business name, address, phone number, or email address)
    Examples: "Change the business name to Acme Corp", "Update the phone number to 555-1234", "Set the business address to 123 Main St"
    Params: businessName (if updating name), businessAddress (if updating address), businessPhone (if updating phone), businessEmail (if updating email)

18. **business_hours_update** — Update business/opening/trading hours
    Examples: "Set Monday hours to 9am-5pm", "Close on Sundays", "Update business hours to 9am-5pm weekdays"
    Params: businessHours (Record<string, string> — day → hours text, e.g. { "monday": "9am - 5pm", "tuesday": "Closed" })

19. **header_edit** — Note: Use this type ONLY when the user explicitly mentions "header", "announcement bar", or "header button". Page headings (h1/h2 text) should use text_replace instead.

## Blog Post Param Extraction
- postTitle: title of the blog post (for create) or new title (for update)
- postBody: body content as HTML — only extract if explicitly provided by the user, not AI-generated
- postSearchTitle: for blog_post_update only — the existing post title to search for
- postDraft: true if "save as draft", "don't publish", or timing is unclear; false if "publish now" or "make live"
- postTags: array of tag strings extracted from "tag with X, Y, Z" or "tags: X, Y"
- postExcerpt: short summary if user provides one explicitly

## NOT Simple Edits (return isSimpleEdit: false)
- Creating new pages or galleries
- Adding new sections or multiple blocks
- Creative content generation (writing copy, suggesting content)
- Complex layout changes or template-based work
- Tasks requiring research or web scraping
- Tasks with attached reference images
- Vague or multi-step instructions

## Response Format
Respond with JSON only:
\`\`\`json
{
  "isSimpleEdit": true,
  "editType": "text_replace",
  "confidence": "high",
  "params": { "searchText": "old text", "newContent": "new text" },
  "reason": "Direct text replacement with both values specified"
}
\`\`\``;

function buildUserMessage(task: Task, pageStructure?: PageStructure): string {
  const parts: string[] = [];

  parts.push(`## Task`);
  if (task.taskType) parts.push(`Type: ${task.taskType}`);
  if (task.description) parts.push(`Description: ${task.description}`);
  if (task.contentToFind) parts.push(`Content to find: ${task.contentToFind}`);
  if (task.contentToAdd) parts.push(`Content to add: ${task.contentToAdd}`);
  if (task.targetPage) parts.push(`Target page: ${task.targetPage}`);

  if (pageStructure && pageStructure.sections.length > 0) {
    parts.push('');
    parts.push(`## Page Structure (${pageStructure.sectionCount} sections)`);
    for (const section of pageStructure.sections) {
      const blockSnippets = section.blocks
        .slice(0, 5)
        .map((b) => {
          if (b.textSnippet) return `  - [${b.type}] "${b.textSnippet}"`;
          if (b.buttonLabel) return `  - [button] "${b.buttonLabel}"`;
          if (b.imageAlt) return `  - [image] alt="${b.imageAlt}"`;
          return `  - [${b.type}]`;
        })
        .join('\n');
      parts.push(`Section ${section.index}: "${section.name}" (${section.blockCount} blocks)`);
      if (blockSnippets) parts.push(blockSnippets);
    }
  }

  return parts.join('\n');
}

function parseLlmResponse(responseText: string): SimpleEditClassification {
  // Extract JSON from markdown code block or raw JSON
  let jsonStr = responseText;
  const jsonBlockMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1];
  }

  const parsed = JSON.parse(jsonStr.trim());

  return {
    isSimpleEdit: !!parsed.isSimpleEdit,
    editType: parsed.editType || undefined,
    confidence: parsed.confidence || 'low',
    params: parsed.params || {},
    reason: parsed.reason || 'LLM classification',
  };
}

// ─── Main Export ────────────────────────────────────────────────────────────

export async function classifySimpleEdit(
  task: Task,
  pageStructure?: PageStructure,
): Promise<SimpleEditClassification> {
  // 1. Pre-LLM fast checks (skip LLM entirely)
  const preLlm = tryPreLlmClassification(task);
  if (preLlm) {
    logger.info({ taskId: task.id, editType: preLlm.editType, reason: preLlm.reason }, 'Pre-LLM simple edit classification');
    return preLlm;
  }

  // 2. Complexity gate (obviously complex tasks)
  const complex = isObviouslyComplex(task);
  if (complex) {
    logger.info({ taskId: task.id, reason: complex.reason }, 'Task classified as complex (skipping LLM)');
    return complex;
  }

  // 3. Empty description → can't classify
  if (!task.description?.trim()) {
    return {
      isSimpleEdit: false,
      confidence: 'low',
      params: {},
      reason: 'No task description provided',
    };
  }

  // 4. LLM classification (with one retry on connection errors)
  const userMessage = buildUserMessage(task, pageStructure);
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await getAnthropicClient().messages.create({
        model: MODEL_HAIKU,
        max_tokens: 1024,
        system: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      const responseText = textBlock?.type === 'text' ? textBlock.text : '';

      const classification = parseLlmResponse(responseText);

      logger.info(
        { taskId: task.id, isSimpleEdit: classification.isSimpleEdit, editType: classification.editType, confidence: classification.confidence },
        'LLM simple edit classification',
      );

      return classification;
    } catch (err) {
      const msg = errMsg(err);
      const isConnectionError = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|Connection error|Could not resolve authentication/i.test(msg);

      if (isConnectionError && attempt < MAX_ATTEMPTS) {
        logger.warn({ taskId: task.id, error: msg, attempt }, 'Simple edit classifier: connection error — retrying after proxy restart');
        try {
          const { ensureProxy } = await import('../utils/proxy-manager.js');
          await ensureProxy();
        } catch {
          // Best effort — retry anyway
        }
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      logger.error({ taskId: task.id, error: msg }, 'Simple edit classification failed');
      return {
        isSimpleEdit: false,
        confidence: 'low',
        params: {},
        reason: `Classification failed: ${msg}`,
      };
    }
  }

  // Unreachable, but TypeScript needs it
  return { isSimpleEdit: false, confidence: 'low' as const, params: {}, reason: 'Classification exhausted retries' };
}
