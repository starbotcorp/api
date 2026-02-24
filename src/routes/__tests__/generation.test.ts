import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify from 'fastify';
import { generationRoutes } from '../generation.js';
import { prisma } from '../../db.js';
import * as interpreter from '../../services/interpreter.js';
import * as webSearch from '../../services/web-search.js';
import * as retrieval from '../../services/retrieval.js';
import type { FastifyInstance } from 'fastify';

describe('Generation Route (POST /v1/chats/:chatId/run)', () => {
  let app: FastifyInstance;
  let projectId: string;
  let workspaceId: string;
  let chatId: string;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(generationRoutes, { prefix: '/v1' });
    await app.ready();

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
        title: 'New Chat',
      },
    });
    chatId = chat.id;

    // Add initial user message
    await prisma.message.create({
      data: {
        chatId,
        role: 'user',
        content: 'Hello, how are you?',
      },
    });
  });

  afterAll(async () => {
    await app.close();

    // Cleanup
    if (chatId) {
      await prisma.message.deleteMany({ where: { chatId } });
      await prisma.chat.delete({ where: { id: chatId } }).catch(() => {});
    }
    if (workspaceId) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
    }
    if (projectId) {
      await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Chat Not Found', () => {
    it('should return 404 for nonexistent chat', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/nonexistent-chat-id/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toHaveProperty('error');
    });
  });

  describe('Interpreter Integration', () => {
    it('should include interpreter events in response', async () => {
      vi.spyOn(interpreter, 'interpretUserMessage').mockResolvedValue({
        shouldClarify: false,
        normalizedUserMessage: 'Test message',
        primaryIntent: 'chat',
        intents: ['chat'],
        confidence: 0.85,
        reason: 'test_reason',
      });

      vi.spyOn(retrieval, 'getRelevantContext').mockResolvedValue('');
      vi.spyOn(retrieval, 'getIdentityContext').mockResolvedValue('');
      vi.spyOn(retrieval, 'getChatMemoryContext').mockResolvedValue('');

      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.body;
      // Check that SSE events are in response (from interpreter pass and status)
      expect(body).toContain('event:');
      expect(body).toContain('status');
    });
  });

  describe('Memory Injection', () => {
    it('should handle memory retrieval in response', async () => {
      vi.spyOn(interpreter, 'interpretUserMessage').mockResolvedValue({
        shouldClarify: false,
        normalizedUserMessage: 'Test',
        primaryIntent: 'chat',
        intents: ['chat'],
        confidence: 0.9,
        reason: 'test',
      });

      vi.spyOn(retrieval, 'getRelevantContext').mockResolvedValue('# Memory\nSome context');
      vi.spyOn(retrieval, 'getIdentityContext').mockResolvedValue('');
      vi.spyOn(retrieval, 'getChatMemoryContext').mockResolvedValue('');

      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.body;
      // Should include status events showing memory processing
      expect(body).toContain('event:');
      expect(body).toContain('status');
    });
  });

  describe('Clarification Handling', () => {
    it('should handle clarification responses from interpreter', async () => {
      // Add ambiguous message
      await prisma.message.create({
        data: {
          chatId,
          role: 'user',
          content: 'Something unclear',
        },
      });

      vi.spyOn(interpreter, 'interpretUserMessage').mockResolvedValue({
        shouldClarify: true,
        clarificationQuestion: 'Could you provide more details?',
        normalizedUserMessage: 'Something unclear',
        primaryIntent: 'clarify',
        intents: ['clarify'],
        confidence: 0.5,
        reason: 'ambiguous_request',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.body;
      // Should send clarification as final message
      expect(body).toContain('event: message.final');
      expect(body).toContain('Could you provide more details');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing user message gracefully', async () => {
      // Create chat with no messages
      const emptyChat = await prisma.chat.create({
        data: {
          projectId,
          workspaceId,
          title: 'Empty Chat',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${emptyChat.id}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.body;
      expect(body).toContain('event: error');

      await prisma.chat.delete({ where: { id: emptyChat.id } });
    });

    it('should send error event on interpreter failure', async () => {
      vi.spyOn(interpreter, 'interpretUserMessage').mockRejectedValue(
        new Error('Interpreter service unavailable')
      );

      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.body;
      expect(body).toContain('event: error');
    });
  });

  describe('Request Body Parameters', () => {
    it('should validate route parameters', async () => {
      // Basic validation that endpoint exists and validates input
      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/run`,
        payload: {
          mode: 'deep',
          speed: true,
        },
      });

      // Should be 200 (success with mocks) or 500 (if provider fails)
      // But not 404 or validation error
      expect([200, 500]).toContain(response.statusCode);
    });
  });

  describe('SSE Event Stream', () => {
    it('should return properly formatted SSE headers', async () => {
      vi.spyOn(interpreter, 'interpretUserMessage').mockResolvedValue({
        shouldClarify: false,
        normalizedUserMessage: 'Test',
        primaryIntent: 'chat',
        intents: ['chat'],
        confidence: 0.9,
        reason: 'test',
      });

      vi.spyOn(retrieval, 'getRelevantContext').mockResolvedValue('');
      vi.spyOn(retrieval, 'getIdentityContext').mockResolvedValue('');
      vi.spyOn(retrieval, 'getChatMemoryContext').mockResolvedValue('');

      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['connection']).toBe('keep-alive');
      // Verify response contains event data
      expect(response.body.length).toBeGreaterThan(0);
    });

    it('should include status events', async () => {
      vi.spyOn(interpreter, 'interpretUserMessage').mockResolvedValue({
        shouldClarify: false,
        normalizedUserMessage: 'Test',
        primaryIntent: 'chat',
        intents: ['chat'],
        confidence: 0.9,
        reason: 'test',
      });

      vi.spyOn(retrieval, 'getRelevantContext').mockResolvedValue('');
      vi.spyOn(retrieval, 'getIdentityContext').mockResolvedValue('');
      vi.spyOn(retrieval, 'getChatMemoryContext').mockResolvedValue('');

      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/run`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.body;
      // Should contain events from the route
      expect(body).toMatch(/event: \w+/);
    });
  });
});
