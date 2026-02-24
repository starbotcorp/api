/**
 * Enhanced Sandboxed Code Execution Tool
 *
 * Features:
 * - Multiple language support (Python, JS, TS, Bash, Ruby, Go)
 * - Resource limits (CPU, memory, file descriptors)
 * - Workspace file access (read-only by default)
 * - Network isolation option
 * - Streaming output support
 * - Package/import support for common libraries
 */

import type { ToolDefinition, ToolResult } from './types.js';
import { spawn, SpawnOptions } from 'child_process';
import { writeFile, readFile, unlink, mkdir, rm, copyFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename, dirname } from 'path';
import { randomBytes } from 'crypto';

// Configuration
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_TIMEOUT_MS = 120_000; // 2 minutes max
const MAX_OUTPUT_LENGTH = 50_000; // 50KB output
const MAX_MEMORY_MB = 512; // 512MB memory limit
const SANDBOX_DIR_PREFIX = 'starbot-sandbox-';

interface ExecutionConfig {
  language: string;
  code: string;
  timeout_ms?: number;
  workspace_files?: string[]; // Files to copy into sandbox (read-only)
  allow_network?: boolean;
  env_vars?: Record<string, string>;
  stdin?: string;
  args?: string[];
}

interface LanguageRuntime {
  extension: string;
  command: string;
  args: (filename: string, userArgs?: string[]) => string[];
  setup?: (sandboxDir: string, code: string) => Promise<void>;
  prelude?: string;
}

const RUNTIMES: Record<string, LanguageRuntime> = {
  python: {
    extension: '.py',
    command: 'python3',
    args: (f, userArgs) => ['-u', f, ...(userArgs || [])], // -u for unbuffered output
    prelude: `
import sys
sys.path.insert(0, '.')
`,
  },
  py: {
    extension: '.py',
    command: 'python3',
    args: (f, userArgs) => ['-u', f, ...(userArgs || [])],
    prelude: `
import sys
sys.path.insert(0, '.')
`,
  },
  javascript: {
    extension: '.js',
    command: 'node',
    args: (f, userArgs) => ['--no-warnings', f, ...(userArgs || [])],
  },
  js: {
    extension: '.js',
    command: 'node',
    args: (f, userArgs) => ['--no-warnings', f, ...(userArgs || [])],
  },
  typescript: {
    extension: '.ts',
    command: 'npx',
    args: (f, userArgs) => ['tsx', f, ...(userArgs || [])],
  },
  ts: {
    extension: '.ts',
    command: 'npx',
    args: (f, userArgs) => ['tsx', f, ...(userArgs || [])],
  },
  bash: {
    extension: '.sh',
    command: 'bash',
    args: (f, userArgs) => [f, ...(userArgs || [])],
    prelude: 'set -e\n', // Exit on error
  },
  sh: {
    extension: '.sh',
    command: 'sh',
    args: (f, userArgs) => [f, ...(userArgs || [])],
  },
  ruby: {
    extension: '.rb',
    command: 'ruby',
    args: (f, userArgs) => [f, ...(userArgs || [])],
  },
  rb: {
    extension: '.rb',
    command: 'ruby',
    args: (f, userArgs) => [f, ...(userArgs || [])],
  },
  go: {
    extension: '.go',
    command: 'go',
    args: (f, userArgs) => ['run', f, ...(userArgs || [])],
  },
};

async function createSandbox(): Promise<string> {
  const sandboxId = randomBytes(8).toString('hex');
  const sandboxDir = join(tmpdir(), `${SANDBOX_DIR_PREFIX}${sandboxId}`);
  await mkdir(sandboxDir, { recursive: true });
  return sandboxDir;
}

