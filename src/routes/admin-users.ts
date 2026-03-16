// Admin user management routes
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAdmin, requireAuthIfEnabled } from '../security/route-guards.js';

const UsersListQuerySchema = z.object({
  search: z.string().optional(),
  page: z.string().transform(val => parseInt(val, 10)).default('1'),
  limit: z.string().transform(val => Math.min(parseInt(val, 10), 100)).default('50'),
  sortBy: z.enum(['createdAt', 'email', 'updatedAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const UpdateUserSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().optional(),
  displayName: z.string().optional(),
  onboardingStatus: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']).optional(),
});

const UpdateFactSchema = z.object({
  factValue: z.string(),
  confidence: z.number().min(0).max(1).optional().default(1.0),
  source: z.string().optional().default('admin'),
});

export async function adminUserRoutes(server: FastifyInstance) {
  // GET /v1/admin/users - List users with search/filters
  server.get('/admin/users', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;
    if (!requireAdmin(request, reply)) return;

    try {
      const query = UsersListQuerySchema.parse(request.query);
      const { search, page, limit, sortBy, sortOrder } = query;
      const skip = (page - 1) * limit;

      // Build where clause for search
      const where: any = {};
      if (search) {
        where.OR = [
          { email: { contains: search, mode: 'insensitive' as const } },
          { displayName: { contains: search, mode: 'insensitive' as const } },
          { name: { contains: search, mode: 'insensitive' as const } },
        ];
      }

      // Get total count
      const total = await prisma.user.count({ where });

      // Get users with related data counts
      const users = await prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: {
          id: true,
          email: true,
          name: true,
          displayName: true,
          createdAt: true,
          updatedAt: true,
          onboardingStatus: true,
          lastOnboardingAt: true,
          personalityTone: true,
          personalityEngagement: true,
          traits: true,
          interests: true,
          _count: {
            select: {
              projects: true,
              sessions: true,
              facts: true,
              calendars: true,
            },
          },
        },
      });

      // Get message count for each user (need separate query due to relationship)
      const userIds = users.map(u => u.id);
      const messageCounts = await prisma.message.groupBy({
        by: ['chatId'],
        _count: true,
      });

      const chatIds = await prisma.chat.findMany({
        where: { projectId: { in: (await prisma.project.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map(p => p.id) } },
        select: { id: true, projectId: true },
      });

      const userIdToProjectIdMap = new Map(
        (await prisma.project.findMany({ where: { userId: { in: userIds } }, select: { id: true, userId: true } }))
          .map(p => [p.id, p.userId])
      );

      const userIdMessageCounts = new Map<string, number>();
      chatIds.forEach(chat => {
        const userId = userIdToProjectIdMap.get(chat.projectId);
        if (userId) {
          const count = userIdMessageCounts.get(userId) || 0;
          userIdMessageCounts.set(userId, count + 1);
        }
      });

      // Enhance users with message count
      const usersWithCounts = users.map(user => ({
        ...user,
        _count: {
          ...user._count,
          messages: userIdMessageCounts.get(user.id) || 0,
        },
      }));

      return reply.send({
        users: usersWithCounts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: 'invalid_query',
          message: error.errors[0]?.message,
        });
      }
      return reply.code(500).send({
        error: 'Failed to list users',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /v1/admin/users/:id - User detail view with facts, threads, projects
  server.get('/admin/users/:id', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;
    if (!requireAdmin(request, reply)) return;

    const { id } = request.params as { id: string };

    try {
      // Get user with basic info
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          name: true,
          displayName: true,
          createdAt: true,
          updatedAt: true,
          onboardingStatus: true,
          lastOnboardingAt: true,
          personalityTone: true,
          personalityEngagement: true,
          traits: true,
          interests: true,
          preferences: true,
          philosophy: true,
          abbrevIndex: true,
          token: true,
          _count: {
            select: {
              projects: true,
              sessions: true,
              facts: true,
              calendars: true,
            },
          },
        },
      });

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      // Get user facts
      const facts = await prisma.userFact.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
      });

      // Get user's projects with chat counts
      const projects = await prisma.project.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          createdAt: true,
          _count: {
            select: {
              chats: true,
              workspaces: true,
              folders: true,
            },
          },
        },
      });

      // Get recent chats (limit to 20)
      const recentChats = await prisma.chat.findMany({
        where: {
          project: { userId: id },
        },
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: {
          id: true,
          title: true,
          projectId: true,
          isFavorite: true,
          isMain: true,
          updatedAt: true,
          _count: {
            select: {
              messages: true,
            },
          },
        },
      });

      // Get active sessions
      const sessions = await prisma.session.findMany({
        where: { userId: id },
        orderBy: { lastUsedAt: 'desc' },
        select: {
          id: true,
          deviceName: true,
          userAgent: true,
          ipAddress: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
        },
      });

      // Get recent calendar events
      const calendarEvents = await prisma.calendar.findMany({
        where: { userId: id },
        orderBy: { startTime: 'desc' },
        take: 10,
        select: {
          id: true,
          title: true,
          startTime: true,
          endTime: true,
          status: true,
        },
      });

      return reply.send({
        user,
        facts,
        projects,
        recentChats,
        sessions,
        calendarEvents,
      });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to get user details',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // PATCH /v1/admin/users/:id - Update user
  server.patch('/admin/users/:id', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;
    if (!requireAdmin(request, reply)) return;

    const { id } = request.params as { id: string };

    try {
      const body = UpdateUserSchema.parse(request.body);

      const user = await prisma.user.update({
        where: { id },
        data: {
          ...body,
          ...(body.onboardingStatus && { lastOnboardingAt: body.onboardingStatus === 'COMPLETED' ? new Date() : null }),
        },
        select: {
          id: true,
          email: true,
          name: true,
          displayName: true,
          createdAt: true,
          updatedAt: true,
          onboardingStatus: true,
          lastOnboardingAt: true,
        },
      });

      return reply.send({ user });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: error.errors[0]?.message,
        });
      }
      return reply.code(500).send({
        error: 'Failed to update user',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // DELETE /v1/admin/users/:id - Delete user (soft delete by deactivating)
  server.delete('/admin/users/:id', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;
    if (!requireAdmin(request, reply)) return;

    const { id } = request.params as { id: string };

    try {
      // First, get the user to return info
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, displayName: true },
      });

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      // Delete all related data in the correct order due to foreign keys
      await prisma.$transaction([
        // Delete calendar events
        prisma.calendar.deleteMany({ where: { userId: id } }),
        // Delete user facts
        prisma.userFact.deleteMany({ where: { userId: id } }),
        // Delete sessions
        prisma.session.deleteMany({ where: { userId: id } }),
        // Delete user's projects and all related data
        prisma.project.deleteMany({ where: { userId: id } }),
        // Finally delete the user
        prisma.user.delete({ where: { id } }),
      ]);

      return reply.send({
        success: true,
        message: 'User deleted successfully',
        deletedUser: user,
      });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to delete user',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /v1/admin/users/:id/facts/:factKey - Update user fact
  server.post('/admin/users/:id/facts/:factKey', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;
    if (!requireAdmin(request, reply)) return;

    const { id, factKey } = request.params as { id: string; factKey: string };

    try {
      const body = UpdateFactSchema.parse(request.body);

      const fact = await prisma.userFact.upsert({
        where: {
          userId_factKey: {
            userId: id,
            factKey,
          },
        },
        create: {
          userId: id,
          factKey,
          factValue: body.factValue,
          confidence: body.confidence,
          source: body.source,
        },
        update: {
          factValue: body.factValue,
          confidence: body.confidence,
          source: body.source,
          updatedAt: new Date(),
        },
      });

      return reply.send({ fact });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: 'invalid_request',
          message: error.errors[0]?.message,
        });
      }
      return reply.code(500).send({
        error: 'Failed to update user fact',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // DELETE /v1/admin/users/:id/facts/:factKey - Delete user fact
  server.delete('/admin/users/:id/facts/:factKey', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;
    if (!requireAdmin(request, reply)) return;

    const { id, factKey } = request.params as { id: string; factKey: string };

    try {
      await prisma.userFact.deleteMany({
        where: { userId: id, factKey },
      });

      return reply.send({ success: true });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to delete user fact',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /v1/admin/users/:id/reset-onboarding - Reset user's onboarding status
  server.post('/admin/users/:id/reset-onboarding', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;
    if (!requireAdmin(request, reply)) return;

    const { id } = request.params as { id: string };

    try {
      const user = await prisma.user.update({
        where: { id },
        data: {
          onboardingStatus: 'NOT_STARTED',
          lastOnboardingAt: null,
        },
        select: {
          id: true,
          email: true,
          onboardingStatus: true,
        },
      });

      return reply.send({
        success: true,
        message: 'User onboarding reset',
        user,
      });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to reset onboarding',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /v1/admin/users/:id/chats - Get user's chats with pagination
  server.get('/admin/users/:id/chats', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;
    if (!requireAdmin(request, reply)) return;

    const { id } = request.params as { id: string };
    const page = parseInt((request.query as any).page || '1', 10);
    const limit = Math.min(parseInt((request.query as any).limit || '50', 10), 100);
    const skip = (page - 1) * limit;

    try {
      const [chats, total] = await Promise.all([
        prisma.chat.findMany({
          where: { project: { userId: id } },
          skip,
          take: limit,
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            title: true,
            projectId: true,
            isFavorite: true,
            isMain: true,
            createdAt: true,
            updatedAt: true,
            _count: {
              select: { messages: true },
            },
          },
        }),
        prisma.chat.count({
          where: { project: { userId: id } },
        }),
      ]);

      return reply.send({
        chats,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to get user chats',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
