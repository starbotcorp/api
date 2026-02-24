// Tool Registry - Central registry for all available tools
// Tools are registered on startup and can be dynamically queried

import type { ToolDefinition, ToolParameter } from './types.js';

export interface OpenAIFunctionDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      console.warn(`Tool "${tool.name}" already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  toOpenAIFunctions(): OpenAIFunctionDef[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: this.parametersToOpenAISchema(tool.parameters),
        required: tool.parameters.filter(p => p.required).map(p => p.name),
      },
    }));
  }

  private parametersToOpenAISchema(params: ToolParameter[]): Record<string, any> {
    const schema: Record<string, any> = {};

    for (const param of params) {
      const paramSchema: any = {
        type: param.type,
        description: param.description,
      };

      if (param.enum) {
        paramSchema.enum = param.enum;
      }

      if (param.default !== undefined) {
        paramSchema.default = param.default;
      }

      schema[param.name] = paramSchema;
    }

    return schema;
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry();
