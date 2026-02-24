import type { ToolDefinition, ToolResult } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const TOOL_NAME = 'fs_grep';

const description = `Search for text or regex patterns within files. Returns matching lines with file paths and line numbers. Useful for finding function definitions, imports, or any code patterns across your codebase.`;

interface GrepArgs {
  pattern: string;
  path?: string;
  include?: string;
  max_results?: number;
  context_lines?: number;
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

// Check if file matches the include pattern
function matchesInclude(filePath: string, include: string | undefined): boolean {
  if (!include) return true;

  const fileName = path.basename(filePath);
  const pattern = include.replace(/\*/g, '.*').replace(/\?/g, '.');
  const regex = new RegExp(`^${pattern}$`, 'i');
  return regex.test(fileName);
}

// Check if file is likely binary
async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const buffer = Buffer.alloc(512);
    const fd = await fs.open(filePath, 'r');
    const { bytesRead } = await fd.read(buffer, 0, 512, 0);
    await fd.close();

    // Check for null bytes (common in binary files)
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export const fsGrepTool: ToolDefinition = {
  name: TOOL_NAME,
  description,
  parameters: [
    {
      name: 'pattern',
      type: 'string',
      description: 'Search pattern (plain text or regex). For regex, use standard JavaScript regex syntax.',
      required: true,
    },
    {
      name: 'path',
      type: 'string',
      description: 'Directory to search in (relative to workspace, default: workspace root)',
      required: false,
    },
    {
      name: 'include',
      type: 'string',
      description: 'File pattern to include in search (e.g., "*.ts", "*.js", "src/**/*.py")',
      required: false,
    },
    {
      name: 'max_results',
      type: 'number',
      description: 'Maximum number of matching lines to return (default: 100)',
      required: false,
      default: 100,
    },
    {
      name: 'context_lines',
      type: 'number',
      description: 'Number of lines of context to include before/after matches (default: 1)',
      required: false,
      default: 1,
    },
  ],

  async execute(args: Record<string, any>): Promise<ToolResult> {
    const {
      pattern,
      path: searchPath,
      include,
      max_results = 100,
      context_lines = 1,
    } = args as GrepArgs;

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

    // Store basePath in a variable that TypeScript knows is a string
    const searchRoot = basePath;

    try {
      // Compile regex
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'gi');
      } catch {
        // If invalid regex, treat as literal string
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      }

      const matches: Array<{
        file: string;
        line: number;
        content: string;
      }> = [];
      const maxDepth = 15;
      const maxFiles = 200;

      async function searchDir(dir: string, depth: number): Promise<void> {
        if (depth > maxDepth || matches.length >= max_results) {
          return;
        }

        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          let filesSearched = 0;

          for (const entry of entries) {
            if (matches.length >= max_results || filesSearched >= maxFiles) break;

            // Skip hidden directories and common noise
            if (entry.name.startsWith('.') && entry.isDirectory()) {
              continue;
            }
            if (['node_modules', '__pycache__', '.git', 'dist', 'build'].includes(entry.name)) {
              continue;
            }

            const fullPath = path.join(dir, entry.name);

            if (entry.isFile()) {
              // Check include pattern
              if (!matchesInclude(fullPath, include)) {
                continue;
              }

              // Skip binary files
              if (await isBinaryFile(fullPath)) {
                continue;
              }

              filesSearched++;

              try {
                const content = await fs.readFile(fullPath, 'utf-8');
                const lines = content.split('\n');

                for (let i = 0; i < lines.length && matches.length < max_results; i++) {
                  // Reset regex state for each line
                  regex.lastIndex = 0;

                  if (regex.test(lines[i])) {
                    // Get context lines
                    const startLine = Math.max(0, i - context_lines);
                    const endLine = Math.min(lines.length - 1, i + context_lines);
                    const context = lines.slice(startLine, endLine + 1).join('\n');

                    matches.push({
                      file: path.relative(searchRoot, fullPath),
                      line: i + 1, // 1-indexed
                      content: context,
                    });
                  }
                }
              } catch {
                // Skip files we can't read
              }
            } else if (entry.isDirectory()) {
              await searchDir(fullPath, depth + 1);
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }

      await searchDir(searchRoot, 0);

      // Format output
      const output = matches.map(m => {
        const prefix = `File: ${m.file} | Line ${m.line}:`;
        return `${prefix}\n${m.content}`;
      }).join('\n\n---\n\n');

      return {
        success: true,
        content: JSON.stringify({
          pattern,
          path: searchPath || '.',
          include: include || '*',
          matches: output,
          match_count: matches.length,
          truncated: matches.length >= max_results,
        }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: JSON.stringify({
          error: `Grep search failed: ${errorMessage}`,
        }),
      };
    }
  },
};

export default fsGrepTool;
