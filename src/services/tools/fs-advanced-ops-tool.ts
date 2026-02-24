import type { ToolDefinition, ToolResult } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const TOOL_NAME = 'fs_advanced_ops';

const description = `Perform advanced file operations: create directories, move/rename files, delete files and directories. Use for project structure management.`;

// Block dangerous operations
const BLOCKED_PATHS = ['/etc', '/usr', '/bin', '/sbin', '/var', '/sys', '/proc'];

interface FsAdvancedOpsArgs {
  operation: 'mkdir' | 'mv' | 'rm' | 'cp';
  source: string;
  destination?: string;
  recursive?: boolean;
  force?: boolean;
}

function validatePath(filePath: string, workspaceRoot: string): string | null {
  const cleaned = filePath.trim();
  if (path.isAbsolute(cleaned)) {
    // Allow absolute paths within workspace
    if (!cleaned.startsWith(workspaceRoot)) {
      return null;
    }
    return cleaned;
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

function isPathBlocked(fullPath: string): boolean {
  const lower = fullPath.toLowerCase();
  return BLOCKED_PATHS.some(blocked => lower.startsWith(blocked));
}

export const fsAdvancedOpsTool: ToolDefinition = {
  name: TOOL_NAME,
  description,
  parameters: [
    {
      name: 'operation',
      type: 'string',
      description: 'Operation to perform: mkdir (create directory), mv (move/rename), rm (delete), cp (copy)',
      required: true,
      enum: ['mkdir', 'mv', 'rm', 'cp'],
    },
    {
      name: 'source',
      type: 'string',
      description: 'Source path (file or directory)',
      required: true,
    },
    {
      name: 'destination',
      type: 'string',
      description: 'Destination path (for mv and cp operations)',
      required: false,
    },
    {
      name: 'recursive',
      type: 'boolean',
      description: 'For rm: delete directories recursively. For mkdir: create parent directories (default: true)',
      required: false,
      default: true,
    },
    {
      name: 'force',
      type: 'boolean',
      description: 'For rm: force deletion without confirmation. Ignore errors for missing files (default: false)',
      required: false,
      default: false,
    },
  ],

  async execute(args: Record<string, any>): Promise<ToolResult> {
    const { operation, source, destination, recursive = true, force = false } = args as FsAdvancedOpsArgs;

    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();

    // Validate source path
    const sourcePath = validatePath(source, workspaceRoot);
    if (!sourcePath) {
      return {
        success: false,
        content: JSON.stringify({
          error: 'Invalid source path. Path traversal attempts are not allowed.',
        }),
      };
    }

    // Security check
    if (isPathBlocked(sourcePath)) {
      return {
        success: false,
        content: JSON.stringify({
          error: 'Cannot operate on system directories.',
        }),
      };
    }

    try {
      switch (operation) {
        case 'mkdir': {
          await fs.mkdir(sourcePath, { recursive });
          return {
            success: true,
            content: JSON.stringify({
              message: `Directory created: ${source}`,
              path: source,
              operation: 'mkdir',
            }),
          };
        }

        case 'mv': {
          if (!destination) {
            return {
              success: false,
              content: JSON.stringify({
                error: 'Destination is required for mv operation',
              }),
            };
          }

          const destPath = validatePath(destination, workspaceRoot);
          if (!destPath) {
            return {
              success: false,
              content: JSON.stringify({
                error: 'Invalid destination path. Path traversal attempts are not allowed.',
              }),
            };
          }

          // Check if source exists
          try {
            await fs.access(sourcePath);
          } catch {
            return {
              success: false,
              content: JSON.stringify({
                error: `Source does not exist: ${source}`,
              }),
            };
          }

          await fs.rename(sourcePath, destPath);
          return {
            success: true,
            content: JSON.stringify({
              message: `Moved/renamed: ${source} -> ${destination}`,
              source,
              destination,
              operation: 'mv',
            }),
          };
        }

        case 'rm': {
          // Check if path exists
          try {
            await fs.access(sourcePath);
          } catch {
            if (force) {
              return {
                success: true,
                content: JSON.stringify({
                  message: `Path does not exist (ignored): ${source}`,
                  path: source,
                  operation: 'rm',
                }),
              };
            }
            return {
              success: false,
              content: JSON.stringify({
                error: `Path does not exist: ${source}`,
              }),
            };
          }

          const stats = await fs.stat(sourcePath);

          if (stats.isDirectory()) {
            if (recursive) {
              await fs.rm(sourcePath, { recursive: true, force });
            } else {
              return {
                success: false,
                content: JSON.stringify({
                  error: `Cannot delete directory without recursive flag: ${source}`,
                }),
              };
            }
          } else {
            await fs.unlink(sourcePath);
          }

          return {
            success: true,
            content: JSON.stringify({
              message: `Deleted: ${source}`,
              path: source,
              operation: 'rm',
              is_directory: stats.isDirectory(),
            }),
          };
        }

        case 'cp': {
          if (!destination) {
            return {
              success: false,
              content: JSON.stringify({
                error: 'Destination is required for cp operation',
              }),
            };
          }

          const destPath = validatePath(destination, workspaceRoot);
          if (!destPath) {
            return {
              success: false,
              content: JSON.stringify({
                error: 'Invalid destination path. Path traversal attempts are not allowed.',
              }),
            };
          }

          // Check if source exists
          try {
            await fs.access(sourcePath);
          } catch {
            return {
              success: false,
              content: JSON.stringify({
                error: `Source does not exist: ${source}`,
              }),
            };
          }

          const stats = await fs.stat(sourcePath);

          if (stats.isDirectory()) {
            // Recursive copy directory
            await copyDirectory(sourcePath, destPath);
          } else {
            await fs.copyFile(sourcePath, destPath);
          }

          return {
            success: true,
            content: JSON.stringify({
              message: `Copied: ${source} -> ${destination}`,
              source,
              destination,
              operation: 'cp',
            }),
          };
        }

        default:
          return {
            success: false,
            content: JSON.stringify({
              error: `Unknown operation: ${operation}`,
            }),
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: JSON.stringify({
          error: `Operation failed: ${errorMessage}`,
          operation,
          source,
          destination,
        }),
      };
    }
  },
};

async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export default fsAdvancedOpsTool;
