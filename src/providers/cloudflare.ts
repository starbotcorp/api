// Cloudflare Workers AI Provider
// Simple REST API for Cloudflare's AI models

import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, StreamChunk } from './types.js';
import { env } from '../env.js';

export class CloudflareProvider implements Provider {
  name = 'cloudflare';

  async sendChat(messages: ProviderMessage[], options: ProviderOptions): Promise<ProviderResponse> {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not configured');
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${options.model}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        stream: false,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cloudflare API error (${response.status}): ${error}`);
    }

    const data = await response.json() as {
      success?: boolean;
      result?: {
        response?: string;
      };
      errors?: Array<{ message: string }>;
    };

    if (!data.success) {
      const errorMsg = data.errors?.map(e => e.message).join(', ') || 'Unknown error';
      throw new Error(`Cloudflare API error: ${errorMsg}`);
    }

    const content = data.result?.response || '';

    // Cloudflare doesn't return token counts, so we estimate
    const promptTokens = Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
    const completionTokens = Math.ceil(content.length / 4);

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
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not configured');
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${options.model}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
        stream: true,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Cloudflare API error (${response.status}): ${error}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalContent = '';

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
        if (data === '[DONE]') {
          // Send final usage estimate
          const promptTokens = Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
          const completionTokens = Math.ceil(totalContent.length / 4);

          yield {
            text: '',
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            },
          };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const text = parsed.response || '';

          if (text) {
            totalContent += text;
            yield { text };
          }
        } catch (e) {
          // Skip malformed JSON
          continue;
        }
      }
    }
  }
}
