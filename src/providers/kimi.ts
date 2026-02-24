// Kimi Provider (Moonshot API)
// Simple REST API with OpenAI-compatible format

import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, StreamChunk } from './types.js';
import { env } from '../env.js';

export class KimiProvider implements Provider {
  name = 'kimi';

  async sendChat(messages: ProviderMessage[], options: ProviderOptions): Promise<ProviderResponse> {
    const apiKey = env.MOONSHOT_API_KEY;
    if (!apiKey) {
      throw new Error('MOONSHOT_API_KEY is not configured');
    }

    const baseUrl = env.MOONSHOT_BASE_URL.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Kimi API error (${response.status}): ${error}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const content = data.choices?.[0]?.message?.content || '';

    return {
      content,
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
    };
  }

  async *sendChatStream(messages: ProviderMessage[], options: ProviderOptions): AsyncIterable<StreamChunk> {
    const apiKey = env.MOONSHOT_API_KEY;
    if (!apiKey) {
      throw new Error('MOONSHOT_API_KEY is not configured');
    }

    const baseUrl = env.MOONSHOT_BASE_URL.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        stream: true,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Kimi API error (${response.status}): ${error}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;

          if (typeof delta === 'string' && delta) {
            yield { text: delta };
          }

          // Check for usage in final chunk
          if (parsed.usage) {
            yield {
              text: '',
              usage: {
                promptTokens: parsed.usage.prompt_tokens || 0,
                completionTokens: parsed.usage.completion_tokens || 0,
                totalTokens: parsed.usage.total_tokens || 0,
              },
            };
          }
        } catch (e) {
          // Skip malformed JSON chunks
          continue;
        }
      }
    }
  }
}
