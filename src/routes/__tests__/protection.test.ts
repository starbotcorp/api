import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { env } from '../../env.js';
import { generationRoutes } from '../generation.js';
import { inferenceRoutes } from '../inference.js';

describe.sequential('Protected Route Guards', () => {
  const app = Fastify();

  const originalAuth = env.AUTH_ENFORCEMENT_ENABLED;
  const originalRate = env.RATE_LIMITING_ENABLED;
  const originalWindow = env.RATE_LIMIT_WINDOW_MS;
  const originalRunLimit = env.RATE_LIMIT_RUN_PER_WINDOW;
  const originalInferenceLimit = env.RATE_LIMIT_INFERENCE_PER_WINDOW;

  beforeAll(async () => {
    await app.register(generationRoutes, { prefix: '/v1' });
    await app.register(inferenceRoutes, { prefix: '/v1' });
    await app.ready();
  });

  afterAll(async () => {
    env.AUTH_ENFORCEMENT_ENABLED = originalAuth;
    env.RATE_LIMITING_ENABLED = originalRate;
    env.RATE_LIMIT_WINDOW_MS = originalWindow;
    env.RATE_LIMIT_RUN_PER_WINDOW = originalRunLimit;
    env.RATE_LIMIT_INFERENCE_PER_WINDOW = originalInferenceLimit;
    await app.close();
  });

  afterEach(() => {
    env.AUTH_ENFORCEMENT_ENABLED = false;
    env.RATE_LIMITING_ENABLED = false;
    env.RATE_LIMIT_WINDOW_MS = 60000;
    env.RATE_LIMIT_RUN_PER_WINDOW = 8;
    env.RATE_LIMIT_INFERENCE_PER_WINDOW = 30;
  });

  it('returns 401 on /v1/chats/:chatId/run when auth enforcement is enabled and no token is provided', async () => {
    env.AUTH_ENFORCEMENT_ENABLED = true;
    env.RATE_LIMITING_ENABLED = false;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chats/does-not-matter/run',
      payload: { mode: 'standard' },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 on /v1/inference/chat when auth enforcement is enabled and no token is provided', async () => {
    env.AUTH_ENFORCEMENT_ENABLED = true;
    env.RATE_LIMITING_ENABLED = false;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/inference/chat',
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('unauthorized');
  });

  it('returns 429 on /v1/chats/:chatId/run when rate limit is exceeded', async () => {
    env.AUTH_ENFORCEMENT_ENABLED = false;
    env.RATE_LIMITING_ENABLED = true;
    env.RATE_LIMIT_WINDOW_MS = 60000;
    env.RATE_LIMIT_RUN_PER_WINDOW = 1;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/chats/does-not-matter/run',
      headers: {
        'x-api-token': 'rate-test-token',
      },
      payload: { mode: 'standard' },
    });

    expect(first.statusCode).toBe(404);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/chats/does-not-matter/run',
      headers: {
        'x-api-token': 'rate-test-token',
      },
      payload: { mode: 'standard' },
    });

    expect(second.statusCode).toBe(429);
    const body = JSON.parse(second.body);
    expect(body.error).toBe('rate_limited');
  });

  it('returns 429 on /v1/inference/chat when rate limit is exceeded', async () => {
    env.AUTH_ENFORCEMENT_ENABLED = false;
    env.RATE_LIMITING_ENABLED = true;
    env.RATE_LIMIT_WINDOW_MS = 60000;
    env.RATE_LIMIT_INFERENCE_PER_WINDOW = 1;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/inference/chat',
      headers: {
        'x-api-token': 'rate-test-token',
      },
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(first.statusCode).not.toBe(429);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/inference/chat',
      headers: {
        'x-api-token': 'rate-test-token',
      },
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(second.statusCode).toBe(429);
    const body = JSON.parse(second.body);
    expect(body.error).toBe('rate_limited');
  });
});
