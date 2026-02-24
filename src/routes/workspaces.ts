import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db.js';

export const workspaceRoutes: FastifyPluginAsync = async (server) => {
  // List workspaces for a project
  server.get('/projects/:projectId/workspaces', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };

    const workspaces = await prisma.workspace.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });

    return { workspaces };
  });

  // Create workspace
  server.post('/projects/:projectId/workspaces', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { type, identifier } = request.body as {
      type: 'repo' | 'folder' | 'cloud';
      identifier: string;
    };

    // Verify project exists
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const workspace = await prisma.workspace.create({
      data: {
        projectId,
        type,
        identifier,
      },
    });

    return { workspace };
  });

  // Get workspace with chats
  server.get('/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: {
        chats: {
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    if (!workspace) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }

    return { workspace };
  });

  // Delete workspace
  server.delete('/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const workspace = await prisma.workspace.findUnique({
      where: { id },
    });

    if (!workspace) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }

    await prisma.workspace.delete({
      where: { id },
    });

    return { success: true };
  });
};
