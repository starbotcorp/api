// Project routes
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().optional(),
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});

export async function projectRoutes(server: FastifyInstance) {
  // GET /v1/projects - List projects (filtered by email)
  server.get('/projects', async (request, reply) => {
    const email = (request as any).userId
      ? await prisma.user.findUnique({
          where: { id: (request as any).userId },
          select: { email: true },
        }).then(u => u?.email || null)
      : null;

    const projects = await prisma.project.findMany({
      where: email ? { email } : undefined,
      orderBy: [
        { chats: { _count: 'desc' } }, // Projects with more chats first
        { createdAt: 'desc' }, // Then by most recently created
      ],
      include: {
        _count: {
          select: { chats: true },
        },
      },
    });

    return { projects };
  });

  // POST /v1/projects - Create a new project
  server.post('/projects', async (request, reply) => {
    const parsed = CreateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
      });
    }
    const body = parsed.data;

    const project = await prisma.project.create({
      data: {
        name: body.name,
        email: body.email,
        userId: (request as any).userId,
      },
    });

    return reply.code(201).send({ project });
  });

  // GET /v1/projects/:id - Get a specific project
  server.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const { id } = request.params;

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        chats: {
          orderBy: { updatedAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    return { project };
  });

  // PUT /v1/projects/:id - Update a project
  server.put<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
      });
    }
    const body = parsed.data;

    try {
      const project = await prisma.project.update({
        where: { id },
        data: body,
        select: {
          id: true,
          name: true,
          email: true,
          userId: true,
          createdAt: true,
        },
      });
      return { project };
    } catch (err) {
      return reply.code(404).send({ error: 'Project not found' });
    }
  });

  // DELETE /v1/projects/:id - Delete a project
  server.delete<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const { id } = request.params;

    try {
      await prisma.project.delete({
        where: { id },
      });
      return { ok: true };
    } catch (err) {
      return reply.code(404).send({ error: 'Project not found' });
    }
  });
}
