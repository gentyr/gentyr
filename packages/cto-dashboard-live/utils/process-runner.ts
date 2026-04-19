/**
 * Process runner — spawns and tracks demo/test processes.
 * Resolves 1Password credentials from services.json secrets.local (same flow
 * as the Playwright MCP server's run_demo pipeline).
 * Executes registered prerequisites and ensures dev server is running before
 * launching demos, matching run_demo behavior exactly.
 * Output is captured to temp files for live tailing by the dashboard.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import type { DemoScenarioItem, TestFileItem, RunningProcess } from '../types.js';
import { isProcessAlive } from '../live-reader.js';
import { preemptForCtoDashboardDemo, releaseCtoDashboardDemo } from './display-lock-manager.js';

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

/** Write a preflight status line to the output file */
function logPreflight(fd: number, msg: string): void {
  try { fs.writeSync(fd, `[preflight] ${msg}\n`); } catch { /* */ }
}

// ============================================================================
// Credential Resolution — services.json secrets.local (matches run_demo)
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
 * Retrieve the OP service account token from the environment or .mcp.json fallback.
 * Returns undefined if unavailable.
 */
function getOpToken(): string | undefined {
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) return process.env.OP_SERVICE_ACCOUNT_TOKEN;
  try {
    const mcpPath = path.join(PROJECT_DIR, '.mcp.json');
    const mcpData = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    return mcpData?.mcpServers?.playwright?.env?.OP_SERVICE_ACCOUNT_TOKEN as string | undefined;
  } catch { return undefined; }
}

/**
 * Resolve any op:// references in an env var map using the dashboard's OP token.
 * Non-op:// values are passed through unchanged.
 * Resolution failures are non-fatal: the key is still included with its raw value
 * so the demo can start and produce a clear auth error rather than silently skipping vars.
 */
