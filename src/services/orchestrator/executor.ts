// Tool Executor
// Executes tools requested by the orchestrator

import { toolRegistry } from '../tools/index.js';
import type { ToolCallRequest, ExecutionResult } from './types.js';

const TOOL_NAME_MAPPING: Record<string, string> = {
  'read_file': 'file.read',
  'write_file': 'fs.write_file',
  'edit_file': 'fs.edit_file',
  'list_directory': 'fs.glob',
  'glob': 'fs.glob',
  'grep': 'fs.grep',
  'calculator': 'calculator',
  'web_search': 'web_search',
  'bash': 'shell.exec',
  'shell': 'shell.exec',
  'run_command': 'shell.exec',
};

export class ToolExecutor {
  private timeoutMs: number;

  constructor(timeoutMs: number = 30000) {
    this.timeoutMs = timeoutMs;
  }

  async execute(toolCall: ToolCallRequest): Promise<ExecutionResult> {
    const startTime = Date.now();
    const toolName = TOOL_NAME_MAPPING[toolCall.tool] || toolCall.tool;

    try {
      const tool = toolRegistry.get(toolName);

      if (!tool) {
        return {
          tool: toolCall.tool,
          success: false,
          result: '',
          error: `Tool "${toolCall.tool}" not found`,
          durationMs: Date.now() - startTime,
        };
      }

      // Execute the tool
      const result = await this.executeTool(tool, toolCall.args);

      return {
        tool: toolCall.tool,
        success: true,
        result: this.formatResult(result),
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        tool: toolCall.tool,
        success: false,
        result: '',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  async executeAll(toolCalls: ToolCallRequest[]): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    for (const toolCall of toolCalls) {
      const result = await this.execute(toolCall);
      results.push(result);

      // Stop on first error unless it's non-critical
      if (!result.success && !this.isNonCriticalError(result.error || '')) {
        break;
      }
    }

    return results;
  }

  private async executeTool(tool: any, args: Record<string, unknown>): Promise<unknown> {
    // Get the handler function from the tool
    const handler = tool.handler || tool.execute;

    if (!handler) {
      throw new Error(`Tool ${tool.name} has no handler`);
    }

    // Execute with timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Tool execution timeout')), this.timeoutMs);
    });

    const execPromise = Promise.resolve(handler(args));

    return Promise.race([execPromise, timeoutPromise]);
  }

  private formatResult(result: unknown): string {
    if (result === null || result === undefined) {
      return '';
    }

    if (typeof result === 'string') {
      return result;
    }

    if (typeof result === 'object') {
      return JSON.stringify(result, null, 2);
    }

    return String(result);
  }

  private isNonCriticalError(error: string): boolean {
    // Some errors are non-critical and we can continue
    const nonCritical = [
      'not found',
      'does not exist',
      'no such file',
      'permission denied',
    ];

    const lowerError = error.toLowerCase();
    return nonCritical.some(nc => lowerError.includes(nc));
  }
}

// Re-export for convenience
export { toolRegistry };
