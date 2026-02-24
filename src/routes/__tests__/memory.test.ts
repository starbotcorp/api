import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { prisma } from '../../db.js';
import { memoryRoutes } from '../memory.js';

describe.sequential('Memory Routes', () => {
  const app = Fastify();
  let projectId = '';
  let chatId = '';

  beforeAll(async () => {
    await app.register(memoryRoutes, { prefix: '/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const project = await prisma.project.create({
      data: { name: `Memory Test ${Date.now()}` },
    });
    projectId = project.id;

    const chat = await prisma.chat.create({
      data: {
        projectId,
        title: 'Memory Test Chat',
      },
    });
    chatId = chat.id;
  });

  afterEach(async () => {
    if (projectId) {
      await prisma.project.delete({
        where: { id: projectId },
      });
    }
    projectId = '';
    chatId = '';
  });

  it('auto-creates identity memory via GET /v1/identity', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/identity',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.memory).toBeDefined();
    expect(typeof body.memory.id).toBe('string');
    expect(body.memory.content).toContain('# IDENTITY');
  });

  it('auto-creates chat memory via GET /v1/chats/:chatId/memory', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/chats/${chatId}/memory`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.memory).toBeDefined();
    expect(typeof body.memory.id).toBe('string');
    expect(body.memory.content).toContain('# Chat Memory');
  });

  it('updates chat memory via PUT /v1/chats/:chatId/memory', async () => {
    const updatedContent = '# Chat Memory\n\n- Decision: use provider failover first.';
    const response = await app.inject({
      method: 'PUT',
      url: `/v1/chats/${chatId}/memory`,
      payload: { content: updatedContent },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.memory.content).toBe(updatedContent);
  });
});
