import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { inferenceRoutes } from '../inference.js';
import type { ModelDefinition } from '../../services/model-catalog.js';
import * as modelCatalog from '../../services/model-catalog.js';
import * as providerRegistry from '../../providers/index.js';
import * as retrieval from '../../services/retrieval.js';

const fakeModel: ModelDefinition = {
  id: 'test-model',
  provider: 'azure',
  deploymentName: 'test-deployment',
  displayName: 'Test Model',
  tier: 2,
  capabilities: ['text', 'streaming'],
  contextWindow: 128000,
  maxOutputTokens: 4096,
  status: 'enabled',
};

function createFakeProvider() {
  return {
    name: 'fake',
    sendChat: vi.fn(async () => ({
      content: 'unused',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })),
    sendChatStream: vi.fn(async function* () {
      yield { text: 'Hello from test' };
      yield { usage: { promptTokens: 1, completionTokens: 3, totalTokens: 4 } };
    }),
  };
}

describe.sequential('Inference Route Model Selection', () => {
  const app = Fastify();
  const originalAuth = env.AUTH_ENFORCEMENT_ENABLED;
  const originalRate = env.RATE_LIMITING_ENABLED;

  beforeAll(async () => {
    await app.register(inferenceRoutes, { prefix: '/v1' });
    await app.ready();
  });

  afterAll(async () => {
    env.AUTH_ENFORCEMENT_ENABLED = originalAuth;
    env.RATE_LIMITING_ENABLED = originalRate;
    await app.close();
  });

  afterEach(async () => {
    env.AUTH_ENFORCEMENT_ENABLED = false;
    env.RATE_LIMITING_ENABLED = false;
    vi.restoreAllMocks();

    await prisma.project.deleteMany({
      where: { name: 'CLI Default' },
    });
  });

  it('uses explicit provider/model selector when provided', async () => {
    vi.spyOn(modelCatalog, 'getModelByProviderAndName').mockResolvedValue(fakeModel);
    vi.spyOn(modelCatalog, 'getModelById').mockResolvedValue(null);
    vi.spyOn(modelCatalog, 'listModels').mockResolvedValue([]);
    vi.spyOn(modelCatalog, 'getBestModelForTier').mockResolvedValue(null);
    vi.spyOn(retrieval, 'getRelevantContext').mockResolvedValue('');
    vi.spyOn(providerRegistry, 'getProvider').mockReturnValue(createFakeProvider() as never);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/inference/chat',
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
        provider: 'azure',
        model: 'test-deployment',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.provider).toBe('azure');
    expect(body.model).toBe('test-deployment');

    expect(modelCatalog.getModelByProviderAndName).toHaveBeenCalledWith('azure', 'test-deployment');
  });

  it('returns 400 for unresolved explicit provider/model selector', async () => {
    vi.spyOn(modelCatalog, 'getModelByProviderAndName').mockResolvedValue(null);
    vi.spyOn(modelCatalog, 'getModelById').mockResolvedValue(null);
    vi.spyOn(modelCatalog, 'listModels').mockResolvedValue([]);
    vi.spyOn(modelCatalog, 'getBestModelForTier').mockResolvedValue(null);
    vi.spyOn(retrieval, 'getRelevantContext').mockResolvedValue('');
    vi.spyOn(providerRegistry, 'getProvider').mockReturnValue(createFakeProvider() as never);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/inference/chat',
      payload: {
        messages: [{ role: 'user', content: 'hello' }],
        provider: 'azure',
        model: 'does-not-exist',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Requested provider/model is not available');
  });

  it('falls back to tier-based selection when no explicit selector is provided', async () => {
    vi.spyOn(modelCatalog, 'getBestModelForTier').mockResolvedValue(fakeModel);
    vi.spyOn(retrieval, 'getRelevantContext').mockResolvedValue('');
    vi.spyOn(providerRegistry, 'getProvider').mockReturnValue(createFakeProvider() as never);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/inference/chat',
      payload: {
        messages: [{ role: 'user', content: 'fallback test' }],
        provider: 'auto',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.provider).toBe('azure');
    expect(body.model).toBe('test-deployment');
    expect(modelCatalog.getBestModelForTier).toHaveBeenCalled();
  });
});
