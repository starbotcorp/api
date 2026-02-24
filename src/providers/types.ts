// Provider Interface for Starbot_API
// Common interface that all providers must implement

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ProviderTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[]; // For assistant messages with tool calls
  tool_call_id?: string; // For tool result messages
  name?: string; // Tool name for tool messages
}

export interface ProviderOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  tools?: ProviderTool[]; // NEW: For function calling
  tool_choice?: 'auto' | 'none'; // NEW: Tool choice strategy
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderResponse {
  content: string;
  usage: ProviderUsage;
}

export interface StreamChunk {
  text: string;
  reasoning?: boolean; // true if this is reasoning/thinking content (DeepSeek R1)
  usage?: ProviderUsage;
  tool_calls?: ToolCall[]; // NEW: Tool calls in streaming response
  finish_reason?: 'stop' | 'tool_calls' | 'length'; // NEW: Why generation stopped
}

export interface Provider {
  name: string;
  sendChat(messages: ProviderMessage[], options: ProviderOptions): Promise<ProviderResponse>;
  sendChatStream(messages: ProviderMessage[], options: ProviderOptions): AsyncIterable<StreamChunk>;
}
