import type { ToolDefinition, ToolResult } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const TOOL_NAME = 'fs_write_file';

const description = `Writes content to a file at a specified path. Creates the file if it doesn't exist, or overwrites it if it does. Automatically creates parent directories as needed. Use this tool to save code, configuration, text, or any content to the filesystem.`;

interface WriteFileArgs {
  path: string;
  content: string;
  create_backup?: boolean;
}

function validatePath(filePath: string, workspaceRoot: string): string | null {
  // Remove leading/trailing whitespace
  const cleaned = filePath.trim();

  // Reject absolute paths that escape workspace
  if (path.isAbsolute(cleaned)) {
    return null;
  }

  // Reject path traversal attempts
  const normalized = path.normalize(cleaned);
  if (normalized.includes('..')) {
    return null;
  }

  // Resolve to absolute path within workspace
  const fullPath = path.resolve(workspaceRoot, normalized);

  // Ensure the resolved path is still within workspace
  const resolvedWorkspace = path.resolve(workspaceRoot);
  if (!fullPath.startsWith(resolvedWorkspace)) {
    return null;
  }

  return fullPath;
}

export const fsWriteFileTool: ToolDefinition = {
  name: TOOL_NAME,
  description,
  parameters: [
    {
      name: 'path',
      type: 'string',
      description: 'The file path to write to (relative to workspace, e.g., "src/app.ts" or "docs/readme.md")',
      required: true,
    },
    {
      name: 'content',
      type: 'string',
      description: 'The complete content to write to the file',
      required: true,
    },
    {
      name: 'create_backup',
      type: 'boolean',
      description: 'Whether to create a backup before overwriting (default: false)',
      required: false,
      default: false,
    },
  ],

  async execute(args: Record<string, any>): Promise<ToolResult> {
    const { path: filePath, content, create_backup = false } = args as WriteFileArgs;

    // Get workspace root - use environment or default to process cwd
    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();

    // Validate path
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
      // Create backup if requested and file exists
      let backupPath: string | undefined;
      if (create_backup) {
        try {
          await fs.access(fullPath);
          const backupDir = path.join(workspaceRoot, '.backups');
          await fs.mkdir(backupDir, { recursive: true });

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupFileName = `${path.basename(filePath)}.${timestamp}.bak`;
          backupPath = path.join(backupDir, backupFileName);

          await fs.copyFile(fullPath, backupPath);
        } catch {
          // File doesn't exist, no backup needed
        }
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(fullPath);
      await fs.mkdir(parentDir, { recursive: true });

      // Write file
      await fs.writeFile(fullPath, content, 'utf-8');

      // Get file stats for response
      const stats = await fs.stat(fullPath);

      return {
        content: JSON.stringify({
          success: true,
          message: `File written successfully to "${filePath}"`,
          path: filePath,
          fullPath: fullPath,
          size: stats.size,
          lines: content.split('\n').length,
          backup_path: backupPath,
        }),
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: JSON.stringify({
          success: false,
          error: `Failed to write file: ${errorMessage}`,
        }),
        success: false,
      };
    }
  },
};

export default fsWriteFileTool;
