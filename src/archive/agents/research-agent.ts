/**
 * Research Agent — multi-query web search with structured synthesis.
 *
 * Used for tasks that need external context (event dates, pricing, seasonal info, etc.).
 *
 * Phase A: LLM-generated targeted search queries (2-3 per task)
 * Phase B: Brave Search execution (parallel, deduplicated)
 * Phase C: Structured URL extraction (when URLs are in search results)
 * Phase D: Claude (Haiku) synthesizes everything into ResearchSynthesis
 */

import Anthropic from '@anthropic-ai/sdk';
import { webSearch } from '../services/brave-search.js';
import type { AgentResult, ResearchResult, ResearchSynthesis, StructuredPageData } from './types.js';
import { logger } from '../utils/logger.js';
import { getAnthropicClient } from '../utils/anthropic-client.js';
import { MODEL_HAIKU } from '../config/models.js';
import { errMsg } from '../utils/errors.js';

/**
 * Research a topic relevant to a Squarespace editing task.
 *
 * @param taskDescription — Tim's original request or the task description
 * @param siteName — The restaurant/business name for context
 * @param location — City/area for location-specific searches (e.g., "NYC")
 */
export async function runResearchAgent(
  taskDescription: string,
  siteName: string,
  location?: string,
): Promise<AgentResult<ResearchResult>> {
  const start = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    // Phase A: Generate targeted search queries via LLM
    const { queries, usage: queryUsage } = await generateSearchQueries(taskDescription, siteName, location);
    inputTokens += queryUsage.inputTokens;
    outputTokens += queryUsage.outputTokens;

    logger.info({ queries, queryCount: queries.length }, 'Research agent: running multi-query web searches');

    // Phase B: Execute all searches in parallel, deduplicate results
    const { snippets: allSnippets, sources: allSources } = await executeSearches(queries);

    if (allSnippets.length === 0) {
      logger.warn('Research agent: no search results found');
      return {
        success: true,
        data: { queries, findings: [], sources: [], rawSnippets: [] },
        tokenUsage: { inputTokens, outputTokens },
        durationMs: Date.now() - start,
      };
    }

    // Phase C: Extract structured data from top result URLs
    const structuredPages = await extractStructuredDataFromUrls(allSources.slice(0, 5));

    // Phase D: Full synthesis — produces ResearchSynthesis with ranked sources
    const { synthesis, findings, usage: synthesisUsage } = await synthesizeResearch(
      taskDescription,
      siteName,
      allSnippets,
      allSources,
      structuredPages,
    );
    inputTokens += synthesisUsage.inputTokens;
    outputTokens += synthesisUsage.outputTokens;

    const result: ResearchResult = {
      queries,
      findings,
      sources: [...new Set(allSources)].slice(0, 10),
      rawSnippets: allSnippets,
      synthesis,
      structuredPages: structuredPages.length > 0 ? structuredPages : undefined,
    };

    logger.info(
      {
        findingCount: result.findings.length,
        sourceCount: result.sources.length,
        hasSynthesis: !!result.synthesis,
        structuredPageCount: structuredPages.length,
        keyFactCount: synthesis?.keyFacts.length ?? 0,
        contentSuggestionCount: synthesis?.contentSuggestions.length ?? 0,
      },
      'Research agent: multi-query synthesis complete',
    );

    return {
      success: true,
      data: result,
      tokenUsage: { inputTokens, outputTokens },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const errorMessage = errMsg(err);
    logger.error({ error: errorMessage }, 'Research agent failed');
    return {
      success: false,
      error: errorMessage,
      tokenUsage: { inputTokens, outputTokens },
      durationMs: Date.now() - start,
    };
  }
}

// ─── Phase A: LLM-Generated Search Queries ──────────────────────────────────

/**
 * Use Claude Haiku to generate 2-3 targeted search queries from the task description.
 * Falls back to the old keyword-based derivation if the LLM call fails.
 */
