// DeepSeek Provider
// Uses the official DeepSeek API which supports function calling

import { env } from '../env.js';
import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, StreamChunk, ToolCall } from './types.js';

export class DeepSeekProvider implements Provider {
  name = 'deepseek';
  private apiKey: string;
  private baseUrl = 'https://api.deepseek.com';

  constructor() {
    this.apiKey = env.DEEPSEEK_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('DEEPSEEK_API_KEY not configured');
    }
  }

  async sendChat(messages: ProviderMessage[], options: ProviderOptions): Promise<ProviderResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || 'deepseek-chat',
        messages: messages.map(m => {
          const base: any = { role: m.role, content: m.content };
          // Include tool_call_id and name for tool messages (required by DeepSeek)
          if (m.role === 'tool') {
            base.tool_call_id = m.tool_call_id;
            if (m.name) base.name = m.name;
          }
          // Include tool_calls for assistant messages with tools
          if (m.role === 'assistant' && m.tool_calls) {
            base.tool_calls = m.tool_calls;
          }
          return base;
        }),
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        stream: false,
        tools: options.tools,
        tool_choice: options.tool_choice,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const message = data.choices[0]?.message;

    return {
      content: message.content || '',
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
    };
  }

  async *sendChatStream(messages: ProviderMessage[], options: ProviderOptions): AsyncIterable<StreamChunk> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || 'deepseek-chat',
        messages: messages.map(m => {
          const base: any = { role: m.role, content: m.content };
          // Include tool_call_id and name for tool messages (required by DeepSeek)
          if (m.role === 'tool') {
            base.tool_call_id = m.tool_call_id;
            if (m.name) base.name = m.name;
          }
          // Include tool_calls for assistant messages with tools
          if (m.role === 'assistant' && m.tool_calls) {
            base.tool_calls = m.tool_calls;
          }
          return base;
        }),
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature || 0.7,
        stream: true,
        tools: options.tools,
        tool_choice: options.tool_choice,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Handle reasoning content for deepseek-reasoner
    let inReasoning = false;
    let reasoningContent = '';

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
          const parsed = JSON.parse(data) as any;
          const delta = parsed.choices?.[0]?.delta;

          // Handle reasoning content
          if (delta?.reasoning_content) {
            yield { text: delta.reasoning_content, reasoning: true };
          }

          // Handle regular content
          if (delta?.content) {
            yield { text: delta.content };
          }

          // Handle tool calls
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                text: '',
                tool_calls: [{
                  id: tc.id || '',
                  // @ts-ignore - type might not exist in all versions
                  type: 'function',
                  function: {
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '',
                  },
                } as any],
              };
            }
          }

          // Handle finish reason
          const finishReason = parsed.choices?.[0]?.finish_reason;
          if (finishReason) {
            yield {
              text: '',
              finish_reason: finishReason as 'stop' | 'tool_calls' | 'length',
            };
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }
}
