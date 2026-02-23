/**
 * Squarespace Dynamic Doc Lookup — fetches relevant Squarespace support
 * articles when the browser agent is stuck on an unfamiliar UI pattern.
 *
 * Flow:
 * 1. Build a search query from what the agent is trying to do
 * 2. Fetch the Squarespace help center search results
 * 3. Extract the top article URL
 * 4. Fetch that article's content
 * 5. Use Haiku to distill into a concise, actionable rescue hint
 *
 * This is the "escalation" path when static rescue hints (in browser-agent-rescue.ts)
 * haven't resolved the stuck state after 4+ steps.
 *
 * Cost: ~1 Haiku call (~$0.001) + 2 fetches. Only triggered on escalation.
 */

import { logger } from '../utils/logger.js';
import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_HAIKU } from '../config/models.js';
import { errMsg } from '../utils/errors.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SQUARESPACE_HELP_BASE = 'https://support.squarespace.com/hc/en-us';
const FETCH_TIMEOUT_MS = 10_000;

/** Known high-value Squarespace support article URLs, keyed by topic */
const KNOWN_ARTICLES: Record<string, string> = {
  'add section': `${SQUARESPACE_HELP_BASE}/articles/205815928-Page-sections`,
  'add block': `${SQUARESPACE_HELP_BASE}/articles/205815578-Adding-content-with-blocks`,
  'fluid engine': `${SQUARESPACE_HELP_BASE}/articles/4585625047949-Editing-with-the-Fluid-Engine`,
  'text block': `${SQUARESPACE_HELP_BASE}/articles/205815668-Text-blocks`,
  'button block': `${SQUARESPACE_HELP_BASE}/articles/205815988-Button-blocks`,
  'format text': `${SQUARESPACE_HELP_BASE}/articles/205810478-Formatting-text`,
  'image block': `${SQUARESPACE_HELP_BASE}/articles/205815908-Image-blocks`,
  'edit mode': `${SQUARESPACE_HELP_BASE}/articles/205815578-Adding-content-with-blocks`,
  'section template': `${SQUARESPACE_HELP_BASE}/articles/205815928-Page-sections`,
  'save changes': `${SQUARESPACE_HELP_BASE}/articles/205815578-Adding-content-with-blocks`,
  'menu block': `${SQUARESPACE_HELP_BASE}/articles/205815578-Adding-content-with-blocks`,
  'spacer block': `${SQUARESPACE_HELP_BASE}/articles/205815578-Adding-content-with-blocks`,
  'announcement bar': `${SQUARESPACE_HELP_BASE}/articles/205815318-Adding-an-announcement-bar`,
  'announcement': `${SQUARESPACE_HELP_BASE}/articles/205815318-Adding-an-announcement-bar`,
  'site header': `${SQUARESPACE_HELP_BASE}/articles/205815928-Site-header`,
  'navigation': `${SQUARESPACE_HELP_BASE}/articles/205815928-Site-header`,
  'site styles': `${SQUARESPACE_HELP_BASE}/articles/205815578-Site-styles`,
  'pop-up': `${SQUARESPACE_HELP_BASE}/articles/205815928-Promotional-pop-ups`,
  'popup': `${SQUARESPACE_HELP_BASE}/articles/205815928-Promotional-pop-ups`,
};

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * Dynamically look up a Squarespace support article and return an actionable
 * rescue hint tailored to what the agent is currently struggling with.
 *
 * @param agentReasoning — recent reasoning text from the agent (describes what it's trying to do)
 * @param stuckPattern — the detected stuck pattern (e.g., 'cant_add_section')
 * @returns A rescue hint string, or undefined if lookup fails
 */
export async function lookupSquarespaceDocs(
  agentReasoning: string,
  stuckPattern: string,
): Promise<string | undefined> {
  const start = Date.now();

  try {
    // Step 1: Find the best article URL
    const articleUrl = await findRelevantArticle(agentReasoning, stuckPattern);
    if (!articleUrl) {
      logger.warn({ stuckPattern }, 'Squarespace docs: no relevant article found');
      return undefined;
    }

    // Step 2: Fetch the article content
    const articleContent = await fetchArticleContent(articleUrl);
    if (!articleContent) {
      logger.warn({ articleUrl }, 'Squarespace docs: could not fetch article content');
      return undefined;
    }

    // Step 3: Distill into a rescue hint using Haiku
    const hint = await distillRescueHint(articleContent, agentReasoning, stuckPattern);

    const durationMs = Date.now() - start;
    logger.info(
      { stuckPattern, articleUrl, hintLength: hint?.length, durationMs },
      'Squarespace docs: dynamic lookup complete',
    );

    return hint;
  } catch (err) {
    logger.error(
      { error: errMsg(err), stuckPattern },
      'Squarespace docs: lookup failed',
    );
    return undefined;
  }
}

// ─── Step 1: Find Relevant Article ──────────────────────────────────────────

/**
 * Find the most relevant Squarespace support article URL.
 * First checks known articles, then falls back to searching the help center.
 */
async function findRelevantArticle(
  agentReasoning: string,
  stuckPattern: string,
): Promise<string | undefined> {
  const reasoning = agentReasoning.toLowerCase();

  // Check known articles first (no network call needed)
  for (const [keyword, url] of Object.entries(KNOWN_ARTICLES)) {
    if (reasoning.includes(keyword) || stuckPattern.includes(keyword.replace(' ', '_'))) {
      logger.info({ keyword, url }, 'Squarespace docs: matched known article');
      return url;
    }
  }

  // Map stuck patterns to search queries
  const patternQueries: Record<string, string> = {
    cant_add_section: 'add section to page',
    cant_add_block: 'add block fluid engine',
    cant_edit_text: 'edit text block format heading',
    cant_edit_button: 'button block edit label url',
    cant_find_element: 'edit mode section block',
    clicking_wrong_things: 'fluid engine editing blocks',
    generic_stuck: 'editing pages blocks sections',
  };

  const query = patternQueries[stuckPattern] ?? extractSearchQuery(reasoning);
  if (!query) return undefined;

  // Search the Squarespace help center
  try {
    const searchUrl = `${SQUARESPACE_HELP_BASE}/search?utf8=%E2%9C%93&query=${encodeURIComponent(query)}&commit=Search`;
    const response = await fetchWithTimeout(searchUrl);
    if (!response) return undefined;

    const html = await response.text();

    // Extract the first search result link
    // Squarespace help center uses <a class="search-result-link" href="...">
    const resultMatch = html.match(/href="(\/hc\/en-us\/articles\/[^"]+)"/);
    if (resultMatch?.[1]) {
      const fullUrl = `https://support.squarespace.com${resultMatch[1]}`;
      logger.info({ query, fullUrl }, 'Squarespace docs: found article via search');
      return fullUrl;
    }

    // Alternative pattern: look for article links in any format
    const altMatch = html.match(/href="(https:\/\/support\.squarespace\.com\/hc\/en-us\/articles\/[^"]+)"/);
    if (altMatch?.[1]) {
      logger.info({ query, url: altMatch[1] }, 'Squarespace docs: found article via alt pattern');
      return altMatch[1];
    }

    logger.warn({ query }, 'Squarespace docs: no results from search');
    return undefined;
  } catch (err) {
    logger.warn(
      { error: errMsg(err), query },
      'Squarespace docs: search failed',
    );
    return undefined;
  }
}

