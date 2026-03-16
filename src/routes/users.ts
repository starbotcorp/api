// User profile routes
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
import { requireAuthIfEnabled } from '../security/route-guards.js';

const SALT_ROUNDS = 12;

const UpdateProfileSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  personalityTone: z.number().int().min(0).max(2).optional(),
  personalityEngagement: z.number().int().min(0).max(2).optional(),
  traits: z.array(z.string()).optional(),
  interests: z.array(z.string()).optional(),
  preferences: z.record(z.unknown()).optional(),
  philosophy: z.record(z.unknown()).optional(),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const SetFactSchema = z.object({
  factKey: z.string().min(1).max(100),
  factValue: z.string(),
  source: z.string().default('conversation'),
  confidence: z.number().min(0).max(1).default(1.0),
});

export async function userRoutes(server: FastifyInstance) {
  // GET /v1/user - Get current user profile
  server.get('/user', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          displayName: true,
          createdAt: true,
          personalityTone: true,
          personalityEngagement: true,
          traits: true,
          interests: true,
          preferences: true,
          philosophy: true,
        },
      });

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return reply.send(user);
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to get user profile',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // PATCH /v1/user - Update user profile
  server.patch('/user', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      const body = UpdateProfileSchema.parse(request.body);

      const updateData: Record<string, unknown> = {};
      if (body.displayName !== undefined) updateData.displayName = body.displayName;
      if (body.personalityTone !== undefined) updateData.personalityTone = body.personalityTone;
      if (body.personalityEngagement !== undefined) updateData.personalityEngagement = body.personalityEngagement;
      if (body.traits !== undefined) updateData.traits = JSON.stringify(body.traits);
      if (body.interests !== undefined) updateData.interests = JSON.stringify(body.interests);
      if (body.preferences !== undefined) updateData.preferences = JSON.stringify(body.preferences);
      if (body.philosophy !== undefined) updateData.philosophy = JSON.stringify(body.philosophy);

      const user = await prisma.user.update({
        where: { id: userId },
        data: updateData,
        select: {
          id: true,
          email: true,
          name: true,
          displayName: true,
          createdAt: true,
          personalityTone: true,
          personalityEngagement: true,
          traits: true,
          interests: true,
          preferences: true,
          philosophy: true,
        },
      });

      return reply.send(user);
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to update user profile',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /v1/user/facts - Get all user facts
  server.get('/user/facts', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      const facts = await prisma.userFact.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send({ facts });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to get user facts',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /v1/user/facts - Set or update a user fact
  server.post('/user/facts', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      const body = SetFactSchema.parse(request.body);

      const fact = await prisma.userFact.upsert({
        where: {
          userId_factKey: {
            userId,
            factKey: body.factKey,
          },
        },
        create: {
          userId,
          factKey: body.factKey,
          factValue: body.factValue,
          source: body.source,
          confidence: body.confidence,
        },
        update: {
          factValue: body.factValue,
          source: body.source,
          confidence: body.confidence,
          updatedAt: new Date(),
        },
      });

      return reply.send({ fact });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to set user fact',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // DELETE /v1/user/facts/:factKey - Delete a user fact
  server.delete('/user/facts/:factKey', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;
    const { factKey } = request.params as { factKey: string };

    try {
      await prisma.userFact.deleteMany({
        where: { userId, factKey },
      });

      return reply.send({ success: true });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to delete user fact',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // GET /v1/user/facts/onboarding-status - Check if onboarding is complete
  server.get('/user/facts/onboarding-status', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      const facts = await prisma.userFact.findMany({
        where: { userId },
      });

      const factKeys = new Set(facts.map((f) => f.factKey));
      const requiredKeys = ['name', 'timezone', 'role'];
      const isComplete = requiredKeys.every((key) => factKeys.has(key));

      return reply.send({
        isComplete,
        collectedFacts: Array.from(factKeys),
        requiredKeys,
      });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to check onboarding status',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /v1/user/facts/reset-onboarding - Clear all onboarding facts to restart
  server.post('/user/facts/reset-onboarding', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      // Delete only the core onboarding facts, keep other user facts
      await prisma.userFact.deleteMany({
        where: {
          userId,
          factKey: {
            in: ['name', 'timezone', 'role'],
          },
        },
      });

      return reply.send({ success: true, message: 'Onboarding facts cleared' });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to reset onboarding',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /v1/user/facts/start-onboarding - Trigger onboarding greeting in main chat
  server.post('/user/facts/start-onboarding', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      // Find the user's main project (first project or create one if doesn't exist)
      let mainProject = await prisma.project.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });

      if (!mainProject) {
        // Create a default project if user has none
        mainProject = await prisma.project.create({
          data: {
            userId,
            name: 'General Chat',
            email: null,
          },
        });
      }

      // Find existing main chat or create a new one
      let mainChat = await prisma.chat.findFirst({
        where: {
          projectId: mainProject.id,
          workspaceId: null,
          folderId: null,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!mainChat) {
        // Create a new chat for onboarding
        mainChat = await prisma.chat.create({
          data: {
            projectId: mainProject.id,
            title: 'Onboarding',
            clientSource: 'webgui',
            isMain: false,
          },
        });
      } else {
        // Update existing chat to be used for onboarding
        mainChat = await prisma.chat.update({
          where: { id: mainChat.id },
          data: { title: 'Onboarding' },
        });
      }

      // Create a trigger user message that will initiate onboarding
      await prisma.message.create({
        data: {
          chatId: mainChat.id,
          role: 'user',
          content: 'Start onboarding',
        },
      });

      await prisma.chat.update({
        where: { id: mainChat.id },
        data: { updatedAt: new Date() },
      });

      return reply.send({
        success: true,
        chatId: mainChat.id,
      });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to start onboarding',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /v1/user/facts/restart-main-onboarding - Clear main chat messages and set up for onboarding
  server.post('/user/facts/restart-main-onboarding', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      // Find the user's main project (first project)
      let mainProject = await prisma.project.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });

      if (!mainProject) {
        return reply.code(404).send({ error: 'No main project found' });
      }

      // Find the main chat (not in a folder/workspace)
      let mainChat = await prisma.chat.findFirst({
        where: {
          projectId: mainProject.id,
          workspaceId: null,
          folderId: null,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!mainChat) {
        return reply.code(404).send({ error: 'No main chat found' });
      }

      // Delete all messages from the main chat
      await prisma.message.deleteMany({
        where: { chatId: mainChat.id },
      });

      // Update chat title to indicate it's ready for onboarding
      await prisma.chat.update({
        where: { id: mainChat.id },
        data: {
          title: 'Main Chat',
          updatedAt: new Date(),
        },
      });

      return reply.send({
        success: true,
        chatId: mainChat.id,
        message: 'Main chat cleared and ready for onboarding',
      });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to restart main onboarding',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /v1/user/change-password - Change user password
  server.post('/user/change-password', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      const body = ChangePasswordSchema.parse(request.body);

      // Get current user with password hash
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, passwordHash: true },
      });

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      // Verify current password
      const isValid = await bcrypt.compare(body.currentPassword, user.passwordHash);
      if (!isValid) {
        return reply.code(401).send({ error: 'Current password is incorrect' });
      }

      // Hash and update new password
      const newPasswordHash = await bcrypt.hash(body.newPassword, SALT_ROUNDS);
      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash: newPasswordHash },
      });

      return reply.send({ success: true, message: 'Password changed successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Validation failed', details: error.errors });
      }
      return reply.code(500).send({
        error: 'Failed to change password',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
