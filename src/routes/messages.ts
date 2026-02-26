// Message routes
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuthIfEnabled, enforceRateLimitIfEnabled } from '../security/route-guards.js';
import { env } from '../env.js';

// Client-facing schema: only allow user and assistant messages
const CreateMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

// Internal-only schema for tool and system messages (used by generation.ts)
export const InternalMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().min(1),
});

export async function messageRoutes(server: FastifyInstance) {
  // POST /v1/chats/:chatId/messages - Add a message to a chat
  server.post<{ Params: { chatId: string } }>(
    '/chats/:chatId/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['role', 'content'],
          properties: {
            role: { type: 'string', enum: ['user', 'assistant'] },
            content: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      // Authentication check
      if (!requireAuthIfEnabled(request, reply)) {
        return;
      }

      // Rate limit check
      if (!enforceRateLimitIfEnabled(request, reply, {
        routeKey: 'messages',
        maxRequests: env.RATE_LIMIT_MESSAGES_PER_WINDOW,
      })) {
        return;
      }

      const { chatId } = request.params;
      const rawBody = request.body as Record<string, unknown> | undefined;

      let body;
      try {
        body = CreateMessageSchema.parse(rawBody);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ error: 'Invalid request body', details: error.errors });
        }
        throw error;
      }

      // Verify chat exists
      const chat = await prisma.chat.findUnique({
        where: { id: chatId },
      });

      if (!chat) {
        return reply.code(404).send({ error: 'Chat not found' });
      }

      // Create and return the message
      const message = await prisma.message.create({
        data: {
          chatId,
          role: body.role,
          content: body.content,
        },
      });

      // Update chat's updatedAt
      await prisma.chat.update({
        where: { id: chatId },
        data: { updatedAt: new Date() },
      });

      return reply.code(201).send({ message });
    },
  );

  // GET /v1/chats/:chatId/messages - Get all messages for a chat
  server.get<{ Params: { chatId: string } }>(
    '/chats/:chatId/messages',
    async (request, reply) => {
      const { chatId } = request.params;

      const messages = await prisma.message.findMany({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
      });

      return { messages };
    },
  );

  // PUT /v1/messages/:id - Update an existing message
  server.put<{ Params: { id: string }; Body: { content: string } }>(
    '/messages/:id',
    async (request, reply) => {
      const message = await prisma.message.findUnique({
        where: { id: request.params.id },
      });

      if (!message) {
        return reply.code(404).send({ error: 'Message not found' });
      }

      const updated = await prisma.message.update({
        where: { id: request.params.id },
        data: {
          content: request.body.content,
        },
      });

      return reply.code(200).send({ message: updated });
    },
  );

  // DELETE /v1/messages/:id - Delete a message
  server.delete<{ Params: { id: string } }>(
    '/messages/:id',
    async (request, reply) => {
      const { id } = request.params;

      await prisma.message.delete({
        where: { id },
      });

      return reply.code(204).send();
    },
  );

  // DELETE /v1/chats/:chatId/messages/after/:messageId - Delete all messages after a specific message
  server.delete<{ Params: { chatId: string; messageId: string } }>(
    '/chats/:chatId/messages/after/:messageId',
    async (request, reply) => {
      const { chatId, messageId } = request.params;

      // Find the message to delete after
      const message = await prisma.message.findUnique({
        where: { id: messageId },
      });

      if (!message || message.chatId !== chatId) {
        return reply.code(404).send({ error: 'Message not found' });
      }

      // Delete all messages after this one
      const deleted = await prisma.message.deleteMany({
        where: {
          chatId,
          createdAt: { gt: message.createdAt },
        },
      });

      return { deleted: deleted.count };
    },
  );
}
