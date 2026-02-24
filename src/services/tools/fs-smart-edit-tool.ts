/**
 * Smart File Edit Tool - AST-aware editing for code files
 *
 * Supports:
 * - Edit by function/class/method name
 * - Smart indentation preservation
 * - Unified diff generation
 * - Language-aware parsing (TS/JS, Python, Rust, Go)
 */

import type { ToolDefinition, ToolResult } from './types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const TOOL_NAME = 'fs_smart_edit';

// Language detection by extension
const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
  '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin',
};

// AST-like patterns for different constructs
const PATTERNS: Record<string, Record<string, RegExp>> = {
  typescript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)(?:\s*:\s*[^{]+)?\s*\{/g,
    arrow: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/g,
    class: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[^{]+)?\s*\{/g,
    method: /(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)(?:\s*:\s*[^{]+)?\s*\{/g,
    interface: /(?:export\s+)?interface\s+(\w+)(?:\s+extends\s+[^{]+)?\s*\{/g,
    type: /(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/g,
  },
  javascript: {
    function: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g,
    arrow: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])\s*=>/g,
    class: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g,
    method: /(\w+)\s*\([^)]*\)\s*\{/g,
  },
  python: {
    function: /^(\s*)(?:async\s+)?def\s+(\w+)\s*\([^)]*\)\s*(?:->\s*[^:]+)?:/gm,
    class: /^(\s*)class\s+(\w+)(?:\([^)]*\))?\s*:/gm,
    method: /^(\s+)(?:async\s+)?def\s+(\w+)\s*\(self[^)]*\)\s*(?:->\s*[^:]+)?:/gm,
  },
  rust: {
    function: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\s*\([^)]*\)(?:\s*->\s*[^{]+)?\s*\{/g,
    struct: /(?:pub\s+)?struct\s+(\w+)(?:<[^>]*>)?\s*\{/g,
    impl: /impl(?:<[^>]*>)?\s+(?:\w+\s+for\s+)?(\w+)(?:<[^>]*>)?\s*\{/g,
    enum: /(?:pub\s+)?enum\s+(\w+)(?:<[^>]*>)?\s*\{/g,
  },
  go: {
    function: /func\s+(\w+)\s*\([^)]*\)(?:\s*[^{]+)?\s*\{/g,
    method: /func\s+\([^)]+\)\s*(\w+)\s*\([^)]*\)(?:\s*[^{]+)?\s*\{/g,
    struct: /type\s+(\w+)\s+struct\s*\{/g,
    interface: /type\s+(\w+)\s+interface\s*\{/g,
  },
};

interface SmartEditArgs {
  path: string;
  target_type: 'function' | 'class' | 'method' | 'block' | 'line_range';
  target_name?: string;
  line_start?: number;
  line_end?: number;
  new_content: string;
  create_backup?: boolean;
}

interface CodeBlock {
  name: string;
  type: string;
  startLine: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
  content: string;
  indentation: string;
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANG_MAP[ext] || 'text';
}

function findMatchingBrace(content: string, startIndex: number, openChar = '{', closeChar = '}'): number {
  let depth = 1;
  let i = startIndex;

  // Handle Python (indentation-based)
  if (openChar === ':') {
    const lines = content.slice(startIndex).split('\n');
    const firstLine = lines[0];
    const baseIndent = (firstLine.match(/^(\s*)/) || ['', ''])[1].length;

    let endIndex = startIndex + firstLine.length;
    for (let j = 1; j < lines.length; j++) {
      const line = lines[j];
      const lineIndent = (line.match(/^(\s*)/) || ['', ''])[1].length;

      // Empty lines or comments continue the block
      if (line.trim() === '' || line.trim().startsWith('#')) {
        endIndex += line.length + 1;
        continue;
      }

      // If we hit a line with less or equal indentation, block ends
      if (lineIndent <= baseIndent && line.trim() !== '') {
        return endIndex - 1;
      }
      endIndex += line.length + 1;
    }
    return content.length;
  }

  while (i < content.length && depth > 0) {
    const char = content[i];
    if (char === openChar) depth++;
    else if (char === closeChar) depth--;

    // Skip strings and comments
    if (char === '"' || char === "'") {
      const quote = char;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') i++;
        i++;
      }
    }
    if (char === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
    }
    if (char === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i++;
    }

    i++;
  }

  return i;
}

function findCodeBlock(content: string, language: string, targetType: string, targetName: string): CodeBlock | null {
  const langPatterns = PATTERNS[language] || PATTERNS.javascript;
  const pattern = langPatterns[targetType];

  if (!pattern) return null;

  // Reset regex
  pattern.lastIndex = 0;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    // Extract name from match (handle Python's different group structure)
    const name = language === 'python' ? match[2] : match[1];

    if (name === targetName) {
      const startIndex = match.index;
      const startLine = content.slice(0, startIndex).split('\n').length;

      // Find end of block
      let endIndex: number;
      if (language === 'python') {
        endIndex = findMatchingBrace(content, match.index + match[0].length, ':', '');
      } else {
        const braceStart = content.indexOf('{', startIndex);
        if (braceStart === -1) continue;
        endIndex = findMatchingBrace(content, braceStart + 1);
      }

      const endLine = content.slice(0, endIndex).split('\n').length;
      const blockContent = content.slice(startIndex, endIndex);
      const indentation = (content.slice(0, startIndex).split('\n').pop() || '').match(/^(\s*)/)?.[1] || '';

      return {
        name,
        type: targetType,
        startLine,
        endLine,
        startIndex,
        endIndex,
        content: blockContent,
        indentation,
      };
    }
  }

  return null;
}

function generateUnifiedDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const diff: string[] = [];
  diff.push(`--- a/${filePath}`);
  diff.push(`+++ b/${filePath}`);

  // Simple line-by-line diff (not optimal but functional)
  let i = 0, j = 0;
  let hunkStart = -1;
  let hunkOldStart = 0, hunkNewStart = 0;
  let hunkLines: string[] = [];

  const flushHunk = () => {
    if (hunkLines.length > 0) {
      diff.push(`@@ -${hunkOldStart + 1},${hunkLines.filter(l => !l.startsWith('+')).length} +${hunkNewStart + 1},${hunkLines.filter(l => !l.startsWith('-')).length} @@`);
      diff.push(...hunkLines);
      hunkLines = [];
    }
  };

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      // Lines match
      if (hunkLines.length > 0) {
        hunkLines.push(` ${oldLines[i]}`);
        if (hunkLines.filter(l => l.startsWith('+') || l.startsWith('-')).length === 0) {
          flushHunk();
        }
      }
      i++;
      j++;
    } else {
      // Lines differ
      if (hunkLines.length === 0) {
        hunkOldStart = i;
        hunkNewStart = j;
        // Add context
        for (let c = Math.max(0, i - 3); c < i; c++) {
          hunkLines.push(` ${oldLines[c]}`);
        }
      }

      if (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
        hunkLines.push(`-${oldLines[i]}`);
        i++;
      }
      if (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) {
        hunkLines.push(`+${newLines[j]}`);
        j++;
      }
    }
  }

  flushHunk();

  return diff.join('\n');
}

function applyIndentation(content: string, baseIndent: string): string {
  const lines = content.split('\n');
  return lines.map((line, i) => {
    if (i === 0 || line.trim() === '') return line;
    return baseIndent + line;
  }).join('\n');
}

function validatePath(filePath: string, workspaceRoot: string): string | null {
  const cleaned = filePath.trim();
  if (path.isAbsolute(cleaned)) return null;

  const normalized = path.normalize(cleaned);
  if (normalized.includes('..')) return null;

  const fullPath = path.resolve(workspaceRoot, normalized);
  if (!fullPath.startsWith(path.resolve(workspaceRoot))) return null;

  return fullPath;
}

export const fsSmartEditTool: ToolDefinition = {
  name: TOOL_NAME,
  description: `Smart code editor with AST-aware editing. Can target specific functions, classes, or methods by name. Generates unified diffs and preserves indentation. Supports TypeScript, JavaScript, Python, Rust, and Go.`,
  parameters: [
    {
      name: 'path',
      type: 'string',
      description: 'File path to edit (relative to workspace)',
      required: true,
    },
    {
      name: 'target_type',
      type: 'string',
      description: 'Type of code block to edit: "function", "class", "method", "block", or "line_range"',
      required: true,
      enum: ['function', 'class', 'method', 'block', 'line_range'],
    },
    {
      name: 'target_name',
      type: 'string',
      description: 'Name of the function/class/method to edit (required unless target_type is "line_range")',
      required: false,
    },
    {
      name: 'line_start',
      type: 'number',
      description: 'Starting line number for line_range edit (1-indexed)',
      required: false,
    },
    {
      name: 'line_end',
      type: 'number',
      description: 'Ending line number for line_range edit (1-indexed, inclusive)',
      required: false,
    },
    {
      name: 'new_content',
      type: 'string',
      description: 'New content to replace the target block with',
      required: true,
    },
    {
      name: 'create_backup',
      type: 'boolean',
      description: 'Create backup before editing (default: true)',
      required: false,
      default: true,
    },
  ],

  async execute(args: Record<string, any>): Promise<ToolResult> {
    const {
      path: filePath,
      target_type,
      target_name,
      line_start,
      line_end,
      new_content,
      create_backup = true,
    } = args as SmartEditArgs;

    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
    const fullPath = validatePath(filePath, workspaceRoot);

    if (!fullPath) {
      return {
        content: JSON.stringify({ success: false, error: 'Invalid file path' }),
        success: false,
      };
    }

    try {
      const originalContent = await fs.readFile(fullPath, 'utf-8');
      const language = detectLanguage(filePath);

      let newFileContent: string;
      let editedBlock: { startLine: number; endLine: number; name?: string } | null = null;

      if (target_type === 'line_range') {
        // Edit by line range
        if (!line_start || !line_end) {
          return {
            content: JSON.stringify({ success: false, error: 'line_start and line_end required for line_range edit' }),
            success: false,
          };
        }

        const lines = originalContent.split('\n');
        const before = lines.slice(0, line_start - 1);
        const after = lines.slice(line_end);

        newFileContent = [...before, new_content, ...after].join('\n');
        editedBlock = { startLine: line_start, endLine: line_end };

      } else {
        // Edit by AST target
        if (!target_name) {
          return {
            content: JSON.stringify({ success: false, error: 'target_name required for function/class/method edit' }),
            success: false,
          };
        }

        const block = findCodeBlock(originalContent, language, target_type, target_name);

        if (!block) {
          return {
            content: JSON.stringify({
              success: false,
              error: `Could not find ${target_type} "${target_name}" in file`,
              hint: `Make sure the ${target_type} exists and is named exactly "${target_name}"`,
            }),
            success: false,
          };
        }

        // Apply proper indentation to new content
        const indentedContent = applyIndentation(new_content, block.indentation);

        newFileContent =
          originalContent.slice(0, block.startIndex) +
          indentedContent +
          originalContent.slice(block.endIndex);

        editedBlock = {
          startLine: block.startLine,
          endLine: block.endLine,
          name: block.name,
        };
      }

      // Create backup
      let backupPath: string | undefined;
      if (create_backup) {
        const backupDir = path.join(workspaceRoot, '.backups');
        await fs.mkdir(backupDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = path.join(backupDir, `${path.basename(filePath)}.${timestamp}.bak`);
        await fs.writeFile(backupPath, originalContent, 'utf-8');
      }

      // Write new content
      await fs.writeFile(fullPath, newFileContent, 'utf-8');

      // Generate diff
      const diff = generateUnifiedDiff(originalContent, newFileContent, filePath);

      return {
        content: JSON.stringify({
          success: true,
          message: `Successfully edited ${target_type}${target_name ? ` "${target_name}"` : ''} in ${filePath}`,
          language,
          edited_block: editedBlock,
          backup_path: backupPath,
          diff_preview: diff.split('\n').slice(0, 50).join('\n') + (diff.split('\n').length > 50 ? '\n...(truncated)' : ''),
          stats: {
            old_lines: originalContent.split('\n').length,
            new_lines: newFileContent.split('\n').length,
            change: newFileContent.split('\n').length - originalContent.split('\n').length,
          },
        }),
        success: true,
      };
    } catch (error) {
      return {
        content: JSON.stringify({
          success: false,
          error: `Failed to edit file: ${error instanceof Error ? error.message : String(error)}`,
        }),
        success: false,
      };
    }
  },
};

export default fsSmartEditTool;
