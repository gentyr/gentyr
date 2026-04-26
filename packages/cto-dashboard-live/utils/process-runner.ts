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
import * as https from 'https';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import type { DemoScenarioItem, TestFileItem, RunningProcess, DemoExecutionMode } from '../types.js';
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
 * demoDevModeEnv is always applied — it may contain env vars (like SUPABASE_URL)
 * that are needed regardless of dev server health.
 */
function buildDemoEnv(opts?: { extra?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const key of INFRA_CRED_KEYS) delete env[key];

  // Inject resolved credentials from services.json secrets.local
  try {
    Object.assign(env, resolveServicesSecrets());
  } catch (err) {
    // Log the error — launchDemo should have caught this earlier, but log defensively
    process.stderr.write(`[buildDemoEnv] resolveServicesSecrets failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Always apply demoDevModeEnv — vars like SUPABASE_URL are needed for demos
  // regardless of whether the dev server is healthy
  Object.assign(env, getDemoDevModeEnv());

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

/**
 * Auto-pull a git branch into the main tree before running demos.
 * Stashes any local changes, pulls, then pops the stash.
 * On failure, restores the original branch and stash to leave the tree clean.
 * Non-fatal: returns an error message on failure, null on success.
 */
function autoPullBranch(branch: string, fd?: number): string | null {
  let originalBranch: string | null = null;
  let didStash = false;
  let didCheckout = false;

  try {
    // Record current branch for recovery
    originalBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', cwd: PROJECT_DIR, timeout: 5000,
    }).trim();

    // Fetch latest refs
    if (fd) logPreflight(fd, `Fetching origin/${branch}...`);
    try {
      execFileSync('git', ['fetch', 'origin', branch], {
        encoding: 'utf8', cwd: PROJECT_DIR, timeout: 30000, stdio: 'pipe',
      });
    } catch {
      // Non-fatal — may be offline, proceed with local state
      if (fd) logPreflight(fd, `  fetch failed (offline?) — using local state`);
    }

    // Check if there are local changes that need stashing
    const status = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8', cwd: PROJECT_DIR, timeout: 5000,
    }).trim();
    const needsStash = status.length > 0;

    if (needsStash) {
      if (fd) logPreflight(fd, `Stashing local changes...`);
      execFileSync('git', ['stash', 'push', '-m', 'gentyr-dashboard-auto-pull'], {
        encoding: 'utf8', cwd: PROJECT_DIR, timeout: 10000, stdio: 'pipe',
      });
      didStash = true;
    }

    // If we're on a different branch, checkout the target
    if (originalBranch !== branch) {
      if (fd) logPreflight(fd, `Checking out ${branch}...`);
      execFileSync('git', ['checkout', branch], {
        encoding: 'utf8', cwd: PROJECT_DIR, timeout: 10000, stdio: 'pipe',
      });
      didCheckout = true;
    }

    // Pull latest
    if (fd) logPreflight(fd, `Pulling origin/${branch}...`);
    execFileSync('git', ['pull', 'origin', branch, '--ff-only'], {
      encoding: 'utf8', cwd: PROJECT_DIR, timeout: 30000, stdio: 'pipe',
    });

    // Pop stash if we stashed
    if (didStash) {
      if (fd) logPreflight(fd, `Restoring local changes...`);
      try {
        execFileSync('git', ['stash', 'pop'], {
          encoding: 'utf8', cwd: PROJECT_DIR, timeout: 10000, stdio: 'pipe',
        });
      } catch {
        // Stash pop conflict — abort the merge conflicts and drop the stash cleanly
        if (fd) logPreflight(fd, `  Stash conflict — resetting and dropping stash`);
        try { execFileSync('git', ['checkout', '--', '.'], { cwd: PROJECT_DIR, timeout: 5000, stdio: 'pipe' }); } catch { /* */ }
        try { execFileSync('git', ['stash', 'drop'], { cwd: PROJECT_DIR, timeout: 5000, stdio: 'pipe' }); } catch { /* */ }
      }
      didStash = false; // Stash has been consumed (popped or dropped)
    }

    if (fd) logPreflight(fd, `Main tree updated to latest origin/${branch}`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (fd) logPreflight(fd, `WARNING: auto-pull failed: ${msg}`);

    // Recovery: restore original branch and pop stash
    if (didCheckout && originalBranch) {
      try {
        if (fd) logPreflight(fd, `  Restoring original branch: ${originalBranch}`);
        execFileSync('git', ['checkout', originalBranch], { cwd: PROJECT_DIR, timeout: 10000, stdio: 'pipe' });
      } catch { /* best-effort */ }
    }
    if (didStash) {
      try {
        if (fd) logPreflight(fd, `  Restoring stashed changes`);
        execFileSync('git', ['stash', 'pop'], { cwd: PROJECT_DIR, timeout: 10000, stdio: 'pipe' });
      } catch { /* best-effort */ }
    }

    return msg;
  }
}

/**
 * Launch a demo scenario.
 * @param scenario - The demo scenario to launch
 * @param environmentBaseUrl - When set (non-local environment), PLAYWRIGHT_BASE_URL
 *   is set to this URL and dev server startup/health checks are skipped entirely.
 *   The Playwright test files still come from the current working tree.
 * @param branch - Git branch to auto-pull before launching. When set, the main tree
 *   is updated to the latest code from this branch before starting the dev server.
 */
export async function launchDemo(scenario: DemoScenarioItem, environmentBaseUrl?: string | null, branch?: string | null): Promise<RunningProcess> {
  // Preempt display/chrome-bridge locks — displaced agents are re-enqueued and signaled
  await preemptForCtoDashboardDemo(scenario.title);

  const outputFile = makeOutputFile('demo', scenario.id);
  const fd = fs.openSync(outputFile, 'a');

  const isRemoteEnv = !!environmentBaseUrl;
  const webPort = process.env.PLAYWRIGHT_WEB_PORT || '3000';
  const baseUrl = isRemoteEnv ? environmentBaseUrl! : `http://localhost:${webPort}`;

  // Step 0: Auto-pull target branch into main tree (local demos only)
  if (!isRemoteEnv && branch) {
    logPreflight(fd, `Auto-pulling branch: ${branch}`);
    const pullError = autoPullBranch(branch, fd);
    if (pullError) {
      logPreflight(fd, `Auto-pull failed but continuing with current code`);
    }
    // Invalidate cached credentials — code may have changed services.json
    _resolvedCredentials = null;
  }

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

  // Step 2: Execute registered prerequisites (may start dev server) — skip for remote environments
  if (!isRemoteEnv) {
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
  } else {
    logPreflight(fd, `Remote environment — skipping prerequisites and dev server startup`);
  }

  // Step 3: Ensure dev server is healthy (fallback auto-start) — skip for remote environments
  if (!isRemoteEnv) {
    const devServerHealthy = await ensureDashboardDevServer(baseUrl, resolvedSecrets, fd);
    if (!devServerHealthy) {
      logPreflight(fd, `WARNING: Dev server not responding at ${baseUrl} — demo may fail at webServer startup`);
    }
  }

  // Step 4: Launch Playwright with PLAYWRIGHT_BASE_URL set (skips webServer block)
  logPreflight(fd, `Launching demo: ${scenario.title}`);
  logPreflight(fd, `Target: ${isRemoteEnv ? 'REMOTE' : 'LOCAL'} — PLAYWRIGHT_BASE_URL=${baseUrl}`);

  const cmdArgs = ['playwright', 'test', scenario.testFile, '--project', scenario.playwrightProject, '--headed', '--reporter', 'list'];

  // Resolve per-scenario env_vars (including any op:// references)
  const scenarioEnv: Record<string, string> = scenario.envVars
    ? resolveOpEnvVars(scenario.envVars)
    : {};

  const demoEnv = buildDemoEnv({
    extra: {
      DEMO_HEADED: '1',
      DEMO_SLOW_MO: '800',
      DEMO_SHOW_CURSOR: '1',
      DEMO_MAXIMIZE: '1',
      PLAYWRIGHT_BASE_URL: baseUrl,
      ...scenarioEnv,
    },
  });

  // Diagnostic: log critical env vars so the CTO can see what reaches the child process
  const diagKeys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_ALLOW_VERTICAL_SLICE'];
  for (const k of diagKeys) {
    if (demoEnv[k]) logPreflight(fd, `  ${k}=${k.includes('KEY') ? '***' : demoEnv[k]}`);
  }
  logPreflight(fd, '---');

  const child = spawn('npx', cmdArgs, {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: PROJECT_DIR,
    env: demoEnv,
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
    executionMode: 'local' as const,
    scenarioId: scenario.id,
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

  // Remote demos: check output file for completion markers
  if (proc.executionMode === 'remote') {
    try {
      const output = fs.readFileSync(proc.outputFile, 'utf8');
      if (output.includes('[remote] DONE: passed')) {
        const result = { ...proc, status: 'passed' as const, exitCode: 0 };
        recordDemoResult(proc.scenarioId, 'passed', 'remote', proc.startedAt, proc.flyMachineId ?? null);
        return result;
      }
      if (output.includes('[remote] DONE: failed') || output.includes('[remote] ERROR:')) {
        const result = { ...proc, status: 'failed' as const, exitCode: 1 };
        recordDemoResult(proc.scenarioId, 'failed', 'remote', proc.startedAt, proc.flyMachineId ?? null);
        return result;
      }
    } catch { /* */ }
    return proc;
  }

  // Local: check PID liveness
  if (isProcessAlive(proc.pid)) return proc;

  // Process is dead — determine result from output
  let exitCode: number | null = null;
  try {
    const output = fs.readFileSync(proc.outputFile, 'utf8');
    if (output.includes('passed') && !output.includes('failed')) exitCode = 0;
    else if (output.includes('failed')) exitCode = 1;
  } catch { /* */ }

  const status = exitCode === 0 ? 'passed' : 'failed';
  if (proc.type === 'demo' && proc.scenarioId) {
    recordDemoResult(proc.scenarioId, status, 'local', proc.startedAt, null);
  }

  return { ...proc, status, exitCode };
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

// ============================================================================
// Demo Result Recording
// ============================================================================

/**
 * Record a demo run result to user-feedback.db demo_results table.
 * Short-lived writable connection — opens, writes, closes immediately.
 */
function recordDemoResult(
  scenarioId: string | undefined,
  status: 'passed' | 'failed',
  executionMode: DemoExecutionMode,
  startedAt: string,
  flyMachineId: string | null,
): void {
  if (!scenarioId) return;
  const dbPath = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
  if (!fs.existsSync(dbPath)) return;
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath);
    // Ensure table exists (auto-migration for dashboard-only usage)
    try { db.prepare('SELECT id FROM demo_results LIMIT 0').run(); } catch {
      db.exec(`CREATE TABLE IF NOT EXISTS demo_results (
        id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, execution_mode TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL, fly_machine_id TEXT, output_file TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT valid_mode CHECK (execution_mode IN ('local', 'remote')),
        CONSTRAINT valid_status CHECK (status IN ('passed', 'failed')),
        FOREIGN KEY (scenario_id) REFERENCES demo_scenarios(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_demo_results_scenario ON demo_results(scenario_id);
      CREATE INDEX IF NOT EXISTS idx_demo_results_completed ON demo_results(completed_at);`);
    }
    const now = new Date();
    const durationMs = now.getTime() - new Date(startedAt).getTime();
    db.prepare(
      'INSERT INTO demo_results (id, scenario_id, execution_mode, status, started_at, completed_at, duration_ms, fly_machine_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), scenarioId, executionMode, status, startedAt, now.toISOString(), durationMs, flyMachineId);
  } catch { /* non-fatal */ }
  finally { try { db?.close(); } catch { /* */ } }
}

// ============================================================================
// Fly.io Remote Demo Execution
// ============================================================================

const FLY_API_BASE = 'https://api.machines.dev/v1';

interface FlyMachineConfig {
  apiToken: string;
  appName: string;
  region: string;
  machineRam: number;
}

/** Load and resolve Fly.io config from services.json. Returns null if not configured. */
function loadFlyConfig(): FlyMachineConfig | null {
  const config = loadServicesConfig();
  if (!config) return null;
  const fly = config.fly as Record<string, unknown> | undefined;
  if (!fly || fly.enabled === false || typeof fly.appName !== 'string' || typeof fly.apiToken !== 'string') return null;

  let resolvedToken: string;
  const tokenRef = fly.apiToken as string;
  if (tokenRef.startsWith('op://')) {
    // Resolve from 1Password — check secrets.local first (already resolved), else direct op read
    const creds = resolveServicesSecrets();
    if (creds['FLY_API_TOKEN']) {
      resolvedToken = creds['FLY_API_TOKEN'];
    } else {
      const opToken = getOpToken();
      if (!opToken) return null;
      try {
        resolvedToken = execFileSync('op', ['read', tokenRef], {
          encoding: 'utf-8', timeout: 15000,
          env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: opToken },
        }).trim();
      } catch { return null; }
    }
  } else {
    resolvedToken = tokenRef;
  }

  return {
    apiToken: resolvedToken,
    appName: fly.appName as string,
    region: (fly.region as string) || 'iad',
    machineRam: (fly.machineRam as number) || 4096,
  };
}

/** Make a Fly Machines API request. */
function flyFetch(config: FlyMachineConfig, urlPath: string, method: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${FLY_API_BASE}${urlPath}`);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method,
      headers: {
        'Authorization': `Bearer ${config.apiToken}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Fly API timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Resolve the latest Docker image for the Fly app. */
async function resolveFlyImage(config: FlyMachineConfig): Promise<string> {
  return `registry.fly.io/${config.appName}:latest`;
}

/**
 * Launch a demo on a Fly.io machine.
 * Spawns the machine and starts a background progress poller that writes to the output file.
 */
export async function launchRemoteDemo(scenario: DemoScenarioItem): Promise<RunningProcess> {
  await preemptForCtoDashboardDemo(scenario.title);

  const outputFile = makeOutputFile('demo-remote', scenario.id);
  const fd = fs.openSync(outputFile, 'a');

  logPreflight(fd, 'Loading Fly.io configuration...');
  const flyConfig = loadFlyConfig();
  if (!flyConfig) {
    logPreflight(fd, 'ABORT: Fly.io not configured or token resolution failed');
    logPreflight(fd, '[remote] ERROR: Fly.io not configured');
    try { fs.closeSync(fd); } catch { /* */ }
    return {
      pid: 0, label: scenario.title, type: 'demo', status: 'failed',
      startedAt: new Date().toISOString(), outputFile, exitCode: 1,
      executionMode: 'remote', scenarioId: scenario.id,
    };
  }

  // Resolve credentials and env
  let resolvedSecrets: Record<string, string>;
  try {
    resolvedSecrets = resolveServicesSecrets();
    logPreflight(fd, `Credentials resolved (${Object.keys(resolvedSecrets).length} keys)`);
  } catch (err) {
    logPreflight(fd, `ABORT: ${err instanceof Error ? err.message : String(err)}`);
    logPreflight(fd, '[remote] ERROR: credential resolution failed');
    try { fs.closeSync(fd); } catch { /* */ }
    return {
      pid: 0, label: scenario.title, type: 'demo', status: 'failed',
      startedAt: new Date().toISOString(), outputFile, exitCode: 1,
      executionMode: 'remote', scenarioId: scenario.id,
    };
  }

  // Get git info
  let gitRemote: string, gitRef: string;
  try {
    gitRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', cwd: PROJECT_DIR, timeout: 5000 }).trim();
    gitRef = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: PROJECT_DIR, timeout: 5000 }).trim();
    // Convert SSH to HTTPS for Fly machine cloning
    if (gitRemote.startsWith('git@')) {
      gitRemote = gitRemote.replace(/^git@([^:]+):/, 'https://$1/');
    }
  } catch {
    logPreflight(fd, 'ABORT: Could not determine git remote/ref');
    logPreflight(fd, '[remote] ERROR: git info unavailable');
    try { fs.closeSync(fd); } catch { /* */ }
    return {
      pid: 0, label: scenario.title, type: 'demo', status: 'failed',
      startedAt: new Date().toISOString(), outputFile, exitCode: 1,
      executionMode: 'remote', scenarioId: scenario.id,
    };
  }

  // Build machine env
  const machineEnv: Record<string, string> = {
    GIT_REMOTE: gitRemote,
    GIT_REF: gitRef,
    TEST_FILE: scenario.testFile,
    DEMO_HEADLESS: '0',
    DEMO_SLOW_MO: '800',
    DEMO_MAXIMIZE: '1',
    DEMO_SHOW_CURSOR: '1',
  };
  // Merge resolved secrets (stripped of infra creds)
  for (const [k, v] of Object.entries(resolvedSecrets)) {
    if (!INFRA_CRED_KEYS.has(k)) machineEnv[k] = v;
  }
  // Merge demoDevModeEnv
  Object.assign(machineEnv, getDemoDevModeEnv());
  // Scenario env vars
  if (scenario.envVars) {
    Object.assign(machineEnv, resolveOpEnvVars(scenario.envVars));
  }
  // NEXT_PUBLIC convenience
  if (machineEnv['SUPABASE_URL'] && !machineEnv['NEXT_PUBLIC_SUPABASE_URL']) machineEnv['NEXT_PUBLIC_SUPABASE_URL'] = machineEnv['SUPABASE_URL'];
  if (machineEnv['SUPABASE_ANON_KEY'] && !machineEnv['NEXT_PUBLIC_SUPABASE_ANON_KEY']) machineEnv['NEXT_PUBLIC_SUPABASE_ANON_KEY'] = machineEnv['SUPABASE_ANON_KEY'];
  // Git auth for private repos
  if (resolvedSecrets['GITHUB_TOKEN']) machineEnv['GIT_AUTH_TOKEN'] = resolvedSecrets['GITHUB_TOKEN'];

  // Spawn machine
  logPreflight(fd, `Spawning Fly machine in ${flyConfig.region}...`);
  const image = await resolveFlyImage(flyConfig);

  let machineId: string;
  try {
    const resp = await flyFetch(flyConfig, `/apps/${flyConfig.appName}/machines`, 'POST', {
      name: `dashboard-demo-${Date.now()}`,
      region: flyConfig.region,
      config: {
        image,
        guest: { cpu_kind: 'shared', cpus: 2, memory_mb: flyConfig.machineRam },
        env: machineEnv,
        auto_destroy: true,
        restart: { policy: 'no' },
        stop_config: { timeout: '75s' },
      },
    });
    const respData = resp.data as { id?: string; error?: string };
    if (!respData?.id) throw new Error(respData?.error || `HTTP ${resp.status}`);
    machineId = respData.id;
    logPreflight(fd, `Machine ${machineId} created`);
  } catch (err) {
    logPreflight(fd, `ABORT: Failed to spawn machine: ${err instanceof Error ? err.message : String(err)}`);
    logPreflight(fd, '[remote] ERROR: machine spawn failed');
    try { fs.closeSync(fd); } catch { /* */ }
    return {
      pid: 0, label: scenario.title, type: 'demo', status: 'failed',
      startedAt: new Date().toISOString(), outputFile, exitCode: 1,
      executionMode: 'remote', scenarioId: scenario.id,
    };
  }

  try { fs.closeSync(fd); } catch { /* */ }

  // Start background poller that writes progress to the output file
  startRemoteProgressPoller(flyConfig, machineId, outputFile);

  return {
    pid: -1, // synthetic — no local PID
    label: scenario.title,
    type: 'demo',
    status: 'running',
    startedAt: new Date().toISOString(),
    outputFile,
    exitCode: null,
    executionMode: 'remote',
    flyMachineId: machineId,
    scenarioId: scenario.id,
  };
}

/** Track active remote poller intervals by machineId for cleanup. */
const _remotePollerIntervals = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Background poller that checks machine state and writes progress to the output file.
 * Tracks test pass/fail from progress JSONL events (not exec on stopped machines).
 * Returns the interval ID for cleanup.
 */
function startRemoteProgressPoller(config: FlyMachineConfig, machineId: string, outputFile: string): void {
  let testsFailed = 0;
  let testsPassed = 0;
  let seenLines = new Set<string>();  // dedup progress lines across polls
  let doneEventSeen = false;          // 'done' event from progress JSONL

  const interval = setInterval(async () => {
    try {
      const resp = await flyFetch(config, `/apps/${config.appName}/machines/${machineId}`, 'GET');
      const machine = resp.data as { state?: string; events?: Array<{ type: string; exit_code?: number }> };
      const state = machine?.state;

      // Try to read progress JSONL while machine is still running
      if (state === 'started') {
        try {
          const execResp = await flyFetch(config, `/apps/${config.appName}/machines/${machineId}/exec`, 'POST', {
            cmd: ['tail', '-30', '/app/.progress.jsonl'], timeout: 10,
          });
          const execData = execResp.data as { stdout?: string; exit_code?: number };
          if (execData?.stdout && execData.exit_code === 0) {
            const raw = Buffer.from(execData.stdout, 'base64').toString();
            for (const line of raw.split('\n').filter(Boolean)) {
              if (seenLines.has(line)) continue;
              seenLines.add(line);
              try {
                const evt = JSON.parse(line) as { type?: string; data?: { title?: string; message?: string; exit_code?: number } };
                if (evt.type === 'test_pass') { testsPassed++; fs.appendFileSync(outputFile, `[remote] PASS: ${evt.data?.title || '?'}\n`); }
                else if (evt.type === 'test_fail') { testsFailed++; fs.appendFileSync(outputFile, `[remote] FAIL: ${evt.data?.title || '?'}\n`); }
                else if (evt.type === 'step') fs.appendFileSync(outputFile, `[remote] step: ${evt.data?.message || evt.data?.title || ''}\n`);
                else if (evt.type === 'setup') fs.appendFileSync(outputFile, `[remote] setup: ${evt.data?.message || ''}\n`);
                else if (evt.type === 'done') doneEventSeen = true;
              } catch { /* skip malformed line */ }
            }
          }
        } catch { /* exec may fail before test starts */ }
      }

      // Machine stopped — determine result from tracked test events
      if (state === 'stopped' || state === 'destroying' || state === 'destroyed') {
        // Determine pass/fail from observed test events (not exec on dead machine)
        const status = (testsFailed === 0 && (testsPassed > 0 || doneEventSeen)) ? 'passed' : 'failed';
        fs.appendFileSync(outputFile, `[remote] DONE: ${status} (${testsPassed} passed, ${testsFailed} failed)\n`);

        // Cleanup: destroy machine and remove poller entry
        try { await flyFetch(config, `/apps/${config.appName}/machines/${machineId}`, 'DELETE'); } catch { /* */ }
        clearInterval(interval);
        _remotePollerIntervals.delete(machineId);
        return;
      }
    } catch { /* network error — retry on next tick */ }
  }, 5000);

  _remotePollerIntervals.set(machineId, interval);

  // Safety net: stop polling after 10 minutes
  setTimeout(() => {
    if (_remotePollerIntervals.has(machineId)) {
      clearInterval(interval);
      _remotePollerIntervals.delete(machineId);
      try { fs.appendFileSync(outputFile, '[remote] ERROR: polling timeout (10 min)\n'); } catch { /* */ }
    }
  }, 600_000);
}

/** Stop a remote Fly machine for a running remote demo. Cleans up the poller interval. */
export async function killRemoteProcess(proc: RunningProcess): Promise<void> {
  if (!proc.flyMachineId) return;
  // Clean up the progress poller
  const pollerId = _remotePollerIntervals.get(proc.flyMachineId);
  if (pollerId) {
    clearInterval(pollerId);
    _remotePollerIntervals.delete(proc.flyMachineId);
  }
  const flyConfig = loadFlyConfig();
  if (!flyConfig) return;
  try {
    await flyFetch(flyConfig, `/apps/${flyConfig.appName}/machines/${proc.flyMachineId}/stop`, 'POST', { signal: 'SIGTERM' });
  } catch { /* machine may already be stopped */ }
  try {
    await flyFetch(flyConfig, `/apps/${flyConfig.appName}/machines/${proc.flyMachineId}`, 'DELETE');
  } catch { /* */ }
}
