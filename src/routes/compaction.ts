// Compaction routes
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { requireAuthIfEnabled } from '../security/route-guards.js';
import { compactChat } from '../services/compactor.js';

export async function compactionRoutes(server: FastifyInstance) {
  // POST /v1/chats/:chatId/compact
  // Runs the Clio compactor on the chat, stores the JSON summary, merges user profile updates.
  server.post('/chats/:chatId/compact', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const userId = (request as any).userId;
    const { chatId } = request.params as { chatId: string };

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { id: true, project: { select: { userId: true } } },
    });

    if (!chat) return reply.code(404).send({ error: 'Chat not found' });

    // Only the owner can compact
    if (chat.project.userId && chat.project.userId !== userId) {
      return reply.code(403).send({ error: 'Not authorised' });
    }

    try {
      const result = await compactChat(chatId, userId);

      return reply.send({
        ok: true,
        summary: result.parsed.summary,
        topicCount: result.parsed.topics.length,
        decisionCount: result.parsed.decisions.length,
        pendingTaskCount: result.parsed.pendingTasks.length,
        mergedTraits: result.mergedTraits,
        mergedInterests: result.mergedInterests,
        newFacts: result.newFacts,
        newAbbrev: result.newAbbrev,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      server.log.error({ err, chatId }, 'Compaction failed');
      return reply.code(500).send({ error: 'Compaction failed', message: msg });
    }
  });

  // GET /v1/chats/:chatId/compaction
  // Returns the stored compaction summary for a chat.
  server.get('/chats/:chatId/compaction', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) return;

    const { chatId } = request.params as { chatId: string };

    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      select: { compaction: true, compactedAt: true },
    });

    if (!chat) return reply.code(404).send({ error: 'Chat not found' });

    if (!chat.compaction) {
      return reply.send({ compaction: null, compactedAt: null });
    }

    let parsed: unknown = null;
    try { parsed = JSON.parse(chat.compaction); } catch { /* raw string fallback */ }

    return reply.send({
      compaction: parsed ?? chat.compaction,
      compactedAt: chat.compactedAt?.toISOString() ?? null,
    });
  });
}
