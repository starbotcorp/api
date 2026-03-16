// DeepSeek Orchestrator
// Main orchestrator class that handles the "think first, execute later" pattern

import { getProvider } from '../../providers/index.js';
import type { Provider, ProviderMessage } from '../../providers/types.js';
import { parseToolCallsFromResponse, hasToolCallIntent } from './parser.js';
import { ToolExecutor } from './executor.js';
import type { ToolCallRequest, ExecutionResult, OrchestratorOptions, OrchestratorMessage, RunContext } from './types.js';
import { env } from '../../env.js';

const BASE_TOOLS = `- list_directory: {"args":{"path":"/directory/path"}}
- read_file: {"args":{"path":"/file/path"}}
- glob: {"args":{"pattern":"*.ts"}}
- bash: {"args":{"command":"ls -la"}}
- calculator: {"args":{"expression":"2+2"}}
- web_search: {"args":{"query":"search term"}}
- get_conversation_metadata: {"args":{}} (use for conversation timing/duration questions)
- memory_search: {"args":{"query":"search term","scope":"all"}} (search across user facts, thread compactions, and project profiles; scope: "facts", "threads", "projects", or "all")
- save_user_fact: {"args":{"fact_key":"key","fact_value":"value","confidence":1.0}} (save a fact about the user)
- read_user_fact: {"args":{"fact_key":"key"}} (read a specific fact, or omit fact_key to get all facts)`;

const TEMPORAL_TOOLS = `- get_current_time: {"args":{"format":"full"}} (use for time/date questions)
- add_calendar_event: {"args":{"title":"Event name","startTime":"2026-03-01T14:00:00Z"}} (use to add calendar events)
- list_calendar_events: {"args":{}} (use to query calendar)
- get_upcoming_events: {"args":{"days":7}} (use to see upcoming events)
- update_calendar_event: {"args":{"eventId":"id","title":"New name"}} (use to update events)
- delete_calendar_event: {"args":{"eventId":"id"}} (use to delete events)`;

export function buildOrchestratorSystemPrompt(isMainThread = false): string {
  const tools = isMainThread ? `${BASE_TOOLS}\n${TEMPORAL_TOOLS}` : BASE_TOOLS;
  return `You are Starbot, an AI assistant.

When you need to use a tool, respond with ONLY raw JSON - no other text.

Output format (raw JSON, no markdown):
{"tool":"tool_name","args":{"param":"value"}}

Tools:
${tools}

IMPORTANT: Output ONLY the JSON. No explanations. No thinking. Just JSON.
If you don't need a tool, respond with plain text (not JSON).`;
}

export const ORCHESTRATOR_SYSTEM_PROMPT = buildOrchestratorSystemPrompt(false);

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
    context?: RunContext
  ): Promise<{
    response: string;
    reasoning: string | null;
    toolResults: ExecutionResult[];
    iterations: number;
  }> {
    const toolResults: ExecutionResult[] = [];
    const isMainThread = context?.isMainThread ?? false;
    const conversation: ProviderMessage[] = this.buildConversation(userInput, messages, context?.identityContext, isMainThread);

    let iteration = 0;
    let lastResponse = '';
    let lastReasoning = '';
    let needsMoreWork = true;

    while (needsMoreWork && iteration < this.maxIterations) {
      iteration++;

      // Call DeepSeek
      const result = await this.callModel(conversation);
      lastResponse = result.response;
      if (result.reasoning) {
        lastReasoning = result.reasoning;
      }

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
        // Set context for tools before executing
        if (context) {
          this.executor.setContext({
            request: {} as any, // Not available in orchestrator context
            projectId: context.projectId,
            workspaceId: context.workspaceId,
            chatId: context.chatId,
            chatCreated: typeof context.chatCreated === 'string'
              ? new Date(context.chatCreated)
              : context.chatCreated,
            messageCount: context.messageCount,
            userTimezone: context.userTimezone,
          });
          this.executor.setAllowedTools(isMainThread ? null : 'non-temporal');
        }
        // Execute tools
        const execResults = await this.executor.executeAll(toolCalls);
        toolResults.push(...execResults);

        // Add assistant message with tool_calls FIRST (required by DeepSeek)
        conversation.push({
          type: 'message',
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
            type: 'message',
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
          type: 'message',
          role: 'user' as const,
          content: 'Based on the tool results above, provide your final answer to the user.',
        });
      }
    }

    // Clean up the final response
    const cleanedResponse = this.cleanResponse(lastResponse);

    return {
      response: cleanedResponse,
      reasoning: lastReasoning || null,
      toolResults,
      iterations: iteration,
    };
  }

  private buildConversation(
    userInput: string,
    existingMessages: OrchestratorMessage[],
    identityContext?: string,
    isMainThread = false
  ): ProviderMessage[] {
    const orchestratorPrompt = buildOrchestratorSystemPrompt(isMainThread);
    // Build system prompt with identity if provided
    const systemContent = identityContext
      ? `${identityContext}\n\n${orchestratorPrompt}`
      : orchestratorPrompt;

    const messages: ProviderMessage[] = [
      { type: 'message', role: 'system', content: systemContent },
    ];

    // Add existing conversation messages (including timestamps)
    for (const msg of existingMessages) {
      messages.push({
        type: 'message',
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      });
    }

    // Add current user input
    messages.push({
      type: 'message',
      role: 'user',
      content: userInput,
    });

    return messages;
  }

  private async callModel(messages: ProviderMessage[]): Promise<{ response: string; reasoning: string | null; toolCalls: any[] }> {
    let fullResponse = '';
    let reasoningContent = '';
    let toolCalls: any[] = [];

    // Use the model from the orchestrator
    for await (const chunk of this.provider.sendChatStream(messages, {
      model: this.modelName,
      maxTokens: 8192,
      temperature: 0.7,
    })) {
      if (chunk.text) {
        // Check if this is reasoning content (DeepSeek R1)
        if (chunk.reasoning) {
          reasoningContent += chunk.text;
        } else {
          fullResponse += chunk.text;
        }
      }
      if (chunk.tool_calls && chunk.tool_calls.length > 0) {
        toolCalls = chunk.tool_calls;
      }
    }

    return { response: fullResponse, reasoning: reasoningContent || null, toolCalls };
  }

  private cleanResponse(response: string): string {
    return response
      // Remove JSON blocks we added (tool call attempts)
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