function resolveOpEnvVars(envVars: Record<string, string>): Record<string, string> {
  const opToken = getOpToken();
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof value === 'string' && value.startsWith('op://')) {
      if (!opToken) {
        resolved[key] = value;
        continue;
      }
      try {
        resolved[key] = execFileSync('op', ['read', value], {
          encoding: 'utf-8',
          timeout: 15000,
          env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: opToken },
        }).trim();
      } catch {
        resolved[key] = value;
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/** Load services.json from the project directory. Returns null on failure. */
function loadServicesConfig(): Record<string, unknown> | null {
  try {
    const configPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch { return null; }
}

/**
 * Resolve credentials from services.json secrets.local — same source as run_demo.
 * FAIL-CLOSED: throws if any op:// reference fails to resolve (G001).
 * Cached after first call (secrets don't change during a dashboard session).
 */
function resolveServicesSecrets(): Record<string, string> {
  if (_resolvedCredentials) return _resolvedCredentials;
  _resolvedCredentials = {};

  const config = loadServicesConfig();
  if (!config) return _resolvedCredentials;

  const secrets = config.secrets as Record<string, unknown> | undefined;
  const localSecrets = (secrets?.local || {}) as Record<string, string>;
  const opToken = getOpToken();
  const failedKeys: string[] = [];

  for (const [key, ref] of Object.entries(localSecrets)) {
    if (typeof ref === 'string' && ref.startsWith('op://')) {
      if (!opToken) {
        failedKeys.push(`${key}: OP_SERVICE_ACCOUNT_TOKEN not available`);
        continue;
      }
      try {
        _resolvedCredentials[key] = execFileSync('op', ['read', ref], {
          encoding: 'utf-8',
          timeout: 15000,
          env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: opToken },
        }).trim();
      } catch (err) {
        failedKeys.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (typeof ref === 'string') {
      _resolvedCredentials[key] = ref;
    }
  }

  if (failedKeys.length > 0) {
    _resolvedCredentials = null;
    throw new Error(`Failed to resolve credentials:\n  ${failedKeys.join('\n  ')}`);
  }

  return _resolvedCredentials;
}

/** Cached services config for demoDevModeEnv — applied only when dev server is ready */
function getDemoDevModeEnv(): Record<string, string> {
  const config = loadServicesConfig();
  return (config?.demoDevModeEnv as Record<string, string> | undefined) || {};
}

// ============================================================================
// Dev Server Health Check + Auto-Start (matches run_demo pipeline)
// ============================================================================

/** Check if a URL responds with HTTP 2xx/3xx */
async function isDevServerHealthy(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(baseUrl);
      const req = http.request(
        { hostname: url.hostname, port: url.port || 80, path: '/', method: 'GET', timeout: 5000 },
        (res) => { res.resume(); resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400); },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

/** Poll a URL until it responds healthy or timeout */
async function pollDevServerHealth(baseUrl: string, timeoutMs: number = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));
    if (await isDevServerHealthy(baseUrl)) return true;
  }
  return false;
}

/**
 * Ensure the dev server is running. Tries devServices from services.json first,
 * then falls back to `pnpm run dev`. Mirrors attemptDevServerAutoStart() in the
 * Playwright MCP server.
 */
async function ensureDashboardDevServer(
  baseUrl: string,
  resolvedEnv: Record<string, string>,
  fd?: number,
): Promise<boolean> {
  if (await isDevServerHealthy(baseUrl)) return true;

  const config = loadServicesConfig();
  const childEnv = { ...process.env as Record<string, string>, ...resolvedEnv };
  for (const key of INFRA_CRED_KEYS) delete childEnv[key];

  const url = new URL(baseUrl);
  const port = url.port || '3000';
  childEnv.PORT = port;

  // Strategy 1: Start from services.json devServices
  const devServices = config?.devServices as Record<string, Record<string, unknown>> | undefined;
  if (devServices && Object.keys(devServices).length > 0) {
    if (fd) logPreflight(fd, `Starting dev services from services.json...`);
    const webNames = new Set(['web', 'app', 'frontend', 'client', 'next', 'vite']);
    const startedPids: Array<{ name: string; pid: number }> = [];

    for (const [name, svc] of Object.entries(devServices)) {
      const filter = svc.filter as string | undefined;
      const command = svc.command as string | undefined;
      const svcPort = svc.port as number | undefined;
      if (!filter || !command) continue;

      const svcEnv = { ...childEnv };
      // Use worktree port override for web services, or config port
      if (process.env.PLAYWRIGHT_WEB_PORT && (webNames.has(name.toLowerCase()) || startedPids.length === 0)) {
        svcEnv.PORT = process.env.PLAYWRIGHT_WEB_PORT;
      } else if (svcPort) {
        svcEnv.PORT = String(svcPort);
      }

      try {
        const child = spawn('pnpm', ['--filter', filter, 'run', command], {
          detached: true, stdio: 'ignore', cwd: PROJECT_DIR, env: svcEnv,
        });
        child.unref();
        if (child.pid) startedPids.push({ name, pid: child.pid });
      } catch { /* non-fatal */ }
    }

    if (startedPids.length > 0) {
      if (fd) logPreflight(fd, `Waiting for dev server at ${baseUrl}...`);
      if (await pollDevServerHealth(baseUrl, 30_000)) {
        if (fd) logPreflight(fd, `Dev server healthy`);
        return true;
      }
      // Kill orphaned processes
      for (const { pid } of startedPids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* */ }
      }
    }
  }

  // Strategy 2: Fallback — pnpm run dev
  if (fd) logPreflight(fd, `Trying fallback: pnpm run dev on port ${port}...`);
  try {
    const child = spawn('pnpm', ['run', 'dev'], {
      detached: true, stdio: 'ignore', cwd: PROJECT_DIR,
      env: { ...childEnv, PORT: port },
    });
    child.unref();
  } catch { /* */ }

  const healthy = await pollDevServerHealth(baseUrl, 30_000);
  if (fd && healthy) logPreflight(fd, `Dev server healthy`);
  return healthy;
}

// ============================================================================
// Prerequisite Execution (matches run_demo pipeline)
// ============================================================================

