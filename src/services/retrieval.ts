/**
 * Retrieval Service
 * Performs semantic search using cosine similarity
 * Includes early-exit optimization for performance
 */

import { prisma } from '../db.js';
import { generateEmbedding } from './embeddings.js';
import { DEFAULT_IDENTITY } from '../routes/memory.js';

export interface RetrievalResult {
  chunkId: string;
  text: string;
  similarity: number;
  memoryId: string;
  scope: string;
}

export interface UserFact {
  id: string;
  userId: string;
  factKey: string;
  factValue: string;
  confidence: number;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

function formatScope(scope: string): string {
  if (scope === 'project') return 'Project';
  if (scope === 'workspace') return 'Workspace';
  if (scope === 'chat') return 'Chat';
  if (scope === 'identity') return 'Identity';
  return scope;
}

async function searchMemoryDocs(
  docs: Array<{
    id: string;
    scope: string;
    content: string;
    chunks: Array<{ id: string; text: string; embeddingVector: string | null }>;
  }>,
  query: string,
  topK: number,
  minSimilarity: number
): Promise<RetrievalResult[]> {
  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) {
    return [];
  }

  const results: RetrievalResult[] = [];

  for (const doc of docs) {
    for (const chunk of doc.chunks) {
      if (!chunk.embeddingVector) continue;

      try {
        const chunkEmbedding = JSON.parse(chunk.embeddingVector);
        const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

        if (similarity >= minSimilarity) {
          results.push({
            chunkId: chunk.id,
            text: chunk.text,
            similarity,
            memoryId: doc.id,
            scope: doc.scope,
          });

          // Early exit optimization: if we have enough high-quality results, stop scanning
          if (results.length >= topK * 2 && similarity > 0.8) {
            break;
          }
        }
      } catch (error) {
        console.error(`Error parsing embedding for chunk ${chunk.id}:`, error);
      }
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

/**
 * Search for relevant memory chunks using semantic similarity
 *
 * @param query - The search query text
 * @param projectId - Project ID to scope search
 * @param workspaceId - Optional workspace ID to scope search
 * @param topK - Number of top results to return
 * @param minSimilarity - Minimum similarity threshold (0-1)
 */
export async function searchMemory(
  query: string,
  projectId: string,
  workspaceId?: string,
  topK = 5,
  minSimilarity = 0.5
): Promise<RetrievalResult[]> {
  const memoryDocs = await prisma.memoryDocument.findMany({
    where: {
      OR: [
        {
          scope: 'project',
          projectId,
          workspaceId: null,
          chatId: null,
        },
        ...(workspaceId ? [{
          scope: 'workspace',
          projectId: null,
          workspaceId,
          chatId: null,
        }] : []),
      ],
    },
    include: {
      chunks: true,
    },
  });

  return searchMemoryDocs(memoryDocs, query, topK, minSimilarity);
}

export async function searchIdentityMemory(
  query: string,
  topK = 3,
  minSimilarity = 0.35
): Promise<RetrievalResult[]> {
  const identityDocs = await prisma.memoryDocument.findMany({
    where: {
      scope: 'identity',
      projectId: null,
      workspaceId: null,
      chatId: null,
    },
    include: {
      chunks: true,
    },
    take: 1,
  });

  return searchMemoryDocs(identityDocs, query, topK, minSimilarity);
}

export async function searchChatMemory(
  query: string,
  chatId: string,
  topK = 5,
  minSimilarity = 0.5
): Promise<RetrievalResult[]> {
  const chatDocs = await prisma.memoryDocument.findMany({
    where: {
      scope: 'chat',
      chatId,
      projectId: null,
      workspaceId: null,
    },
    include: {
      chunks: true,
    },
    take: 1,
  });

  return searchMemoryDocs(chatDocs, query, topK, minSimilarity);
}

/**
 * Get relevant context from memory for a chat
 * Combines project and workspace memory (legacy behavior)
 */
export async function getRelevantContext(
  query: string,
  projectId: string,
  workspaceId?: string,
  maxChunks = 5
): Promise<string> {
  const results = await searchMemory(query, projectId, workspaceId, maxChunks);

  if (results.length === 0) {
    return '';
  }

  let context = '# Relevant Memory\n\n';

  for (const result of results) {
    context += `## From ${formatScope(result.scope)} Memory (${(result.similarity * 100).toFixed(1)}% match)\n\n`;
    context += `${result.text}\n\n`;
  }

  return context;
}

export async function getIdentityContext(query: string, maxChunks = 3): Promise<string> {
  const identityDoc = await prisma.memoryDocument.findFirst({
    where: {
      scope: 'identity',
      projectId: null,
      workspaceId: null,
      chatId: null,
    },
  });

  // No custom identity? Return default - always have an identity
  if (!identityDoc) {
    return DEFAULT_IDENTITY;
  }

  const results = await searchIdentityMemory(query, maxChunks);
  if (results.length === 0) {
    return identityDoc.content;
  }

  let context = '# IDENTITY.md\n\n';
  for (const result of results) {
    context += `${result.text}\n\n`;
  }

  return context;
}

export async function getChatMemoryContext(
  query: string,
  chatId: string,
  maxChunks = 5
): Promise<string> {
  const chatMemory = await prisma.memoryDocument.findFirst({
    where: {
      scope: 'chat',
      chatId,
      projectId: null,
      workspaceId: null,
    },
  });

  if (!chatMemory) {
    return '';
  }

  const results = await searchChatMemory(query, chatId, maxChunks);
  if (results.length === 0) {
    return chatMemory.content;
  }

  let context = '# MEMORY.md\n\n';
  for (const result of results) {
    context += `${result.text}\n\n`;
  }

  return context;
}

/**
 * Get user facts for personalization context
 * Returns formatted string with relevant user information
 * Respects onboarding status - returns empty if IN_PROGRESS
 */
export async function getUserFactsContext(userId: string): Promise<string> {
  // Check user's onboarding status first
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { onboardingStatus: true },
  });

  // If onboarding is in progress, return no facts (clean slate during restart)
  if (user?.onboardingStatus === 'IN_PROGRESS') {
    return '';
  }

  const facts = await prisma.userFact.findMany({
    where: { userId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });

  if (facts.length === 0) {
    return '';
  }

  const factDescriptions = facts.map(f => `${f.factKey}: ${f.factValue}`);

  return `# User Facts\n\n${factDescriptions.join('\n')}\n`;
}

/**
 * Check if user has completed onboarding (has required facts)
 * Uses the onboardingStatus field for the primary check
 * Returns false if userId is undefined (auth disabled)
 */
export async function isOnboardingComplete(userId: string | undefined): Promise<boolean> {
  // If no userId (auth disabled), return false to skip onboarding checks
  if (!userId) {
    return false;
  }

  // First check the status field
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { onboardingStatus: true },
  });

