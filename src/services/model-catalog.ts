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

  // ===== SAVED MODEL DATA (NOT IN USE) =====

  // // Azure GPT-4.1 (Saved for future use)
  // {
  //   id: 'gpt-4.1',
  //   provider: 'azure',
  //   deploymentName: 'gpt-4.1',
  //   displayName: 'GPT-4.1',
  //   tier: 3,
  //   capabilities: ['text', 'streaming', 'tools'],
  //   contextWindow: 128000,
  //   maxOutputTokens: 16384,
  //   status: 'disabled',
  // },

  // // Azure GPT-5.1 Codex Mini (Does NOT support chat completions API)
  // {
  //   id: 'gpt-5.1-codex-mini',
  //   provider: 'azure',
  //   deploymentName: 'gpt-5.1-codex-mini',
  //   displayName: 'GPT-5.1 Codex Mini',
  //   tier: 3,
  //   capabilities: ['text', 'streaming', 'tools'],
  //   contextWindow: 128000,
  //   maxOutputTokens: 16384,
  //   status: 'disabled',
  //   notes: 'Does NOT support chat completions API',
  // },

  // // Azure Mistral-Large-3 (Saved for future use)
  // {
  //   id: 'mistral-large-3',
  //   provider: 'azure',
  //   deploymentName: 'Mistral-Large-3',
  //   displayName: 'Mistral Large 3',
  //   tier: 3,
  //   capabilities: ['text', 'streaming', 'tools'],
  //   contextWindow: 128000,
  //   maxOutputTokens: 16384,
  //   status: 'disabled',
  // },

  // // Claude models (Saved for future use)
  // {
  //   id: 'claude-sonnet-4-5',
  //   provider: 'azure',
  //   deploymentName: 'claude-sonnet-4-5',
  //   displayName: 'Claude Sonnet 4-5',
  //   tier: 2,
  //   capabilities: ['text', 'streaming', 'tools', 'vision'],
  //   contextWindow: 200000,
  //   maxOutputTokens: 8192,
  //   status: 'disabled',
  // },
  //   provider: 'vertex',
  //   deploymentName: 'gemini-2.0-flash',
  //   displayName: 'Gemini 2.0 Flash',
  //   tier: 1,
  //   capabilities: ['text', 'streaming', 'tools', 'vision'],
  //   contextWindow: 1000000,
  //   maxOutputTokens: 8192,
  //   costPer1kInput: 0.0, // Vertex billing different
  //   costPer1kOutput: 0.0,
  //   latencyMs: 400,
  //   status: 'disabled',
  // },

  // // Google Vertex Gemini 1.5 Pro
  // {
  //   id: 'gemini-1.5-pro',
  //   provider: 'vertex',
  //   deploymentName: 'gemini-1.5-pro',
  //   displayName: 'Gemini 1.5 Pro',
  //   tier: 2,
  //   capabilities: ['text', 'streaming', 'tools', 'vision'],
  //   contextWindow: 2000000,
  //   maxOutputTokens: 8192,
  //   costPer1kInput: 0.00125,
  //   costPer1kOutput: 0.005,
  //   latencyMs: 900,
  //   status: 'disabled',
  // },

  // // Cloudflare Workers AI (LLama 3)
  // {
  //   id: 'llama-3.1-70b',
  //   provider: 'cloudflare',
  //   deploymentName: '@cf/meta/llama-3.1-70b-instruct',
  //   displayName: 'Llama 3.1 70B',
  //   tier: 2,
  //   capabilities: ['text', 'streaming'],
  //   contextWindow: 128000,
  //   maxOutputTokens: 4096,
  //   costPer1kInput: 0.0, // Workers AI billing different
  //   costPer1kOutput: 0.0,
  //   latencyMs: 600,
  //   status: 'disabled',
  // },

  // // AWS Bedrock Claude 3.5 Sonnet
  // {
  //   id: 'claude-3.5-sonnet',
  //   provider: 'bedrock',
  //   deploymentName: 'anthropic.claude-3-5-sonnet-20241022',
  //   displayName: 'Claude 3.5 Sonnet',
  //   tier: 2,
  //   capabilities: ['text', 'streaming', 'tools', 'vision'],
  //   contextWindow: 200000,
  //   maxOutputTokens: 8192,
  //   costPer1kInput: 0.003,
  //   costPer1kOutput: 0.015,
  //   latencyMs: 1000,
  //   status: 'disabled',
  // },

  // // Kimi (Moonshot AI)
  // {
  //   id: 'kimi-k2',
  //   provider: 'kimi',
  //   deploymentName: 'moonshot-v1-8k',
  //   displayName: 'Kimi K2',
  //   tier: 2,
  //   capabilities: ['text', 'streaming'],
  //   contextWindow: 128000,
  //   maxOutputTokens: 8192,
  //   costPer1kInput: 0.002,
  //   costPer1kOutput: 0.008,
  //   latencyMs: 800,
  //   status: 'disabled',
  // },
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
