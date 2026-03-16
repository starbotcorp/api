/**
 * Memory Search Tool (Echo)
 *
 * Searches across all memory stores for information relevant to a query:
 *   - User Facts: key-value pairs learned from conversation
 *   - Thread Compactions: lossless JSON summaries of past conversations
 *   - Project Profiles: extracted project-specific facts
 *
 * Uses keyword-based matching initially; can be extended with vector embeddings
 * for semantic search in the future.
 */

import type { ToolDefinition, ToolResult } from './types.js';
import { prisma } from '../../db.js';

interface MemorySearchResult {
  source: 'user_fact' | 'thread_compaction' | 'project_profile';
  content: string;
  importance?: number;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * Compute a basic keyword relevance score between a query and a text body.
 * Returns a value between 0 and 1.
 */
function keywordScore(query: string, text: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (queryTerms.length === 0) return 0;

  const textLower = text.toLowerCase();
  let matchedTerms = 0;
  let totalWeight = 0;

  for (const term of queryTerms) {
    // Count occurrences for weighting
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = textLower.match(regex);
    if (matches) {
      matchedTerms++;
      totalWeight += Math.min(matches.length, 3); // cap at 3 to avoid over-weighting
    }
  }

  if (matchedTerms === 0) return 0;

  // Score is a combination of term coverage and match density
  const coverage = matchedTerms / queryTerms.length;
  const density = totalWeight / (queryTerms.length * 3);
  return coverage * 0.7 + density * 0.3;
}

async function searchUserFacts(userId: string, query: string): Promise<MemorySearchResult[]> {
  const facts = await prisma.userFact.findMany({
    where: { userId, status: 'ACTIVE' },
  });

  const results: MemorySearchResult[] = [];

  for (const fact of facts) {
    const searchText = `${fact.factKey} ${fact.factValue}`;
    const score = keywordScore(query, searchText);

    if (score > 0.1) {
      results.push({
        source: 'user_fact',
        content: `${fact.factKey}: ${fact.factValue}`,
        score,
        metadata: {
          factKey: fact.factKey,
          confidence: fact.confidence,
          source: fact.source,
        },
      });
    }
  }

  return results;
}

async function searchThreadCompactions(userId: string, query: string): Promise<MemorySearchResult[]> {
  // Find all chats with compactions that belong to the user's projects
  const chats = await prisma.chat.findMany({
    where: {
      compaction: { not: null },
      project: { userId },
    },
    select: {
      id: true,
      title: true,
      compaction: true,
      compactedAt: true,
      project: { select: { name: true } },
    },
  });

  const results: MemorySearchResult[] = [];

  for (const chat of chats) {
    if (!chat.compaction) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(chat.compaction);
    } catch {
      // If the compaction isn't valid JSON, search the raw text
      const score = keywordScore(query, chat.compaction);
      if (score > 0.1) {
        results.push({
          source: 'thread_compaction',
          content: chat.compaction.slice(0, 500),
          score,
          metadata: { chatId: chat.id, chatTitle: chat.title },
        });
      }
      continue;
    }

    // Search through the structured compaction fields
    const searchableTexts: Array<{ text: string; importance?: number }> = [];

    if (parsed.summary) {
      searchableTexts.push({ text: parsed.summary });
    }

    if (Array.isArray(parsed.topics)) {
      for (const topic of parsed.topics) {
        const topicText = `${topic.title || ''} ${topic.notes || ''}`;
        searchableTexts.push({ text: topicText, importance: topic.imp });
      }
    }

    if (Array.isArray(parsed.decisions)) {
      for (const decision of parsed.decisions) {
        searchableTexts.push({ text: decision, importance: 7 });
      }
    }

    if (Array.isArray(parsed.pendingTasks)) {
      for (const task of parsed.pendingTasks) {
        searchableTexts.push({ text: task, importance: 6 });
      }
    }

    for (const item of searchableTexts) {
      const score = keywordScore(query, item.text);
      if (score > 0.1) {
        results.push({
          source: 'thread_compaction',
          content: item.text.slice(0, 500),
          importance: item.importance,
          score,
          metadata: {
            chatId: chat.id,
            chatTitle: chat.title,
            projectName: chat.project?.name,
            compactedAt: chat.compactedAt?.toISOString(),
          },
        });
      }
    }
  }

  return results;
}

async function searchProjectProfiles(userId: string, query: string): Promise<MemorySearchResult[]> {
  const projects = await prisma.project.findMany({
    where: { userId },
    select: { id: true, name: true, profile: true },
  });

  const results: MemorySearchResult[] = [];

  for (const project of projects) {
    if (!project.profile || project.profile === '{}') continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(project.profile);
    } catch {
      continue;
    }

    if (Object.keys(parsed).length === 0) continue;

    // Build searchable text from profile entries
    const entries = Object.entries(parsed);
    for (const [key, value] of entries) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      const searchText = `${key} ${valueStr}`;
      const score = keywordScore(query, searchText);

      if (score > 0.1) {
        results.push({
          source: 'project_profile',
          content: `${key}: ${valueStr}`,
          score,
          metadata: {
            projectId: project.id,
            projectName: project.name,
          },
        });
      }
    }
  }

  return results;
}

export const memorySearchTool: ToolDefinition = {
  name: 'memory_search',
  description: 'Search across all memory stores (user facts, thread compaction summaries, project profiles) for information relevant to a query. Use this when you need to recall past conversations, user preferences, project state, or any previously stored information.',
  parameters: [
    {
      name: 'query',
      type: 'string',
      description: 'Natural language search query (e.g., "book about AI ethics", "project deadline", "user timezone")',
      required: true,
    },
    {
      name: 'scope',
      type: 'string',
      description: 'Which memory stores to search. Options: "facts" (user facts only), "threads" (thread compactions only), "projects" (project profiles only), "all" (everything).',
      required: false,
      enum: ['facts', 'threads', 'projects', 'all'],
      default: 'all',
    },
  ],
  execute: async (args, context): Promise<ToolResult> => {
    const { query, scope = 'all' } = args;
    const userId = (context?.request as any)?.userId;

    if (!userId) {
      return {
        success: false,
        content: JSON.stringify({ error: 'User not authenticated' }),
      };
    }

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return {
        success: false,
        content: JSON.stringify({ error: 'Query must be a non-empty string' }),
      };
    }

    try {
      const allResults: MemorySearchResult[] = [];

      // Search the requested scopes
      const searchPromises: Promise<MemorySearchResult[]>[] = [];

      if (scope === 'all' || scope === 'facts') {
        searchPromises.push(searchUserFacts(userId, query));
      }
      if (scope === 'all' || scope === 'threads') {
        searchPromises.push(searchThreadCompactions(userId, query));
      }
      if (scope === 'all' || scope === 'projects') {
        searchPromises.push(searchProjectProfiles(userId, query));
      }

      const searchResults = await Promise.all(searchPromises);
      for (const results of searchResults) {
        allResults.push(...results);
      }

      // Sort by score descending, then by importance descending
      allResults.sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
        return (b.importance ?? 0) - (a.importance ?? 0);
      });

      // Return top 10 results
      const topResults = allResults.slice(0, 10);

      return {
        success: true,
        content: JSON.stringify({
          query,
          scope,
          resultCount: topResults.length,
          results: topResults.map(r => ({
            source: r.source,
            content: r.content,
            importance: r.importance ?? null,
            score: Math.round(r.score * 100) / 100,
            metadata: r.metadata,
          })),
        }),
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({
          error: 'Memory search failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};
