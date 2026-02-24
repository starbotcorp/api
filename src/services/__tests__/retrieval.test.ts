import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../db.js';
import {
  searchMemory,
  searchIdentityMemory,
  searchChatMemory,
  getRelevantContext,
  getIdentityContext,
  getChatMemoryContext,
} from '../retrieval.js';
import * as embeddingsModule from '../embeddings.js';
import { vi } from 'vitest';

describe('Retrieval Service', () => {
  let projectId: string;
  let workspaceId: string;
  let chatId: string;

  // Mock embedding function
  const mockEmbedding = (text: string): number[] => {
    // Simple deterministic mock: hash text to embedding
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit int
    }
    // Generate 1536-dimensional vector (same as OpenAI)
    const seed = Math.abs(hash);
    const embedding: number[] = [];
    for (let i = 0; i < 1536; i++) {
      embedding.push((Math.sin(seed + i * 0.1) + 1) / 2); // Values 0-1
    }
    return embedding;
  };

  beforeEach(async () => {
    // Create test project
    const project = await prisma.project.create({
      data: {
        name: `Test Project ${Date.now()}`,
      },
    });
    projectId = project.id;

    // Create test workspace
    const workspace = await prisma.workspace.create({
      data: {
        projectId,
        type: 'folder',
        identifier: '/test/workspace',
      },
    });
    workspaceId = workspace.id;

    // Create test chat
    const chat = await prisma.chat.create({
      data: {
        projectId,
        workspaceId,
        title: 'Test Chat',
      },
    });
    chatId = chat.id;

    // Mock the embeddings
    vi.spyOn(embeddingsModule, 'generateEmbedding').mockImplementation(async (text: string) => {
      return mockEmbedding(text);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Cleanup
    if (chatId) {
      await prisma.memoryDocument.deleteMany({ where: { chatId } });
      await prisma.chat.delete({ where: { id: chatId } }).catch(() => {});
    }
    if (workspaceId) {
      await prisma.memoryDocument.deleteMany({ where: { workspaceId } });
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
    }
    if (projectId) {
      await prisma.memoryDocument.deleteMany({ where: { projectId } });
      await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    }
  });

  describe('searchMemory', () => {
    it('should return top K chunks sorted by similarity', async () => {
      // Create memory document with chunks
      const memDoc = await prisma.memoryDocument.create({
        data: {
          projectId,
          scope: 'project',
          content: '# Project Memory\n\nThis is project context.',
        },
      });

      // Create chunks separately
      await prisma.memoryChunk.createMany({
        data: [
          {
            memoryId: memDoc.id,
            text: 'Project overview section',
            embeddingVector: JSON.stringify(mockEmbedding('Project overview')),
          },
          {
            memoryId: memDoc.id,
            text: 'Team members and roles',
            embeddingVector: JSON.stringify(mockEmbedding('Team information')),
          },
        ],
      });

      const results = await searchMemory('project team', projectId, undefined, 2);

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        expect(results[0]).toHaveProperty('chunkId');
        expect(results[0]).toHaveProperty('text');
        expect(results[0]).toHaveProperty('similarity');
        expect(results[0].similarity >= 0 && results[0].similarity <= 1).toBe(true);
      }
    });

    it('should filter by minimum similarity threshold', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          projectId,
          scope: 'project',
          content: 'Test content',
        },
      });

      await prisma.memoryChunk.create({
        data: {
          memoryId: memDoc.id,
          text: 'Completely unrelated content about cats and dogs',
          embeddingVector: JSON.stringify(mockEmbedding('cats dogs')),
        },
      });

      // Query with high similarity threshold for unrelated term
      const results = await searchMemory('quantum computing', projectId, undefined, 5, 0.9);

      // Should return empty or very few results due to high threshold
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should return empty array for no matching documents', async () => {
      // Don't create any memory documents
      const results = await searchMemory('test query', projectId, undefined, 5);

      expect(results).toEqual([]);
    });

    it('should include workspace scope when workspaceId is provided', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          projectId: null,
          workspaceId,
          scope: 'workspace',
          content: 'Workspace context',
        },
      });

      await prisma.memoryChunk.create({
        data: {
          memoryId: memDoc.id,
          text: 'Workspace specific info',
          embeddingVector: JSON.stringify(mockEmbedding('workspace')),
        },
      });

      const results = await searchMemory('workspace', projectId, workspaceId, 5);

      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.scope === 'workspace')).toBe(true);
    });
  });

  describe('searchIdentityMemory', () => {
    it('should search identity scope documents', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          scope: 'identity',
          projectId: null,
          workspaceId: null,
          chatId: null,
          content: 'Identity information',
        },
      });

      await prisma.memoryChunk.create({
        data: {
          memoryId: memDoc.id,
          text: 'My name is Claude',
          embeddingVector: JSON.stringify(mockEmbedding('name Claude')),
        },
      });

      const results = await searchIdentityMemory('What is your name?', 3);

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should return empty array if no identity doc exists', async () => {
      // Clean up any existing identity docs first
      await prisma.memoryDocument.deleteMany({
        where: {
          scope: 'identity',
        },
      });

      const results = await searchIdentityMemory('test', 3);

      expect(results).toEqual([]);
    });
  });

  describe('searchChatMemory', () => {
    it('should search chat scope documents', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          scope: 'chat',
          projectId: null,
          workspaceId: null,
          chatId,
          content: 'Chat memory',
        },
      });

      await prisma.memoryChunk.create({
        data: {
          memoryId: memDoc.id,
          text: 'Previous discussion about databases',
          embeddingVector: JSON.stringify(mockEmbedding('databases')),
        },
      });

      const results = await searchChatMemory('Tell me about databases', chatId, 5);

      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    });

    it('should return empty array if no chat doc exists', async () => {
      const results = await searchChatMemory('test', chatId, 5);

      expect(results).toEqual([]);
    });
  });

  describe('getRelevantContext', () => {
    it('should return formatted markdown context', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          projectId,
          scope: 'project',
          content: 'Project info',
        },
      });

      await prisma.memoryChunk.create({
        data: {
          memoryId: memDoc.id,
          text: 'Important project detail',
          embeddingVector: JSON.stringify(mockEmbedding('project')),
        },
      });

      const context = await getRelevantContext('project info', projectId, undefined, 5);

      expect(typeof context).toBe('string');
      if (context) {
        expect(context).toContain('# Relevant Memory');
        expect(context).toContain('Project');
      }
    });

    it('should return empty string if no results', async () => {
      const context = await getRelevantContext('nonexistent', projectId, undefined, 5);

      expect(context).toBe('');
    });
  });

  describe('getIdentityContext', () => {
    it('should return formatted identity markdown', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          scope: 'identity',
          projectId: null,
          workspaceId: null,
          chatId: null,
          content: '# IDENTITY.md\n\nI am an AI assistant.',
        },
      });

      await prisma.memoryChunk.create({
        data: {
          memoryId: memDoc.id,
          text: 'I am an AI assistant',
          embeddingVector: JSON.stringify(mockEmbedding('identity')),
        },
      });

      const context = await getIdentityContext('Who are you?', 3);

      expect(typeof context).toBe('string');
      if (context) {
        expect(context).toContain('IDENTITY');
      }
    });

    it('should return empty string if no identity doc', async () => {
      // Clean up any existing identity docs first
      await prisma.memoryDocument.deleteMany({
        where: {
          scope: 'identity',
        },
      });

      const context = await getIdentityContext('test', 3);

      expect(context).toBe('');
    });
  });

  describe('getChatMemoryContext', () => {
    it('should return formatted chat markdown', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          scope: 'chat',
          projectId: null,
          workspaceId: null,
          chatId,
          content: '# Chat Memory\n\nPrevious context',
        },
      });

      await prisma.memoryChunk.create({
        data: {
          memoryId: memDoc.id,
          text: 'Previous context about topic',
          embeddingVector: JSON.stringify(mockEmbedding('previous')),
        },
      });

      // Search with term that matches the embedding
      const context = await getChatMemoryContext('previous', chatId, 5);

      expect(typeof context).toBe('string');
      if (context) {
        // When there are search results, context includes # MEMORY.md header
        expect(context).toContain('# MEMORY');
        expect(context).toContain('Previous');
      }
    });

    it('should return empty string if no chat doc', async () => {
      const context = await getChatMemoryContext('test', chatId, 5);

      expect(context).toBe('');
    });
  });

  describe('Cosine Similarity', () => {
    it('should correctly sort results by similarity', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          projectId,
          scope: 'project',
          content: 'Project content',
        },
      });

      await prisma.memoryChunk.createMany({
        data: [
          {
            memoryId: memDoc.id,
            text: 'Content about dogs and animals',
            embeddingVector: JSON.stringify(mockEmbedding('dogs animals')),
          },
          {
            memoryId: memDoc.id,
            text: 'Content about cats and animals',
            embeddingVector: JSON.stringify(mockEmbedding('cats animals')),
          },
          {
            memoryId: memDoc.id,
            text: 'Content about programming languages',
            embeddingVector: JSON.stringify(mockEmbedding('programming')),
          },
        ],
      });

      const results = await searchMemory('animals', projectId, undefined, 10);

      // Results should be sorted by similarity (highest first)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle chunks with null embeddings', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          projectId,
          scope: 'project',
          content: 'Content',
        },
      });

      await prisma.memoryChunk.createMany({
        data: [
          {
            memoryId: memDoc.id,
            text: 'Valid chunk',
            embeddingVector: JSON.stringify(mockEmbedding('test')),
          },
          {
            memoryId: memDoc.id,
            text: 'Invalid chunk with null embedding',
            embeddingVector: null,
          },
        ],
      });

      const results = await searchMemory('test', projectId, undefined, 5);

      // Should only return the valid chunk
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.chunkId)).toBe(true);
    });

    it('should handle empty chunks array', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          projectId,
          scope: 'project',
          content: 'Content without chunks',
        },
      });

      const results = await searchMemory('test', projectId, undefined, 5);

      expect(results).toEqual([]);
    });

    it('should respect topK limit', async () => {
      const memDoc = await prisma.memoryDocument.create({
        data: {
          projectId,
          scope: 'project',
          content: 'Content',
        },
      });

      await prisma.memoryChunk.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          memoryId: memDoc.id,
          text: `Chunk ${i}`,
          embeddingVector: JSON.stringify(mockEmbedding(`chunk ${i}`)),
        })),
      });

      const results = await searchMemory('chunk', projectId, undefined, 5);

      expect(results.length).toBeLessThanOrEqual(5);
    });
  });
});
