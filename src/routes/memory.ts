import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { processContent } from '../services/chunking.js';
import { generateEmbeddingsBatch, areEmbeddingsAvailable } from '../services/embeddings.js';
import { searchChatMemory, searchMemory } from '../services/retrieval.js';

const DEFAULT_IDENTITY = `# IDENTITY

You are Starbot's default assistant identity.

## Core behavior
- Be accurate and explicit
- Prefer practical solutions
- Explain tradeoffs briefly
`;

const DEFAULT_PMEMORY = `# Project Memory

This document stores project-level context and conventions.

## Purpose
- Document architectural decisions
- Store coding conventions
- Track important project-wide patterns

## Guidelines
- Keep content organized with markdown headings
- Update this document as the project evolves
- Use this to guide AI assistants about project preferences
`;

const DEFAULT_WORKSPACE_MEMORY = `# Workspace Memory

This document stores workspace-specific context.

## Purpose
- Document workspace structure
- Store frequently used commands
- Track workspace-specific patterns

## Guidelines
- Keep content focused on this workspace
- Update as you discover patterns
- Use this to guide context-aware operations
`;

const DEFAULT_CHAT_MEMORY = `# Chat Memory

This document stores chat-specific context, decisions, and preferences.

## Purpose
- Keep durable thread context
- Track decisions made in this chat
- Preserve key user preferences for this thread

## Guidelines
- Keep entries concise and factual
- Remove stale or incorrect entries
- Prefer short bullet lists
`;

const MemoryContentSchema = z.object({
  content: z.string(),
});

const ProjectMemorySearchSchema = z.object({
  query: z.string().min(1),
  workspaceId: z.string().optional(),
  topK: z.number().int().min(1).max(20).optional().default(5),
});

const ChatMemorySearchSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(20).optional().default(5),
});

async function processMemory(memoryId: string, content: string) {
  await prisma.memoryChunk.deleteMany({
    where: { memoryId },
  });

  const chunks = processContent(content);
  if (chunks.length === 0) {
    return { status: 'success', chunks: 0, embeddings: 0 };
  }

  let embeddingsGenerated = 0;
  const embeddings = areEmbeddingsAvailable()
    ? await generateEmbeddingsBatch(chunks.map((c) => c.text))
    : chunks.map(() => null);

  const chunkData = chunks.map((chunk, index) => {
    const embedding = embeddings[index];
    if (embedding) embeddingsGenerated++;
    return {
      memoryId,
      text: chunk.text,
      embeddingVector: embedding ? JSON.stringify(embedding) : null,
    };
  });

  await prisma.memoryChunk.createMany({
    data: chunkData,
  });

  return {
    status: 'success',
    chunks: chunks.length,
    embeddings: embeddingsGenerated,
  };
}

function toMemoryEnvelope(memory: { id: string; content: string; updatedAt: Date }) {
  return {
    memory: {
      id: memory.id,
      content: memory.content,
      updatedAt: memory.updatedAt,
    },
  };
}

async function ensureIdentityMemory() {
  let memory = await prisma.memoryDocument.findFirst({
    where: {
      scope: 'identity',
      projectId: null,
      workspaceId: null,
      chatId: null,
    },
  });

  if (!memory) {
    memory = await prisma.memoryDocument.create({
      data: {
        scope: 'identity',
        projectId: null,
        workspaceId: null,
        chatId: null,
        content: DEFAULT_IDENTITY,
      },
    });
  }

  return memory;
}

async function ensureProjectMemory(projectId: string) {
  let memory = await prisma.memoryDocument.findFirst({
    where: {
      scope: 'project',
      projectId,
      workspaceId: null,
      chatId: null,
    },
  });

  if (!memory) {
    memory = await prisma.memoryDocument.create({
      data: {
        scope: 'project',
        projectId,
        workspaceId: null,
        chatId: null,
        content: DEFAULT_PMEMORY,
      },
    });
  }

  return memory;
}

async function ensureWorkspaceMemory(workspaceId: string) {
  let memory = await prisma.memoryDocument.findFirst({
    where: {
      scope: 'workspace',
      projectId: null,
      workspaceId,
      chatId: null,
    },
  });

  if (!memory) {
    memory = await prisma.memoryDocument.create({
      data: {
        scope: 'workspace',
        projectId: null,
        workspaceId,
        chatId: null,
        content: DEFAULT_WORKSPACE_MEMORY,
      },
    });
  }

  return memory;
}

async function ensureChatMemory(chatId: string) {
  let memory = await prisma.memoryDocument.findFirst({
    where: {
      scope: 'chat',
      chatId,
      projectId: null,
      workspaceId: null,
    },
  });

  if (!memory) {
    memory = await prisma.memoryDocument.create({
      data: {
        scope: 'chat',
        chatId,
        projectId: null,
        workspaceId: null,
        content: DEFAULT_CHAT_MEMORY,
      },
    });
  }

  return memory;
}

