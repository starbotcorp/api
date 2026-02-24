import type { ToolDefinition, ToolResult } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const TOOL_NAME = 'fs_edit_file';

const description = `Edits an existing file by replacing specific text with new content. This is safer than overwriting entire files as it preserves the surrounding context. Use this to make targeted changes to code, configuration, or any text file.`;

interface EditFileArgs {
  path: string;
  search: string;
  replace: string;
  global?: boolean;
  create_backup?: boolean;
}

function validatePath(filePath: string, workspaceRoot: string): string | null {
  const cleaned = filePath.trim();

  if (path.isAbsolute(cleaned)) {
    return null;
  }

  const normalized = path.normalize(cleaned);
  if (normalized.includes('..')) {
    return null;
  }

  const fullPath = path.resolve(workspaceRoot, normalized);
  const resolvedWorkspace = path.resolve(workspaceRoot);

  if (!fullPath.startsWith(resolvedWorkspace)) {
    return null;
  }

  return fullPath;
}

export const fsEditFileTool: ToolDefinition = {
  name: TOOL_NAME,
  description,
  parameters: [
    {
      name: 'path',
      type: 'string',
      description: 'The file path to edit (relative to workspace, e.g., "src/app.ts")',
      required: true,
    },
    {
      name: 'search',
      type: 'string',
      description: 'The exact text to search for in the file (must match exactly)',
      required: true,
    },
    {
      name: 'replace',
      type: 'string',
      description: 'The new text to replace the search text with',
      required: true,
    },
    {
      name: 'global',
      type: 'boolean',
      description: 'If true, replace all occurrences. If false, replace only the first occurrence (default: false)',
      required: false,
      default: false,
    },
    {
      name: 'create_backup',
      type: 'boolean',
      description: 'Whether to create a backup before editing (default: true)',
      required: false,
      default: true,
    },
  ],

  async execute(args: Record<string, any>): Promise<ToolResult> {
    const { path: filePath, search, replace, global = false, create_backup = true } = args as EditFileArgs;

    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
    const fullPath = validatePath(filePath, workspaceRoot);

    if (!fullPath) {
      return {
        content: JSON.stringify({
          success: false,
          error: 'Invalid file path. Path traversal attempts or absolute paths outside workspace are not allowed.',
        }),
        success: false,
      };
    }

    try {
      // Read existing file content
      let originalContent: string;
      try {
        originalContent = await fs.readFile(fullPath, 'utf-8');
      } catch (error) {
        return {
          content: JSON.stringify({
            success: false,
            error: `File not found: "${filePath}". Use fs_write_file to create new files.`,
          }),
          success: false,
        };
      }

      // Create backup if requested
      let backupPath: string | undefined;
      if (create_backup) {
        const backupDir = path.join(workspaceRoot, '.backups');
        await fs.mkdir(backupDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFileName = `${path.basename(filePath)}.${timestamp}.bak`;
        backupPath = path.join(backupDir, backupFileName);

        await fs.writeFile(backupPath, originalContent, 'utf-8');
      }

      // Perform the replacement
      let newContent: string;
      let matchCount: number;

      if (global) {
        // Replace all occurrences
        if (!originalContent.includes(search)) {
          return {
            content: JSON.stringify({
              success: false,
              error: `Search text not found in file. Make sure the search text matches exactly, including whitespace and newlines.`,
            }),
            success: false,
          };
        }
        matchCount = (originalContent.match(new RegExp(escapeRegExp(search), 'g')) || []).length;
        newContent = originalContent.split(search).join(replace);
      } else {
        // Replace first occurrence only
        const index = originalContent.indexOf(search);
        if (index === -1) {
          return {
            content: JSON.stringify({
              success: false,
              error: `Search text not found in file. Make sure the search text matches exactly, including whitespace and newlines.`,
            }),
            success: false,
          };
        }
        matchCount = 1;
        newContent = originalContent.slice(0, index) + replace + originalContent.slice(index + search.length);
      }

      // Write the modified content
      await fs.writeFile(fullPath, newContent, 'utf-8');

      return {
        content: JSON.stringify({
          success: true,
          message: `File edited successfully. ${matchCount} occurrence(s) replaced.`,
          path: filePath,
          fullPath: fullPath,
          replacements: matchCount,
          backup_path: backupPath,
          diff: {
            old_length: originalContent.length,
            new_length: newContent.length,
            change: newContent.length - originalContent.length,
          },
        }),
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: JSON.stringify({
          success: false,
          error: `Failed to edit file: ${errorMessage}`,
        }),
        success: false,
      };
    }
  },
};

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default fsEditFileTool;
