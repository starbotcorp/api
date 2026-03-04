// Model Catalog for Starbot_API
// Simplified to 2 models: Codex Mini for routing, DeepSeek R1 for chat

import { env, isProviderConfigured } from '../env.js';

export interface ModelDefinition {
  id: string;                    // Unique identifier
  provider: string;              // kimi, vertex, azure, bedrock, cloudflare
  deploymentName: string;        // Actual model name used by provider API
  displayName: string;           // Human-readable name
  tier: number;                  // 1=cheap/fast, 2=standard, 3=premium
  capabilities: string[];        // ['text', 'vision', 'tools', 'streaming']
  contextWindow: number;         // Max input tokens
  maxOutputTokens: number;       // Max output tokens
  costPer1kInput?: number;       // USD per 1k input tokens
  costPer1kOutput?: number;      // USD per 1k output tokens
  latencyMs?: number;            // Typical latency
  status: 'enabled' | 'disabled' | 'beta';
  notes?: string;
}

const MODELS: ModelDefinition[] = [
  // ===== CURRENTLY USING: DEEPSEEK R1 (OFFICIAL API) =====

  // Official DeepSeek API - supports function calling!
  {
    id: 'deepseek-chat',
    provider: 'deepseek',
    deploymentName: 'deepseek-chat',
    displayName: 'DeepSeek Chat V3',
    tier: 1,
    capabilities: ['text', 'streaming', 'tools'],
    contextWindow: 131072,
    maxOutputTokens: 8192,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    latencyMs: 1200,
    status: 'enabled',
    notes: 'Official DeepSeek API - supports function calling',
  },

  // DeepSeek Reasoner (R1) - Reasoning model
  {
    id: 'deepseek-reasoner',
    provider: 'deepseek',
    deploymentName: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner (R1)',
    tier: 1,
    capabilities: ['text', 'streaming'],
    contextWindow: 131072,
    maxOutputTokens: 8192,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    latencyMs: 1500,
    status: 'enabled',
    notes: 'DeepSeek R1 reasoning model - outputs thought process',
  },

  // Azure DeepSeek-R1 (No function calling support)
  {
    id: 'deepseek-r1-azure',
    provider: 'azure',
    deploymentName: 'DeepSeek-R1',
    displayName: 'DeepSeek R1 (Azure)',
    tier: 1,
    capabilities: ['text', 'streaming'],
    contextWindow: 64000,
    maxOutputTokens: 8192,
    costPer1kInput: 0.002,
    costPer1kOutput: 0.008,
    latencyMs: 1200,
    status: 'disabled',
    notes: 'Azure version - does NOT support function calling',
  },

];

export interface ListModelsOptions {
  status?: 'enabled' | 'disabled' | 'beta';
  provider?: string;
  tier?: number;
  capability?: string;
  configuredOnly?: boolean; // Only return models from configured providers
}

export async function listModels(options: ListModelsOptions = {}): Promise<ModelDefinition[]> {
  let filtered = [...MODELS];

  if (options.status) {
    filtered = filtered.filter(m => m.status === options.status);
  }

  if (options.provider) {
    filtered = filtered.filter(m => m.provider === options.provider);
  }

  if (options.tier !== undefined) {
    filtered = filtered.filter(m => m.tier === options.tier);
  }

  if (options.capability) {
    filtered = filtered.filter(m => m.capabilities.includes(options.capability!));
  }

  if (options.configuredOnly) {
    filtered = filtered.filter(m => isProviderConfigured(m.provider));
  }

  return filtered;
}

export async function getModelById(id: string): Promise<ModelDefinition | null> {
  return MODELS.find(m => m.id === id) || null;
}

export async function getModelByProviderAndName(
  provider: string,
  deploymentName: string
): Promise<ModelDefinition | null> {
  return MODELS.find(m => m.provider === provider && m.deploymentName === deploymentName) || null;
}

export async function getCheapestModel(capability: string = 'text'): Promise<ModelDefinition | null> {
  const models = await listModels({ status: 'enabled', capability });

  if (models.length === 0) return null;

  return models.sort((a, b) => {
    const aCost = a.costPer1kInput || Number.POSITIVE_INFINITY;
    const bCost = b.costPer1kInput || Number.POSITIVE_INFINITY;
    return aCost - bCost;
  })[0];
}

export async function getBestModelForTier(
  tier: number,
  capability: string = 'text',
  configuredOnly: boolean = true
): Promise<ModelDefinition | null> {
  const models = await listModels({
    status: 'enabled',
    tier,
    capability,
    configuredOnly,
  });

  if (models.length === 0) {
    // Fallback: try adjacent tiers
    if (tier > 1) {
      return getBestModelForTier(tier - 1, capability, configuredOnly);
    }
    return null;
  }

  // Prefer lower cost within same tier
  return models.sort((a, b) => {
    const aCost = a.costPer1kInput || Number.POSITIVE_INFINITY;
    const bCost = b.costPer1kInput || Number.POSITIVE_INFINITY;
    return aCost - bCost;
  })[0];
}

// Get all models, grouped by tier
export async function getModelsByTier(): Promise<Record<number, ModelDefinition[]>> {
  const models = await listModels({ status: 'enabled', configuredOnly: true });
  const byTier: Record<number, ModelDefinition[]> = { 1: [], 2: [], 3: [] };

  for (const model of models) {
    if (!byTier[model.tier]) byTier[model.tier] = [];
    byTier[model.tier].push(model);
  }

  return byTier;
}
