/**
 * Process runner — spawns and tracks demo/test processes.
 * Resolves 1Password credentials before launch (same flow as mcp-launcher.js).
 * Output is captured to temp files for live tailing by the dashboard.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
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

// ============================================================================
// Credential Resolution (mirrors mcp-launcher.js flow)
// ============================================================================

/** Infrastructure credentials that must NOT leak to child processes */
const INFRA_CRED_KEYS = new Set([
  'OP_SERVICE_ACCOUNT_TOKEN',
  'RENDER_API_KEY',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);

let _resolvedCredentials: Record<string, string> | null = null;

/**
 * Resolve credentials from vault-mappings.json + protected-actions.json.
 * Cached after first call (secrets don't change during a dashboard session).
 */
function resolvePlaywrightCredentials(): Record<string, string> {
  if (_resolvedCredentials) return _resolvedCredentials;
  _resolvedCredentials = {};

  // Read vault mappings (op:// references and direct values)
  const mappingsPath = path.join(PROJECT_DIR, '.claude', 'vault-mappings.json');
  let mappings: Record<string, string> = {};
  try {
    const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    mappings = data.mappings || {};
  } catch { return _resolvedCredentials; }

  // Read which keys the Playwright server needs
  const actionsPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');
  let credentialKeys: string[] = [];
  try {
    const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    credentialKeys = actions.servers?.playwright?.credentialKeys || [];
  } catch { return _resolvedCredentials; }

  // Get OP token (env → launchd plist fallback)
  let opToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!opToken) {
    try {
      // Read from .mcp.json playwright env (same location as the MCP server uses)
      const mcpPath = path.join(PROJECT_DIR, '.mcp.json');
      const mcpData = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      opToken = mcpData?.mcpServers?.playwright?.env?.OP_SERVICE_ACCOUNT_TOKEN;
    } catch { /* */ }
  }

  for (const key of credentialKeys) {
    const ref = mappings[key];
    if (!ref) continue;

    if (ref.startsWith('op://')) {
      // Resolve from 1Password
      if (!opToken) continue;
      try {
        _resolvedCredentials[key] = execFileSync('op', ['read', ref], {
          encoding: 'utf-8',
          timeout: 15000,
          env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: opToken },
        }).trim();
      } catch { /* non-fatal: demo will fail with a clear error */ }
    } else {
      // Direct value (e.g., SUPABASE_URL is just a URL, not an op:// ref)
      _resolvedCredentials[key] = ref;
    }
  }

  // Also load demoDevModeEnv from services.json
  try {
    const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    const config = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
    if (config.demoDevModeEnv) {
      Object.assign(_resolvedCredentials, config.demoDevModeEnv);
    }
  } catch { /* */ }

  return _resolvedCredentials;
}

/**
 * Build a clean environment for demo child processes.
 * Strips infra creds, injects resolved 1Password secrets.
 */
function buildDemoEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const key of INFRA_CRED_KEYS) delete env[key];

  // Inject resolved credentials
  Object.assign(env, resolvePlaywrightCredentials());

  // Supabase NEXT_PUBLIC_ convenience mapping
  if (env.SUPABASE_URL && !env.NEXT_PUBLIC_SUPABASE_URL) env.NEXT_PUBLIC_SUPABASE_URL = env.SUPABASE_URL;
  if (env.SUPABASE_ANON_KEY && !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;

  env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
  if (extra) Object.assign(env, extra);
  return env;
}

export function launchDemo(scenario: DemoScenarioItem): RunningProcess {
  const outputFile = makeOutputFile('demo', scenario.id);
  const fd = fs.openSync(outputFile, 'a');

  const cmdArgs = ['playwright', 'test', scenario.testFile, '--project', scenario.playwrightProject, '--headed', '--reporter', 'list'];

  const child = spawn('npx', cmdArgs, {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: PROJECT_DIR,
    env: buildDemoEnv({
      DEMO_HEADED: '1',
      DEMO_SLOW_MO: '800',
      DEMO_SHOW_CURSOR: '1',
      DEMO_MAXIMIZE: '1',
    }),
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

  let cmdArgs: string[];
  if (testFile.runner === 'vitest') {
    cmdArgs = ['vitest', 'run', testFile.filePath, '--reporter', 'verbose'];
  } else if (testFile.runner === 'jest') {
    cmdArgs = ['jest', testFile.filePath, '--verbose'];
  } else {
    cmdArgs = ['playwright', 'test', testFile.filePath, '--project', testFile.project, '--reporter', 'list'];
  }

  const child = spawn('npx', cmdArgs, {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: PROJECT_DIR,
    env: buildDemoEnv(),
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
