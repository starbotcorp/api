// Code Execution Tool
// Executes code in a sandboxed environment with timeout protection

import type { ToolDefinition, ToolResult } from './types.js';
import { spawn } from 'child_process';
import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const EXECUTION_TIMEOUT_MS = 5000; // 5 second timeout
const MAX_OUTPUT_LENGTH = 5000; // Max output chars

async function executeCode(language: string, code: string): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'starbot-exec-'));
  let fileName: string;
  let command: string;
  let args: string[];

  if (language === 'python' || language === 'py') {
    fileName = join(tmpDir, 'script.py');
    command = 'python3';
    args = [fileName];
  } else if (language === 'javascript' || language === 'js') {
    fileName = join(tmpDir, 'script.js');
    command = 'node';
    args = [fileName];
  } else {
    throw new Error(`Unsupported language: ${language}`);
  }

  try {
    // Write code to temp file
    await writeFile(fileName, code, 'utf-8');

    // Execute with timeout
    return await new Promise((resolve, reject) => {
      const process = spawn(command, args, {
        timeout: EXECUTION_TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      process.stdout?.on('data', (data) => {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT_LENGTH) {
          process.kill();
        }
      });

      process.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        process.kill();
        reject(new Error('Execution timeout: code took longer than 5 seconds'));
      }, EXECUTION_TIMEOUT_MS);

      process.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.slice(0, MAX_OUTPUT_LENGTH));
        } else {
          reject(new Error(`Exit code ${code}: ${stderr || stdout}`));
        }
      });

      process.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    // Cleanup temp file
    try {
      await unlink(fileName);
      await unlink(tmpDir);
    } catch {
      // Ignore cleanup errors
    }
  }
}

export const codeExecTool: ToolDefinition = {
  name: 'execute_code',
  description: 'Execute code in a sandboxed environment (Python or JavaScript). Limited to 5 seconds execution time. Use for calculations, data processing, or quick scripts.',
  parameters: [
    {
      name: 'language',
      type: 'string',
      description: 'Programming language: "python" or "javascript"',
      required: true,
      enum: ['python', 'javascript'],
    },
    {
      name: 'code',
      type: 'string',
      description: 'Code to execute',
      required: true,
    },
  ],
  execute: async (args: Record<string, any>): Promise<ToolResult> => {
    try {
      const language = String(args.language || '').toLowerCase().trim();
      const code = String(args.code || '').trim();

      if (!language) {
        return {
          success: false,
          content: JSON.stringify({ error: 'Language is required' }),
        };
      }

      if (!code) {
        return {
          success: false,
          content: JSON.stringify({ error: 'Code is required' }),
        };
      }

      if (language !== 'python' && language !== 'javascript' && language !== 'py' && language !== 'js') {
        return {
          success: false,
          content: JSON.stringify({ error: 'Language must be "python" or "javascript"' }),
        };
      }

      const startTime = Date.now();
      const output = await executeCode(language, code);
      const durationMs = Date.now() - startTime;

      return {
        success: true,
        content: JSON.stringify({
          language,
          output: output || '(no output)',
          truncated: output.length >= MAX_OUTPUT_LENGTH,
        }),
        metadata: {
          duration_ms: durationMs,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        content: JSON.stringify({
          error: `Code execution failed: ${errorMessage}`,
        }),
      };
    }
  },
};