interface PrerequisiteRow {
  id: string;
  command: string;
  description: string;
  timeout_ms: number;
  health_check: string | null;
  health_check_timeout_ms: number;
  scope: string;
  run_as_background: number;
}

/**
 * Execute registered demo prerequisites from user-feedback.db.
 * Mirrors executePrerequisites() in the Playwright MCP server.
 */
async function executeDashboardPrerequisites(
  scenarioId: string,
  baseUrl: string,
  resolvedEnv: Record<string, string>,
  fd?: number,
): Promise<{ success: boolean; message: string }> {
  const dbPath = path.join(PROJECT_DIR, '.claude', 'state', 'user-feedback.db');
  if (!fs.existsSync(dbPath)) return { success: true, message: 'No user-feedback.db' };

  let db: InstanceType<typeof Database>;
  try { db = new Database(dbPath, { readonly: true }); }
  catch { return { success: true, message: 'Cannot open user-feedback.db' }; }

  try {
    // Check table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='demo_prerequisites'",
    ).get() as { name: string } | undefined;
    if (!tableCheck) return { success: true, message: 'No prerequisites table' };

    // Resolve persona_id from scenario_id
    let personaId: string | undefined;
    if (scenarioId) {
      const scenario = db.prepare('SELECT persona_id FROM demo_scenarios WHERE id = ?').get(scenarioId) as { persona_id: string } | undefined;
      if (scenario) personaId = scenario.persona_id;
    }

    // Query prerequisites: global + persona + scenario, ordered by scope then sort_order
    const scopeConditions: string[] = ["scope = 'global'"];
    const params: string[] = [];
    if (personaId) {
      scopeConditions.push("(scope = 'persona' AND persona_id = ?)");
      params.push(personaId);
    }
    if (scenarioId) {
      scopeConditions.push("(scope = 'scenario' AND scenario_id = ?)");
      params.push(scenarioId);
    }

    const query = `SELECT * FROM demo_prerequisites WHERE enabled = 1 AND (${scopeConditions.join(' OR ')}) ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'persona' THEN 1 WHEN 'scenario' THEN 2 END, sort_order ASC`;
    const prerequisites = db.prepare(query).all(...params) as PrerequisiteRow[];

    if (prerequisites.length === 0) return { success: true, message: 'No prerequisites' };
    if (fd) logPreflight(fd, `Executing ${prerequisites.length} prerequisite(s)...`);

    // Build env for prerequisite commands
    const childEnv = { ...process.env as Record<string, string>, ...resolvedEnv };
    for (const key of INFRA_CRED_KEYS) delete childEnv[key];
    const port = new URL(baseUrl).port || '3000';
    childEnv.PORT = port;
    childEnv.PLAYWRIGHT_BASE_URL = baseUrl;
    childEnv.CLAUDE_PROJECT_DIR = PROJECT_DIR;

    for (const prereq of prerequisites) {
      // Run health check first — skip if passing
      if (prereq.health_check) {
        try {
          execFileSync('bash', ['-c', prereq.health_check], {
            encoding: 'utf8',
            timeout: prereq.health_check_timeout_ms || 10_000,
            env: childEnv,
            cwd: PROJECT_DIR,
          });
          if (fd) logPreflight(fd, `  [skip] ${prereq.description} (healthy)`);
          continue;
        } catch { /* health check failed — run command */ }
      }

      if (prereq.run_as_background) {
        // Background prerequisite — spawn detached and poll health
        if (fd) logPreflight(fd, `  [bg]   ${prereq.description}...`);
        const child = spawn('bash', ['-c', prereq.command], {
          detached: true, stdio: 'ignore', cwd: PROJECT_DIR, env: childEnv,
        });
        child.unref();

        if (prereq.health_check) {
          const pollStart = Date.now();
          const timeout = prereq.health_check_timeout_ms || 30_000;
          let healthy = false;
          while (Date.now() - pollStart < timeout) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              execFileSync('bash', ['-c', prereq.health_check], {
                encoding: 'utf8', timeout: 5000, env: childEnv, cwd: PROJECT_DIR,
              });
              healthy = true;
              break;
            } catch { /* keep polling */ }
          }
          if (!healthy) {
            const msg = `Background prerequisite "${prereq.description}" health check timed out`;
            if (fd) logPreflight(fd, `  [FAIL] ${msg}`);
            return { success: false, message: msg };
          }
          if (fd) logPreflight(fd, `  [ok]   ${prereq.description} (healthy)`);
        }
      } else {
        // Foreground prerequisite — run synchronously
        if (fd) logPreflight(fd, `  [run]  ${prereq.description}...`);
        try {
          execFileSync('bash', ['-c', prereq.command], {
            encoding: 'utf8',
            timeout: prereq.timeout_ms || 120_000,
            env: childEnv,
            cwd: PROJECT_DIR,
          });
          if (fd) logPreflight(fd, `  [ok]   ${prereq.description}`);
        } catch (err) {
          const msg = `Prerequisite "${prereq.description}" failed: ${err instanceof Error ? err.message : String(err)}`;
          if (fd) logPreflight(fd, `  [FAIL] ${msg}`);
          return { success: false, message: msg };
        }
      }
    }

    return { success: true, message: `${prerequisites.length} prerequisite(s) executed` };
  } finally {
    try { db.close(); } catch { /* */ }
  }
}

