import type { FastifyInstance } from 'fastify';
import { listModels } from '../services/model-catalog.js';

export async function modelRoutes(server: FastifyInstance) {
  // Public: list configured models for pickers/clients.
  server.get('/models', async () => {
    const models = await listModels({ status: 'enabled', configuredOnly: true });
    const sorted = [...models].sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.displayName.localeCompare(b.displayName);
    });

    const providers = [
      { id: 'auto', label: 'Auto' },
      ...sorted.map((m) => ({
        id: `${m.provider}:${m.deploymentName}`,
        provider: m.provider,
        model: m.deploymentName,
        label: m.displayName,
        tier: m.tier,
        capabilities: m.capabilities,
      })),
    ];

    return {
      defaultProvider: 'auto',
      providers,
    };
  });
}

