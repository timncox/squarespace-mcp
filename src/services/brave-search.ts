/**
 * Brave Search API wrapper for the Research Agent.
 *
 * Simple fetch-based integration — no npm dependency needed.
 * Free tier: 2,000 queries/month.
 * Docs: https://api.search.brave.com/app/documentation/web-search
 */

import { logger } from '../utils/logger.js';
import { errMsg } from '../utils/errors.js';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

/**
 * Search the web using Brave Search API.
 * Returns up to `count` results with title, URL, and description snippet.
 */
export async function webSearch(query: string, count = 5): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    logger.warn('BRAVE_SEARCH_API_KEY not set — skipping web search');
    return [];
  }

  const params = new URLSearchParams({
    q: query,
    count: String(count),
    text_decorations: 'false', // No bold markers in snippets
  });

  const url = `${BRAVE_SEARCH_URL}?${params.toString()}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error({ status: response.status, body }, 'Brave Search API error');
      return [];
    }

    const data = (await response.json()) as BraveSearchResponse;

    const results: SearchResult[] = (data.web?.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.description ?? '',
    }));

    logger.info({ query, resultCount: results.length }, 'Brave Search completed');
    return results;
  } catch (err) {
    logger.error({ error: errMsg(err), query }, 'Brave Search request failed');
    return [];
  }
}

// ─── Brave Search API response types ────────────────────────────────────────

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}
