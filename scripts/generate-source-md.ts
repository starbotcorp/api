#!/usr/bin/env node
/**
 * Generate a single Markdown file with all Starbot API source code
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Extensions to include
const INCLUDE_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.json',
  '.md',
  '.prisma',
  '.yml',
  '.yaml',
]);

// Directories/files to exclude
const EXCLUDE_PATHS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  'coverage',
  'build',
  'scripts',
  '.vscode',
]);

interface FileContent {
  path: string;
  content: string;
}

/**
 * Escape markdown special characters in code
 */
function escapeCodeBlock(code: string): string {
  return code
    .replace(/```/g, '\\`\\`\\`');
}

/**
 * Escape inline code
 */
function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\\`');
}

/**
 * Convert path to markdown header
 */
function pathToHeader(filePath: string): string {
  // Normalize path separators
  const normalized = filePath.replace(/\\/g, '/');
  const depth = normalized.split('/').filter(Boolean).length;
  return '#'.repeat(Math.min(depth + 1, 6)) + ` ${escapeInlineCode(normalized)}`;
}

async function gatherFiles(dir: string, baseDir: string = dir): Promise<FileContent[]> {
  const results: FileContent[] = [];

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    const parts = relativePath.split(path.sep);

    // Skip excluded paths
    if (parts.some(p => EXCLUDE_PATHS.has(p))) {
      continue;
    }

    // Skip hidden files (except .env.example)
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      continue;
    }

    if (entry.isDirectory()) {
      const subFiles = await gatherFiles(fullPath, baseDir);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (INCLUDE_EXTENSIONS.has(ext)) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          results.push({
            path: relativePath,
            content,
          });
        } catch (e) {
          console.warn(`Warning: Could not read ${relativePath}`, e);
        }
      }
    }
  }

  return results;
}

async function organizeByDirectory(files: FileContent[]): Promise<string> {
  const dirMap = new Map<string, FileContent[]>();

  for (const file of files) {
    const dirPath = path.dirname(file.path) || '(root)';
    if (!dirMap.has(dirPath)) {
      dirMap.set(dirPath, []);
    }
    dirMap.get(dirPath)!.push(file);
  }

  const lines: string[] = [];

  // Title
  lines.push('# Starbot API Source Code\n');
  lines.push('> Complete source code of the Starbot API backend\n');
  lines.push(`> Generated on: ${new Date().toISOString()}\n`);
  lines.push('---\n');

  // Sort directories: (root) first, then alphabetical
  const sortedDirs = Array.from(dirMap.entries())
    .sort(([a], [b]) => {
      if (a === '(root)') return -1;
      if (b === '(root)') return 1;
      return a.localeCompare(b);
    });

  for (const [dirPath, dirFiles] of sortedDirs) {
    // Directory section header
    if (dirPath === '(root)') {
      lines.push('# Root Directory\n');
    } else {
      lines.push(`# ${escapeInlineCode(dirPath)}\n`);
    }
    lines.push('');

    // Sort files alphabetically
    dirFiles.sort((a, b) => a.path.localeCompare(b.path));

    for (const file of dirFiles) {
      lines.push(`## ${escapeInlineCode(file.path)}\n`);
      lines.push('```');
      lines.push(escapeCodeBlock(file.content));
      lines.push('```\n');
    }
  }

  return lines.join('\n');
}

async function main() {
  console.log('Gathering source files...');
  const files = await gatherFiles(rootDir);
  console.log(`Found ${files.length} source files`);

  console.log('Organizing content...');
  const markdown = await organizeByDirectory(files);

  const outputPath = path.join(rootDir, 'starbot-api-source.md');

  console.log('Writing markdown file...');
  await fs.writeFile(outputPath, markdown, 'utf-8');

  console.log(`\nMarkdown file generated: ${outputPath}`);
  console.log(`Total size: ${(markdown.length / 1024).toFixed(1)} KB`);
}

main().catch(console.error);
