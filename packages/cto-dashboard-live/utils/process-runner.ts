/**
 * Process runner — spawns and tracks Playwright demo/test processes.
 * Output is captured to temp files for live tailing by the dashboard.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { DemoScenarioItem, TestFileItem, RunningProcess } from '../types.js';
import { isProcessAlive } from '../live-reader.js';

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());

function ensureStateDir(): string {
  const dir = path.join(PROJECT_DIR, '.claude', 'state');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeOutputFile(prefix: string, id: string): string {
  const stateDir = ensureStateDir();
  return path.join(stateDir, `dashboard-run-${prefix}-${id}-${Date.now()}.log`);
}

export function launchDemo(scenario: DemoScenarioItem): RunningProcess {
  const outputFile = makeOutputFile('demo', scenario.id);
  const fd = fs.openSync(outputFile, 'a');

  const cmdArgs = ['playwright', 'test', scenario.testFile, '--project', scenario.playwrightProject, '--headed', '--reporter', 'list'];

  const child = spawn('npx', cmdArgs, {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      DEMO_HEADED: '1',
      DEMO_SLOW_MO: '800',
    },
  });
  child.unref();

  try { fs.closeSync(fd); } catch { /* */ }

  return {
    pid: child.pid!,
    label: scenario.title,
    type: 'demo',
    status: 'running',
    startedAt: new Date().toISOString(),
    outputFile,
    exitCode: null,
  };
}

export function launchTest(testFile: TestFileItem): RunningProcess {
  const outputFile = makeOutputFile('test', testFile.fileName.replace(/\.ts$/, ''));
  const fd = fs.openSync(outputFile, 'a');

  const cmdArgs = ['playwright', 'test', testFile.filePath, '--project', testFile.project, '--reporter', 'list'];

  const child = spawn('npx', cmdArgs, {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
    },
  });
  child.unref();

  try { fs.closeSync(fd); } catch { /* */ }

  return {
    pid: child.pid!,
    label: `${testFile.project}/${testFile.fileName}`,
    type: 'test',
    status: 'running',
    startedAt: new Date().toISOString(),
    outputFile,
    exitCode: null,
  };
}

export function checkProcess(proc: RunningProcess): RunningProcess {
  if (proc.status !== 'running') return proc;
  if (isProcessAlive(proc.pid)) return proc;

  // Process is dead — determine result from output
  let exitCode: number | null = null;
  try {
    const output = fs.readFileSync(proc.outputFile, 'utf8');
    if (output.includes('passed') && !output.includes('failed')) exitCode = 0;
    else if (output.includes('failed')) exitCode = 1;
  } catch { /* */ }

  return {
    ...proc,
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
  };
}

export function killProcess(proc: RunningProcess): void {
  if (!isProcessAlive(proc.pid)) return;
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try { process.kill(proc.pid, 'SIGTERM'); } catch { /* */ }
  }
}