async function generateSearchQueries(
  taskDescription: string,
  siteName: string,
  location?: string,
): Promise<{ queries: string[]; usage: { inputTokens: number; outputTokens: number } }> {
  const year = new Date().getFullYear();
  const loc = location ? ` in ${location}` : '';

  const prompt = `You are a research assistant for a Squarespace website editor. Generate 2-3 targeted web search queries to find relevant information for this website editing task.

Business: "${siteName}"${loc}
Task: "${taskDescription}"
Current year: ${year}

Generate search queries that cover different angles:
1. Company/person/brand information (who they are, what they do)
2. Industry best practices or content patterns relevant to the task (e.g., "best portfolio section layouts" or "restaurant week ${year} details")
3. Specific details mentioned in the task (services, products, events, dates, etc.)

Each query should be concise (3-8 words) and optimized for a web search engine. Do NOT include generic filler words.

Respond with JSON:
{
  "queries": ["query 1", "query 2", "query 3"]
}`;

  try {
    const response = await getAnthropicClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    const parsed = JSON.parse(jsonStr) as { queries?: string[] };

    const queries = Array.isArray(parsed.queries) ? parsed.queries.slice(0, 3) : [];

    if (queries.length === 0) {
      throw new Error('LLM returned no queries');
    }

    logger.info({ queries }, 'Research agent: LLM-generated search queries');

    return {
      queries,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  } catch (err) {
    logger.warn({ error: errMsg(err) }, 'Research agent: LLM query generation failed, falling back to keyword derivation');
    const queries = deriveSearchQueriesFallback(taskDescription, siteName, location);
    return { queries, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

/**
 * Fallback: derive search queries from keywords (no LLM needed).
 * Same logic as the original implementation.
 */
function deriveSearchQueriesFallback(
  taskDescription: string,
  siteName: string,
  location?: string,
): string[] {
  const desc = taskDescription.toLowerCase();
  const queries: string[] = [];
  const year = new Date().getFullYear();
  const loc = location ? ` ${location}` : '';

  if (desc.includes('restaurant week')) {
    queries.push(`${loc.trim() || 'NYC'} Restaurant Week ${year} dates pricing`);
    queries.push(`${loc.trim() || 'NYC'} Restaurant Week ${year} participating restaurants menu`);
  } else if (desc.includes('valentine') || desc.includes("valentine's")) {
    queries.push(`Valentine's Day ${siteName}${loc} ${year}`);
  } else if (desc.includes('new year') || desc.includes("new year's")) {
    queries.push(`New Year's Eve ${siteName}${loc} ${year}`);
  } else if (desc.includes('holiday') || desc.includes('christmas')) {
    queries.push(`holiday ${siteName}${loc} ${year}`);
  } else if (desc.includes('brunch') && (desc.includes('special') || desc.includes('promo'))) {
    queries.push(`${siteName} brunch menu ${year}`);
  } else {
    const topicWords = desc
      .replace(/\b(add|remove|update|change|edit|the|a|an|on|to|from|page|front|home)\b/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (topicWords.length > 3) {
      queries.push(`${topicWords} ${siteName}${loc} ${year}`);
    }
  }

  if (siteName && queries.length < 3) {
    queries.push(`${siteName}${loc}`);
  }

  return queries.slice(0, 3);
}

// ─── Phase B: Execute Searches ──────────────────────────────────────────────

/**
 * Run all search queries in parallel, deduplicate results by URL.
 */
async function executeSearches(
  queries: string[],
): Promise<{ snippets: string[]; sources: string[] }> {
  const searchResults = await Promise.all(
    queries.map((q) => webSearch(q, 5)),
  );

  const seenUrls = new Set<string>();
  const snippets: string[] = [];
  const sources: string[] = [];

  for (const results of searchResults) {
    for (const r of results) {
      // Deduplicate by URL across all queries
      if (seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);

      snippets.push(`[${r.title}] ${r.description}`);
      sources.push(r.url);
    }
  }

  logger.info(
    { totalSnippets: snippets.length, deduplicatedFrom: searchResults.flat().length, queryCount: queries.length },
    'Research agent: search results deduplicated',
  );

  return { snippets, sources };
}

// ─── Phase C: Structured URL Extraction ─────────────────────────────────────

/**
 * Extract structured data from URLs found in search results.
 * Uses fetch + HTML parsing (no browser needed — lightweight extraction).
 * Only processes URLs that look like content pages (not PDFs, images, etc.).
 */
async function extractStructuredDataFromUrls(urls: string[]): Promise<StructuredPageData[]> {
  const contentUrls = urls.filter((url) => {
    const lower = url.toLowerCase();
    // Skip non-HTML resources
    if (lower.endsWith('.pdf') || lower.endsWith('.jpg') || lower.endsWith('.png') || lower.endsWith('.gif')) return false;
    if (lower.includes('/api/') || lower.includes('?format=json')) return false;
    return true;
  }).slice(0, 3); // Limit to top 3 URLs

  if (contentUrls.length === 0) return [];

  const results = await Promise.allSettled(
    contentUrls.map((url) => extractPageData(url)),
  );

  const structured: StructuredPageData[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      structured.push(result.value);
    }
  }

  logger.info(
    { attempted: contentUrls.length, succeeded: structured.length },
    'Research agent: structured URL extraction complete',
  );

  return structured;
}

/**
 * Fetch a single URL and extract structured page data from the HTML.
 */
async function extractPageData(url: string): Promise<StructuredPageData | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SquarespaceHelper/1.0)',
        'Accept': 'text/html',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return null;

    const html = await response.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? '';

    // Extract headings (h1-h3)
    const headings: string[] = [];
    const headingRegex = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
    let headingMatch;
    while ((headingMatch = headingRegex.exec(html)) !== null) {
      const text = stripHtmlTags(headingMatch[2]).trim();
      if (text.length > 0 && text.length < 200) {
        headings.push(`h${headingMatch[1]}: ${text}`);
      }
    }

    // Extract key paragraphs (first 5 non-trivial paragraphs)
    const keyContent: string[] = [];
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(html)) !== null && keyContent.length < 5) {
      const text = stripHtmlTags(pMatch[1]).trim();
      if (text.length > 30 && text.length < 500) {
        keyContent.push(text);
      }
    }

    // Extract images with alt text
    const images: Array<{ src: string; alt: string }> = [];
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi;
    const imgRegex2 = /<img[^>]+alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(html)) !== null && images.length < 5) {
      if (imgMatch[2]?.trim()) {
        images.push({ src: imgMatch[1], alt: imgMatch[2].trim() });
      }
    }
    while ((imgMatch = imgRegex2.exec(html)) !== null && images.length < 5) {
      if (imgMatch[1]?.trim()) {
        images.push({ src: imgMatch[2], alt: imgMatch[1].trim() });
      }
    }

    // Extract lists
    const lists: string[][] = [];
    const listRegex = /<[uo]l[^>]*>([\s\S]*?)<\/[uo]l>/gi;
    let listMatch;
    while ((listMatch = listRegex.exec(html)) !== null && lists.length < 3) {
      const items: string[] = [];
      const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liMatch;
      while ((liMatch = liRegex.exec(listMatch[1])) !== null && items.length < 10) {
        const text = stripHtmlTags(liMatch[1]).trim();
        if (text.length > 0 && text.length < 200) {
          items.push(text);
        }
      }
      if (items.length > 0) {
        lists.push(items);
      }
    }

    const result: StructuredPageData = { url, title, headings, keyContent, images, lists };

    logger.info(
      { url, title: title.substring(0, 60), headingCount: headings.length, paragraphCount: keyContent.length },
      'Research agent: extracted structured page data',
    );

    return result;
  } catch (err) {
    logger.warn({ url, error: errMsg(err) }, 'Research agent: failed to extract page data');
    return null;
  }
}