export const memoryRoutes: FastifyPluginAsync = async (server) => {
  // Global identity memory (IDENTITY.md)
  server.get('/identity', async () => {
    const memory = await ensureIdentityMemory();
    return toMemoryEnvelope(memory);
  });

  server.put('/identity', async (request) => {
    const { content } = MemoryContentSchema.parse(request.body);
    const memory = await ensureIdentityMemory();
    const updated = await prisma.memoryDocument.update({
      where: { id: memory.id },
      data: { content },
    });

    return toMemoryEnvelope(updated);
  });

  server.post('/identity/process', async () => {
    const memory = await ensureIdentityMemory();
    return processMemory(memory.id, memory.content);
  });

  // Get project memory (PMEMORY.md)
  server.get('/projects/:projectId/memory', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const memory = await ensureProjectMemory(projectId);
    return toMemoryEnvelope(memory);
  });

  // Update project memory
  server.put('/projects/:projectId/memory', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { content } = MemoryContentSchema.parse(request.body);

    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const memory = await ensureProjectMemory(projectId);
    const updated = await prisma.memoryDocument.update({
      where: { id: memory.id },
      data: { content },
    });

    return toMemoryEnvelope(updated);
  });

  // Get workspace memory (MEMORY.md)
  server.get('/workspaces/:workspaceId/memory', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }

    const memory = await ensureWorkspaceMemory(workspaceId);
    return toMemoryEnvelope(memory);
  });

  // Update workspace memory
  server.put('/workspaces/:workspaceId/memory', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { content } = MemoryContentSchema.parse(request.body);

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }

    const memory = await ensureWorkspaceMemory(workspaceId);
    const updated = await prisma.memoryDocument.update({
      where: { id: memory.id },
      data: { content },
    });

    return toMemoryEnvelope(updated);
  });

  // Get chat-specific memory (MEMORY.md)
  server.get('/chats/:chatId/memory', async (request, reply) => {
    const { chatId } = request.params as { chatId: string };

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
    });

    if (!chat) {
      return reply.status(404).send({ error: 'Chat not found' });
    }

    const memory = await ensureChatMemory(chatId);
    return toMemoryEnvelope(memory);
  });

  // Update chat-specific memory
  server.put('/chats/:chatId/memory', async (request, reply) => {
    const { chatId } = request.params as { chatId: string };
    const { content } = MemoryContentSchema.parse(request.body);

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
    });

    if (!chat) {
      return reply.status(404).send({ error: 'Chat not found' });
    }

    const memory = await ensureChatMemory(chatId);
    const updated = await prisma.memoryDocument.update({
      where: { id: memory.id },
      data: { content },
    });

    return toMemoryEnvelope(updated);
  });

  // Process project memory (generate chunks and embeddings)
  server.post('/projects/:projectId/memory/process', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    const memory = await prisma.memoryDocument.findFirst({
      where: {
        scope: 'project',
        projectId,
        workspaceId: null,
        chatId: null,
      },
    });

    if (!memory) {
      return reply.status(404).send({ error: 'Memory document not found' });
    }

    return processMemory(memory.id, memory.content);
  });

  // Process workspace memory
  server.post('/workspaces/:workspaceId/memory/process', async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };

    const memory = await prisma.memoryDocument.findFirst({
      where: {
        scope: 'workspace',
        projectId: null,
        workspaceId,
        chatId: null,
      },
    });

    if (!memory) {
      return reply.status(404).send({ error: 'Memory document not found' });
    }

    return processMemory(memory.id, memory.content);
  });

  // Process chat memory
  server.post('/chats/:chatId/memory/process', async (request, reply) => {
    const { chatId } = request.params as { chatId: string };

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
    });
    if (!chat) {
      return reply.status(404).send({ error: 'Chat not found' });
    }

    const memory = await ensureChatMemory(chatId);
    return processMemory(memory.id, memory.content);
  });

  // Search project/workspace memory
  server.post('/projects/:projectId/memory/search', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { query, workspaceId, topK } = ProjectMemorySearchSchema.parse(request.body);
    const results = await searchMemory(query, projectId, workspaceId, topK);
    return { results };
  });

  // Search chat memory
  server.post('/chats/:chatId/memory/search', async (request, reply) => {
    const { chatId } = request.params as { chatId: string };
    const { query, topK } = ChatMemorySearchSchema.parse(request.body);

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
    });
    if (!chat) {
      return reply.status(404).send({ error: 'Chat not found' });
    }

    const results = await searchChatMemory(query, chatId, topK);
    return { results };
  });
};
