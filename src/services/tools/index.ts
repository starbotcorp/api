// Tool System Initialization
// Registers all available tools on startup

import { env } from '../../env.js';
import { toolRegistry } from './registry.js';
import { webSearchTool } from './web-search-tool.js';
import { calculatorTool } from './calculator-tool.js';
import { codeExecTool } from './code-exec-tool.js';
import { fileReadTool } from './file-read-tool.js';
import { fsWriteFileTool } from './fs-write-file-tool.js';
import { fsEditFileTool } from './fs-edit-file-tool.js';
import { fsGlobTool } from './fs-glob-tool.js';
import { fsGrepTool } from './fs-grep-tool.js';
import { shellExecTool } from './shell-exec-tool.js';
import { fsAdvancedOpsTool } from './fs-advanced-ops-tool.js';

export { toolRegistry } from './registry.js';
export type { ToolDefinition, ToolResult, ToolCall, ToolParameter } from './types.js';

/**
 * Returns only the tools matching the given names.
 * Used by the Codex router to selectively inject tools per-request.
 */
export function getToolsByNames(names: string[]): import('./types.js').ToolDefinition[] {
  if (!names || names.length === 0) return [];
  const nameSet = new Set(names.map(n => n.toLowerCase()));
  return toolRegistry.getAll().filter(t => nameSet.has(t.name.toLowerCase()));
}

export function initializeTools(): void {
  console.log('Initializing tool system...');

  // Register web search tool if enabled
  if (env.TOOLS_ENABLED && env.WEB_SEARCH_ENABLED && env.BRAVE_SEARCH_API_KEY) {
    toolRegistry.register(webSearchTool);
    console.log('✓ Web search tool registered');
  }

  // Register calculator tool
  if (env.TOOLS_ENABLED) {
    toolRegistry.register(calculatorTool);
    console.log('✓ Calculator tool registered');
  }

  // Register code execution tool (disabled by default for security)
  if (env.TOOLS_ENABLED && env.CODE_EXECUTION_ENABLED) {
    toolRegistry.register(codeExecTool);
    console.log('✓ Code execution tool registered (SECURITY WARNING: Code execution enabled)');
  }

  // Register file read tool
  if (env.TOOLS_ENABLED) {
    toolRegistry.register(fileReadTool);
    console.log('✓ File read tool registered');
  }

  // Register file write tool
  if (env.TOOLS_ENABLED) {
    toolRegistry.register(fsWriteFileTool);
    console.log('✓ File write tool registered');
  }

  // Register file edit tool (search and replace)
  if (env.TOOLS_ENABLED) {
    toolRegistry.register(fsEditFileTool);
    console.log('✓ File edit tool registered');
  }

  // Register glob tool (find files by pattern)
  if (env.TOOLS_ENABLED) {
    toolRegistry.register(fsGlobTool);
    console.log('✓ Glob tool registered');
  }

  // Register grep tool (search content in files)
  if (env.TOOLS_ENABLED) {
    toolRegistry.register(fsGrepTool);
    console.log('✓ Grep tool registered');
  }

  // Register shell execution tool
  if (env.TOOLS_ENABLED && env.SHELL_EXEC_ENABLED) {
    toolRegistry.register(shellExecTool);
    console.log('✓ Shell execution tool registered');
  }

  // Register advanced file operations tool
  if (env.TOOLS_ENABLED) {
    toolRegistry.register(fsAdvancedOpsTool);
    console.log('✓ Advanced file operations tool registered');
  }

  const registeredTools = toolRegistry.getAll();
  console.log(`Tool system initialized with ${registeredTools.length} tool(s)`);

  if (registeredTools.length > 0) {
    console.log(`Registered tools: ${registeredTools.map(t => t.name).join(', ')}`);
  }
}