// ============================================================================
// Build Demo Environment
// ============================================================================

/**
 * Build a clean environment for demo child processes.
 * Strips infra creds, injects resolved 1Password secrets from services.json.
 * demoDevModeEnv is only applied when dev_server_ready=true (matches canonical pipeline).
 */
function buildDemoEnv(opts?: { extra?: Record<string, string>; dev_server_ready?: boolean }): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const key of INFRA_CRED_KEYS) delete env[key];

  // Inject resolved credentials from services.json secrets.local
  try { Object.assign(env, resolveServicesSecrets()); } catch { /* caller handles */ }

  // Apply demoDevModeEnv only when dev server is confirmed healthy
  if (opts?.dev_server_ready) {
    Object.assign(env, getDemoDevModeEnv());
  }

  // Supabase NEXT_PUBLIC_ convenience mapping
  if (env.SUPABASE_URL && !env.NEXT_PUBLIC_SUPABASE_URL) env.NEXT_PUBLIC_SUPABASE_URL = env.SUPABASE_URL;
  if (env.SUPABASE_ANON_KEY && !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;

  env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

  // Pass through port env vars from worktree allocation
  if (process.env.PLAYWRIGHT_WEB_PORT) env.PLAYWRIGHT_WEB_PORT = process.env.PLAYWRIGHT_WEB_PORT;
  if (process.env.PLAYWRIGHT_BACKEND_PORT) env.PLAYWRIGHT_BACKEND_PORT = process.env.PLAYWRIGHT_BACKEND_PORT;
  if (process.env.PLAYWRIGHT_BRIDGE_PORT) env.PLAYWRIGHT_BRIDGE_PORT = process.env.PLAYWRIGHT_BRIDGE_PORT;

  // Auto-inject Playwright setup (interrupt + cursor highlight) via --import
  const autoSetupPath = path.resolve(PROJECT_DIR, '.claude/hooks/lib/playwright-auto-setup.mjs');
  try {
    fs.accessSync(autoSetupPath);
    if (!(env.NODE_OPTIONS || '').includes('playwright-auto-setup')) {
      env.NODE_OPTIONS = ((env.NODE_OPTIONS || '') + ` --import "${autoSetupPath}"`).trim();
    }
  } catch { /* auto-setup not available — skip */ }

  if (opts?.extra) Object.assign(env, opts.extra);
  return env;
}

// ============================================================================
// Demo Launch — full run_demo pipeline parity
// ============================================================================

