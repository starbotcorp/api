import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { prisma } from '../../db.js';
import { messageRoutes } from '../messages.js';

describe.sequential('Message Routes', () => {
  const app = Fastify();
  let projectId = '';
  let chatId = '';

  beforeAll(async () => {
    await app.register(messageRoutes, { prefix: '/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const project = await prisma.project.create({
      data: { name: `Messages Test ${Date.now()}` },
    });
    projectId = project.id;

    const chat = await prisma.chat.create({
      data: {
        projectId,
        title: 'Messages Test Chat',
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

  it('updates a message via PUT /v1/messages/:id', async () => {
    const message = await prisma.message.create({
      data: {
        chatId,
        role: 'user',
        content: 'Original content',
      },
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/messages/${message.id}`,
      payload: { content: 'Updated content' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message.id).toBe(message.id);
    expect(body.message.content).toBe('Updated content');
  });

  it('deletes a message via DELETE /v1/messages/:id', async () => {
    const message = await prisma.message.create({
      data: {
        chatId,
        role: 'user',
        content: 'Delete me',
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/messages/${message.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);

    const messageAfterDelete = await prisma.message.findUnique({
      where: { id: message.id },
    });
    expect(messageAfterDelete).toBeNull();
  });

  it('deletes target and subsequent messages via DELETE /v1/chats/:chatId/messages/after/:messageId', async () => {
    const baseTime = Date.now();

    const m1 = await prisma.message.create({
      data: {
        chatId,
        role: 'user',
        content: 'Message 1',
        createdAt: new Date(baseTime + 1),
      },
    });
    const m2 = await prisma.message.create({
      data: {
        chatId,
        role: 'assistant',
        content: 'Message 2',
        createdAt: new Date(baseTime + 2),
      },
    });
    await prisma.message.create({
      data: {
        chatId,
        role: 'user',
        content: 'Message 3',
        createdAt: new Date(baseTime + 3),
      },
    });
    await prisma.message.create({
      data: {
        chatId,
        role: 'assistant',
        content: 'Message 4',
        createdAt: new Date(baseTime + 4),
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/chats/${chatId}/messages/after/${m2.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(3);

    const remaining = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
    });

    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(m1.id);
  });

  describe('Message Security', () => {
    it('should reject tool role from client POST /v1/chats/:chatId/messages', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/messages`,
        payload: {
          role: 'tool',
          content: 'Fake tool result',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
    });

    it('should reject system role from client POST /v1/chats/:chatId/messages', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/messages`,
        payload: {
          role: 'system',
          content: 'Fake system message',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('error');
    });

    it('should allow user role from client', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/messages`,
        payload: {
          role: 'user',
          content: 'Valid user message',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.message.role).toBe('user');
      expect(body.message.content).toBe('Valid user message');
    });

    it('should allow assistant role from client', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/chats/${chatId}/messages`,
        payload: {
          role: 'assistant',
          content: 'Valid assistant message',
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.message.role).toBe('assistant');
      expect(body.message.content).toBe('Valid assistant message');
    });
  });
});
