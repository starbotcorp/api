import type { ModelDefinition } from '../../services/model-catalog.js';
import {
  getBestModelForTier,
  getModelById,
  getModelByProviderAndName,
  listModels,
} from '../../services/model-catalog.js';

const KNOWN_PROVIDERS = new Set(['kimi', 'vertex', 'azure', 'bedrock', 'cloudflare', 'deepseek']);

export function parseModelPrefs(raw?: string): { provider?: string; model?: string } {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return {};
  if (trimmed.includes(':')) {
    const [providerRaw, modelRaw] = trimmed.split(':', 2);
    const provider = providerRaw.trim().toLowerCase();
    const model = modelRaw.trim();
    return {
      provider: provider || undefined,
      model: model || undefined,
    };
  }
  const lower = trimmed.toLowerCase();
  if (KNOWN_PROVIDERS.has(lower)) {
    return { provider: lower };
  }
  return { model: trimmed };
}

export function sortByCost(models: ModelDefinition[]): ModelDefinition[] {
  return [...models].sort((a, b) => {
    const aCost = a.costPer1kInput || Number.POSITIVE_INFINITY;
    const bCost = b.costPer1kInput || Number.POSITIVE_INFINITY;
    return aCost - bCost;
  });
}

export function sortFallbackCandidates(models: ModelDefinition[], targetTier: number): ModelDefinition[] {
  return [...models].sort((a, b) => {
    const aTierDistance = Math.abs(a.tier - targetTier);
    const bTierDistance = Math.abs(b.tier - targetTier);
    if (aTierDistance !== bTierDistance) return aTierDistance - bTierDistance;

    const aCost = a.costPer1kInput || Number.POSITIVE_INFINITY;
    const bCost = b.costPer1kInput || Number.POSITIVE_INFINITY;
    return aCost - bCost;
  });
}

export async function resolveRequestedModel(
  tier: number,
  capability: string,
  modelPrefs?: string,
): Promise<ModelDefinition | null> {
  const prefs = parseModelPrefs(modelPrefs);

  if (prefs.model) {
    if (prefs.provider) {
      const exact = await getModelByProviderAndName(prefs.provider, prefs.model);
      if (exact && exact.status === 'enabled') return exact;
    }

    const byId = await getModelById(prefs.model);
    if (byId && byId.status === 'enabled' && (!prefs.provider || byId.provider === prefs.provider)) {
      return byId;
    }

    const all = await listModels({
      status: 'enabled',
      capability,
      configuredOnly: true,
      ...(prefs.provider ? { provider: prefs.provider } : {}),
    });
    const byDeployment = all.find(m => m.deploymentName === prefs.model);
    if (byDeployment) return byDeployment;
  }

  if (prefs.provider) {
    const atTier = await listModels({
      status: 'enabled',
      tier,
      capability,
      configuredOnly: true,
      provider: prefs.provider,
    });
    if (atTier.length > 0) return sortByCost(atTier)[0];

    const anyTier = await listModels({
      status: 'enabled',
      capability,
      configuredOnly: true,
      provider: prefs.provider,
    });
    if (anyTier.length > 0) return sortByCost(anyTier)[0];
  }

  return getBestModelForTier(tier, capability, true);
}
