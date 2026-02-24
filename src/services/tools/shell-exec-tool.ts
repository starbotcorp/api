import type { ToolDefinition, ToolResult } from './types.js';
import { spawn } from 'child_process';
import * as path from 'path';

const TOOL_NAME = 'shell_exec';

const description = `Execute shell commands in the terminal. Use this to run build commands, tests, git operations, npm/yarn/pnpm commands, or any other command-line operations. Returns stdout, stderr, and exit code.`;

// Blocked commands for security
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf /*',
  'mkfs',
  'dd if=',
  ':(){:|:&};:', // Fork bomb
  'chmod 777 /',
  'chown -R',
  '> /dev/sda',
  'wget | sh',
  'curl | sh',
];

// Commands that require confirmation or are high-risk
const WARN_COMMANDS = [
  'rm -rf',
  'rm -r',
  'del ',
  'format',
  'shutdown',
  'reboot',
  'halt',
  'init 0',
  'init 6',
];

interface ShellExecArgs {
  command: string;
  timeout?: number;
  cwd?: string;
}

function isCommandBlocked(command: string): boolean {
  const lower = command.toLowerCase().trim();
  return BLOCKED_COMMANDS.some(blocked => lower.includes(blocked));
}

function isCommandWarnable(command: string): boolean {
  const lower = command.toLowerCase().trim();
  return WARN_COMMANDS.some(warn => lower.startsWith(warn) || lower.includes(` ${warn}`));
}

export const shellExecTool: ToolDefinition = {
  name: TOOL_NAME,
  description,
  parameters: [
    {
      name: 'command',
      type: 'string',
      description: 'Shell command to execute (e.g., "npm run build", "git status", "python script.py")',
      required: true,
    },
    {
      name: 'timeout',
      type: 'number',
      description: 'Maximum execution time in seconds (default: 30, max: 120)',
      required: false,
      default: 30,
    },
    {
      name: 'cwd',
      type: 'string',
      description: 'Working directory for command (relative to workspace, default: workspace root)',
      required: false,
    },
  ],

  async execute(args: Record<string, any>): Promise<ToolResult> {
    const { command, timeout = 30, cwd } = args as ShellExecArgs;

    // Validate timeout
    const safeTimeout = Math.min(Math.max(1, timeout), 120);

    // Security check
    if (isCommandBlocked(command)) {
      return {
        success: false,
        content: JSON.stringify({
          error: 'Command blocked for security reasons',
          blocked: true,
        }),
      };
    }

    // Warn about dangerous commands but still execute
    const isWarnable = isCommandWarnable(command);

    // Determine working directory
    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
    let workingDir = workspaceRoot;

    if (cwd) {
      const resolvedCwd = path.resolve(workspaceRoot, cwd);
      if (resolvedCwd.startsWith(workspaceRoot)) {
        workingDir = resolvedCwd;
      }
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      // Determine shell based on platform
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/bash';
      const shellArgs = isWindows ? ['/c', command] : ['-c', command];

      const child = spawn(shell, shellArgs, {
        cwd: workingDir,
        env: {
          ...process.env,
          // Limit environment variables for security
          HOME: workingDir,
          PATH: process.env.PATH?.split(':').filter(p => !p.startsWith('/usr/bin')).join(':') || '/usr/local/bin:/usr/bin:/bin',
        },
        timeout: safeTimeout * 1000,
      });

      const timeoutHandle = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
        stderr += `\n\n[TIMEOUT] Command exceeded ${safeTimeout} seconds and was killed`;
      }, safeTimeout * 1000);

      child.stdout?.on('data', (data) => {
        const chunk = data.toString();
        // Limit stdout size
        if (stdout.length + chunk.length < 100000) {
          stdout += chunk;
        } else if (stdout.length < 100000) {
          stdout += chunk.slice(0, 100000 - stdout.length);
          stdout += '\n[OUTPUT TRUNCATED]';
        }
      });

      child.stderr?.on('data', (data) => {
        const chunk = data.toString();
        // Limit stderr size
        if (stderr.length + chunk.length < 50000) {
          stderr += chunk;
        }
      });

      child.on('close', (code) => {
        clearTimeout(timeoutHandle);

        const result = {
          command,
          cwd: workingDir,
          exit_code: code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          killed,
          warning: isWarnable ? 'Command may be destructive - executed with caution' : undefined,
        };

        resolve({
          success: code === 0 || !killed,
          content: JSON.stringify(result),
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeoutHandle);
        resolve({
          success: false,
          content: JSON.stringify({
            error: `Command execution failed: ${error.message}`,
            command,
            cwd: workingDir,
          }),
        });
      });
    });
  },
};

export default shellExecTool;
