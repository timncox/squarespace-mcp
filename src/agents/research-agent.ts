/**
 * Research Agent — searches the web for relevant facts and synthesizes them.
 *
 * Used for tasks that need external context (event dates, pricing, seasonal info, etc.).
 * Phase A: Brave Search API call with derived queries
 * Phase B: Claude (Haiku) synthesizes search snippets into structured facts
 */

import Anthropic from '@anthropic-ai/sdk';
import { webSearch } from '../services/brave-search.js';
import type { AgentResult, ResearchResult } from './types.js';
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
    // Phase A: Generate search queries and run them
    const queries = deriveSearchQueries(taskDescription, siteName, location);
    logger.info({ queries }, 'Research agent: running web searches');

    const allSnippets: string[] = [];
    const allSources: string[] = [];

    // Run searches in parallel
    const searchResults = await Promise.all(
      queries.map((q) => webSearch(q, 5)),
    );

    for (const results of searchResults) {
      for (const r of results) {
        allSnippets.push(`[${r.title}] ${r.description}`);
        allSources.push(r.url);
      }
    }

    if (allSnippets.length === 0) {
      logger.warn('Research agent: no search results found');
      return {
        success: true,
        data: { queries, findings: [], sources: [], rawSnippets: [] },
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        durationMs: Date.now() - start,
      };
    }

    // Phase B: Claude synthesizes the search results
    const synthesisPrompt = buildSynthesisPrompt(taskDescription, siteName, allSnippets);

    const response = await getAnthropicClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 1024,
      messages: [{ role: 'user', content: synthesisPrompt }],
    });

    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const parsed = parseSynthesisResponse(text);

    const result: ResearchResult = {
      queries,
      findings: parsed.findings,
      sources: [...new Set(allSources)].slice(0, 5), // Dedupe, top 5
      rawSnippets: allSnippets,
    };

    logger.info(
      { findingCount: result.findings.length, sourceCount: result.sources.length },
      'Research agent: synthesis complete',
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Derive 1-3 search queries from the task description.
 * Simple keyword extraction — no LLM needed for this.
 */
function deriveSearchQueries(
  taskDescription: string,
  siteName: string,
  location?: string,
): string[] {
  const desc = taskDescription.toLowerCase();
  const queries: string[] = [];
  const year = new Date().getFullYear();
  const loc = location ? ` ${location}` : '';

  // Look for event/promotion keywords and build targeted queries
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
    // Generic: extract topic words and search
    const topicWords = desc
      .replace(/\b(add|remove|update|change|edit|the|a|an|on|to|from|page|front|home)\b/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    if (topicWords.length > 3) {
      queries.push(`${topicWords} ${siteName}${loc} ${year}`);
    }
  }

  // Always add a site-specific search if we have a name
  if (siteName && queries.length < 3) {
    queries.push(`${siteName}${loc}`);
  }

  return queries.slice(0, 3);
}

function buildSynthesisPrompt(
  taskDescription: string,
  siteName: string,
  snippets: string[],
): string {
  const snippetText = snippets.slice(0, 15).map((s, i) => `${i + 1}. ${s}`).join('\n');

  return `You are a research assistant helping create website content for "${siteName}".

The site owner asked: "${taskDescription}"

Here are web search results with relevant information:

${snippetText}

Extract the KEY FACTS needed to create website content. Focus on:
- Event dates, deadlines, and duration
- Pricing and package details
- What's included or offered
- How to book, reserve, or sign up
- Any other relevant promotional or informational details

Respond with JSON:
{
  "findings": [
    "Key fact 1 extracted from search results",
    "Key fact 2 extracted from search results"
  ]
}

Only include facts that are directly relevant and sourced from the search results. If the search results don't contain useful information for this task, return an empty findings array.`;
}

function parseSynthesisResponse(text: string): { findings: string[] } {
  try {
    // Extract JSON from potential markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : text;
    const parsed = JSON.parse(jsonStr) as { findings?: string[] };
    return { findings: Array.isArray(parsed.findings) ? parsed.findings : [] };
  } catch {
    logger.warn('Research agent: could not parse synthesis response as JSON');
    // Fall back: treat each line as a finding
    const lines = text
      .split('\n')
      .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter((l) => l.length > 10);
    return { findings: lines };
  }
}