/**
 * Extract a reasonable search query from the agent's reasoning text.
 */
function extractSearchQuery(reasoning: string): string {
  // Pull out key action phrases
  const phrases = [
    'add section', 'add block', 'edit text', 'edit button', 'format heading',
    'save changes', 'edit mode', 'section template', 'block picker',
    'fluid engine', 'image block', 'menu block', 'spacer',
  ];

  const found = phrases.filter((p) => reasoning.includes(p));
  if (found.length > 0) {
    return found.slice(0, 3).join(' ');
  }

  // Fallback: extract first 5 meaningful words from reasoning
  const words = reasoning.split(/\s+/).filter((w) => w.length > 3).slice(0, 5);
  return words.join(' ') || 'editing page content blocks';
}

// ─── Step 2: Fetch Article Content ──────────────────────────────────────────

/**
 * Fetch a Squarespace support article and extract readable text content.
 * Strips HTML tags and returns plain text, focused on the article body.
 */
async function fetchArticleContent(url: string): Promise<string | undefined> {
  try {
    const response = await fetchWithTimeout(url);
    if (!response) return undefined;

    const html = await response.text();

    // Extract article body content
    // Squarespace help articles have the main content in <div class="article-body">
    let articleHtml = '';

    const bodyMatch = html.match(/<div[^>]*class="[^"]*article-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
    if (bodyMatch?.[1]) {
      articleHtml = bodyMatch[1];
    } else {
      // Fallback: try to find the main content area
      const mainMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
      if (mainMatch?.[1]) {
        articleHtml = mainMatch[1];
      } else {
        // Last resort: take everything in the body
        const bodyTag = html.match(/<body[^>]*>([\s\S]*?)<\/body>/);
        articleHtml = bodyTag?.[1] ?? html;
      }
    }

    // Convert HTML to readable text
    const text = htmlToText(articleHtml);

    // Truncate to avoid sending too much to Haiku
    const MAX_CHARS = 6000;
    if (text.length > MAX_CHARS) {
      return text.substring(0, MAX_CHARS) + '\n\n[... article truncated]';
    }

    return text;
  } catch (err) {
    logger.warn(
      { error: errMsg(err), url },
      'Squarespace docs: article fetch failed',
    );
    return undefined;
  }
}

