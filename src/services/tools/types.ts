// Tool system types and interfaces
// Defines the schema and interfaces for tools in Starbot

import type { FastifyRequest } from 'fastify';

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required: boolean;
  enum?: string[]; // For enum types
  default?: any;
}

export interface ToolContext {
  request: FastifyRequest;
  projectId?: string;
  workspaceId?: string;
  chatId?: string;
  chatCreated?: Date;
  messageCount?: number;
  userTimezone?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute: (args: Record<string, any>, context?: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  content: string; // JSON stringified result or error message
  metadata?: {
    duration_ms?: number;
    tokens_used?: number;
    [key: string]: any;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}