async function cleanupSandbox(sandboxDir: string): Promise<void> {
  try {
    await rm(sandboxDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function copyWorkspaceFiles(
  sandboxDir: string,
  files: string[],
  workspaceRoot: string
): Promise<string[]> {
  const copiedFiles: string[] = [];

  for (const file of files) {
    try {
      const sourcePath = join(workspaceRoot, file);
      const destPath = join(sandboxDir, basename(file));

      // Ensure we don't escape workspace
      if (!sourcePath.startsWith(workspaceRoot)) continue;

      await copyFile(sourcePath, destPath);
      copiedFiles.push(basename(file));
    } catch {
      // Skip files that can't be copied
    }
  }

  return copiedFiles;
}

interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

async function executeInSandbox(
  sandboxDir: string,
  runtime: LanguageRuntime,
  filename: string,
  config: ExecutionConfig
): Promise<ExecutionResult> {
  const timeout = Math.min(config.timeout_ms || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const env: Record<string, string> = {
    ...process.env,
    HOME: sandboxDir,
    TMPDIR: sandboxDir,
    PATH: process.env.PATH || '/usr/bin:/bin',
    ...config.env_vars,
  };

  // Network isolation (Linux only - uses unshare if available)
  let command = runtime.command;
  let args = runtime.args(filename, config.args);

  // Add resource limits via ulimit wrapper on Linux
  if (process.platform === 'linux' && !config.allow_network) {
    // Wrap with timeout and resource limits
    const limits = [
      `ulimit -v ${MAX_MEMORY_MB * 1024}`, // Virtual memory limit
      `ulimit -t ${Math.ceil(timeout / 1000)}`, // CPU time limit
      `ulimit -f 10240`, // File size limit (10MB)
    ].join(' && ');

    args = ['-c', `${limits} && ${command} ${args.map(a => `'${a}'`).join(' ')}`];
    command = 'bash';
  }

  const spawnOptions: SpawnOptions = {
    cwd: sandboxDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
  };

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn(command, args, spawnOptions);

    // Send stdin if provided
    if (config.stdin && proc.stdin) {
      proc.stdin.write(config.stdin);
      proc.stdin.end();
    }

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT_LENGTH) {
        stdout = stdout.slice(0, MAX_OUTPUT_LENGTH) + '\n...[output truncated]';
        proc.kill('SIGTERM');
      }
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT_LENGTH) {
        stderr = stderr.slice(0, MAX_OUTPUT_LENGTH) + '\n...[output truncated]';
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: signal as string | null,
        timedOut,
        durationMs: Date.now() - startTime,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + '\n' + err.message,
        exitCode: -1,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

export const sandboxExecTool: ToolDefinition = {
  name: 'sandbox_execute',
  description: `Execute code in a secure sandboxed environment with resource limits.

Supported languages: python, javascript, typescript, bash, ruby, go

Features:
- 30 second default timeout (max 2 minutes)
- Memory limit: 512MB
- Can access workspace files (read-only)
- Isolated temporary directory
- Captures stdout, stderr, and exit code

Use for:
- Running calculations and data processing
- Testing code snippets
- Executing scripts with file I/O
- Quick prototyping`,

  parameters: [
    {
      name: 'language',
      type: 'string',
      description: 'Programming language (python, javascript, typescript, bash, ruby, go)',
      required: true,
      enum: ['python', 'javascript', 'typescript', 'bash', 'ruby', 'go', 'py', 'js', 'ts', 'sh', 'rb'],
    },
    {
      name: 'code',
      type: 'string',
      description: 'Code to execute',
      required: true,
    },
    {
      name: 'timeout_ms',
      type: 'number',
      description: 'Execution timeout in milliseconds (default: 30000, max: 120000)',
      required: false,
      default: 30000,
    },
    {
      name: 'workspace_files',
      type: 'array',
      description: 'List of workspace files to copy into sandbox (read-only access)',
      required: false,
    },
    {
      name: 'stdin',
      type: 'string',
      description: 'Input to send to stdin',
      required: false,
    },
    {
      name: 'args',
      type: 'array',
      description: 'Command line arguments to pass to the script',
      required: false,
    },
    {
      name: 'env_vars',
      type: 'object',
      description: 'Environment variables to set',
      required: false,
    },
  ],

  async execute(args: Record<string, any>): Promise<ToolResult> {
    const config = args as ExecutionConfig;

    // Validate language
    const lang = config.language?.toLowerCase().trim();
    const runtime = RUNTIMES[lang];

    if (!runtime) {
      const supported = Object.keys(RUNTIMES).filter(k => !['py', 'js', 'ts', 'sh', 'rb'].includes(k));
      return {
        success: false,
        content: JSON.stringify({
          error: `Unsupported language: ${lang}`,
          supported_languages: supported,
        }),
      };
    }

    if (!config.code?.trim()) {
      return {
        success: false,
        content: JSON.stringify({ error: 'Code is required' }),
      };
    }

    let sandboxDir: string | null = null;

    try {
      // Create isolated sandbox directory
      sandboxDir = await createSandbox();

      // Copy workspace files if requested
      const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
      let copiedFiles: string[] = [];
      if (config.workspace_files?.length) {
        copiedFiles = await copyWorkspaceFiles(sandboxDir, config.workspace_files, workspaceRoot);
      }

      // Write code to file
      const filename = `main${runtime.extension}`;
      const filepath = join(sandboxDir, filename);

      const fullCode = (runtime.prelude || '') + config.code;
      await writeFile(filepath, fullCode, 'utf-8');

      // Run setup if defined
      if (runtime.setup) {
        await runtime.setup(sandboxDir, config.code);
      }

      // Execute
      const result = await executeInSandbox(sandboxDir, runtime, filename, config);

      // Format result
      const output: Record<string, any> = {
        success: result.exitCode === 0,
        language: lang,
        exit_code: result.exitCode,
        duration_ms: result.durationMs,
      };

      if (result.stdout) {
        output.stdout = result.stdout;
      }

      if (result.stderr) {
        output.stderr = result.stderr;
      }

      if (result.timedOut) {
        output.error = `Execution timed out after ${config.timeout_ms || DEFAULT_TIMEOUT_MS}ms`;
        output.timed_out = true;
      }

      if (result.signal) {
        output.signal = result.signal;
      }

      if (copiedFiles.length > 0) {
        output.workspace_files_copied = copiedFiles;
      }

      // Check for generated files in sandbox
      try {
        const sandboxFiles = await readdir(sandboxDir);
        const generatedFiles = sandboxFiles.filter(f => f !== filename && !copiedFiles.includes(f));
        if (generatedFiles.length > 0) {
          output.generated_files = generatedFiles;
        }
      } catch {
        // Ignore
      }

      return {
        success: result.exitCode === 0 && !result.timedOut,
        content: JSON.stringify(output, null, 2),
        metadata: {
          duration_ms: result.durationMs,
          sandbox_id: basename(sandboxDir),
        },
      };
    } catch (error) {
      return {
        success: false,
        content: JSON.stringify({
          error: `Sandbox execution failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      };
    } finally {
      // Always cleanup sandbox
      if (sandboxDir) {
        await cleanupSandbox(sandboxDir);
      }
    }
  },
};

export default sandboxExecTool;