/**
 * Simple HTML to text conversion — strips tags, decodes entities,
 * preserves list structure and headings.
 */
function htmlToText(html: string): string {
  return html
    // Remove script and style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert headings to markdown-style
    .replace(/<h[1-6][^>]*>/gi, '\n### ')
    .replace(/<\/h[1-6]>/gi, '\n')
    // Convert list items
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    // Convert paragraphs and line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    // Convert ordered lists to numbered items
    .replace(/<ol[^>]*>/gi, '\n')
    .replace(/<\/ol>/gi, '\n')
    .replace(/<ul[^>]*>/gi, '\n')
    .replace(/<\/ul>/gi, '\n')
    // Strip remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Step 3: Distill Rescue Hint via Haiku ──────────────────────────────────

/**
 * Use Claude Haiku to distill a Squarespace support article into
 * a concise, actionable rescue hint for the browser agent.
 */
async function distillRescueHint(
  articleContent: string,
  agentReasoning: string,
  stuckPattern: string,
): Promise<string | undefined> {
  const prompt = `You are helping a browser automation agent that is stuck while editing a Squarespace website.

The agent is trying to: ${stuckPattern.replace(/_/g, ' ')}
The agent's recent reasoning: "${agentReasoning.substring(0, 300)}"

Here is a Squarespace support article that may help:

---
${articleContent}
---

Based on this article, write a CONCISE rescue hint (max 15 lines) that tells the agent EXACTLY what to do next. Use this format:

⚠️ SQUARESPACE DOCS HINT — [what the agent should do]

Then provide numbered steps. Be VERY specific about:
- Which buttons to click and WHERE they are (top-left, top-right, toolbar, etc.)
- Whether to use "click" (admin UI) or "clickInIframe" (page content)
- The exact sequence of actions
- Common mistakes to avoid

Do NOT include generic advice like "try again" — only actionable UI steps.`;

  try {
    const response = await getAnthropicClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const hint = textBlock?.type === 'text' ? textBlock.text.trim() : undefined;

    if (hint) {
      logger.info(
        {
          hintLength: hint.length,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        'Squarespace docs: Haiku distilled rescue hint',
      );
    }

    return hint;
  } catch (err) {
    logger.error(
      { error: errMsg(err) },
      'Squarespace docs: Haiku call failed',
    );
    return undefined;
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Fetch a URL with a timeout. Returns the Response or undefined on failure.
 */
async function fetchWithTimeout(url: string): Promise<Response | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn({ url, status: response.status }, 'Squarespace docs: HTTP error');
      return undefined;
    }

    return response;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn({ url }, 'Squarespace docs: fetch timed out');
    } else {
      logger.warn(
        { url, error: errMsg(err) },
        'Squarespace docs: fetch error',
      );
    }
    return undefined;
  }
}
