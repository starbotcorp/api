import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';

interface Entry {
  name: string;
  size: number | null;
}

const MAX_PER_GROUP = 80;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function cleanPrompt(input: string): string {
  return String(input || '')
    .trim()
    .replace(/[?!.]+$/g, '')
    .trim();
}

function normalizePathToken(token: string): string {
  return token
    .trim()
    .replace(/^the\s+/i, '')
    .replace(/\s+(folder|directory|dir|files|file|contents?|content)$/i, '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim();
}

function parseListTarget(prompt: string): string | null {
  const cleaned = cleanPrompt(prompt);

  if (cleaned === 'ls') return null;
  if (cleaned.startsWith('/ls')) {
    const target = cleaned.slice(3).trim();
    return target || null;
  }
  if (cleaned.startsWith('ls ')) {
    const target = cleaned.slice(3).trim();
    return target || null;
  }

  const natural = cleaned.match(
    /^(?:what(?:'s| is)? in|whats in|show me|list|look in|look inside)\s+(?:the\s+)?(.+)$/i,
  );
  if (!natural || !natural[1]) return null;

  const candidate = normalizePathToken(natural[1]);
  if (!candidate) return null;
  if (['here', 'in here', 'there', 'this directory', 'this dir'].includes(candidate.toLowerCase())) {
    return null;
  }
  return candidate;
}

function isPwdRequest(prompt: string): boolean {
  const lower = cleanPrompt(prompt).toLowerCase();
  if (!lower) return false;
  if (lower === 'pwd' || lower === '/pwd') return true;

  return [
    'what directory are we in',
    'what dir are we in',
    'what folder are we in',
    'where are we',
    'where am i',
    'current directory',
    'current dir',
    'working directory',
    'show current directory',
  ].some((needle) => lower.includes(needle));
}

function isListRequest(prompt: string): boolean {
  const lower = cleanPrompt(prompt).toLowerCase();
  if (!lower) return false;

  if (lower === 'ls' || lower.startsWith('ls ') || lower.startsWith('/ls')) return true;

  const staticNeedles = [
    'list directory',
    'directory contents',
    'show directory',
    'show dir',
    'list dir',
    'this dir',
    'in this dir',
    "what's in this dir",
    'whats in this dir',
    'what is in this dir',
    'look at files',
    'look in there',
    'look in here',
    'show current directory',
    'list current directory',
    'files in here',
    'files here',
    'what files are here',
    'list files in this directory',
    'show files in this directory',
    'show contents',
    'show the contents',
    'directory content',
    'what is in this directory',
    "what's in this directory",
    'whats in this directory',
    'what are the contents',
    "what's the contents",
    'what is the contents',
    'tell me what the contents are',
    'contents of our working directory',
    'contents of working directory',
    'contents of current directory',
    'current folder contents',
    // Additional patterns to catch "list files" variations
    'list files',
    'show files',
    'show the files',
    'what files',
    'see the files',
    'what files are',
    'list the files',
  ];
  if (staticNeedles.some((needle) => lower.includes(needle))) return true;

  if (
    (lower.includes("what's in") ||
      lower.includes('whats in') ||
      lower.includes('what is in') ||
      lower.includes('look in') ||
      lower.includes('look inside') ||
      lower.includes('show me') ||
      lower.includes('list')) &&
    (lower.includes('folder') ||
      lower.includes('directory') ||
      lower.includes(' dir') ||
      lower.endsWith('dir'))
  ) {
    return true;
  }

  if (
    lower.includes('contents') &&
    (lower.includes('working directory') ||
      lower.includes('current directory') ||
      lower.includes('our directory') ||
      lower.includes('folder') ||
      lower.includes('directory') ||
      lower.includes(' dir') ||
      lower.includes('here') ||
      lower.includes('there') ||
      lower.includes('current') ||
      lower.includes('our'))
  ) {
    return true;
  }

  if (
    lower.startsWith('of ') &&
    (lower.includes('working directory') ||
      lower.includes('current directory') ||
      lower.includes('our directory') ||
      lower.includes('this directory') ||
      lower.includes('this dir'))
  ) {
    return true;
  }

  return false;
}

function isAccessRequest(prompt: string): boolean {
  const lower = cleanPrompt(prompt).toLowerCase();
  if (!lower) return false;
  return (
    (lower.includes('access') ||
      lower.includes('see') ||
      lower.includes('read') ||
      lower.includes('view')) &&
    (lower.includes('file') ||
      lower.includes('files') ||
      lower.includes('directory') ||
      lower.includes('folder') ||
      lower.includes('filesystem'))
  );
}

function resolveBaseDir(workingDir?: string): string {
  const candidate = String(workingDir || '').trim();
  if (!candidate) return process.cwd();
  return path.resolve(candidate);
}

async function listDirectory(baseDir: string, target: string | null): Promise<string> {
  const targetPath = target
    ? path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(baseDir, target)
    : baseDir;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(targetPath, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    return `Local directory listing failed for \`${targetPath}\`: ${error instanceof Error ? error.message : String(error)}`;
  }

  const dirs: Entry[] = [];
  const files: Entry[] = [];
  const other: Entry[] = [];

  for (const entry of entries) {
    const full = path.join(targetPath, entry.name);
    let size: number | null = null;
    try {
      size = (await fs.stat(full)).size;
    } catch {
      size = null;
    }

    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, size });
    } else if (entry.isFile()) {
      files.push({ name: entry.name, size });
    } else {
      other.push({ name: entry.name, size });
    }
  }

  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  dirs.sort(byName);
  files.sort(byName);
  other.sort(byName);

  const truncated =
    dirs.length > MAX_PER_GROUP || files.length > MAX_PER_GROUP || other.length > MAX_PER_GROUP;
  const total = dirs.length + files.length + other.length;

  const lines: string[] = [];
  lines.push(
    `Local directory listing for \`${targetPath}\` (${total} entries${truncated ? ', truncated' : ''}):`,
  );

  const pushGroup = (label: string, group: Entry[], isDir: boolean) => {
    if (group.length === 0) return;
    lines.push('');
    lines.push(`${label}:`);
    for (const item of group.slice(0, MAX_PER_GROUP)) {
      const suffix = isDir ? '/' : '';
      if (item.size === null) {
        lines.push(`- ${item.name}${suffix}`);
      } else {
        lines.push(`- ${item.name}${suffix} (${formatFileSize(item.size)})`);
      }
    }
    if (group.length > MAX_PER_GROUP) {
      lines.push('- ...');
    }
  };

  pushGroup('Folders', dirs, true);
  pushGroup('Files', files, false);
  pushGroup('Other', other, false);

  return lines.join('\n');
}

export async function executeFilesystemRouterPrompt(
  message: string,
  workingDir?: string,
): Promise<string> {
  const baseDir = resolveBaseDir(workingDir);

  if (isPwdRequest(message)) {
    return `Current working directory:\n\`${baseDir}\``;
  }

  if (isAccessRequest(message)) {
    const listing = await listDirectory(baseDir, null);
    return `Yes. I have local access to files in:\n\`${baseDir}\`\n\n${listing}`;
  }

  if (isListRequest(message)) {
    return listDirectory(baseDir, parseListTarget(message));
  }

  return [
    'Filesystem router is active, but I need a concrete file task.',
    'Try: `pwd`, `ls`, `ls deploy`, or "what is in the deploy folder?"',
  ].join('\n');
}
