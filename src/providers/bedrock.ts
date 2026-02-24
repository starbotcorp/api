// AWS Bedrock Provider
// Uses @aws-sdk/client-bedrock-runtime for Claude, Mistral, DeepSeek

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { Provider, ProviderMessage, ProviderOptions, ProviderResponse, StreamChunk } from './types.js';
import { env } from '../env.js';

export class BedrockProvider implements Provider {
  name = 'bedrock';
  private client: BedrockRuntimeClient;

  constructor() {
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.BEDROCK_REGION) {
      throw new Error('AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and BEDROCK_REGION are required');
    }

    this.client = new BedrockRuntimeClient({
      region: env.BEDROCK_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  private getModelFamily(modelId: string): 'claude' | 'mistral' | 'deepseek' {
    if (modelId.includes('anthropic.claude')) return 'claude';
    if (modelId.includes('mistral')) return 'mistral';
    if (modelId.includes('deepseek')) return 'deepseek';
    throw new Error(`Unknown Bedrock model family: ${modelId}`);
  }

  private formatRequestClaude(messages: ProviderMessage[], options: ProviderOptions) {
    const systemMsg = messages.find(m => m.role === 'system');
    const conversationMsgs = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role,
        content: m.content,
      }));

    return {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
      messages: conversationMsgs,
      ...(systemMsg ? { system: systemMsg.content } : {}),
    };
  }

  private formatRequestMistral(messages: ProviderMessage[], options: ProviderOptions) {
    return {
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    };
  }

  private formatRequestDeepSeek(messages: ProviderMessage[], options: ProviderOptions) {
    // DeepSeek uses prompt-based format with special delimiters
    let prompt = '';
    for (const msg of messages) {
      if (msg.role === 'system') {
        prompt += msg.content + '\n\n';
      } else if (msg.role === 'user') {
        prompt += `<｜User｜>${msg.content}<｜Assistant｜>`;
      } else if (msg.role === 'assistant') {
        prompt += msg.content + '\n\n';
      }
    }

    return {
      prompt,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    };
  }

  private stripThinkTags(text: string): string {
    // Remove DeepSeek R1 thinking tags
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  async sendChat(messages: ProviderMessage[], options: ProviderOptions): Promise<ProviderResponse> {
    const family = this.getModelFamily(options.model);

    let requestBody: any;
    if (family === 'claude') {
      requestBody = this.formatRequestClaude(messages, options);
    } else if (family === 'mistral') {
      requestBody = this.formatRequestMistral(messages, options);
    } else {
      requestBody = this.formatRequestDeepSeek(messages, options);
    }

    const command = new InvokeModelCommand({
      modelId: options.model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody),
    });

    const response = await this.client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    let content = '';
    let promptTokens = 0;
    let completionTokens = 0;

    if (family === 'claude') {
      // Claude: { content: [{ text: "..." }], usage: { input_tokens, output_tokens } }
      content = responseBody.content?.[0]?.text || '';
      promptTokens = responseBody.usage?.input_tokens || 0;
      completionTokens = responseBody.usage?.output_tokens || 0;
    } else if (family === 'mistral') {
      // Mistral: { choices: [{ message: { content: "..." } }] }
      content = responseBody.choices?.[0]?.message?.content || '';
      // Mistral doesn't return token counts in response, estimate
      promptTokens = Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
      completionTokens = Math.ceil(content.length / 4);
    } else {
      // DeepSeek: { choices: [{ text: "..." }] }
      content = responseBody.choices?.[0]?.text || '';
      content = this.stripThinkTags(content);
      // DeepSeek doesn't return token counts, estimate
      promptTokens = Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
      completionTokens = Math.ceil(content.length / 4);
    }

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
    const family = this.getModelFamily(options.model);

    let requestBody: any;
    if (family === 'claude') {
      requestBody = this.formatRequestClaude(messages, options);
    } else if (family === 'mistral') {
      requestBody = this.formatRequestMistral(messages, options);
    } else {
      requestBody = this.formatRequestDeepSeek(messages, options);
    }

    const command = new InvokeModelWithResponseStreamCommand({
      modelId: options.model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody),
    });

    const response = await this.client.send(command);

    let fullContent = '';
    let promptTokens = 0;
    let completionTokens = 0;

    if (response.body) {
      for await (const event of response.body) {
        if (event.chunk) {
          const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));

          let text = '';

          if (family === 'claude') {
            // Claude streaming: { type: "content_block_delta", delta: { text: "..." } }
            if (chunk.type === 'content_block_delta') {
              text = chunk.delta?.text || '';
            } else if (chunk.type === 'message_delta') {
              promptTokens = chunk.usage?.input_tokens || promptTokens;
              completionTokens = chunk.usage?.output_tokens || completionTokens;
            }
          } else if (family === 'mistral') {
            // Mistral streaming: { choices: [{ delta: { content: "..." } }] }
            text = chunk.choices?.[0]?.delta?.content || '';
          } else {
            // DeepSeek streaming: { choices: [{ text: "..." }] }
            text = chunk.choices?.[0]?.text || '';
          }

          if (text) {
            // Strip think tags for DeepSeek in real-time
            if (family === 'deepseek') {
              fullContent += text;
              // Only yield if we're not inside a think tag
              if (!fullContent.includes('<think>') || fullContent.includes('</think>')) {
                const cleaned = this.stripThinkTags(fullContent);
                const newText = cleaned.substring(fullContent.length - text.length);
                if (newText) {
                  yield { text: newText };
                }
              }
            } else {
              fullContent += text;
              yield { text };
            }
          }
        }
      }
    }

    // Estimate tokens if not provided
    if (promptTokens === 0) {
      promptTokens = Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
    }
    if (completionTokens === 0) {
      completionTokens = Math.ceil(fullContent.length / 4);
    }

    // Final usage report
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
