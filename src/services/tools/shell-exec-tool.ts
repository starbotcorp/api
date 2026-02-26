import type { ToolDefinition, ToolResult } from './types.js';
import { spawn } from 'child_process';
import * as path from 'path';

const TOOL_NAME = 'shell_exec';

const description = `Execute shell commands in the terminal. Use this to run build commands, tests, git operations, npm/yarn/pnpm commands, or any other command-line operations. Returns stdout, stderr, and exit code.`;

// Fix #3: Switch from blocklist to allowlist approach
const ALLOWED_COMMANDS = [
  /^npm\s+(install|run|test|build|lint|ci|update|outdated|audit)/,
  /^pnpm\s+(install|run|test|build|lint|ci|update|outdated|audit)/,
  /^yarn\s+(install|run|test|build|lint|upgrade|outdated)/,
  /^bun\s+(install|run|test|build|lint)/,
  /^git\s+(status|log|diff|branch|clone|pull|push|add|commit|checkout|merge|rebase|stash|fetch|tag|remote|init|restore|switch)/,
  /^node\s+[\w\-\.\/]+\.js$/,
  /^node\s+--/,
  /^python3?\s+[\w\-\.\/]+\.py$/,
  /^python3?\s+-m\s+[\w\.]+/,
  /^pip3?\s+(install|list|show|freeze|uninstall)/,
  /^cargo\s+(build|run|test|check|clippy|fmt|doc|clean|update)/,
  /^rustc\s+[\w\-\.\/]+\.rs$/,
  /^go\s+(build|run|test|mod|fmt|vet|doc|clean)/,
  /^make\s*$/,
  /^make\s+[\w\-]+$/,
  /^ls(\s+-[la]+)?$/,
  /^cat\s+[\w\-\.\/]+$/,
  /^echo\s+.+$/,
  /^mkdir\s+-p\s+[\w\-\.\/]+$/,
  /^touch\s+[\w\-\.\/]+$/,
  /^pwd$/,
  /^which\s+[\w\-\.\/]+$/,
  /^type\s+[\w\-\.\/]+$/,
  /^head\s+-n\s+\d+\s+[\w\-\.\/]+$/,
  /^tail\s+-n\s+\d+\s+[\w\-\.\/]+$/,
  /^wc(\s+-[lw]+)?\s+[\w\-\.\/]+$/,
  /^find\s+[\w\-\.\/]+\s+-name\s+.+$/,
  /^grep(\s+-[rinvE]+)?\s+.+\s+[\w\-\.\/]+$/,
  /^sed\s+-i?\s*['"].+['"]\s+[\w\-\.\/]+$/,
  /^awk\s+['"].+['"]\s+[\w\-\.\/]+$/,
  /^env$/,
  /^printenv\s*[\w]*$/,
  /^date$/,
  /^uname(\s+-a)?$/,
  /^curl\s+-[sS]\s+[\w\-\.\/:]+$/,
  /^tar\s+-[cxz][vf]+\s+[\w\-\.\/]+$/,
  /^unzip\s+[\w\-\.\/]+$/,
];

// Dangerous patterns that should never be allowed
const DANGEROUS_PATTERNS = [
  /[;&|`$()]/,           // Command chaining/injection
  /\.\./,                // Path traversal
  /[<>]/,                // Redirection
  /~|\$HOME|\$USER|\$PATH/, // Environment expansion
  /\\x[0-9a-fA-F]{2}/,   // Hex encoding
  /\\u[0-9a-fA-F]{4}/,   // Unicode encoding
  /\$\(/,                // Command substitution
  /\$\{/,                // Variable expansion
  /`/,                   // Backtick command substitution
  /\|\s*\w+/,            // Piping to other commands
  /&&/,                  // AND operator
  /\|\|/,                // OR operator
  /;/,                   // Command separator
];

interface ShellExecArgs {
  command: string;
  timeout?: number;
  cwd?: string;
}

function isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
  const trimmed = command.trim();

  // Check for dangerous patterns first
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `Dangerous pattern detected: ${pattern.source}` };
    }
  }

  // Check against allowlist
  for (const pattern of ALLOWED_COMMANDS) {
    if (pattern.test(trimmed)) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: 'Command not in allowlist' };
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

    // Fix #3: Use allowlist instead of blocklist
    const commandCheck = isCommandAllowed(command);
    if (!commandCheck.allowed) {
      return {
        success: false,
        content: JSON.stringify({
          error: 'Command not allowed for security reasons',
          reason: commandCheck.reason,
          command,
          hint: 'Only standard development commands (npm, git, build tools) are allowed. Contact admin if you need additional commands.',
        }),
      };
    }

    // Determine working directory
    const workspaceRoot = process.env.WORKSPACE_ROOT || process.cwd();
    let workingDir = workspaceRoot;

    if (cwd) {
      const resolvedCwd = path.resolve(workspaceRoot, cwd);
      // Prevent path traversal
      if (resolvedCwd.startsWith(workspaceRoot)) {
        workingDir = resolvedCwd;
      } else {
        return {
          success: false,
          content: JSON.stringify({
            error: 'Working directory outside workspace',
            cwd,
          }),
        };
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
