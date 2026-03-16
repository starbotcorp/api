// Chat routes
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuthIfEnabled } from '../security/route-guards.js';

const CreateChatSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  folderId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  clientSource: z.enum(["webgui", "cli"]).optional(),
});

const UpdateChatSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  folderId: z.string().uuid().optional().nullable(),
  isFavorite: z.boolean().optional(),
});

export async function chatRoutes(server: FastifyInstance) {
  // GET /v1/projects/:projectId/chats - List chats in a project
  server.get<{ Params: { projectId: string }; Querystring: { clientSource?: string } }>(
    '/projects/:projectId/chats',
    async (request, reply) => {
      const { projectId } = request.params;
      const { clientSource } = request.query;

      const where: { projectId: string; clientSource?: string } = { projectId };
      if (clientSource) {
        where.clientSource = clientSource;
      }

      const chats = await prisma.chat.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        include: {
          _count: {
            select: { messages: true },
          },
          folder: {
            select: { id: true, name: true },
          },
        },
      });

      return { chats };
    }
  );

  // POST /v1/projects/:projectId/chats - Create a new chat
  server.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/chats',
    async (request, reply) => {
      const { projectId } = request.params;
      const body = CreateChatSchema.parse(request.body);

      // Verify project exists
      const project = await prisma.project.findUnique({
        where: { id: projectId },
      });

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const chat = await prisma.chat.create({
        data: {
          projectId,
          title: body.title || 'New Chat',
          folderId: body.folderId,
          workspaceId: body.workspaceId,
          clientSource: body.clientSource || 'webgui',
        },
      });

      return reply.code(201).send({ chat });
    }
  );

  // GET /v1/chats/:id - Get a specific chat
  server.get<{ Params: { id: string } }>('/chats/:id', async (request, reply) => {
    const { id } = request.params;

    const chat = await prisma.chat.findUnique({
      where: { id },
      include: {
        project: true,
        folder: true,
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    return { chat };
  });

  // PUT /v1/chats/:id - Update a chat
  server.put<{ Params: { id: string } }>('/chats/:id', async (request, reply) => {
    const { id } = request.params;
    const body = UpdateChatSchema.parse(request.body);

    try {
      // Check if this is the main thread - main thread cannot be moved to a folder
      const existingChat = await prisma.chat.findUnique({ where: { id } });
      if (existingChat?.isMain && body.folderId !== undefined && body.folderId !== null) {
        return reply.code(403).send({ error: 'Main thread cannot be moved to a folder' });
      }

      const chat = await prisma.chat.update({
        where: { id },
        data: body,
      });
      return { chat };
    } catch (err) {
      return reply.code(404).send({ error: 'Chat not found' });
    }
  });

  // DELETE /v1/chats/:id - Delete a chat
  server.delete<{ Params: { id: string } }>('/chats/:id', async (request, reply) => {
    const { id } = request.params;

    try {
      // Check if this is the main thread - main thread cannot be deleted
      const chat = await prisma.chat.findUnique({ where: { id } });
      if (chat?.isMain) {
        return reply.code(403).send({ error: 'Main thread cannot be deleted' });
      }

      await prisma.chat.delete({
        where: { id },
      });
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: 'Chat not found' });
    }
  });

  // PATCH /v1/chats/:id/favorite - Toggle favorite status
  server.patch<{ Params: { id: string } }>('/chats/:id/favorite', async (request, reply) => {
    const { id } = request.params;
    const body = z.object({ isFavorite: z.boolean() }).parse(request.body);

    try {
      const chat = await prisma.chat.update({
        where: { id },
        data: { isFavorite: body.isFavorite },
      });
      return { chat };
    } catch (err) {
      return reply.code(404).send({ error: 'Chat not found' });
    }
  });

  // PATCH /v1/chats/:id/main - Set as main thread (only one per project)
  server.patch<{ Params: { id: string } }>('/chats/:id/main', async (request, reply) => {
    const { id } = request.params;
    const body = z.object({ isMain: z.boolean() }).parse(request.body);

    try {
      const chat = await prisma.chat.findUnique({ where: { id } });
      if (!chat) {
        return reply.code(404).send({ error: 'Chat not found' });
      }

      // If setting as main, unset any existing main thread in the same project
      if (body.isMain) {
        await prisma.chat.updateMany({
          where: {
            projectId: chat.projectId,
            isMain: true,
          },
          data: { isMain: false },
        });
      }

      const updatedChat = await prisma.chat.update({
        where: { id },
        data: { isMain: body.isMain },
      });
      return { chat: updatedChat };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update main thread' });
    }
  });

  // DELETE /v1/chats/:id/messages - Delete all messages in a chat
  server.delete<{ Params: { id: string } }>('/chats/:id/messages', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const { id } = request.params;

    try {
      // Verify chat exists and user has access
      const chat = await prisma.chat.findUnique({
        where: { id },
      });

      if (!chat) {
        return reply.code(404).send({ error: 'Chat not found' });
      }

      // Delete all messages
      await prisma.message.deleteMany({
        where: { chatId: id },
      });

      // Update chat timestamp
      await prisma.chat.update({
        where: { id },
        data: { updatedAt: new Date() },
      });

      return reply.send({ success: true });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to delete messages',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /v1/projects/:projectId/chats/favorites - List favorite chats in a project
  server.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/chats/favorites',
    async (request, reply) => {
      const { projectId } = request.params;

      const chats = await prisma.chat.findMany({
        where: {
          projectId,
          isFavorite: true,
        },
        orderBy: { updatedAt: 'desc' },
        include: {
          _count: {
            select: { messages: true },
          },
          folder: {
            select: { id: true, name: true },
          },
        },
      });

      return { chats };
    }
  );

  // GET /v1/chats/main/or-create - Get main thread or create one
  server.get('/chats/main/or-create', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;
    const userEmail = (request as any).userEmail;

    try {
      // Get user's first project, or create one if it doesn't exist
      let project = await prisma.project.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });

      if (!project) {
        // Auto-create a default project for the user
        project = await prisma.project.create({
          data: {
            userId,
            name: 'My Project',
            email: userEmail,
          },
        });
      }

      // Check if main thread exists
      let mainThread = await prisma.chat.findFirst({
        where: {
          projectId: project.id,
          isMain: true,
        },
      });

      // If no main thread exists, create one
      if (!mainThread) {
        // Check if user needs onboarding to determine initial title
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { onboardingStatus: true },
        });
        const needsOnboarding = user?.onboardingStatus !== 'COMPLETED';
        const initialTitle = needsOnboarding ? 'Onboarding' : 'Main Thread';

        mainThread = await prisma.chat.create({
          data: {
            projectId: project.id,
            title: initialTitle,
            clientSource: 'webgui',
            isMain: true,
          },
        });

        // Add initial system message for onboarding
        await prisma.message.create({
          data: {
            chatId: mainThread.id,
            role: 'system',
            content: "Hello! Welcome to Starbot. I'm here to help you get started.\n\nTo begin, could you tell me:\n\n1. What should I call you?\n2. Is there anything specific you'd like help with right now?\n\nTake your time - I'm here whenever you're ready!",
          },
        });
      }

      return reply.send({ chat: mainThread });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to get or create main thread',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