/**
 * Strip HTML tags from a string.
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// ─── Phase D: Research Synthesis ────────────────────────────────────────────

/**
 * Synthesize all gathered data into a structured ResearchSynthesis.
 * Uses Claude Haiku to analyze snippets, structured page data, and produce
 * ranked sources with content suggestions.
 */
async function synthesizeResearch(
  taskDescription: string,
  siteName: string,
  snippets: string[],
  sourceUrls: string[],
  structuredPages: StructuredPageData[],
): Promise<{
  synthesis: ResearchSynthesis;
  findings: string[];
  usage: { inputTokens: number; outputTokens: number };
}> {
  const prompt = buildSynthesisPrompt(taskDescription, siteName, snippets, sourceUrls, structuredPages);

  const response = await getAnthropicClient().messages.create({
    model: MODEL_HAIKU,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const parsed = parseSynthesisResponse(text);

  return {
    synthesis: parsed.synthesis,
    findings: parsed.findings,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

function buildSynthesisPrompt(
  taskDescription: string,
  siteName: string,
  snippets: string[],
  sourceUrls: string[],
  structuredPages: StructuredPageData[],
): string {
  const snippetText = snippets.slice(0, 15).map((s, i) => `${i + 1}. ${s}`).join('\n');

  // Build structured page data section if available
  let structuredSection = '';
  if (structuredPages.length > 0) {
    const pageDescriptions = structuredPages.map((page) => {
      const parts: string[] = [`URL: ${page.url}`, `Title: ${page.title}`];
      if (page.headings.length > 0) {
        parts.push(`Headings: ${page.headings.slice(0, 5).join('; ')}`);
      }
      if (page.keyContent.length > 0) {
        parts.push(`Key content: ${page.keyContent.slice(0, 3).map(c => c.substring(0, 150)).join(' | ')}`);
      }
      if (page.lists.length > 0) {
        parts.push(`Lists: ${page.lists.slice(0, 2).map(l => l.slice(0, 5).join(', ')).join(' | ')}`);
      }
      return parts.join('\n  ');
    });
    structuredSection = `\n\nStructured data extracted from key pages:\n${pageDescriptions.join('\n\n')}`;
  }

  // Build source URL list for ranking
  const sourceList = sourceUrls.slice(0, 10).map((url, i) => `${i + 1}. ${url}`).join('\n');

  return `You are a research assistant helping create website content for "${siteName}".

The site owner asked: "${taskDescription}"

Here are web search results with relevant information:

${snippetText}${structuredSection}

Source URLs:
${sourceList}

Analyze ALL the information above and produce a comprehensive research synthesis. Your output will be used by a content strategist to write exact website copy.

Respond with JSON:
{
  "keyFacts": [
    "Verified fact 1 (include specific dates, numbers, names when available)",
    "Verified fact 2"
  ],
  "contentSuggestions": [
    "Suggested heading, section idea, or content angle based on research",
    "Another content suggestion"
  ],
  "toneGuidance": "Recommended tone and voice for the content based on the business type and task context (e.g., 'professional and approachable', 'upscale and refined', 'casual and friendly')",
  "sources": [
    { "url": "https://...", "relevance": "high", "summary": "Why this source is relevant" },
    { "url": "https://...", "relevance": "medium", "summary": "What useful info this contains" }
  ],
  "findings": [
    "Legacy finding 1 (key fact for backward compatibility)",
    "Legacy finding 2"
  ]
}

Guidelines:
- "keyFacts": Extract SPECIFIC, VERIFIED facts from the search results. Include dates, prices, names, locations. Do not make up facts.
- "contentSuggestions": Suggest 2-4 concrete content ideas (section headings, copy angles, calls-to-action) that would work well for this task.
- "toneGuidance": Brief tone recommendation (1-2 sentences) based on the business type and target audience.
- "sources": Rank ALL source URLs by relevance (high/medium/low) with a brief summary of what each contains.
- "findings": Include the key facts as simple strings (for backward compatibility with the existing pipeline).
- Only include facts that are directly sourced from the search results. Do not fabricate information.`;
}

/**
 * Parse the synthesis LLM response into structured data.
 */
function parseSynthesisResponse(text: string): {
  synthesis: ResearchSynthesis;
  findings: string[];
} {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    const parsed = JSON.parse(jsonStr) as {
      keyFacts?: string[];
      contentSuggestions?: string[];
      toneGuidance?: string;
      sources?: Array<{ url: string; relevance: string; summary: string }>;
      findings?: string[];
    };

    const synthesis: ResearchSynthesis = {
      keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts : [],
      contentSuggestions: Array.isArray(parsed.contentSuggestions) ? parsed.contentSuggestions : [],
      toneGuidance: typeof parsed.toneGuidance === 'string' ? parsed.toneGuidance : 'Professional and clear',
      sources: Array.isArray(parsed.sources)
        ? parsed.sources.map((s) => ({
            url: s.url ?? '',
            relevance: (['high', 'medium', 'low'].includes(s.relevance) ? s.relevance : 'medium') as 'high' | 'medium' | 'low',
            summary: s.summary ?? '',
          }))
        : [],
    };

    // Use findings from JSON, or fall back to keyFacts
    const findings = Array.isArray(parsed.findings) && parsed.findings.length > 0
      ? parsed.findings
      : synthesis.keyFacts;

    return { synthesis, findings };
  } catch {
    logger.warn('Research agent: could not parse synthesis response as JSON');
    // Fall back: treat each line as a finding, create minimal synthesis
    const lines = text
      .split('\n')
      .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter((l) => l.length > 10);

    return {
      synthesis: {
        keyFacts: lines,
        contentSuggestions: [],
        toneGuidance: 'Professional and clear',
        sources: [],
      },
      findings: lines,
    };
  }
}
