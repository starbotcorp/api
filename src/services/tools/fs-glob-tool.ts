import type { ToolDefinition, ToolResult } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const TOOL_NAME = 'fs_glob';

const description = `Find files matching a glob pattern. Useful for discovering files when you don't know the exact path. Supports patterns like "**/*.ts", "src/**/*.js", "**/test*.py". Searches recursively from the starting directory.`;

interface GlobArgs {
  pattern: string;
  path?: string;
  max_results?: number;
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

// Simple glob matching - supports **, *, and ?
function matchesPattern(filePath: string, pattern: string): boolean {
  // Handle ** (recursive wildcard)
  if (pattern.startsWith('**/')) {
    const rest = pattern.slice(3);
    const parts = filePath.split('/');
    for (let i = 0; i < parts.length; i++) {
      const subpath = parts.slice(i).join('/');
      if (matchesPattern(subpath, rest)) return true;
    }
    return matchesPattern(filePath, rest);
  }

  // Split pattern into parts
  const patternParts = pattern.split('/');
  const pathParts = filePath.split('/');

  // If pattern has more parts than path, can't match
  if (patternParts.length > pathParts.length) {
    return false;
  }

  // Match each part
  let pathIndex = 0;
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];

    if (p === '*') {
      // Single directory wildcard - matches anything except /
      pathIndex++;
    } else if (p === '**') {
      // Already handled above
      pathIndex++;
    } else if (p.includes('*') || p.includes('?')) {
      // Complex pattern with wildcards
      const regex = new RegExp(
        '^' + p.replace(/\./g, '\\.').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$'
      );
      if (!regex.test(pathParts[pathIndex])) {
        return false;
      }
      pathIndex++;
    } else {
      // Exact match
      if (pathParts[pathIndex] !== p) {
        return false;
      }
      pathIndex++;
    }
  }

  return true;
}

export const fsGlobTool: ToolDefinition = {
  name: TOOL_NAME,
  description,
  parameters: [
    {
      name: 'pattern',
      type: 'string',
      description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.js", "**/test*.py")',
      required: true,
    },
    {
      name: 'path',
      type: 'string',
      description: 'Starting directory for search (relative to workspace, default: workspace root)',
      required: false,
    },
    {
      name: 'max_results',
      type: 'number',
      description: 'Maximum number of results to return (default: 50)',
      required: false,
      default: 50,
    },
  ],

  async execute(args: Record<string, any>): Promise<ToolResult> {
    const { pattern, path: searchPath, max_results = 50 } = args as GlobArgs;

    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
    const basePath = searchPath
      ? validatePath(searchPath, workspaceRoot)
      : workspaceRoot;

    if (!basePath) {
      return {
        success: false,
        content: JSON.stringify({
          error: 'Invalid search path. Path traversal attempts are not allowed.',
        }),
      };
    }

    try {
      const matches: string[] = [];
      const maxDepth = 20; // Prevent infinite recursion

      // Store basePath in a variable that TypeScript knows is a string
      const searchRoot = basePath;

      async function walkDir(dir: string, depth: number): Promise<void> {
        if (depth > maxDepth || matches.length >= max_results) {
          return;
        }

        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });

          for (const entry of entries) {
            if (matches.length >= max_results) break;

            // Skip hidden directories and common noise
            if (entry.name.startsWith('.') && entry.isDirectory()) {
              continue;
            }
            if (['node_modules', '__pycache__', '.git', 'dist', 'build'].includes(entry.name)) {
              continue;
            }

            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(searchRoot, fullPath);

            if (entry.isFile()) {
              if (matchesPattern(relativePath, pattern)) {
                matches.push(relativePath);
              }
            } else if (entry.isDirectory()) {
              await walkDir(fullPath, depth + 1);
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }

      await walkDir(searchRoot, 0);

      // Sort results alphabetically
      matches.sort();

      return {
        success: true,
        content: JSON.stringify({
          pattern,
          path: searchPath || '.',
          matches,
          count: matches.length,
          truncated: matches.length >= max_results,
        }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: JSON.stringify({
          error: `Glob search failed: ${errorMessage}`,
        }),
      };
    }
  },
};

export default fsGlobTool;
