#!/usr/bin/env node
// Simple API TUI - Server management tool
// Shows API status and allows start/stop/restart

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';

const execAsync = promisify(exec);

const API_PORT = 3737;
const API_DIR = process.cwd();

let apiProcess: ReturnType<typeof spawn> | null = null;

async function checkApiRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`lsof -i :${API_PORT} -sTCP:LISTEN -t`);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function getApiPid(): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`lsof -i :${API_PORT} -sTCP:LISTEN -t`);
    const pid = parseInt(stdout.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function killPort(): Promise<void> {
  const pid = await getApiPid();
  if (pid) {
    console.log(`\nKilling process on port ${API_PORT} (PID: ${pid})...`);
    try {
      process.kill(pid, 'SIGKILL');
      await new Promise(r => setTimeout(r, 1000));
      console.log('Port freed.');
    } catch (e) {
      console.log('Failed to kill process:', e);
    }
  }
}

async function stopApi(): Promise<void> {
  const pid = await getApiPid();
  if (pid) {
    console.log(`\nStopping API (PID: ${pid})...`);
    try {
      process.kill(pid, 'SIGTERM');
      await new Promise(r => setTimeout(r, 2000));
      // Force kill if still running
      const stillRunning = await checkApiRunning();
      if (stillRunning) {
        process.kill(pid, 'SIGKILL');
      }
      console.log('API stopped.');
    } catch (e) {
      console.log('Failed to stop API:', e);
    }
  } else {
    console.log('\nAPI is not running.');
  }
}

async function startApi(): Promise<void> {
  const running = await checkApiRunning();
  if (running) {
    const pid = await getApiPid();
    console.log(`\nAPI is already running (PID: ${pid}).`);
    return;
  }

  console.log('\nStarting API...');
  apiProcess = spawn('npm', ['run', 'dev'], {
    cwd: API_DIR,
    stdio: 'inherit',
    shell: true,
  });

  // Wait for API to be ready
  await new Promise(r => setTimeout(r, 3000));
  console.log('API started.');
}

async function restartApi(): Promise<void> {
  console.log('\nRestarting API...');
  await killPort();
  await new Promise(r => setTimeout(r, 1000));
  await startApi();
}

function drawHeader() {
  console.clear();
  console.log('╔════════════════════════════════════════╗');
  console.log('║         Starbot API Manager            ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
}

async function showStatus() {
  const running = await checkApiRunning();
  const pid = await getApiPid();

  console.log('┌────────────────────────────────────────┐');
  console.log('│  Status: ' + (running ? '🟢 Running  ' : '🔴 Stopped'));
  if (running && pid) {
    console.log('│  PID:    ' + pid.toString().padEnd(34));
  }
  console.log('│  Port:   ' + API_PORT.toString().padEnd(34));
  console.log('│  URL:    http://localhost:' + API_PORT + '/v1'.padEnd(26));
  console.log('└────────────────────────────────────────┘');
  console.log('');
}

function showMenu() {
  console.log('┌────────────────────────────────────────┐');
  console.log('│  [s] Start API                         │');
  console.log('│  [x] Stop API                          │');
  console.log('│  [k] Kill port (force stop)            │');
  console.log('│  [r] Restart API                       │');
  console.log('│  [t] Test API (curl health)            │');
  console.log('│  [q] Quit                              │');
  console.log('└────────────────────────────────────────┘');
  console.log('');
}

async function testApi(): Promise<void> {
  try {
    const { stdout } = await execAsync('curl -s http://localhost:3737/v1/health');
    console.log('\n✓ API Health Response:');
    console.log(stdout);
  } catch (e) {
    console.log('\n✗ API is not responding');
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> => {
    return new Promise(resolve => rl.question(prompt, resolve));
  };

  while (true) {
    drawHeader();
    await showStatus();
    showMenu();

    const choice = await question('Choose: ');

    switch (choice.toLowerCase()) {
      case 's':
        await startApi();
        break;
      case 'x':
        await stopApi();
        break;
      case 'k':
        await killPort();
        break;
      case 'r':
        await restartApi();
        break;
      case 't':
        await testApi();
        break;
      case 'q':
        rl.close();
        process.exit(0);
    }

    await question('\nPress Enter to continue...');
  }
}

main().catch(console.error);
