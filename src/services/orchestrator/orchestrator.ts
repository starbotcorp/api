// DeepSeek Orchestrator
// Main orchestrator class that handles the "think first, execute later" pattern

import { getProvider } from '../../providers/index.js';
import type { Provider, ProviderMessage } from '../../providers/types.js';
import { parseToolCallsFromResponse, hasToolCallIntent } from './parser.js';
import { ToolExecutor } from './executor.js';
import type { ToolCallRequest, ExecutionResult, OrchestratorOptions, OrchestratorMessage } from './types.js';
import { env } from '../../env.js';

const SYSTEM_PROMPT = `You are a tool-using assistant. When you need to use a tool, you MUST respond with ONLY raw JSON - no other text.

Output format (raw JSON, no markdown):
{"tool":"tool_name","args":{"param":"value"}}

Tools:
- list_directory: {"args":{"path":"/directory/path"}}
- read_file: {"args":{"path":"/file/path"}}
- glob: {"args":{"pattern":"*.ts"}}
- bash: {"args":{"command":"ls -la"}}
- calculator: {"args":{"expression":"2+2"}}
- web_search: {"args":{"query":"search term"}}

IMPORTANT: Output ONLY the JSON. No explanations. No thinking. Just JSON.
If you don't need a tool, respond with plain text (not JSON).`;

export class DeepSeekOrchestrator {
  private provider: Provider;
  private executor: ToolExecutor;
  private maxIterations: number;
  private includeReasoning: boolean;
  private modelName: string;

  constructor(modelId: string, options: OrchestratorOptions = {}) {
    const modelParts = modelId.split(':');
    const providerName = modelParts[0] || 'azure';
    const deploymentName = modelParts[1] || modelId;

    this.modelName = deploymentName;
    this.provider = getProvider(providerName);
    this.executor = new ToolExecutor(options.timeoutMs || 30000);
    this.maxIterations = options.maxIterations || 5;
    this.includeReasoning = options.includeReasoning ?? true;
  }

  async run(
    userInput: string,
    messages: OrchestratorMessage[] = [],
    context?: { workspaceId?: string; projectId?: string }
  ): Promise<{
    response: string;
    toolResults: ExecutionResult[];
    iterations: number;
  }> {
    const toolResults: ExecutionResult[] = [];
    const conversation: ProviderMessage[] = this.buildConversation(userInput, messages);

    let iteration = 0;
    let lastResponse = '';
    let needsMoreWork = true;

    while (needsMoreWork && iteration < this.maxIterations) {
      iteration++;

      // Call DeepSeek
      const result = await this.callModel(conversation);
      lastResponse = result.response;

      // Check for tool calls from the model (native function calling)
      let toolCalls = result.toolCalls.map((tc: any, i: number) => ({
        id: tc.id || `call_${i}`,
        tool: tc.function?.name || tc.name,
        args: typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function?.arguments || tc.arguments || {},
        reasoning: 'From native function call',
      }));

      // If no native tool calls, try parsing from text
      if (toolCalls.length === 0) {
        const parsedCalls = parseToolCallsFromResponse(result.response);
        toolCalls = parsedCalls.map((tc: any, i: number) => ({
          id: `call_${i}`,
          ...tc,
          reasoning: tc.reasoning || 'From text parsing',
        }));
      }

      if (toolCalls.length === 0) {
        // No tool calls, we're done
        needsMoreWork = false;
      } else {
        // Execute tools
        const execResults = await this.executor.executeAll(toolCalls);
        toolResults.push(...execResults);

        // Add assistant message with tool_calls FIRST (required by DeepSeek)
        conversation.push({
          role: 'assistant' as const,
          content: lastResponse,
          tool_calls: toolCalls.map((tc: any) => ({
            id: tc.id,
            name: tc.tool,
            arguments: JSON.stringify(tc.args),
          })),
        });

        // Add tool results to conversation - include tool_call_id for DeepSeek
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          const res = execResults[i];
          conversation.push({
            role: 'tool' as const,
            tool_call_id: tc.id || `call_${i}`,
            name: tc.tool,
            content: res.success
              ? res.result
              : `Error: ${res.error}`,
          });
        }

        // Ask DeepSeek to synthesize
        conversation.push({
          role: 'user' as const,
          content: 'Based on the tool results above, provide your final answer to the user.',
        });
      }
    }

    // Clean up the final response
    const cleanedResponse = this.cleanResponse(lastResponse);

    return {
      response: cleanedResponse,
      toolResults,
      iterations: iteration,
    };
  }

  private buildConversation(
    userInput: string,
    existingMessages: OrchestratorMessage[]
  ): ProviderMessage[] {
    // For now, just use system prompt + current message to avoid tool_call_id issues
    // TODO: Properly handle conversation history with tool messages
    const messages: ProviderMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userInput },
    ];

    return messages;
  }

  private async callModel(messages: ProviderMessage[]): Promise<{ response: string; toolCalls: any[] }> {
    let fullResponse = '';
    let toolCalls: any[] = [];

    // Use the model from the orchestrator
    for await (const chunk of this.provider.sendChatStream(messages, {
      model: this.modelName,
      maxTokens: 8192,
      temperature: 0.7,
    })) {
      if (chunk.text) {
        fullResponse += chunk.text;
      }
      if (chunk.tool_calls && chunk.tool_calls.length > 0) {
        toolCalls = chunk.tool_calls;
      }
    }

    return { response: fullResponse, toolCalls };
  }

  private cleanResponse(response: string): string {
    return response
      // Remove thinking tags
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      // Remove JSON blocks we added
      .replace(/```json\s*\{[\s\S]*?\}\s*```/g, '')
      .replace(/\{[\s\S]*?"tool"[\s\S]*?\}/g, '')
      .trim();
  }
}

export function createOrchestrator(
  modelId: string,
  options?: OrchestratorOptions
): DeepSeekOrchestrator {
  return new DeepSeekOrchestrator(modelId, options);
}
