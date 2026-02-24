// File Read Tool
// Reads file contents from workspace with path traversal protection

import type { ToolDefinition, ToolResult } from './types.js';
import { readFile } from 'fs/promises';
import { resolve, normalize } from 'path';

const MAX_FILE_SIZE = 100000; // 100KB max file size
const MAX_LINES = 500; // Max lines to return

function isPathSafe(filePath: string, baseDir: string): boolean {
  const normalized = normalize(resolve(filePath));
  const normalizedBase = normalize(resolve(baseDir));

  // Ensure the resolved path is within baseDir
  return normalized.startsWith(normalizedBase);
}

export const fileReadTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read contents of a file from the current workspace. Useful for reviewing code, configuration, or documentation files.',
  parameters: [
    {
      name: 'file_path',
      type: 'string',
      description: 'Path to the file to read (relative to workspace root)',
      required: true,
    },
    {
      name: 'max_lines',
      type: 'number',
      description: 'Maximum number of lines to return (default: 500)',
      required: false,
      default: 500,
    },
  ],
  execute: async (args: Record<string, any>): Promise<ToolResult> => {
    try {
      const filePath = String(args.file_path || '').trim();
      if (!filePath) {
        return {
          success: false,
          content: JSON.stringify({ error: 'File path is required' }),
        };
      }

      const maxLines = Math.min(500, Math.max(1, parseInt(String(args.max_lines || '500'), 10)));

      // For now, use current working directory as base
      // In a real implementation, this would be the workspace directory
      const baseDir = process.cwd();

      // Check for path traversal attempts
      const fullPath = resolve(baseDir, filePath);
      if (!isPathSafe(filePath, baseDir)) {
        return {
          success: false,
          content: JSON.stringify({ error: 'Access denied: path traversal detected' }),
        };
      }

      // Read file
      const content = await readFile(fullPath, 'utf-8');

      // Check file size
      if (content.length > MAX_FILE_SIZE) {
        return {
          success: false,
          content: JSON.stringify({
            error: `File is too large (${content.length} bytes > ${MAX_FILE_SIZE} bytes)`,
          }),
        };
      }

      // Split into lines and limit
      const lines = content.split('\n');
      const truncated = lines.length > maxLines;
      const limitedLines = lines.slice(0, maxLines);

      return {
        success: true,
        content: JSON.stringify({
          file_path: filePath,
          lines: limitedLines,
          total_lines: lines.length,
          truncated,
          line_count: limitedLines.length,
        }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: JSON.stringify({
          error: `Failed to read file: ${errorMessage}`,
        }),
      };
    }
  },
};
