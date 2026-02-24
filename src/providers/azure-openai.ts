// Azure AI Services Provider
// Uses direct REST API calls (Azure OpenAI uses standard OpenAI format)

import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, StreamChunk, ToolCall } from './types.js';
import { env } from '../env.js';

export class AzureProvider implements Provider {
  name = 'azure';

  private formatMessages(messages: ProviderMessage[]): Array<any> {
    return messages.map(m => {
      const formatted: any = {
        role: m.role,
        content: m.content,
      };

      // Add tool calls if present (for assistant messages)
      if (m.tool_calls) {
        formatted.tool_calls = m.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
      }

      // Add tool call ID if present (for tool result messages)
      if (m.tool_call_id) {
        formatted.tool_call_id = m.tool_call_id;
      }

      // Add tool name if present (for tool result messages)
      if (m.name) {
        formatted.name = m.name;
      }

      return formatted;
    });
  }

  private getModelConfig(model: string, options: ProviderOptions) {
    // Handle model-specific quirks
    const isGPT5x = model.includes('gpt-5.');
    const isGPT41 = model.includes('gpt-4.1');

    // GPT-5.x and GPT-4.1 require max_completion_tokens instead of max_tokens
    const useCompletionTokens = isGPT5x || isGPT41;

    // GPT-5.x does NOT accept custom temperature (only default 1.0)
    const supportsTemperature = !isGPT5x;

    const config: any = {};

    if (useCompletionTokens) {
      config.max_completion_tokens = options.maxTokens ?? 4096;
    } else {
      config.max_tokens = options.maxTokens ?? 4096;
    }

    if (supportsTemperature) {
      config.temperature = options.temperature ?? 0.7;
    }

    return config;
  }

  async sendChat(messages: ProviderMessage[], options: ProviderOptions): Promise<ProviderResponse> {
    if (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_API_KEY) {
      throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY are required');
    }

    const config = this.getModelConfig(options.model, options);

    // Azure OpenAI URL format: {endpoint}/openai/deployments/{deployment-name}/chat/completions?api-version=...
    const url = `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${options.model}/chat/completions?api-version=2024-12-01-preview`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': env.AZURE_OPENAI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: this.formatMessages(messages),
        ...config,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Azure OpenAI API error (${response.status}): ${error}`);
    }

    const data = await response.json() as any;
    const content = data.choices[0]?.message?.content || '';
    const usage = data.usage;

    return {
      content,
      usage: {
        promptTokens: usage?.prompt_tokens || 0,
        completionTokens: usage?.completion_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
      },
    };
  }

  async *sendChatStream(messages: ProviderMessage[], options: ProviderOptions): AsyncIterable<StreamChunk> {
    if (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_API_KEY) {
      throw new Error('AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY are required');
    }

    const config = this.getModelConfig(options.model, options);
    const requestBody: any = {
      messages: this.formatMessages(messages),
      ...config,
      stream: true,
    };

    // Add tools to request if provided
    if (options.tools && options.tools.length > 0) {
      requestBody.tools = options.tools;
      requestBody.tool_choice = options.tool_choice || 'auto';
    }

    const url = `${env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${options.model}/chat/completions?api-version=2024-12-01-preview`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': env.AZURE_OPENAI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Azure OpenAI API error (${response.status}): ${error}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let accumulatedToolCalls: Map<number, ToolCall> = new Map();

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
          // Send final usage and tool calls if available
          const toolCalls = Array.from(accumulatedToolCalls.values());
          if (promptTokens > 0 || completionTokens > 0 || toolCalls.length > 0) {
            yield {
              text: '',
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
              usage: {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
              },
            };
          }
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;

          // Handle reasoning content (DeepSeek R1 thinking)
          if (delta?.reasoning_content) {
            yield { text: delta.reasoning_content, reasoning: true };
          }

          // Handle text content
          if (delta?.content) {
            yield { text: delta.content };
          }

          // Handle tool calls in streaming
          if (delta?.tool_calls) {
            for (const toolCallDelta of delta.tool_calls) {
              const index = toolCallDelta.index;
              const existing = accumulatedToolCalls.get(index) || {
                id: '',
                name: '',
                arguments: '',
              };

              if (toolCallDelta.id) existing.id = toolCallDelta.id;
              if (toolCallDelta.function?.name) existing.name = toolCallDelta.function.name;
              if (toolCallDelta.function?.arguments) {
                existing.arguments += toolCallDelta.function.arguments;
              }

              accumulatedToolCalls.set(index, existing);
            }
          }

          // Handle finish reason
          const finishReason = parsed.choices?.[0]?.finish_reason;
          if (finishReason) {
            const toolCalls = Array.from(accumulatedToolCalls.values());
            yield {
              text: '',
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
              finish_reason: finishReason,
            };
          }

          // Azure sometimes includes usage in stream
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens || 0;
            completionTokens = parsed.usage.completion_tokens || 0;
          }
        } catch (e) {
          // Skip malformed JSON
          continue;
        }
      }
    }
  }
}
