// Calendar routes - user calendar events
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { z } from 'zod';
import { enforceRateLimitIfEnabled, requireAuthIfEnabled } from '../security/route-guards.js';

// Schemas
const CreateEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional(),
  timezone: z.string().optional(),
  recurrence: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional(),
  reminder: z.string().optional(), // "5min", "15min", "30min", "1hour", etc.
  location: z.string().optional(),
  color: z.string().optional(),
});

const UpdateEventSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  timezone: z.string().optional(),
  recurrence: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional(),
  reminder: z.string().optional(),
  location: z.string().optional(),
  color: z.string().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
});

const ListEventsSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
});

export async function calendarRoutes(server: FastifyInstance) {
  // GET /v1/calendar - List user's calendar events
  server.get('/calendar', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    if (!enforceRateLimitIfEnabled(request, reply, {
      routeKey: 'calendar-list',
      maxRequests: 60,
    })) return;

    const userId = (request as any).userId;

    try {
      const query = ListEventsSchema.parse(request.query as any);

      const events = await prisma.calendar.findMany({
        where: {
          userId,
          ...(query.startDate || query.endDate ? {
            startTime: {
              ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
              ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
            },
          } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: { startTime: 'asc' },
      });

      reply.send(events);
    } catch (error) {
      reply.code(400).send({ error: 'Invalid request', message: error instanceof Error ? error.message : String(error) });
    }
  });

  // POST /v1/calendar - Create a calendar event
  server.post('/calendar', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    if (!enforceRateLimitIfEnabled(request, reply, {
      routeKey: 'calendar-create',
      maxRequests: 30,
    })) return;

    const userId = (request as any).userId;

    try {
      const body = CreateEventSchema.parse(request.body);
      const user = await prisma.user.findUnique({ where: { id: userId } });

      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const event = await prisma.calendar.create({
        data: {
          userId,
          title: body.title,
          description: body.description,
          startTime: new Date(body.startTime),
          endTime: body.endTime ? new Date(body.endTime) : null,
          timezone: body.timezone || 'UTC',
          recurrence: body.recurrence,
          reminder: body.reminder,
          location: body.location,
          color: body.color,
        },
      });

      reply.code(201).send(event);
    } catch (error) {
      reply.code(400).send({ error: 'Invalid request', message: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /v1/calendar/:eventId - Get a specific event
  server.get('/calendar/:eventId', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;
    const { eventId } = request.params as { eventId: string };

    try {
      const event = await prisma.calendar.findFirst({
        where: { id: eventId, userId },
      });

      if (!event) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      reply.send(event);
    } catch (error) {
      reply.code(500).send({ error: 'Server error' });
    }
  });

  // PATCH /v1/calendar/:eventId - Update an event
  server.patch('/calendar/:eventId', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;
    const { eventId } = request.params as { eventId: string };

    try {
      const body = UpdateEventSchema.parse(request.body);

      const event = await prisma.calendar.findFirst({
        where: { id: eventId, userId },
      });

      if (!event) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      const updatedEvent = await prisma.calendar.update({
        where: { id: eventId },
        data: {
          ...(body.title !== undefined && { title: body.title }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.startTime !== undefined && { startTime: new Date(body.startTime) }),
          ...(body.endTime !== undefined && { endTime: body.endTime ? new Date(body.endTime) : null }),
          ...(body.timezone !== undefined && { timezone: body.timezone }),
          ...(body.recurrence !== undefined && { recurrence: body.recurrence }),
          ...(body.reminder !== undefined && { reminder: body.reminder }),
          ...(body.location !== undefined && { location: body.location }),
          ...(body.color !== undefined && { color: body.color }),
          ...(body.status !== undefined && { status: body.status }),
        },
      });

      reply.send(updatedEvent);
    } catch (error) {
      reply.code(400).send({ error: 'Invalid request', message: error instanceof Error ? error.message : String(error) });
    }
  });

  // DELETE /v1/calendar/:eventId - Delete an event
  server.delete('/calendar/:eventId', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;
    const { eventId } = request.params as { eventId: string };

    try {
      const event = await prisma.calendar.findFirst({
        where: { id: eventId, userId },
      });

      if (!event) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      await prisma.calendar.delete({
        where: { id: eventId },
      });

      reply.code(204).send();
    } catch (error) {
      reply.code(500).send({ error: 'Server error' });
    }
  });

  // GET /v1/calendar/upcoming - Get upcoming events (next 7 days by default)
  server.get('/calendar/upcoming', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;
    const days = parseInt((request.query as any).days || '7', 10);

    try {
      const now = new Date();
      const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

      const events = await prisma.calendar.findMany({
        where: {
          userId,
          status: 'scheduled',
          startTime: { gte: now, lte: future },
        },
        orderBy: { startTime: 'asc' },
      });

      reply.send(events);
    } catch (error) {
      reply.code(500).send({ error: 'Server error' });
    }
  });
}
