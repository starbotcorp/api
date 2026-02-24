// Web Search Tool
// Wraps the existing web search service as a tool

import type { ToolDefinition, ToolResult } from './types.js';
import { searchWeb, formatWebSearchContext } from '../web-search.js';

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for current information and recent events. Use this when you need up-to-date information not in your training data.',
  parameters: [
    {
      name: 'query',
      type: 'string',
      description: 'The search query to look up on the web',
      required: true,
    },
    {
      name: 'num_results',
      type: 'number',
      description: 'Number of results to return (1-10, default: 5)',
      required: false,
      default: 5,
    },
  ],
  execute: async (args: Record<string, any>): Promise<ToolResult> => {
    try {
      const query = String(args.query || '').trim();
      if (!query) {
        return {
          success: false,
          content: JSON.stringify({ error: 'Query is required' }),
        };
      }

      const numResults = Math.max(1, Math.min(10, parseInt(String(args.num_results || '5'), 10)));
      const result = await searchWeb(query, numResults);

      if (!result) {
        return {
          success: false,
          content: JSON.stringify({ error: 'Web search is not enabled or API key is missing' }),
        };
      }

      // Format results as structured data
      const formatted = {
        query: result.query,
        results: result.hits.map((hit, idx) => ({
          rank: idx + 1,
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
        })),
      };

      return {
        success: true,
        content: JSON.stringify(formatted, null, 2),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: JSON.stringify({ error: errorMessage }),
      };
    }
  },
};