  // If status is COMPLETED, return true
  if (user?.onboardingStatus === 'COMPLETED') {
    return true;
  }

  // If status is IN_PROGRESS, return false
  if (user?.onboardingStatus === 'IN_PROGRESS') {
    return false;
  }

  // For NOT_STARTED (or null/undefined), fall back to checking facts
  // This handles legacy users who may have facts but no status set
  const facts = await prisma.userFact.findMany({
    where: { userId },
    select: { factKey: true },
  });

  const factKeys = new Set(facts.map((f) => f.factKey));
  const requiredKeys = ['name', 'timezone', 'role'];

  return requiredKeys.every((key) => factKeys.has(key));
}

/**
 * Search within a specific memory document
 */
export async function searchInMemory(
  memoryId: string,
  query: string,
  topK = 3,
  minSimilarity = 0.5
): Promise<RetrievalResult[]> {
  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) {
    return [];
  }

  const chunks = await prisma.memoryChunk.findMany({
    where: { memoryId },
    include: {
      memory: true,
    },
  });

  const results: RetrievalResult[] = [];

  for (const chunk of chunks) {
    if (!chunk.embeddingVector) {
      continue;
    }

    try {
      const chunkEmbedding = JSON.parse(chunk.embeddingVector);
      const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

      if (similarity >= minSimilarity) {
        results.push({
          chunkId: chunk.id,
          text: chunk.text,
          similarity,
          memoryId: chunk.memory.id,
          scope: chunk.memory.scope,
        });
      }
    } catch (error) {
      console.error(`Error parsing embedding for chunk ${chunk.id}:`, error);
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}
