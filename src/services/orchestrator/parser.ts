// DeepSeek Output Parser
// Parses DeepSeek R1's response to extract tool call requests
// DeepSeek outputs tool requests in JSON format inside markdown code blocks

import type { ToolCallRequest } from './types.js';

const TOOL_NAMES = [
  'read_file',
  'file_read',
  'write_file',
  'file_write',
  'edit_file',
  'file_edit',
  'list_directory',
  'glob',
  'grep',
  'calculator',
  'web_search',
  'search',
  'bash',
  'shell',
  'run_command',
];

export function parseToolCallsFromResponse(response: string): ToolCallRequest[] {
  const toolCalls: ToolCallRequest[] = [];

  console.log('[Parser] Received response, length:', response.length);
  console.log('[Parser] First 200 chars:', response.slice(0, 200));

  // First, try to extract XML-like tool calls (DeepSeek often uses this format)
  const xmlToolCalls = parseXmlToolCalls(response);
  console.log('[Parser] XML tool calls found:', xmlToolCalls.length);
  if (xmlToolCalls.length > 0) {
    console.log('[Parser] XML tool calls:', JSON.stringify(xmlToolCalls));
    return xmlToolCalls;
  }

  // Try to extract JSON from response
  // Remove thinking tags but preserve JSON structure
  let cleanedResponse = response
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();

  // Try to find JSON blocks in markdown code blocks first
  const codeBlockMatches = cleanedResponse.match(/```json\s*(\{[\s\S]*?\})\s*```/g);
  if (codeBlockMatches) {
    console.log('[Parser] Found code blocks:', codeBlockMatches.length);
    for (const block of codeBlockMatches) {
      const jsonMatch = block.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.tool && parsed.args) {
            toolCalls.push({
              tool: parsed.tool,
              args: typeof parsed.args === 'string' ? JSON.parse(parsed.args) : parsed.args,
              reasoning: parsed.reasoning,
            });
          }
        } catch {
          // Not valid JSON
        }
      }
    }
    if (toolCalls.length > 0) {
      console.log('[Parser] Tool calls from code blocks:', JSON.stringify(toolCalls));
      return toolCalls;
    }
  }

  // Also try plain JSON objects with tool/args keys
  // Match complete JSON objects - find {"tool":...} patterns
  const jsonRegex = /\{"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*\{([^}]+)\}\s*\}/g;
  let jsonMatch;
  while ((jsonMatch = jsonRegex.exec(cleanedResponse)) !== null) {
    const toolName = jsonMatch[1];
    const argsStr = jsonMatch[2];
    // Parse args
    const args: Record<string, string> = {};
    const argRegex = /"([^"]+)"\s*:\s*"([^"]*)"/g;
    let argMatch;
    while ((argMatch = argRegex.exec(argsStr)) !== null) {
      args[argMatch[1]] = argMatch[2];
    }
    if (Object.keys(args).length > 0) {
      toolCalls.push({
        tool: toolName,
        args,
        reasoning: 'Extracted from text',
      });
    }
  }
  console.log('[Parser] Extracted tool calls from regex:', JSON.stringify(toolCalls));
  if (toolCalls.length > 0) {
    return toolCalls;
  }

  console.log('[Parser] Final tool calls:', JSON.stringify(toolCalls));
  return toolCalls;
}

// Parse XML-like tool call formats that DeepSeek often uses
function parseXmlToolCalls(response: string): ToolCallRequest[] {
  const toolCalls: ToolCallRequest[] = [];

  // Pattern: <<<tool_name args>>>, <<tool_name args>>, <tool_name args>
  const xmlPatterns = [
    /<<<(\w+)([^>]*)>>>/g,
    /<<(\w+)([^>]*)>>/g,
    /<(\w+)([^>]+)>/g,
  ];

  for (const pattern of xmlPatterns) {
    let match;
    while ((match = pattern.exec(response)) !== null) {
      const toolName = match[1].toLowerCase();
      const argsStr = match[2].trim();

      if (TOOL_NAMES.includes(toolName)) {
        const args = parseXmlArgs(toolName, argsStr);
        if (Object.keys(args).length > 0) {
          toolCalls.push({
            tool: toolName,
            args,
            reasoning: 'Extracted from XML-like format',
          });
        }
      }
    }
  }

  return toolCalls;
}

function parseXmlArgs(toolName: string, argsStr: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  // Try to parse key="value" or key=value patterns
  const keyValuePattern = /(\w+)[\s:=]+["']?([^"'\n]+)["']?/g;
  let match;
  while ((match = keyValuePattern.exec(argsStr)) !== null) {
    const key = match[1].toLowerCase();
    let value = match[2].trim();

    // Remove trailing characters
    value = value.replace(/[>,}\]]+$/, '');

    // Try to parse as number
    const numValue = parseFloat(value);
    if (!isNaN(numValue) && value.match(/^[\d.]+$/)) {
      args[key] = numValue;
    } else {
      args[key] = value;
    }
  }

  return args;
}

export function hasToolCallIntent(response: string): boolean {
  const lower = response.toLowerCase();
  const indicators = [
    'need to',
    'i need to',
    'let me',
    "i'll",
    'i will',
    'should',
    'could use',
    'can use',
    'tool:',
    'using',
    'execute',
    'run the',
    'check the',
    'look at',
    'read the',
    'list',
    'directory',
    'file',
    'calculate',
  ];

  return indicators.some(ind => lower.includes(ind));
}
