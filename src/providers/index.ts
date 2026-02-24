// Provider Registry
// Central registry for all LLM providers

import type { Provider } from './types.js';
import { KimiProvider } from './kimi.js';
import { CloudflareProvider } from './cloudflare.js';
import { VertexProvider } from './vertex.js';
import { AzureProvider } from './azure-openai.js';
import { BedrockProvider } from './bedrock.js';
import { DeepSeekProvider } from './deepseek.js';
import { isProviderConfigured } from '../env.js';

// Provider instances (lazy initialization)
const providers: Map<string, Provider> = new Map();

function getOrCreateProvider(name: string): Provider | null {
  // Return cached instance if exists
  if (providers.has(name)) {
    return providers.get(name)!;
  }

  // Check if provider is configured
  if (!isProviderConfigured(name)) {
    return null;
  }

  // Create new instance based on name
  let provider: Provider | null = null;

  switch (name) {
    case 'kimi':
      provider = new KimiProvider();
      break;
    case 'cloudflare':
      provider = new CloudflareProvider();
      break;
    case 'vertex':
      provider = new VertexProvider();
      break;
    case 'azure':
      provider = new AzureProvider();
      break;
    case 'bedrock':
      provider = new BedrockProvider();
      break;
    case 'deepseek':
      provider = new DeepSeekProvider();
      break;
    default:
      return null;
  }

  if (provider) {
    providers.set(name, provider);
  }

  return provider;
}

export function getProvider(name: string): Provider {
  const provider = getOrCreateProvider(name);

  if (!provider) {
    throw new Error(`Provider "${name}" is not available or not configured`);
  }

  return provider;
}

export function listAvailableProviders(): string[] {
  const allProviders = ['kimi', 'vertex', 'azure', 'bedrock', 'cloudflare', 'deepseek'];
  return allProviders.filter(isProviderConfigured);
}

// Re-export types
export type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, StreamChunk } from './types.js';