export async function launchDemo(scenario: DemoScenarioItem): Promise<RunningProcess> {
  // Preempt display/chrome-bridge locks — displaced agents are re-enqueued and signaled
  await preemptForCtoDashboardDemo(scenario.title);

  const outputFile = makeOutputFile('demo', scenario.id);
  const fd = fs.openSync(outputFile, 'a');

  const webPort = process.env.PLAYWRIGHT_WEB_PORT || '3000';
  const baseUrl = `http://localhost:${webPort}`;

  // Step 1: Resolve credentials from services.json secrets.local (fail-closed)
  logPreflight(fd, `Resolving credentials from services.json...`);
  let resolvedSecrets: Record<string, string>;
  try {
    resolvedSecrets = resolveServicesSecrets();
    logPreflight(fd, `Credentials resolved (${Object.keys(resolvedSecrets).length} keys)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logPreflight(fd, `ABORT: ${msg}`);
    try { fs.closeSync(fd); } catch { /* */ }
    return {
      pid: 0,
      label: scenario.title,
      type: 'demo',
      status: 'failed',
      startedAt: new Date().toISOString(),
      outputFile,
      exitCode: 1,
    };
  }

  // Step 2: Execute registered prerequisites (may start dev server)
  const prereqResult = await executeDashboardPrerequisites(scenario.id, baseUrl, resolvedSecrets, fd);
  if (!prereqResult.success) {
    logPreflight(fd, `ABORT: ${prereqResult.message}`);
    try { fs.closeSync(fd); } catch { /* */ }
    return {
      pid: 0,
      label: scenario.title,
      type: 'demo',
      status: 'failed',
      startedAt: new Date().toISOString(),
      outputFile,
      exitCode: 1,
    };
  }

  // Step 3: Ensure dev server is healthy (fallback auto-start if no prerequisite handled it)
  const devServerHealthy = await ensureDashboardDevServer(baseUrl, resolvedSecrets, fd);
  if (!devServerHealthy) {
    logPreflight(fd, `WARNING: Dev server not responding at ${baseUrl} — demo may fail at webServer startup`);
  }

  // Step 4: Launch Playwright with PLAYWRIGHT_BASE_URL set (skips webServer block)
  logPreflight(fd, `Launching demo: ${scenario.title}`);
  logPreflight(fd, `PLAYWRIGHT_BASE_URL=${baseUrl}`);
  logPreflight(fd, '---');

  const cmdArgs = ['playwright', 'test', scenario.testFile, '--project', scenario.playwrightProject, '--headed', '--reporter', 'list'];

  // Resolve per-scenario env_vars (including any op:// references)
  const scenarioEnv: Record<string, string> = scenario.envVars
    ? resolveOpEnvVars(scenario.envVars)
    : {};

  const child = spawn('npx', cmdArgs, {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: PROJECT_DIR,
    env: buildDemoEnv({
      dev_server_ready: devServerHealthy,
      extra: {
        DEMO_HEADED: '1',
        DEMO_SLOW_MO: '800',
        DEMO_SHOW_CURSOR: '1',
        DEMO_MAXIMIZE: '1',
        PLAYWRIGHT_BASE_URL: baseUrl,
        ...scenarioEnv,
      },
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

export async function releaseDemo(): Promise<void> {
  await releaseCtoDashboardDemo();
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
    env: buildDemoEnv({}),
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

/**
 * Recursively collect all descendant PIDs of a process via `pgrep -P`.
 * Returns the full tree in bottom-up order (deepest children first).
 */
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) {
      for (const line of out.split('\n')) {
        const child = parseInt(line, 10);
        if (!isNaN(child)) {
          descendants.push(...getDescendantPids(child));
          descendants.push(child);
        }
      }
    }
  } catch { /* no children or pgrep failed */ }
  return descendants;
}

export function killProcess(proc: RunningProcess): void {
  if (!isProcessAlive(proc.pid)) return;
  // Collect all descendants BEFORE sending any signals (process tree may change)
  const descendants = getDescendantPids(proc.pid);
  // SIGTERM the process group first for graceful cleanup
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try { process.kill(proc.pid, 'SIGTERM'); } catch { /* */ }
  }
  // SIGTERM each descendant individually (they may be in different process groups)
  for (const pid of descendants) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  }
  // Escalate to SIGKILL after 2s for anything still alive
  setTimeout(() => {
    for (const pid of [proc.pid, ...descendants]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  }, 2000);
}
