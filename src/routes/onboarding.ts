// Onboarding routes for managing user onboarding state
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuthIfEnabled } from '../security/route-guards.js';

// Onboarding status type
type OnboardingStatusType = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

const CompleteOnboardingSchema = z.object({
  facts: z.record(z.string(), z.any()),
});

export async function onboardingRoutes(server: FastifyInstance) {
  // GET /v1/onboarding/status - Get current onboarding status
  server.get('/onboarding/status', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          onboardingStatus: true,
          lastOnboardingAt: true,
        },
      });

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return reply.send({
        status: user.onboardingStatus as OnboardingStatusType,
        lastCompletedAt: user.lastOnboardingAt?.toISOString() || null,
      });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to get onboarding status',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /v1/onboarding/reset - Reset onboarding to IN_PROGRESS
  server.post('/onboarding/reset', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      // Set status to IN_PROGRESS - this will hide existing facts from prompts
      await prisma.user.update({
        where: { id: userId },
        data: {
          onboardingStatus: 'IN_PROGRESS',
        },
      });

      return reply.send({ success: true });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to reset onboarding',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /v1/onboarding/complete - Complete onboarding with new facts
  server.post('/onboarding/complete', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      const body = CompleteOnboardingSchema.parse(request.body);
      const facts = body.facts;

      // Use transaction to update facts and status atomically
      await prisma.$transaction(async (tx) => {
        // Update or create each fact
        for (const [factKey, factValue] of Object.entries(facts)) {
          const valueStr = typeof factValue === 'string' ? factValue : JSON.stringify(factValue);

          await tx.userFact.upsert({
            where: {
              userId_factKey: {
                userId,
                factKey,
              },
            },
            create: {
              userId,
              factKey,
              factValue: valueStr,
              source: 'onboarding',
              confidence: 1.0,
              status: 'ACTIVE',
            },
            update: {
              factValue: valueStr,
              source: 'onboarding',
              confidence: 1.0,
              status: 'ACTIVE',
              updatedAt: new Date(),
            },
          });
        }

        // Update status to COMPLETED and set lastOnboardingAt
        await tx.user.update({
          where: { id: userId },
          data: {
            onboardingStatus: 'COMPLETED',
            lastOnboardingAt: new Date(),
          },
        });
      });

      return reply.send({ success: true });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to complete onboarding',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
