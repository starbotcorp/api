import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuthIfEnabled } from '../security/route-guards.js';

const UpdateSettingsSchema = z.object({
  mode: z.enum(['quick', 'standard', 'deep']).optional(),
  auto: z.boolean().optional(),
  thinking: z.boolean().optional(),
  modelPrefs: z.string().max(200).nullable().optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
});

export async function settingsRoutes(server: FastifyInstance) {
  // GET /v1/user/settings - Get or create user settings
  server.get('/user/settings', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      let settings = await prisma.userSettings.findUnique({
        where: { userId },
      });

      if (!settings) {
        settings = await prisma.userSettings.create({
          data: { userId },
        });
      }

      return reply.send({
        mode: settings.mode,
        auto: settings.auto,
        thinking: settings.thinking,
        modelPrefs: settings.modelPrefs,
        theme: settings.theme,
      });
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to get settings',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // PATCH /v1/user/settings - Update user settings (partial)
  server.patch('/user/settings', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;

    try {
      const body = UpdateSettingsSchema.parse(request.body);

      const settings = await prisma.userSettings.upsert({
        where: { userId },
        create: {
          userId,
          ...body,
          modelPrefs: body.modelPrefs ?? undefined,
        },
        update: body,
      });

      return reply.send({
        mode: settings.mode,
        auto: settings.auto,
        thinking: settings.thinking,
        modelPrefs: settings.modelPrefs,
        theme: settings.theme,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: 'Validation failed', details: error.errors });
      }
      return reply.code(500).send({
        error: 'Failed to update settings',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
