// Google Vertex AI Provider
// Uses @google-cloud/vertexai SDK for Gemini models

import { VertexAI } from '@google-cloud/vertexai';
import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, StreamChunk } from './types.js';
import { env } from '../env.js';

function isGemini3Model(model: string): boolean {
  return /^gemini-3(?:$|[.-])/.test(String(model || '').trim().toLowerCase());
}

function isModelAllowed(model: string): boolean {
  if (env.VERTEX_ALLOWED_MODELS.length === 0) return true;
  const allowed = new Set(env.VERTEX_ALLOWED_MODELS.map(s => s.toLowerCase()));
  return allowed.has(String(model || '').trim().toLowerCase());
}

export class VertexProvider implements Provider {
  name = 'vertex';
  private projectId: string;
  private location: string;
  private clients: Map<string, VertexAI>;

  constructor() {
    if (!env.VERTEX_PROJECT_ID) {
      throw new Error('VERTEX_PROJECT_ID is required');
    }
    this.projectId = env.VERTEX_PROJECT_ID;
    this.location = env.VERTEX_LOCATION || 'us-central1';
    this.clients = new Map();
  }

  private getClient(location: string): VertexAI {
    const loc = location.trim() || 'us-central1';
    const cached = this.clients.get(loc);
    if (cached) return cached;
    const client = new VertexAI({
      project: this.projectId,
      location: loc,
    });
    this.clients.set(loc, client);
    return client;
  }

  private preferredLocationForModel(model: string): string {
    // Gemini 3 preview is exposed under global in this project.
    return isGemini3Model(model) ? 'global' : this.location;
  }

  private formatMessages(messages: ProviderMessage[]): Array<{ role: string; parts: Array<{ text: string }> }> {
    // Vertex AI uses 'user' and 'model' roles (not 'assistant')
    return messages
      .filter(m => m.role !== 'system') // System messages handled separately
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : m.role,
        parts: [{ text: m.content }],
      }));
  }

  private getSystemInstruction(messages: ProviderMessage[]): string | undefined {
    const systemMsg = messages.find(m => m.role === 'system');
    return systemMsg?.content;
  }

  async sendChat(messages: ProviderMessage[], options: ProviderOptions): Promise<ProviderResponse> {
    const modelName = options.model;
    if (!isModelAllowed(modelName)) {
      throw new Error(`Vertex model not allowed: ${modelName}`);
    }

    const callOnce = async (location: string) => {
      const model = this.getClient(location).getGenerativeModel({
        model: modelName,
        systemInstruction: this.getSystemInstruction(messages),
        generationConfig: {
          maxOutputTokens: options.maxTokens ?? 8192,
          temperature: options.temperature ?? 0.7,
        },
      });
      return model.generateContent({
        contents: this.formatMessages(messages),
      });
    };

    const preferredLocation = this.preferredLocationForModel(modelName);
    let result;
    try {
      result = await callOnce(preferredLocation);
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (preferredLocation !== 'global' && msg.includes('404')) {
        result = await callOnce('global');
      } else {
        throw err;
      }
    }

    const response = result.response;
    const content = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extract token usage if available
    const usageMetadata = response.usageMetadata;
    const promptTokens = usageMetadata?.promptTokenCount || 0;
    const completionTokens = usageMetadata?.candidatesTokenCount || 0;

    return {
      content,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }

  async *sendChatStream(messages: ProviderMessage[], options: ProviderOptions): AsyncIterable<StreamChunk> {
    const modelName = options.model;
    if (!isModelAllowed(modelName)) {
      throw new Error(`Vertex model not allowed: ${modelName}`);
    }

    const callOnce = async (location: string) => {
      const model = this.getClient(location).getGenerativeModel({
        model: modelName,
        systemInstruction: this.getSystemInstruction(messages),
        generationConfig: {
          maxOutputTokens: options.maxTokens ?? 8192,
          temperature: options.temperature ?? 0.7,
        },
      });
      return model.generateContentStream({
        contents: this.formatMessages(messages),
      });
    };

    const preferredLocation = this.preferredLocationForModel(modelName);
    let result;
    try {
      result = await callOnce(preferredLocation);
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (preferredLocation !== 'global' && msg.includes('404')) {
        result = await callOnce('global');
      } else {
        throw err;
      }
    }

    let promptTokens = 0;
    let completionTokens = 0;

    // Stream text chunks
    for await (const chunk of result.stream) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (text) {
        yield { text };
      }

      // Update token counts if available
      if (chunk.usageMetadata) {
        promptTokens = chunk.usageMetadata.promptTokenCount || 0;
        completionTokens = chunk.usageMetadata.candidatesTokenCount || 0;
      }
    }

    // Final usage report
    if (promptTokens > 0 || completionTokens > 0) {
      yield {
        text: '',
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
      };
    }
  }
}
