#!/usr/bin/env node
/**
 * Generate EPUB from Starbot API source code
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import EPub from 'epub-gen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Extensions to include in the EPUB
const INCLUDE_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.json',
  '.md',
  '.prisma',
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
]);

interface FileContent {
  title: string;
  data: string;
}

interface Chapter {
  title: string;
  content: string;
  filename?: string;
}

/**
 * HTML template for code display with syntax highlighting
 */
function codeToHtml(filePath: string, code: string): string {
  const ext = path.extname(filePath);
  const lang = ext.replace(/^\./, '');

  // Basic syntax highlighting
  const highlighted = escapeHtml(code)
    // Comments
    .replace(/(\/\/.*$)/gm, '<span class="comment">$1</span>')
    .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="comment">$1</span>')
    // Keywords
    .replace(/\b(import|export|from|const|let|var|function|return|if|else|for|while|class|interface|type|async|await|new|this|try|catch|throw|default)\b/g, '<span class="keyword">$1</span>')
    // Strings
    .replace(/(`[\s\S]*?`)/g, '<span class="string">$1</span>')
    .replace(/("(?:[^"\\]|\\.)*")/g, '<span class="string">$1</span>')
    .replace(/('(?:[^'\\]|\\.)*')/g, '<span class="string">$1</span>')
    // Numbers
    .replace(/\b(\d+)\b/g, '<span class="number">$1</span>');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.4;
      margin: 20px;
      background: #1e1e1e;
      color: #d4d4d4;
    }
    pre {
      background: #1e1e1e;
      border-radius: 6px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .header {
      background: #252526;
      padding: 10px 15px;
      border-radius: 6px 6px 0 0;
      color: #9cdcfe;
      font-weight: bold;
      border-bottom: 1px solid #3c3c3c;
    }
    .comment { color: #6a9955; font-style: italic; }
    .keyword { color: #569cd6; }
    .string { color: #ce9178; }
    .number { color: #b5cea8; }
    code {
      display: block;
      padding: 15px;
    }
  </style>
</head>
<body>
  <div class="header">${escapeHtml(filePath)}</div>
  <pre><code>${highlighted}</code></pre>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

    if (entry.isDirectory()) {
      const subFiles = await gatherFiles(fullPath, baseDir);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (INCLUDE_EXTENSIONS.has(ext)) {
        const content = await fs.readFile(fullPath, 'utf-8');
        results.push({
          title: relativePath,
          data: content,
        });
      }
    }
  }

  return results;
}

async function organizeByDirectory(files: FileContent[]): Promise<Chapter[]> {
  const dirMap = new Map<string, FileContent[]>();

  for (const file of files) {
    const dirPath = path.dirname(file.title) || '(root)';
    if (!dirMap.has(dirPath)) {
      dirMap.set(dirPath, []);
    }
    dirMap.get(dirPath)!.push(file);
  }

  const chapters: Chapter[] = [];

  // Add cover/intro
  chapters.push({
    title: 'Starbot API Source Code',
    content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: #2c3e50; }
    p { color: #34495e; }
  </style>
</head>
<body>
  <h1>Starbot API</h1>
  <p>This EPUB contains the complete source code for the Starbot API backend.</p>
  <p><strong>Starbot</strong> is an AI assistant system with a Fastify/TypeScript server that handles auth, chat persistence, memory injection, LLM streaming, and tool execution.</p>
  <p><strong>Generated on:</strong> ${new Date().toISOString()}</p>
</body>
</html>`,
  });

  // Add CLAUDE.md as a chapter
  try {
    const claudeMdPath = path.join(rootDir, 'CLAUDE.md');
    const claudeMd = await fs.readFile(claudeMdPath, 'utf-8');
    chapters.push({
      title: 'Documentation / CLAUDE.md',
      content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 20px;
      line-height: 1.6;
    }
    h1, h2, h3 { color: #2c3e50; margin-top: 1.5em; }
    code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }
    pre {
      background: #f4f4f4;
      padding: 15px;
      border-radius: 6px;
      overflow-x: auto;
    }
    pre code {
      background: none;
      padding: 0;
    }
  </style>
</head>
<body>
${markdownToHtml(claudeMd)}
</body>
</html>`,
    });
  } catch (e) {
    // CLAUDE.md not found, skip
  }

  // Sort directories for better navigation
  const sortedDirs = Array.from(dirMap.entries())
    .sort(([a], [b]) => {
      // Put (root) first, then alphabetical
      if (a === '(root)') return -1;
      if (b === '(root)') return 1;
      return a.localeCompare(b);
    });

  for (const [dirPath, dirFiles] of sortedDirs) {
    // Sort files within directory
    dirFiles.sort((a, b) => a.title.localeCompare(b.title));

    const chapterTitle = `Code / ${dirPath}`;
    const content = dirFiles.map(file => codeToHtml(file.title, file.data)).join('\n<hr style="border: 1px solid #3c3c3c; margin: 30px 0;" />\n');

    chapters.push({
      title: chapterTitle,
      content,
      filename: `${dirPath.replace(/[/\\]/g, '_')}.xhtml`,
    });
  }

  return chapters;
}

function markdownToHtml(md: string): string {
  // Simple markdown to HTML conversion
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/\n/g, '<br />\n')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
}

async function main() {
  console.log('Gathering source files...');
  const files = await gatherFiles(rootDir);
  console.log(`Found ${files.length} source files`);

  console.log('Organizing content...');
  const chapters = await organizeByDirectory(files);
  console.log(`Created ${chapters.length} chapters`);

  const outputPath = path.join(rootDir, 'starbot-api-source.epub');

  console.log('Generating EPUB...');
  await new EPub({
    title: 'Starbot API Source Code',
    author: 'Starbot',
    publisher: 'Starbot',
    cover: undefined,
    content: chapters,
    output: outputPath,
    css: `
      body {
        margin: 0;
        padding: 0;
      }
      @media screen {
        body {
          background: #1e1e1e;
        }
      }
    `,
    version: 3,
  }).promise;

  console.log(`\nEPUB generated: ${outputPath}`);
}

main().catch(console.error);
