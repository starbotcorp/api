import { env } from '../env.js';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  hits: WebSearchHit[];
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

export async function searchWeb(query: string, count = 5): Promise<WebSearchResult | null> {
  if (!env.WEB_SEARCH_ENABLED) return null;
  if (!env.BRAVE_SEARCH_API_KEY) return null;

  const q = normalizeText(query);
  if (!q) return null;

  const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
  endpoint.searchParams.set('q', q);
  endpoint.searchParams.set('count', String(Math.max(1, Math.min(count, 10))));

  const response = await fetch(endpoint.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search error (${response.status})`);
  }

  const payload = (await response.json()) as {
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
    };
  };

  const hits = (payload.web?.results || [])
    .map((item) => ({
      title: normalizeText(item.title),
      url: normalizeText(item.url),
      snippet: normalizeText(item.description),
    }))
    .filter((item) => item.title && item.url)
    .slice(0, Math.max(1, Math.min(count, 10)));

  return {
    query: q,
    hits,
  };
}

export function formatWebSearchContext(result: WebSearchResult): string {
  const lines: string[] = [];
  lines.push(`Web search results for query: "${result.query}"`);
  lines.push('Use these results as external context. Cite URLs when relevant.');
  lines.push('');

  result.hits.forEach((hit, idx) => {
    lines.push(`${idx + 1}. ${hit.title}`);
    lines.push(`   URL: ${hit.url}`);
    if (hit.snippet) {
      lines.push(`   Snippet: ${hit.snippet}`);
    }
  });

  return lines.join('\n');
}
