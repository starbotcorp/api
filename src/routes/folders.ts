// Folder routes
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const CreateFolderSchema = z.object({
  name: z.string().min(1).max(255),
});

const UpdateFolderSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});

export async function folderRoutes(server: FastifyInstance) {
  // GET /v1/projects/:projectId/folders - List folders in a project
  server.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/folders',
    async (request, reply) => {
      const { projectId } = request.params;

      const folders = await prisma.folder.findMany({
        where: { projectId },
        orderBy: { createdAt: 'asc' },
        include: {
          chats: {
            select: { id: true, title: true },
            orderBy: { updatedAt: 'desc' },
          },
        },
      });

      return { folders };
    }
  );

  // POST /v1/projects/:projectId/folders - Create a new folder
  server.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/folders',
    async (request, reply) => {
      const { projectId } = request.params;
      const body = CreateFolderSchema.parse(request.body);

      // Verify project exists
      const project = await prisma.project.findUnique({
        where: { id: projectId },
      });

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const folder = await prisma.folder.create({
        data: {
          projectId,
          name: body.name,
        },
      });

      return reply.code(201).send({ folder });
    }
  );

  // GET /v1/folders/:id - Get a specific folder with its chats
  server.get<{ Params: { id: string } }>('/folders/:id', async (request, reply) => {
    const { id } = request.params;

    const folder = await prisma.folder.findUnique({
      where: { id },
      include: {
        chats: {
          orderBy: { updatedAt: 'desc' },
          include: {
            _count: {
              select: { messages: true },
            },
          },
        },
      },
    });

    if (!folder) {
      return reply.code(404).send({ error: 'Folder not found' });
    }

    return { folder };
  });

  // PUT /v1/folders/:id - Update a folder
  server.put<{ Params: { id: string } }>('/folders/:id', async (request, reply) => {
    const { id } = request.params;
    const body = UpdateFolderSchema.parse(request.body);

    try {
      const folder = await prisma.folder.update({
        where: { id },
        data: body,
      });
      return { folder };
    } catch (err) {
      return reply.code(404).send({ error: 'Folder not found' });
    }
  });

  // DELETE /v1/folders/:id - Delete a folder (moves chats to unfoldered)
  server.delete<{ Params: { id: string } }>('/folders/:id', async (request, reply) => {
    const { id } = request.params;

    // First, move all chats in this folder to have null folderId
    await prisma.chat.updateMany({
      where: { folderId: id },
      data: { folderId: null },
    });

    try {
      await prisma.folder.delete({
        where: { id },
      });
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: 'Folder not found' });
    }
  });
}
