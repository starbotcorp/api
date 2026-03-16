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

/**
 * Extract complete JSON objects from a string using bracket counting.
 * This properly handles nested objects unlike simple regex.
 */
function extractCompleteJsonObjects(str: string): object[] {
  const objects: object[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        if (depth === 0) {
          start = i;
        }
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          const jsonStr = str.slice(start, i + 1);
          try {
            objects.push(JSON.parse(jsonStr));
          } catch {
            // Invalid JSON, skip
          }
          start = -1;
        }
      }
    }
  }

  return objects;
}

export function parseToolCallsFromResponse(response: string): ToolCallRequest[] {
  const toolCalls: ToolCallRequest[] = [];

  // First, try to extract XML-like tool calls (DeepSeek often uses this format)
  const xmlToolCalls = parseXmlToolCalls(response);
  if (xmlToolCalls.length > 0) {
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
      return toolCalls;
    }
  }

  // Use robust JSON extraction that handles nested objects
  const jsonObjects = extractCompleteJsonObjects(cleanedResponse);
  for (const obj of jsonObjects) {
    const parsed = obj as Record<string, unknown>;
    if (parsed.tool && parsed.args) {
      toolCalls.push({
        tool: String(parsed.tool),
        args: parsed.args as Record<string, unknown>,
        reasoning: parsed.reasoning ? String(parsed.reasoning) : 'Extracted from text',
      });
    }
  }

  if (toolCalls.length > 0) {
    return toolCalls;
  }

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
