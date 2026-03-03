/**
 * MCP Tools — Web Search
 *
 * sq_web_search: Search the web using Brave Search API
 * sq_fetch_url: Fetch a URL and return its text content (HTML stripped)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerWebSearchTools(server: McpServer) {
  // ── sq_web_search ──────────────────────────────────────────────────────────
  server.registerTool('sq_web_search', {
    description:
      'Search the web using Brave Search API. Returns titles, URLs, and descriptions.',
    inputSchema: {
      query: z.string().describe('Search query'),
      count: z.number().optional().describe('Number of results (default 5)'),
    },
  }, async ({ query, count }) => {
    try {
      const { webSearch } = await import('../../services/brave-search.js');
      const results = await webSearch(query, count ?? 5);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Web search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_fetch_url ───────────────────────────────────────────────────────────
  server.registerTool('sq_fetch_url', {
    description:
      'Fetch a URL and return its text content (HTML stripped). Useful for extracting content from web pages.',
    inputSchema: {
      url: z.string().url().describe('URL to fetch'),
    },
  }, async ({ url }) => {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'SquarespaceHelper/1.0' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        return {
          content: [{ type: 'text' as const, text: `Fetch failed: HTTP ${resp.status}` }],
          isError: true,
        };
      }
      const html = await resp.text();
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '\n')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return {
        content: [{ type: 'text' as const, text: text.substring(0, 10_000) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
