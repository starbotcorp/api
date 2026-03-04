// Orchestrator Types

export interface ToolCallRequest {
  tool: string;
  args: Record<string, unknown>;
  reasoning?: string;
}

export interface ExecutionResult {
  tool: string;
  success: boolean;
  result: string;
  error?: string;
  durationMs: number;
}

export interface OrchestratorContext {
  conversationId: string;
  messages: OrchestratorMessage[];
  toolHistory: ExecutionResult[];
  identityContext?: string;  // Starbot identity to inject
}

export interface OrchestratorMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallRequest[];
}

export interface OrchestratorOptions {
  maxIterations?: number;
  timeoutMs?: number;
  includeReasoning?: boolean;
}

export interface RunContext {
  workspaceId?: string;
  projectId?: string;
  chatId?: string;
  chatCreated?: Date | string;
  messageCount?: number;
  userTimezone?: string;
  identityContext?: string;  // Starbot identity to inject
}
