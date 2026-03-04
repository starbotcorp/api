// File operation routes - extracted from generation.ts
import type { FastifyInstance } from 'fastify';
import * as fs from 'fs/promises';
import * as path from 'path';
import { prisma } from '../../db.js';
import { requireAuthIfEnabled } from '../../security/route-guards.js';
import { FileListSchema, FileReadSchema, FileWriteSchema } from './schemas.js';

// Path traversal validation helper
async function validatePathWithinWorkspace(
  workspacePath: string,
  requestedPath: string
): Promise<{ valid: boolean; resolvedPath?: string; error?: string }> {
  const resolvedWorkspace = path.resolve(workspacePath);
  const resolvedPath = path.resolve(workspacePath, requestedPath);

  // Check if resolved path is within workspace
  if (!resolvedPath.startsWith(resolvedWorkspace)) {
    return { valid: false, error: 'Access denied: path outside workspace' };
  }

  // Check for symlinks that escape the workspace
  try {
    const realPath = await fs.realpath(resolvedPath);
    if (!realPath.startsWith(resolvedWorkspace)) {
      return { valid: false, error: 'Access denied: symlink outside workspace' };
    }
    return { valid: true, resolvedPath: realPath };
  } catch {
    // Path doesn't exist yet (for writes) - use resolved path
    return { valid: true, resolvedPath };
  }
}

// Workspace validation helper
async function validateWorkspace(workspaceId: string): Promise<{ valid: boolean; workspace?: any; error?: string }> {
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      return { valid: false, error: 'Workspace not found' };
    }

    return { valid: true, workspace };
  } catch {
    return { valid: false, error: 'Failed to validate workspace' };
  }
}

// Language detection from file extension
const LANGUAGE_MAP: Record<string, string> = {
  '.js': 'javascript',
  '.ts': 'typescript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cpp': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.md': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.fish': 'fish',
  '.zsh': 'zsh',
  '.ps1': 'powershell',
  '.dockerfile': 'dockerfile',
};

export async function fileRoutes(server: FastifyInstance) {
  // GET /v1/files/list - List files in directory
  server.get('/files/list', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) {
      return;
    }

    const { workspace_id, path: dirPath } = FileListSchema.parse(request.query);

    try {
      const workspaceValidation = await validateWorkspace(workspace_id);
      if (!workspaceValidation.valid) {
        return reply.code(404).send({ error: workspaceValidation.error });
      }

      const workspace = workspaceValidation.workspace;
      const workspacePath = workspace.identifier || `/workspace/${workspace_id}`;

      const pathValidation = await validatePathWithinWorkspace(workspacePath, dirPath);
      if (!pathValidation.valid) {
        return reply.code(403).send({ error: pathValidation.error });
      }

      const fullPath = pathValidation.resolvedPath!;
      const items = await fs.readdir(fullPath, { withFileTypes: true });

      const files = await Promise.all(items.map(async (item) => {
        const itemPath = path.join(fullPath, item.name);
        const stats = await fs.stat(itemPath);

        return {
          name: item.name,
          path: path.join(dirPath, item.name).replace(/^\//, ''),
          is_dir: item.isDirectory(),
          size: stats.size,
          last_modified: stats.mtime.toISOString(),
        };
      }));

      return {
        request_id: crypto.randomUUID(),
        elapsed_ms: 0,
        json: {
          files: files.sort((a, b) => {
            if (a.is_dir !== b.is_dir) return b.is_dir ? 1 : -1;
            return a.name.localeCompare(b.name);
          }),
        },
      };
    } catch (err) {
      server.log.error(err);
      return reply.code(500).send({
        error: 'Failed to list files',
        message: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // GET /v1/files/read - Read file contents
  server.get('/files/read', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) {
      return;
    }

    const { workspace_id, path: filePath } = FileReadSchema.parse(request.query);

    try {
      const workspaceValidation = await validateWorkspace(workspace_id);
      if (!workspaceValidation.valid) {
        return reply.code(404).send({ error: workspaceValidation.error });
      }

      const workspace = workspaceValidation.workspace;
      const workspacePath = workspace.identifier || `/workspace/${workspace_id}`;

      const pathValidation = await validatePathWithinWorkspace(workspacePath, filePath);
      if (!pathValidation.valid) {
        return reply.code(403).send({ error: pathValidation.error });
      }

      const fullPath = pathValidation.resolvedPath!;

      const content = await fs.readFile(fullPath, 'utf-8');
      const stats = await fs.stat(fullPath);

      const ext = path.extname(filePath).toLowerCase();

      return {
        request_id: crypto.randomUUID(),
        elapsed_ms: 0,
        json: {
          content,
          language: LANGUAGE_MAP[ext] || 'text',
          line_count: content.split('\n').length,
          file_path: filePath,
        },
      };
    } catch (err) {
      server.log.error(err);
      return reply.code(404).send({
        error: 'File not found',
        message: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });

  // POST /v1/files/write - Write/create file
  server.post('/files/write', async (request, reply) => {
    if (!requireAuthIfEnabled(request, reply)) {
      return;
    }

    const { workspace_id, file_path, content, create_backup } = FileWriteSchema.parse(request.body);

    try {
      const workspaceValidation = await validateWorkspace(workspace_id);
      if (!workspaceValidation.valid) {
        return reply.code(404).send({ error: workspaceValidation.error });
      }

      const workspace = workspaceValidation.workspace;
      const workspacePath = workspace.identifier || `/workspace/${workspace_id}`;

      const pathValidation = await validatePathWithinWorkspace(workspacePath, file_path);
      if (!pathValidation.valid) {
        return reply.code(403).send({ error: pathValidation.error });
      }

      const fullPath = pathValidation.resolvedPath!;

      // Create backup if requested and file exists
      let backupPath: string | undefined;
      if (create_backup) {
        try {
          const stats = await fs.stat(fullPath);
          const backupDir = path.join(workspacePath, '.backups');
          await fs.mkdir(backupDir, { recursive: true });

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupFileName = `${path.basename(file_path)}.${timestamp}.bak`;
          backupPath = path.join(backupDir, backupFileName);

          await fs.copyFile(fullPath, backupPath);
        } catch {
          // File doesn't exist, no backup needed
        }
      }

      // Ensure directory exists
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // Write file
      await fs.writeFile(fullPath, content, 'utf-8');

      // Get diff if backup exists
      let diff: { old: string; new: string } | undefined;
      if (backupPath) {
        const oldContent = await fs.readFile(backupPath, 'utf-8');
        diff = { old: oldContent, new: content };
      }

      return {
        request_id: crypto.randomUUID(),
        elapsed_ms: 0,
        json: {
          success: true,
          backup_path: backupPath,
          diff,
        },
      };
    } catch (err) {
      server.log.error(err);
      return reply.code(500).send({
        error: 'Failed to write file',
        message: err instanceof Error ? err.message : 'Unknown error'
      });
    }
  });
}
